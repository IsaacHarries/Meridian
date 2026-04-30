// Checkpoint Chat workflow.
//
// Multi-turn chat at any post-grooming pipeline checkpoint (impact, plan,
// implementation, tests, review, pr, retro). The agent can read files for
// context, write files (implementation stage only), and amend the stage's
// output. Returns JSON the frontend parses to apply state updates.

import { z } from "zod";
import { ChatHistoryItemSchema } from "./chat-with-tools.js";

export const CheckpointChatInputSchema = z.object({
  /** Pipeline stage the chat is anchored to: "implementation", "impact",
   *  "plan", "tests", "review", "pr", "retro", etc. */
  stage: z.string(),
  contextText: z.string(),
  historyJson: z.string(),
});

export type CheckpointChatInput = z.infer<typeof CheckpointChatInputSchema>;

export const CheckpointChatHistorySchema = z.array(ChatHistoryItemSchema);

export function buildCheckpointChatSystemPrompt(
  input: CheckpointChatInput,
): string {
  const isImpl = input.stage === "implementation";
  if (isImpl) {
    return (
      `You are a senior software engineer implementing code changes in a git worktree.\n\n` +
      `${input.contextText}\n\n` +
      `The developer is asking you to write or fix one or more files.\n\n` +
      `WORKFLOW:\n` +
      `1. Use read_repo_file to read every file you intend to change (understand what's there).\n` +
      `2. Use write_repo_file to write each file with its COMPLETE new content. Do NOT truncate or omit anything — partial content overwrites the whole file.\n` +
      `3. You MUST use write_repo_file for every file. Never describe code in your message or return it as text — that will NOT update the filesystem.\n` +
      `4. After writing all files, return your FINAL response.\n\n` +
      `Your FINAL response (after all tool calls) MUST be ONLY this JSON — no markdown fences, no prose outside it:\n` +
      `{\n` +
      `  "message": "<one sentence describing what was written — NO code>",\n` +
      `  "files_written": ["<path1>", "<path2>"],\n` +
      `  "deviations_resolved": ["<exact deviation string this fix addresses>"],\n` +
      `  "skipped_resolved": ["<path from the skipped list that you have now written>"]\n` +
      `}\n` +
      `The files_written list must contain every path you wrote with write_repo_file.\n` +
      `Use empty arrays for fields where nothing applies.`
    );
  }
  return (
    `You are a senior software engineer reviewing and updating pipeline output.\n\n` +
    `${input.contextText}\n\n` +
    `The developer may ask you to correct, clarify, or update the stage output shown above. Use read_repo_file or grep_repo_files if you need extra code context to answer accurately.\n\n` +
    `Your FINAL response (after any tool calls) MUST be exactly this JSON with no markdown fences or extra text outside it:\n` +
    `{\n` +
    `  "message": "<what you changed or answered>",\n` +
    `  "updated_output": <the complete updated stage output JSON object, or null if nothing changed>\n` +
    `}`
  );
}
