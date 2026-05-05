// Pure helpers shared across pipeline nodes: text extraction, token-usage
// shaping, JSON repair, structured-response parsing, skill appending, context
// rendering, transient-error classification, build-output truncation, and
// triage-turn markdown formatting.

import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";
import { streamLLMJson } from "../streaming.js";
import type { TriageTurnOutput } from "../pipeline-schemas.js";
import type { PipelineGraphContext, PipelineState } from "./state.js";

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : (b as { text?: string }).text ?? ""))
      .join("");
  }
  return "";
}

export function tokenUsage(
  metadata: { input_tokens?: number; output_tokens?: number } | undefined,
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: metadata?.input_tokens ?? 0,
    outputTokens: metadata?.output_tokens ?? 0,
  };
}

export function stripJsonFences(text: string): string {
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
export function extractFirstJsonObject(text: string): string | null {
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
export function repairJsonInsideStrings(input: string): string {
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

export function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseStructuredResponse(text: string): unknown {
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

export function appendSkill(
  base: string,
  skillBody: string | null | undefined,
  label: string,
): string {
  if (!skillBody?.trim()) return base;
  return `${base}\n\n=== PROJECT-SPECIFIC ${label} ===\n${skillBody}`;
}

/**
 * Append a SELF-CHECK block to a system prompt. The model is told to verify
 * the listed items before emitting its final output — catches the most likely
 * failure modes (vague verdicts, missing per-item evidence, hallucinated
 * citations) at the model side before the JSON parser runs.
 *
 * Pair with structured-output prompts where the schema alone doesn't enforce
 * correctness (free-form summary/assessment fields, lists that need per-item
 * evidence, severity calibration the schema can't validate).
 */
export function appendSelfCheck(base: string, items: string[]): string {
  if (items.length === 0) return base;
  const numbered = items.map((it, i) => `${i + 1}. ${it}`).join("\n");
  return (
    `${base}\n\n=== SELF-CHECK (apply before outputting) ===\n${numbered}\n` +
    `If any answer is NO — fix or downgrade the affected fields before emitting JSON.`
  );
}

/**
 * Stream a structured-output response, forwarding each parsable
 * incremental partial-JSON snapshot to the frontend as a `progress` event
 * with `data.partial` so the UI can render fields as they fill in,
 * instead of waiting for the full reply.
 */
export async function streamAndParse<S extends z.ZodTypeAny>(args: {
  ctx: PipelineGraphContext;
  nodeName: string;
  model: BaseChatModel;
  messages: BaseMessage[];
  schema: S;
}): Promise<{ parsed: z.output<S>; usage: { inputTokens: number; outputTokens: number } }> {
  const { ctx, nodeName, model, messages, schema } = args;
  const { raw, usage } = await streamLLMJson({
    llm: model,
    messages,
    emit: ctx.emit,
    workflowId: ctx.workflowId,
    nodeName,
    cleanText: stripJsonFences,
  });
  const json = parseStructuredResponse(raw);
  const parsed = schema.parse(json) as z.output<S>;
  return { parsed, usage };
}

export function buildContextText(state: PipelineState): string {
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

/** Errors that are worth retrying once because they're transient model-quality
 *  or quota failures rather than logic bugs in our prompt or schema. */
export function isTransientModelError(err: unknown): boolean {
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

/** Cap on stdout/stderr forwarded to the fix agent — long build outputs
 *  drown the model in noise. The tail is the most useful part. */
export const BUILD_OUTPUT_TAIL_CHARS = 12_000;

export function tailBuildOutput(output: string): string {
  if (output.length <= BUILD_OUTPUT_TAIL_CHARS) return output;
  return (
    `…(truncated; showing last ${BUILD_OUTPUT_TAIL_CHARS} chars)…\n\n` +
    output.slice(output.length - BUILD_OUTPUT_TAIL_CHARS)
  );
}

export function formatTriageTurnAsMarkdown(turn: TriageTurnOutput): string {
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
