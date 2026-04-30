// Implementation pipeline workflow — 8-stage LangGraph with `interrupt()`
// after each agent node so the user can approve, request changes, or abort
// before the next stage runs.
//
// Tool-loop nodes (Implementation, TestGen) and the diff-aware Code Review
// node depend on a per-run `RepoTools` set passed into `buildPipelineGraph`.
// The runner constructs tools (capturing the workflow id + emit closure for
// the IPC callback bridge) and threads them through.
//
// Stage flow:
//   START → grooming → checkpoint → impact → checkpoint →
//     triage → triage_checkpoint → (loop / plan → guidance →
//     implementation → checkpoint → test_gen → checkpoint →
//     code_review → checkpoint → pr_description → checkpoint →
//     retrospective → END)
//
// Approve at every checkpoint to advance. Triage's checkpoint accepts a
// `reply` action that loops back to triage with the engineer's message
// appended.

import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { buildModel } from "../models/factory.js";
import type { ModelSelection, OutboundEvent } from "../protocol.js";
import { getCheckpointer } from "../checkpointer.js";
import type { RepoTools } from "../tools/repo-tools.js";
import { resolveModelSelection } from "../tools/refresh-credentials.js";

/** Context passed into node factories that need to perform sidecar→Rust IPC
 *  outside of a tool call (e.g. mid-stage credential refresh). */
export interface PipelineGraphContext {
  tools: RepoTools;
  workflowId: string;
  emit: (event: OutboundEvent) => void;
}
import {
  buildSystemPrompt as buildGroomingSystem,
  buildUserPrompt as buildGroomingUser,
  GroomingOutputSchema,
  type GroomingOutput,
} from "./grooming.js";
import {
  GuidanceOutputSchema,
  ImpactOutputSchema,
  ImplementationOutputSchema,
  ImplementationPlanSchema,
  PIPELINE_STAGES,
  PlanReviewOutputSchema,
  PrDescriptionOutputSchema,
  RetrospectiveOutputSchema,
  TestOutputSchema,
  TestPlanSchema,
  TriageTurnOutputSchema,
  type BuildAttempt,
  type BuildCheckResult,
  type BuildStatus,
  type GuidanceOutput,
  type ImpactOutput,
  type ImplementationFileResult,
  type ImplementationOutput,
  type ImplementationPlan,
  type PipelineStage,
  type PlanReviewOutput,
  type PrDescriptionOutput,
  type RetrospectiveOutput,
  type TestOutput,
  type TestPlan,
  type TriageTurnOutput,
} from "./pipeline-schemas.js";
import {
  buildPlanSystem,
  buildPrDescriptionSystem,
  buildTriageSystem,
  CODE_REVIEW_SYSTEM,
  GUIDANCE_SYSTEM,
  IMPACT_SYSTEM,
  IMPLEMENTATION_PER_FILE_SYSTEM,
  RETROSPECTIVE_SYSTEM,
  TEST_GEN_SYSTEM,
  TEST_PLAN_SYSTEM,
  BUILD_FIX_SYSTEM,
} from "./pipeline-prompts.js";
import { execInWorktree } from "../tools/repo-tools.js";

// ── Input schema ──────────────────────────────────────────────────────────────

export const PipelineInputSchema = z.object({
  ticketText: z.string(),
  ticketKey: z.string(),
  worktreePath: z.string(),
  codebaseContext: z.string().optional().default(""),
  groomingTemplates: z
    .object({
      acceptance_criteria: z.string().nullish(),
      steps_to_reproduce: z.string().nullish(),
    })
    .nullish(),
  skills: z
    .object({
      grooming: z.string().nullish(),
      patterns: z.string().nullish(),
      implementation: z.string().nullish(),
      review: z.string().nullish(),
      testing: z.string().nullish(),
    })
    .nullish(),
  prTemplate: z
    .object({
      body: z.string(),
      mode: z.enum(["guide", "strict"]).default("guide"),
    })
    .nullish(),
  /** Phase 3c — when true and `buildCheckCommand` is non-empty, the pipeline
   *  runs the build after implementation and loops back into a fix node on
   *  failure. Off by default; the user toggles it in Settings. */
  buildVerifyEnabled: z.boolean().optional().default(false),
  buildCheckCommand: z.string().optional().default(""),
});

export type PipelineInput = z.infer<typeof PipelineInputSchema>;

// ── State annotation ──────────────────────────────────────────────────────────

const TriageMessageInternalSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

type TriageMessage = z.infer<typeof TriageMessageInternalSchema>;

const PipelineStateAnnotation = Annotation.Root({
  input: Annotation<PipelineInput>(),
  model: Annotation<ModelSelection>(),

  currentStage: Annotation<PipelineStage>({
    reducer: (_current, update) => update,
    default: () => "grooming" as PipelineStage,
  }),

  groomingOutput: Annotation<GroomingOutput | undefined>(),
  impactOutput: Annotation<ImpactOutput | undefined>(),
  triageHistory: Annotation<TriageMessage[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  triageLastTurn: Annotation<TriageTurnOutput | undefined>(),
  plan: Annotation<ImplementationPlan | undefined>(),
  guidance: Annotation<GuidanceOutput | undefined>(),
  implementationOutput: Annotation<ImplementationOutput | undefined>(),
  buildVerification: Annotation<BuildCheckResult | undefined>(),
  testPlan: Annotation<TestPlan | undefined>(),
  testOutput: Annotation<TestOutput | undefined>(),
  reviewOutput: Annotation<PlanReviewOutput | undefined>(),
  prDescription: Annotation<PrDescriptionOutput | undefined>(),
  retrospective: Annotation<RetrospectiveOutput | undefined>(),

  buildStatus: Annotation<BuildStatus | undefined>(),
  buildAttempts: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),

  usage: Annotation<{ inputTokens: number; outputTokens: number }>({
    reducer: (current, update) => ({
      inputTokens: (current?.inputTokens ?? 0) + update.inputTokens,
      outputTokens: (current?.outputTokens ?? 0) + update.outputTokens,
    }),
    default: () => ({ inputTokens: 0, outputTokens: 0 }),
  }),
});

export type PipelineState = typeof PipelineStateAnnotation.State;

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

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    // Strip any language hint after the opening backticks (`json`,
    // `typescript`, `gitignore`, …) — models occasionally pick a label
    // matching the content rather than the structure.
    return trimmed
      .replace(/^```[a-zA-Z0-9_+-]*\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();
  }
  return trimmed;
}

/** Models sometimes wrap the structured response in prose. As a final
 *  fallback, look for the first balanced `{ ... }` block and try to parse
 *  that as JSON. Returns null if nothing parsable is found. */
function extractFirstJsonObject(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Repair common malformations that bite cheap models when emitting JSON
 *  that contains source-code snippets or shell commands:
 *  - Backslashes inside string literals that aren't part of a valid JSON
 *    escape sequence (e.g. a literal `\b` in a regex, `C:\foo` in a path).
 *  - Bare control characters (newlines, tabs) inside string literals.
 *  Both are common in Gemini Flash output. We only modify content inside
 *  string literals — structural punctuation outside strings is left alone. */
function repairJsonInsideStrings(input: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    // Inside a string literal.
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      const next = input[i + 1];
      if (next && '"\\/bfnrtu'.includes(next)) {
        out += ch;
        escape = true;
      } else {
        // Invalid escape — double the backslash so JSON.parse accepts it.
        out += "\\\\";
      }
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") {
      out += "\\r";
      continue;
    }
    if (ch === "\t") {
      out += "\\t";
      continue;
    }
    out += ch;
  }
  return out;
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseStructuredResponse(text: string): unknown {
  const cleaned = stripJsonFences(text);
  // Try strict parse first, then a repair pass for unescaped backslashes /
  // raw control chars, then balanced-brace extraction with the same fallbacks.
  const direct = tryParse(cleaned);
  if (direct !== undefined) return direct;
  const repaired = tryParse(repairJsonInsideStrings(cleaned));
  if (repaired !== undefined) return repaired;
  const extracted = extractFirstJsonObject(cleaned);
  if (extracted) {
    const extDirect = tryParse(extracted);
    if (extDirect !== undefined) return extDirect;
    const extRepaired = tryParse(repairJsonInsideStrings(extracted));
    if (extRepaired !== undefined) return extRepaired;
  }
  throw new Error(
    `Could not parse JSON from model response: ${cleaned.slice(0, 300)}`,
  );
}

function appendSkill(
  base: string,
  skillBody: string | null | undefined,
  label: string,
): string {
  if (!skillBody?.trim()) return base;
  return `${base}\n\n=== PROJECT-SPECIFIC ${label} ===\n${skillBody}`;
}

async function invokeAndParse<S extends z.ZodTypeAny>(
  model: BaseChatModel,
  system: string,
  user: string,
  schema: S,
): Promise<{ parsed: z.output<S>; usage: { inputTokens: number; outputTokens: number } }> {
  const response = await model.invoke([new SystemMessage(system), new HumanMessage(user)]);
  const raw = extractText(response.content) || response.text;
  const json = parseStructuredResponse(raw);
  const parsed = schema.parse(json) as z.output<S>;
  return { parsed, usage: tokenUsage(response.usage_metadata) };
}

function buildContextText(state: PipelineState): string {
  const parts: string[] = [`=== TICKET ===\n${state.input.ticketText}`];
  if (state.groomingOutput) {
    parts.push(`=== GROOMING ===\n${JSON.stringify(state.groomingOutput, null, 2)}`);
  }
  if (state.impactOutput) {
    parts.push(`=== IMPACT ===\n${JSON.stringify(state.impactOutput, null, 2)}`);
  }
  if (state.plan) {
    parts.push(`=== PLAN ===\n${JSON.stringify(state.plan, null, 2)}`);
  }
  return parts.join("\n\n");
}

// ── Tool-loop helper ──────────────────────────────────────────────────────────

const MAX_TOOL_LOOP_ITERATIONS = 15;

async function runToolLoop(
  model: BaseChatModel,
  tools: RepoTools,
  system: string,
  user: string,
): Promise<{
  finalMessage: AIMessage;
  usage: { inputTokens: number; outputTokens: number };
  /** Paths the model successfully wrote during this loop. Used by the
   *  implementation node to recover from final-message parse failures: if the
   *  file was written, we can synthesise a success summary instead of
   *  declaring the file skipped. */
  writtenPaths: string[];
}> {
  // Standard adapters (ChatAnthropic, ChatGoogleGenerativeAI, ChatOllama)
  // implement bindTools natively; the custom Claude OAuth adapter inherits
  // it from ChatAnthropic. Custom adapters that don't support bindTools
  // (Gemini CodeAssist, Copilot) will throw a clear error here — that's
  // expected for now; they're not used for tool-loop workflows.
  if (typeof model.bindTools !== "function") {
    throw new Error(
      `Model ${model._llmType()} does not support tool calls. Implementation pipeline requires a provider with native bindTools support (Anthropic API key, Anthropic OAuth via Claude.ai subscription, Google API key, or Ollama).`,
    );
  }

  const modelWithTools = model.bindTools(tools);
  const messages: BaseMessage[] = [new SystemMessage(system), new HumanMessage(user)];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const writtenPaths: string[] = [];

  for (let i = 0; i < MAX_TOOL_LOOP_ITERATIONS; i++) {
    const response = (await modelWithTools.invoke(messages)) as AIMessage;
    messages.push(response);
    const u = tokenUsage(response.usage_metadata);
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;

    const calls = response.tool_calls;
    if (!calls || calls.length === 0) {
      return { finalMessage: response, usage, writtenPaths };
    }

    for (const call of calls) {
      const found = tools.find((t) => t.name === call.name) as
        | { invoke: (input: unknown) => Promise<unknown> }
        | undefined;
      if (!found) {
        messages.push(
          new ToolMessage({
            tool_call_id: call.id ?? "",
            content: `Error: unknown tool '${call.name}'`,
          }),
        );
        continue;
      }
      try {
        const result = await found.invoke(call.args);
        if (call.name === "write_repo_file") {
          const path = (call.args as { path?: string } | undefined)?.path;
          if (path) writtenPaths.push(path);
        }
        messages.push(
          new ToolMessage({
            tool_call_id: call.id ?? "",
            name: call.name,
            content: typeof result === "string" ? result : JSON.stringify(result),
          }),
        );
      } catch (err) {
        messages.push(
          new ToolMessage({
            tool_call_id: call.id ?? "",
            name: call.name,
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
      }
    }
  }

  throw new Error(
    `Tool loop exceeded ${MAX_TOOL_LOOP_ITERATIONS} iterations without producing a final response.`,
  );
}

/** Errors that are worth retrying once because they're transient model-quality
 *  or quota failures rather than logic bugs in our prompt or schema. */
function isTransientModelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("MALFORMED_FUNCTION_CALL") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    // Node's undici surfaces transient DNS / TLS / connection-reset issues
    // as a bare "fetch failed" with the underlying cause buried in `cause`.
    msg.includes("fetch failed") ||
    // Gemini occasionally returns a `finishReason: STOP` candidate with no
    // text and no functionCall parts — our adapter surfaces this as
    // "Unexpected CodeAssist response shape". A fresh request usually works.
    msg.includes("Unexpected CodeAssist response shape")
  );
}

// ── Nodes ─────────────────────────────────────────────────────────────────────

async function groomingNode(state: PipelineState): Promise<Partial<PipelineState>> {
  const model = buildModel(state.model);
  const system = appendSkill(
    buildGroomingSystem(state.input.groomingTemplates ?? undefined),
    state.input.skills?.grooming,
    "GROOMING CONVENTIONS",
  );
  const user = buildGroomingUser({
    ticketText: state.input.ticketText,
    fileContents: state.input.codebaseContext,
    templates: state.input.groomingTemplates ?? undefined,
  });

  const { parsed, usage } = await invokeAndParse(model, system, user, GroomingOutputSchema);
  return { groomingOutput: parsed, currentStage: "impact" as PipelineStage, usage };
}

async function impactNode(state: PipelineState): Promise<Partial<PipelineState>> {
  if (!state.groomingOutput) throw new Error("Impact node ran before grooming completed");
  const model = buildModel(state.model);
  const user = `Ticket:\n${state.input.ticketText}\n\nGrooming analysis:\n${JSON.stringify(state.groomingOutput, null, 2)}`;
  const { parsed, usage } = await invokeAndParse(model, IMPACT_SYSTEM, user, ImpactOutputSchema);
  return { impactOutput: parsed, currentStage: "triage" as PipelineStage, usage };
}

async function triageNode(state: PipelineState): Promise<Partial<PipelineState>> {
  const model = buildModel(state.model);
  const contextText = buildContextText(state);
  const system = buildTriageSystem(contextText);

  const seedHistory: TriageMessage[] =
    state.triageHistory.length === 0
      ? [
          {
            role: "user",
            content:
              "Kick off the triage discussion. Surface the candidate approaches and any decisions I need to make.",
          },
        ]
      : [];

  const conversation: TriageMessage[] = [...seedHistory, ...state.triageHistory];
  const messages = [
    new SystemMessage(system),
    ...conversation.map((m) =>
      m.role === "user" ? new HumanMessage(m.content) : new SystemMessage(m.content),
    ),
  ];

  const response = await model.invoke(messages);
  const raw = extractText(response.content) || response.text;
  const turn = TriageTurnOutputSchema.parse(parseStructuredResponse(raw));

  // Render the structured turn as plain markdown for the chat history. The
  // raw model response is JSON wrapped in prose / fences; storing that
  // verbatim makes the triage panel show a JSON dump instead of the agent's
  // actual proposal. The structured form is still surfaced via
  // triageLastTurn for the checkpoint payload.
  const formatted = formatTriageTurnAsMarkdown(turn);

  return {
    triageHistory: [...seedHistory, { role: "assistant", content: formatted }],
    triageLastTurn: turn,
    usage: tokenUsage(response.usage_metadata),
  };
}

function formatTriageTurnAsMarkdown(turn: TriageTurnOutput): string {
  const parts: string[] = [];
  if (turn.message?.trim()) parts.push(turn.message.trim());
  if (turn.proposal?.trim()) parts.push(turn.proposal.trim());
  const questions = (turn.questions ?? []).filter((q) => q.trim().length > 0);
  if (questions.length > 0) {
    parts.push(
      "**Questions for you**\n" + questions.map((q) => `- ${q}`).join("\n"),
    );
  }
  return parts.join("\n\n");
}

async function planNode(state: PipelineState): Promise<Partial<PipelineState>> {
  const model = buildModel(state.model);
  const contextText = buildContextText(state);
  const system = buildPlanSystem(contextText);
  const conversation = JSON.stringify(state.triageHistory, null, 2);
  const user = `Triage conversation:\n${conversation}`;
  const { parsed, usage } = await invokeAndParse(model, system, user, ImplementationPlanSchema);
  return { plan: parsed, currentStage: "implementation" as PipelineStage, usage };
}

async function guidanceNode(state: PipelineState): Promise<Partial<PipelineState>> {
  if (!state.plan) throw new Error("Guidance node ran before plan was finalised");
  const model = buildModel(state.model);
  const system = appendSkill(
    GUIDANCE_SYSTEM,
    state.input.skills?.implementation,
    "IMPLEMENTATION CONVENTIONS",
  );
  const user = `Ticket:\n${state.input.ticketText}\n\nImplementation plan:\n${JSON.stringify(state.plan, null, 2)}`;
  const { parsed, usage } = await invokeAndParse(model, system, user, GuidanceOutputSchema);
  return { guidance: parsed, usage };
}

// Per-file response from the implementation tool-loop. `summary` is treated
// as optional at the schema level because Gemini Flash frequently omits it
// even when the prompt mandates it; the implementation node synthesises a
// fallback summary when the file was actually written via write_repo_file.
const PerFileResponseSchema = z.object({
  summary: z.string().optional().default(""),
  deviations: z.array(z.string()).optional().default([]),
  skipped: z.boolean().optional().default(false),
});

function makeImplementationNode(ctx: PipelineGraphContext) {
  const { tools, workflowId, emit } = ctx;
  return async function implementationNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    if (!state.plan) throw new Error("Implementation node ran before plan was finalised");

    const system = appendSkill(
      IMPLEMENTATION_PER_FILE_SYSTEM,
      state.input.skills?.implementation,
      "IMPLEMENTATION CONVENTIONS",
    );

    const filesChanged: ImplementationFileResult[] = [];
    const deviations: string[] = [];
    const skipped: string[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };

    // Re-resolve the full ModelSelection before each file. This both keeps
    // OAuth tokens fresh (Gemini CodeAssist tokens are ~1h) and picks up any
    // model/provider change the user has made via the header dropdown since
    // the workflow started — the workflow doesn't have to be restarted.
    let currentSelection: ModelSelection = state.model;

    const totalFiles = state.plan.files.length;
    for (let fileIndex = 0; fileIndex < totalFiles; fileIndex++) {
      const file = state.plan.files[fileIndex];
      // Surface per-file progress so the frontend can show
      // "Writing src/cli.ts (3/8)…" instead of a static "Writing code…".
      emit({
        id: workflowId,
        type: "progress",
        node: "implementation",
        status: "started",
        data: {
          phase: "file_started",
          file: file.path,
          fileIndex: fileIndex + 1,
          totalFiles,
        },
      });

      try {
        currentSelection = await resolveModelSelection({
          workflowId,
          panel: "implement_ticket",
          stage: "pipeline",
          emit,
        });
        console.error(
          `[implementation] ${file.path}: using ${currentSelection.provider}/${currentSelection.model}`,
        );
      } catch (err) {
        console.error(
          `[implementation] model refresh failed before ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const guidanceSteps = state.guidance?.steps?.filter((s) => s.file === file.path) ?? [];
      const guidanceText = guidanceSteps.length
        ? `\n\nGuidance for this file:\n${JSON.stringify(guidanceSteps, null, 2)}`
        : "";
      const userPrompt =
        `Plan entry: ${JSON.stringify(file, null, 2)}\n\n` +
        `Full ticket context:\n${state.input.ticketText}\n\n` +
        `Full plan summary:\n${state.plan.summary}\n` +
        `Patterns to follow:\n${JSON.stringify(state.guidance?.patterns_to_follow ?? [], null, 2)}\n` +
        `Common pitfalls:\n${JSON.stringify(state.guidance?.common_pitfalls ?? [], null, 2)}` +
        guidanceText +
        `\n\nImplement ONLY this single file. Use read_repo_file first if you need context, then write_repo_file with the COMPLETE new content.`;

      // Try the file once; on a transient model-quality / quota error
      // (Gemini MALFORMED_FUNCTION_CALL, 429, etc.) retry once with a fresh
      // model build before giving up.
      let attempt: { finalMessage: AIMessage; usage: { inputTokens: number; outputTokens: number }; writtenPaths: string[] } | undefined;
      let lastErr: unknown;
      for (let tries = 0; tries < 2; tries++) {
        try {
          const model = buildModel(currentSelection);
          attempt = await runToolLoop(model, tools, system, userPrompt);
          break;
        } catch (err) {
          lastErr = err;
          if (tries === 0 && isTransientModelError(err)) {
            console.error(
              `[implementation] transient error on ${file.path}, retrying: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
          break;
        }
      }

      if (!attempt) {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        skipped.push(`${file.path}: tool-loop failed (${msg})`);
        continue;
      }

      const { finalMessage, usage: u, writtenPaths } = attempt;
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;

      const fileWasWritten = writtenPaths.includes(file.path);
      const action: ImplementationFileResult["action"] =
        file.action === "delete"
          ? "deleted"
          : file.action === "create"
            ? "created"
            : "modified";

      try {
        const raw = extractText(finalMessage.content) || finalMessage.text;
        const parsed = PerFileResponseSchema.parse(parseStructuredResponse(raw));

        if (parsed.skipped) {
          skipped.push(
            `${file.path}: ${parsed.summary || "model declined to implement"}`,
          );
        } else if (fileWasWritten) {
          filesChanged.push({
            path: file.path,
            action,
            summary:
              parsed.summary ||
              "Implementation written (model omitted summary in final response).",
          });
        } else {
          // Final response parsed cleanly but the model never called
          // write_repo_file. Treat as skipped — nothing was actually written.
          skipped.push(
            `${file.path}: model returned a final response without writing the file`,
          );
        }
        if (parsed.deviations.length) {
          deviations.push(...parsed.deviations.map((d) => `${file.path}: ${d}`));
        }
      } catch (parseErr) {
        // Final-response parse failure (malformed JSON, missing summary, etc.).
        // If the model actually wrote the file via write_repo_file during the
        // loop, count it as success with a synthesised summary — losing the
        // structured summary is far less bad than throwing away a real change.
        if (fileWasWritten) {
          filesChanged.push({
            path: file.path,
            action,
            summary:
              "Implementation written; final structured summary was malformed and could not be parsed.",
          });
        } else {
          const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          skipped.push(`${file.path}: tool-loop failed (${msg})`);
        }
      }
    }

    const output: ImplementationOutput = {
      summary: `Implemented ${filesChanged.length} of ${state.plan.files.length} planned file(s)${skipped.length ? `, skipped ${skipped.length}` : ""}.`,
      files_changed: filesChanged,
      deviations,
      skipped,
    };
    // Persist the most recently-refreshed credentials so downstream nodes
    // (test_gen, code_review) see them too.
    return { implementationOutput: output, usage, model: currentSelection };
  };
}

// ── Build-check sub-loop (Phase 3c) ──────────────────────────────────────────

const BUILD_CHECK_MAX_ATTEMPTS = 3;
/** Cap on stdout/stderr forwarded to the fix agent — long build outputs
 *  drown the model in noise. The tail is the most useful part. */
const BUILD_OUTPUT_TAIL_CHARS = 12_000;

function tailBuildOutput(output: string): string {
  if (output.length <= BUILD_OUTPUT_TAIL_CHARS) return output;
  return (
    `…(truncated; showing last ${BUILD_OUTPUT_TAIL_CHARS} chars)…\n\n` +
    output.slice(output.length - BUILD_OUTPUT_TAIL_CHARS)
  );
}

const BuildFixResponseSchema = z.object({
  summary: z.string().optional().default(""),
  files_written: z.array(z.string()).optional().default([]),
});

function makeBuildCheckNode(ctx: PipelineGraphContext) {
  const { workflowId, emit } = ctx;
  return async function buildCheckNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    const command = state.input.buildCheckCommand?.trim() ?? "";
    if (!command) {
      // Defensive — the conditional edge should already have routed away.
      return {};
    }

    const priorAttempts = state.buildVerification?.attempts ?? [];
    const attemptNumber = priorAttempts.length + 1;

    let exitCode = 1;
    let output = "";
    try {
      const result = await execInWorktree({
        workflowId,
        emit,
        command,
        timeoutSecs: 300,
      });
      exitCode = result.exitCode;
      output = result.output;
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
    }

    const attempt: BuildAttempt = {
      attempt: attemptNumber,
      exit_code: exitCode,
      output,
      // The build_check node itself never writes files; the build_fix node
      // does and amends the previous attempt with its file list. So the
      // first attempt's `fixed` is false; subsequent verifications inherit
      // the fixed flag set by the preceding fix turn.
      fixed: false,
      files_written: [],
    };

    const next: BuildCheckResult = {
      build_command: command,
      build_passed: exitCode === 0,
      attempts: [...priorAttempts, attempt],
    };
    return { buildVerification: next };
  };
}

function makeBuildFixNode(ctx: PipelineGraphContext) {
  const { tools, workflowId, emit } = ctx;
  return async function buildFixNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    if (!state.buildVerification || state.buildVerification.build_passed) {
      // Should not be reachable via the routing edges, but guard anyway.
      return {};
    }
    const lastAttempt =
      state.buildVerification.attempts[state.buildVerification.attempts.length - 1];

    const model = buildModel(state.model);
    const userPrompt =
      `Implementation plan:\n${JSON.stringify(state.plan, null, 2)}\n\n` +
      `What was implemented:\n${JSON.stringify(state.implementationOutput, null, 2)}\n\n` +
      `Build command: \`${state.buildVerification.build_command}\`\n\n` +
      `=== BUILD OUTPUT (attempt ${lastAttempt.attempt}, exit ${lastAttempt.exit_code}) ===\n` +
      `${tailBuildOutput(lastAttempt.output)}\n\n` +
      `Read the failing files, fix the errors, and write the corrections. Return the structured summary when done.`;

    const { finalMessage, usage, writtenPaths } = await runToolLoop(
      model,
      tools,
      BUILD_FIX_SYSTEM,
      userPrompt,
    );

    const raw = extractText(finalMessage.content) || finalMessage.text;
    let parsed: { summary: string; files_written: string[] };
    try {
      parsed = BuildFixResponseSchema.parse(parseStructuredResponse(raw));
    } catch {
      // Fallback when the model couldn't produce clean JSON: trust the tool
      // calls — if it wrote files, treat that as the fix.
      parsed = {
        summary:
          writtenPaths.length > 0
            ? `Fix applied; structured summary failed to parse — files: ${writtenPaths.join(", ")}.`
            : "Build fix attempted; no structured summary and no files written.",
        files_written: writtenPaths,
      };
    }

    // Record the fix on the most recent attempt and add it to the chain.
    const attempts = [...state.buildVerification.attempts];
    if (attempts.length > 0) {
      const last = attempts[attempts.length - 1];
      attempts[attempts.length - 1] = {
        ...last,
        fixed: true,
        files_written: [...new Set([...last.files_written, ...parsed.files_written, ...writtenPaths])],
      };
    }
    const next: BuildCheckResult = {
      build_command: state.buildVerification.build_command,
      build_passed: false,
      attempts,
    };
    return { buildVerification: next, usage };
  };
}

/** Conditional edge after `implementation`. Skips the build sub-loop entirely
 *  unless the user has both opted in AND configured a command. */
function routeAfterImplementation(state: PipelineState): "build_check" | "checkpoint_implementation" {
  const enabled = state.input.buildVerifyEnabled === true;
  const hasCommand = (state.input.buildCheckCommand ?? "").trim().length > 0;
  return enabled && hasCommand ? "build_check" : "checkpoint_implementation";
}

/** Conditional edge after `build_check`. Either the build passed (continue),
 *  the attempt budget is exhausted (continue and let the user decide), or we
 *  loop into the fix node. */
function routeAfterBuildCheck(
  state: PipelineState,
): "checkpoint_implementation" | "build_fix" {
  const v = state.buildVerification;
  if (!v) return "checkpoint_implementation";
  if (v.build_passed) return "checkpoint_implementation";
  if (v.attempts.length >= BUILD_CHECK_MAX_ATTEMPTS) return "checkpoint_implementation";
  return "build_fix";
}

function makeTestPlanNode(tools: RepoTools) {
  return async function testPlanNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    if (!state.plan) throw new Error("TestPlan node ran before plan was finalised");
    if (!state.implementationOutput) {
      throw new Error("TestPlan node ran before implementation completed");
    }

    const model = buildModel(state.model);
    const system = appendSkill(
      TEST_PLAN_SYSTEM,
      state.input.skills?.testing ?? state.input.skills?.implementation,
      "TESTING CONVENTIONS",
    );
    const userPrompt =
      `Ticket:\n${state.input.ticketText}\n\n` +
      `Implementation plan:\n${JSON.stringify(state.plan, null, 2)}\n\n` +
      `What was implemented:\n${JSON.stringify(state.implementationOutput, null, 2)}\n\n` +
      `Propose a test plan for the new/changed code. Read implementation files and existing test conventions if needed. Do NOT write any test files yet — return the plan as JSON.`;

    const { finalMessage, usage } = await runToolLoop(model, tools, system, userPrompt);
    const raw = extractText(finalMessage.content) || finalMessage.text;
    const parsed = TestPlanSchema.parse(parseStructuredResponse(raw));

    return { testPlan: parsed, usage };
  };
}

function makeTestGenNode(tools: RepoTools) {
  return async function testGenNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    if (!state.plan) throw new Error("TestGen node ran before plan was finalised");
    if (!state.implementationOutput) {
      throw new Error("TestGen node ran before implementation completed");
    }
    if (!state.testPlan) {
      throw new Error("TestGen node ran before testPlan was approved");
    }

    const model = buildModel(state.model);
    const system = appendSkill(
      TEST_GEN_SYSTEM,
      state.input.skills?.testing ?? state.input.skills?.implementation,
      "TESTING CONVENTIONS",
    );
    const userPrompt =
      `Ticket:\n${state.input.ticketText}\n\n` +
      `Implementation plan:\n${JSON.stringify(state.plan, null, 2)}\n\n` +
      `What was implemented:\n${JSON.stringify(state.implementationOutput, null, 2)}\n\n` +
      `=== APPROVED TEST PLAN (write these files) ===\n${JSON.stringify(state.testPlan, null, 2)}\n\n` +
      `Write each approved test file using write_repo_file with the COMPLETE content. Stick to the approved plan — don't silently drop or invent files.`;

    const { finalMessage, usage } = await runToolLoop(model, tools, system, userPrompt);
    const raw = extractText(finalMessage.content) || finalMessage.text;
    const parsed = TestOutputSchema.parse(parseStructuredResponse(raw));

    return { testOutput: parsed, usage };
  };
}

function makeCodeReviewNode(tools: RepoTools) {
  return async function codeReviewNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    const model = buildModel(state.model);
    const system = appendSkill(
      CODE_REVIEW_SYSTEM,
      state.input.skills?.review,
      "REVIEW STANDARDS",
    );
    // Pull the actual unified diff via the tool callback bridge so the
    // reviewer sees real changes, not just summaries.
    const diffTool = tools.find((t) => t.name === "get_repo_diff") as
      | { invoke: (input: unknown) => Promise<unknown> }
      | undefined;
    let diff = "(diff unavailable — get_repo_diff tool not registered)";
    if (diffTool) {
      try {
        const result = await diffTool.invoke({});
        diff = typeof result === "string" ? result : JSON.stringify(result);
      } catch (err) {
        diff = `(diff unavailable — ${err instanceof Error ? err.message : String(err)})`;
      }
    }

    const planJson = JSON.stringify(state.plan ?? {}, null, 2);
    const implJson = JSON.stringify(state.implementationOutput ?? {}, null, 2);
    const testJson = JSON.stringify(state.testOutput ?? {}, null, 2);
    const user = `Ticket:\n${state.input.ticketText}\n\nImplementation plan:\n${planJson}\n\nImplementation result:\n${implJson}\n\nTest plan:\n${testJson}\n\nCode diff:\n${diff}`;

    const { parsed, usage } = await invokeAndParse(model, system, user, PlanReviewOutputSchema);
    return { reviewOutput: parsed, usage };
  };
}

async function prDescriptionNode(state: PipelineState): Promise<Partial<PipelineState>> {
  const model = buildModel(state.model);
  const tmpl = state.input.prTemplate;
  const system = buildPrDescriptionSystem(tmpl?.body, tmpl?.mode ?? "guide");
  const user = `Ticket:\n${state.input.ticketText}\n\nImplementation plan:\n${JSON.stringify(state.plan ?? {}, null, 2)}\n\nImplementation result:\n${JSON.stringify(state.implementationOutput ?? {}, null, 2)}\n\nReview notes:\n${JSON.stringify(state.reviewOutput ?? {}, null, 2)}`;
  const { parsed, usage } = await invokeAndParse(model, system, user, PrDescriptionOutputSchema);
  return { prDescription: parsed, usage };
}

async function retrospectiveNode(state: PipelineState): Promise<Partial<PipelineState>> {
  const model = buildModel(state.model);
  const user = `Ticket:\n${state.input.ticketText}\n\nImplementation plan:\n${JSON.stringify(state.plan ?? {}, null, 2)}\n\nImplementation result:\n${JSON.stringify(state.implementationOutput ?? {}, null, 2)}\n\nReview:\n${JSON.stringify(state.reviewOutput ?? {}, null, 2)}`;
  const { parsed, usage } = await invokeAndParse(
    model,
    RETROSPECTIVE_SYSTEM,
    user,
    RetrospectiveOutputSchema,
  );
  return { retrospective: parsed, usage };
}

// ── Checkpoint nodes ──────────────────────────────────────────────────────────

type CheckpointResume =
  | { action: "approve" }
  | { action: "abort"; reason?: string }
  | { action: "reply"; message: string };

function checkpointNode(stage: PipelineStage, payloadSelector: (s: PipelineState) => unknown) {
  return async function (state: PipelineState): Promise<Partial<PipelineState>> {
    const decision = interrupt({
      stage,
      payload: payloadSelector(state),
    }) as CheckpointResume;
    if (decision.action === "abort") {
      throw new Error(`Pipeline aborted at ${stage}: ${decision.reason ?? "(no reason given)"}`);
    }
    if (decision.action === "reply") {
      throw new Error(
        `Stage ${stage} received a 'reply' resume; only the triage stage handles replies.`,
      );
    }
    return {};
  };
}

async function triageCheckpointNode(state: PipelineState): Promise<Command> {
  const decision = interrupt({
    stage: "triage" as PipelineStage,
    payload: state.triageLastTurn,
  }) as CheckpointResume;
  if (decision.action === "abort") {
    throw new Error(`Pipeline aborted at triage: ${decision.reason ?? "(no reason given)"}`);
  }
  if (decision.action === "reply") {
    return new Command({
      goto: "triage",
      update: {
        triageHistory: [{ role: "user" as const, content: decision.message }],
      },
    });
  }
  return new Command({
    goto: "do_plan",
    update: { currentStage: "implementation" as PipelineStage },
  });
}

// ── Graph builder ─────────────────────────────────────────────────────────────

export function buildPipelineGraph(ctx: PipelineGraphContext) {
  const { tools } = ctx;
  return new StateGraph(PipelineStateAnnotation)
    .addNode("grooming", groomingNode)
    .addNode("impact", impactNode)
    .addNode("triage", triageNode)
    // Node names use a `do_` prefix for plan/guidance/retrospective because
    // LangGraph forbids node names that collide with state-channel names —
    // and we already have `plan`, `guidance`, and `retrospective` as state
    // fields holding each agent's output.
    .addNode("do_plan", planNode)
    .addNode("do_guidance", guidanceNode)
    .addNode("implementation", makeImplementationNode(ctx))
    // Phase 3c — optional build verification sub-loop. Skipped entirely when
    // the user hasn't enabled it in Settings.
    .addNode("build_check", makeBuildCheckNode(ctx))
    .addNode("build_fix", makeBuildFixNode(ctx))
    .addNode("test_plan", makeTestPlanNode(tools))
    .addNode("test_gen", makeTestGenNode(tools))
    .addNode("code_review", makeCodeReviewNode(tools))
    .addNode("pr_description", prDescriptionNode)
    .addNode("do_retrospective", retrospectiveNode)
    .addNode("checkpoint_grooming", checkpointNode("grooming", (s) => s.groomingOutput))
    .addNode("checkpoint_impact", checkpointNode("impact", (s) => s.impactOutput))
    .addNode("checkpoint_triage", triageCheckpointNode, {
      ends: ["triage", "do_plan"],
    })
    .addNode(
      "checkpoint_implementation",
      checkpointNode("implementation", (s) => s.implementationOutput),
    )
    .addNode("checkpoint_test_plan", checkpointNode("test_plan", (s) => s.testPlan))
    .addNode("checkpoint_test_gen", checkpointNode("test_gen", (s) => s.testOutput))
    .addNode(
      "checkpoint_code_review",
      checkpointNode("code_review", (s) => s.reviewOutput),
    )
    .addNode(
      "checkpoint_pr_description",
      checkpointNode("pr_description", (s) => s.prDescription),
    )
    .addEdge(START, "grooming")
    .addEdge("grooming", "checkpoint_grooming")
    .addEdge("checkpoint_grooming", "impact")
    .addEdge("impact", "checkpoint_impact")
    .addEdge("checkpoint_impact", "triage")
    .addEdge("triage", "checkpoint_triage")
    .addEdge("do_plan", "do_guidance")
    .addEdge("do_guidance", "implementation")
    // Phase 3c routing: implementation → (build_check OR checkpoint_implementation),
    // build_check → (build_fix OR checkpoint_implementation), build_fix → build_check.
    .addConditionalEdges("implementation", routeAfterImplementation, [
      "build_check",
      "checkpoint_implementation",
    ])
    .addConditionalEdges("build_check", routeAfterBuildCheck, [
      "build_fix",
      "checkpoint_implementation",
    ])
    .addEdge("build_fix", "build_check")
    .addEdge("checkpoint_implementation", "test_plan")
    .addEdge("test_plan", "checkpoint_test_plan")
    .addEdge("checkpoint_test_plan", "test_gen")
    .addEdge("test_gen", "checkpoint_test_gen")
    .addEdge("checkpoint_test_gen", "code_review")
    .addEdge("code_review", "checkpoint_code_review")
    .addEdge("checkpoint_code_review", "pr_description")
    .addEdge("pr_description", "checkpoint_pr_description")
    .addEdge("checkpoint_pr_description", "do_retrospective")
    .addEdge("do_retrospective", END)
    .compile({ checkpointer: getCheckpointer() });
}

export { PIPELINE_STAGES };
