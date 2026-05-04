// Stage compression for the Implement-Ticket Orchestrator.
//
// When the pipeline advances from stage A to stage B, the runner calls
// `summariseStageTurns` over the orchestrator's chat entries that were
// tagged with stage A and writes the result to `stageSummaries[A]`. The
// next chat turn's prompt then drops those raw entries and shows the
// compressed version instead — bounded prompt size with no information loss
// in the persisted thread (UI still renders the originals).

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildModel } from "../../models/factory.js";
import type { ModelSelection } from "../../protocol.js";
import { STAGE_SUMMARY_SYSTEM } from "./system-prompt.js";
import { extractText } from "./tools.js";
import type { OrchestratorMessage } from "./types.js";

/** Render orchestrator messages as plain text for the summariser model. */
export function renderTurnsForSummary(turns: OrchestratorMessage[]): string {
  const lines: string[] = [];
  for (const m of turns) {
    if (m.kind === "user") lines.push(`USER: ${m.content}`);
    else if (m.kind === "assistant") lines.push(`ORCHESTRATOR: ${m.content}`);
    else if (m.kind === "system_note") lines.push(`[note] ${m.content}`);
    else if (m.kind === "tool_call") {
      const args =
        typeof m.args === "string" ? m.args : JSON.stringify(m.args);
      lines.push(
        `[tool: ${m.name}(${args.length > 120 ? args.slice(0, 120) + "…" : args})${
          m.error ? ` ERROR: ${m.error}` : ""
        }]`,
      );
    }
  }
  return lines.join("\n");
}

/** Summarise the orchestrator's exchanges from a given stage into a short
 *  natural-language note. Uses a non-streaming model invocation since the
 *  output is internal state, not user-facing. */
export async function summariseStageTurns(args: {
  model: ModelSelection;
  stage: string;
  turns: OrchestratorMessage[];
}): Promise<string | undefined> {
  if (args.turns.length === 0) return undefined;
  const llm = buildModel(args.model);
  const rendered = renderTurnsForSummary(args.turns);
  const userMsg = `STAGE: ${args.stage}\n\nEXCHANGES:\n${rendered}`;
  try {
    // Use the streaming path so adapters that only attach usage_metadata
    // on the streaming branch (Gemini CodeAssist, Copilot) still report
    // tokens, and so on_chat_model_stream events fire if a future caller
    // wants to surface stage-summary progress in the UI.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (await (llm as any).stream([
      new SystemMessage(STAGE_SUMMARY_SYSTEM),
      new HumanMessage(userMsg),
    ])) as AsyncIterable<import("@langchain/core/messages").AIMessageChunk>;
    let accumulated:
      | import("@langchain/core/messages").AIMessageChunk
      | undefined;
    for await (const part of stream) {
      accumulated = accumulated ? accumulated.concat(part) : part;
    }
    const text = accumulated ? extractText(accumulated.content).trim() : "";
    return text.length > 0 ? text : undefined;
  } catch (err) {
    console.error(
      `[orchestrator] stage-summary call failed for ${args.stage}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/** Compare prior vs incoming stage and, on transition, summarise the prior
 *  stage's chat turns. Returns the partial state update to apply (the
 *  caller is responsible for `graph.updateState`-ing it in). Returns
 *  `undefined` when no transition is detected or there's nothing to
 *  summarise. */
export async function maybeCompressStageOnTransition(args: {
  model: ModelSelection;
  priorStage: string | undefined;
  incomingStage: string | undefined;
  thread: OrchestratorMessage[];
  existingSummaries: Record<string, string>;
}): Promise<{ stageSummaries: Record<string, string> } | undefined> {
  const { priorStage, incomingStage } = args;
  if (!priorStage) return undefined;            // no prior stage to summarise
  if (!incomingStage) return undefined;          // nothing to compare
  if (priorStage === incomingStage) return undefined; // same stage, no-op
  if (args.existingSummaries[priorStage]) return undefined; // already summarised
  const turns = args.thread.filter((m) => m.stage === priorStage);
  if (turns.length === 0) return undefined;
  const summary = await summariseStageTurns({
    model: args.model,
    stage: priorStage,
    turns,
  });
  if (!summary) return undefined;
  return { stageSummaries: { [priorStage]: summary } };
}
