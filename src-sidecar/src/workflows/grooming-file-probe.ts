// Grooming File Probe workflow.
//
// Pre-grooming step: given a JIRA ticket (optionally with a worktree path
// hint), ask the model which files in the codebase are most relevant. The
// response is JSON-as-text — the frontend parses it and uses the file/grep
// list to build the codebase context for the main grooming workflow.

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { buildModel } from "../models/factory.js";
import type { ModelSelection, OutboundEvent } from "../protocol.js";
import { streamLLMText } from "./streaming.js";

export const GroomingFileProbeInputSchema = z.object({
  ticketText: z.string(),
});

export type GroomingFileProbeInput = z.infer<
  typeof GroomingFileProbeInputSchema
>;

const SYSTEM_PROMPT = `You are a codebase navigation agent. Given a JIRA ticket, identify the source files most relevant to understanding and implementing it. Return ONLY valid JSON (no markdown fences, no explanation) with exactly this schema:
{
  "files": ["<relative path from repo root>", ...],
  "grep_patterns": ["<regex to search for relevant symbols/functions>", ...]
}
Rules:
- List at most 12 files and 6 grep patterns
- Paths should be relative (e.g. "src/reports/ReportEditor.tsx"), not absolute
- Grep patterns should target specific function names, class names, or identifiers mentioned in the ticket
- If a CODEBASE CONTEXT section is provided, use the worktree path information to form accurate paths
- Do not include test files, lock files, or generated files
- Return an empty arrays if the ticket is too vague to identify specific files`;

export interface GroomingFileProbeResult {
  markdown: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function runGroomingFileProbe(args: {
  input: GroomingFileProbeInput;
  model: ModelSelection;
  emit?: (event: OutboundEvent) => void;
  workflowId?: string;
  nodeName?: string;
}): Promise<GroomingFileProbeResult> {
  const llm = buildModel(args.model);
  // File probe returns a small JSON object — stream internally for usage
  // metadata but don't forward partial deltas (a half-formed JSON list isn't
  // useful UX for this small response).
  const { text, usage } = await streamLLMText({
    llm,
    messages: [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(`Identify relevant files for this ticket:\n\n${args.input.ticketText}`),
    ],
  });
  return { markdown: text, usage };
}
