// PR Review workflow — sequential, chunk-aware (faithful port of the Rust
// review_pr behaviour, expressed as a LangGraph StateGraph).
//
// Two paths through the graph:
//   - Single-pass (small PRs ≤ chunkChars): one synthesis call on the
//     line-annotated diff produces the final report directly.
//   - Multi-chunk (large PRs): for each chunk, one CHUNK_SYSTEM call collects
//     findings; a final SYNTHESIS_SYSTEM call deduplicates and calibrates.
//
// Structure:
//   START → prepare ─[mode]─→ single_pass → END
//                  │
//                  └────────→ chunk_review ─[done?]─→ synthesis → END
//                                  ↑                 │
//                                  └─────────────────┘  (loop back if more chunks)

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AIMessageChunk } from "@langchain/core/messages";
import { parsePartialJson } from "@langchain/core/output_parsers";
import { z } from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { buildModel } from "../models/factory.js";
import type { ModelSelection, OutboundEvent } from "../protocol.js";
import { CHUNK_SYSTEM, SYNTHESIS_SYSTEM } from "./pr-review-prompts.js";
import {
  buildSinglePassReviewText,
  capFindingsBySeverity,
  sanitiseBareLineRanges,
  splitReviewIntoChunks,
  stripJsonFences,
} from "./pr-review-helpers.js";

// How often (ms) the synthesis nodes flush a partial-report progress event
// while streaming. Tight enough to feel live, loose enough that even a 1000
// token/sec local model doesn't flood the IPC channel.
const PARTIAL_FLUSH_MS = 80;

// ── Schemas ───────────────────────────────────────────────────────────────────

export const PrReviewInputSchema = z.object({
  // Pre-assembled review context: header (PR description, AC, ticket info,
  // comments) + "=== DIFF ===" section + optional "=== FULL FILE CONTENTS
  // FROM BRANCH ===" section. Assembly stays in Rust for this migration.
  reviewText: z.string(),
  // Per-chunk character budget (Rust picks 12k for local LLMs, 80k for cloud).
  chunkChars: z.number().int().positive().default(80_000),
  // Synthesis-input findings budget — when collected chunk findings exceed
  // this, lower-severity findings are dropped before being handed to synthesis.
  findingsBudget: z.number().int().positive().default(40_000),
  // Optional codebase-specific Agent Skills text appended to the synthesis
  // system prompt.
  skillsBlock: z.string().nullish(),
});

export type PrReviewInput = z.infer<typeof PrReviewInputSchema>;

export const FindingSchema = z.object({
  lens: z
    .enum(["acceptance_criteria", "security", "logic", "quality", "testing"])
    .optional(),
  severity: z.enum(["blocking", "non_blocking", "nitpick"]),
  title: z.string(),
  description: z.string(),
  file: z.string().nullable(),
  line_range: z.string().nullable(),
});

export type Finding = z.infer<typeof FindingSchema>;

const LensReportSchema = z.object({
  assessment: z.string(),
  findings: z.array(
    FindingSchema.omit({ lens: true }),
  ),
});

const BugTestStepsSchema = z
  .object({
    description: z.string(),
    happy_path: z.array(z.string()),
    sad_path: z.array(z.string()),
  })
  .nullable();

export const PrReviewReportSchema = z.object({
  overall: z.enum(["approve", "request_changes", "needs_discussion"]),
  summary: z.string(),
  bug_test_steps: BugTestStepsSchema,
  lenses: z.object({
    acceptance_criteria: LensReportSchema,
    security: LensReportSchema,
    logic: LensReportSchema,
    testing: LensReportSchema,
    quality: LensReportSchema,
  }),
});

export type PrReviewReport = z.infer<typeof PrReviewReportSchema>;

// ── State graph annotation ────────────────────────────────────────────────────

type Mode = "single_pass" | "multi_chunk";

const PrReviewStateAnnotation = Annotation.Root({
  input: Annotation<PrReviewInput>(),
  model: Annotation<ModelSelection>(),
  mode: Annotation<Mode | undefined>(),
  chunks: Annotation<string[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
  currentChunk: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
  allFindings: Annotation<Finding[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  rawReport: Annotation<string | undefined>(),
  parsedReport: Annotation<PrReviewReport | undefined>(),
  parseError: Annotation<string | undefined>(),
  usage: Annotation<{ inputTokens: number; outputTokens: number }>({
    reducer: (current, update) => ({
      inputTokens: (current?.inputTokens ?? 0) + update.inputTokens,
      outputTokens: (current?.outputTokens ?? 0) + update.outputTokens,
    }),
    default: () => ({ inputTokens: 0, outputTokens: 0 }),
  }),
});

type PrReviewState = typeof PrReviewStateAnnotation.State;

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : (b as { text?: string }).text ?? ""))
      .join("");
  }
  return "";
}

function tokenUsage(
  metadata: { input_tokens?: number; output_tokens?: number } | undefined,
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: metadata?.input_tokens ?? 0,
    outputTokens: metadata?.output_tokens ?? 0,
  };
}

/**
 * Stream a synthesis-style model response while emitting partial-JSON
 * progress events. Returns the final raw text and accumulated usage so the
 * caller can run schema validation once streaming completes.
 *
 * Each emit carries the deepest valid partial parse of the JSON tokens
 * received so far. The frontend renders whatever fields exist; missing
 * fields simply don't render yet, so users see the summary appear, then
 * each lens populate as the model produces it.
 */
async function streamSynthesis(args: {
  model: BaseChatModel;
  system: string;
  user: string;
  emit?: (event: OutboundEvent) => void;
  workflowId?: string;
  node: string;
}): Promise<{
  raw: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
  const { model, system, user, emit, workflowId, node } = args;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = (await (model as any).stream([
    new SystemMessage(system),
    new HumanMessage(user),
  ])) as AsyncIterable<AIMessageChunk>;

  let raw = "";
  let accumulated: AIMessageChunk | undefined;
  let lastFlushAt = 0;
  let lastEmittedSize = -1;

  const tryFlush = (force: boolean) => {
    if (!emit || !workflowId) return;
    const now = Date.now();
    if (!force && now - lastFlushAt < PARTIAL_FLUSH_MS) return;

    const cleaned = sanitiseBareLineRanges(stripJsonFences(raw));
    if (cleaned.length === lastEmittedSize) return;

    const partial = parsePartialJson(cleaned);
    if (partial == null || typeof partial !== "object") return;

    lastFlushAt = now;
    lastEmittedSize = cleaned.length;
    emit({
      id: workflowId,
      type: "progress",
      node,
      status: "started",
      data: { partialReport: partial },
    });
  };

  for await (const chunk of stream) {
    accumulated = accumulated ? accumulated.concat(chunk) : chunk;
    const deltaText = extractText(chunk.content);
    if (deltaText) {
      raw += deltaText;
      tryFlush(false);
    }
  }
  tryFlush(true);

  const meta = accumulated?.usage_metadata as
    | { input_tokens?: number; output_tokens?: number }
    | undefined;

  return {
    raw,
    usage: tokenUsage(meta),
  };
}

function buildSynthesisSystem(skillsBlock?: string | null): string {
  if (!skillsBlock?.trim()) return SYNTHESIS_SYSTEM;
  return (
    SYNTHESIS_SYSTEM +
    "\n\n=== PROJECT-SPECIFIC REVIEW STANDARDS (Agent Skills) ===\n" +
    "The following conventions are specific to this codebase. Apply them when " +
    "evaluating findings — they take precedence over generic heuristics.\n" +
    skillsBlock
  );
}

// ── Nodes ─────────────────────────────────────────────────────────────────────

function prepareNode(state: PrReviewState): Partial<PrReviewState> {
  const chunks = splitReviewIntoChunks(state.input.reviewText, state.input.chunkChars);
  const mode: Mode = chunks.length > 1 ? "multi_chunk" : "single_pass";
  return { chunks, mode, currentChunk: 0 };
}

function makeSinglePassNode(
  emit?: (event: OutboundEvent) => void,
  workflowId?: string,
) {
  return async function singlePassNode(
    state: PrReviewState,
  ): Promise<Partial<PrReviewState>> {
    const model: BaseChatModel = buildModel(state.model);
    const annotated = buildSinglePassReviewText(state.input.reviewText);
    const system = buildSynthesisSystem(state.input.skillsBlock);
    const user =
      `Review this pull request across five lenses: acceptance_criteria, security, ` +
      `logic, quality, and testing. Apply the severity calibration rules from your ` +
      `system prompt carefully — do not inflate severity. Note what is done well in ` +
      `the summary. Produce the final review report JSON.\n\n${annotated}`;

    const { raw, usage } = await streamSynthesis({
      model,
      system,
      user,
      emit,
      workflowId,
      node: "single_pass",
    });

    const cleaned = sanitiseBareLineRanges(stripJsonFences(raw));

    try {
      const parsed = JSON.parse(cleaned);
      const validated = PrReviewReportSchema.parse(parsed);
      return {
        rawReport: raw,
        parsedReport: validated,
        usage,
      };
    } catch (err) {
      return {
        rawReport: raw,
        parseError: err instanceof Error ? err.message : String(err),
        usage,
      };
    }
  };
}

async function chunkReviewNode(state: PrReviewState): Promise<Partial<PrReviewState>> {
  const model = buildModel(state.model);
  const chunk = state.chunks[state.currentChunk];
  if (!chunk) {
    // Defensive — shouldn't happen given the conditional edge, but stay safe.
    return { currentChunk: state.currentChunk + 1 };
  }

  const user = `Find all review findings in this diff chunk:\n\n${chunk}`;
  const response = await model.invoke([
    new SystemMessage(CHUNK_SYSTEM),
    new HumanMessage(user),
  ]);

  const raw = extractText(response.content) || response.text;
  const cleaned = stripJsonFences(raw);

  let chunkFindings: Finding[] = [];
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      // Validate each finding individually; skip ones the model malformed
      // rather than failing the whole chunk.
      for (const item of parsed) {
        const result = FindingSchema.safeParse(item);
        if (result.success) {
          chunkFindings.push(result.data);
        }
      }
    }
  } catch (err) {
    console.error(
      `[pr-review] chunk ${state.currentChunk + 1}/${state.chunks.length} returned unparsable findings:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  return {
    allFindings: chunkFindings,
    currentChunk: state.currentChunk + 1,
    usage: tokenUsage(response.usage_metadata),
  };
}

function makeSynthesisNode(
  emit?: (event: OutboundEvent) => void,
  workflowId?: string,
) {
  return async function synthesisNode(
    state: PrReviewState,
  ): Promise<Partial<PrReviewState>> {
    const model = buildModel(state.model);
    const system = buildSynthesisSystem(state.input.skillsBlock);

    const { json: cappedFindings, dropped } = capFindingsBySeverity(
      state.allFindings,
      state.input.findingsBudget,
    );

    const dropNote = dropped > 0
      ? `\n\nNote: ${dropped} lower-severity finding(s) were omitted to fit the model context window. All blocking and non-blocking findings are included.`
      : "";

    const marker = "=== DIFF ===";
    const idx = state.input.reviewText.indexOf(marker);
    const header = idx !== -1
      ? state.input.reviewText.slice(0, idx + marker.length) +
        "\n[diff reviewed in chunks — findings collected above]"
      : state.input.reviewText;

    const user =
      `Pull request context:\n${header}\n\n` +
      `Findings collected from reviewing all diff chunks:${dropNote}\n${cappedFindings}\n\n` +
      `Produce the final review report JSON.`;

    const { raw, usage } = await streamSynthesis({
      model,
      system,
      user,
      emit,
      workflowId,
      node: "synthesis",
    });

    const cleaned = sanitiseBareLineRanges(stripJsonFences(raw));

    try {
      const parsed = JSON.parse(cleaned);
      const validated = PrReviewReportSchema.parse(parsed);
      return {
        rawReport: raw,
        parsedReport: validated,
        usage,
      };
    } catch (err) {
      return {
        rawReport: raw,
        parseError: err instanceof Error ? err.message : String(err),
        usage,
      };
    }
  };
}

// ── Routing ───────────────────────────────────────────────────────────────────

function routeFromPrepare(state: PrReviewState): "single_pass" | "chunk_review" {
  return state.mode === "multi_chunk" ? "chunk_review" : "single_pass";
}

function routeFromChunk(state: PrReviewState): "chunk_review" | "synthesis" {
  return state.currentChunk < state.chunks.length ? "chunk_review" : "synthesis";
}

// ── Graph builder ─────────────────────────────────────────────────────────────

export function buildPrReviewGraph(opts?: {
  emit?: (event: OutboundEvent) => void;
  workflowId?: string;
}) {
  return new StateGraph(PrReviewStateAnnotation)
    .addNode("prepare", prepareNode)
    .addNode("single_pass", makeSinglePassNode(opts?.emit, opts?.workflowId))
    .addNode("chunk_review", chunkReviewNode)
    .addNode("synthesis", makeSynthesisNode(opts?.emit, opts?.workflowId))
    .addEdge(START, "prepare")
    .addConditionalEdges("prepare", routeFromPrepare, {
      single_pass: "single_pass",
      chunk_review: "chunk_review",
    })
    .addConditionalEdges("chunk_review", routeFromChunk, {
      chunk_review: "chunk_review",
      synthesis: "synthesis",
    })
    .addEdge("single_pass", END)
    .addEdge("synthesis", END)
    .compile();
}
