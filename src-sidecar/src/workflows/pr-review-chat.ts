// PR Review Chat workflow.
//
// Interactive follow-up chat after the structured PR Review report has been
// produced. The engineer asks questions about findings; the model can call
// repo-inspection tools to verify claims against the codebase before
// answering. Streams reply tokens live to the frontend.

import { z } from "zod";
import { ChatHistoryItemSchema } from "./chat-with-tools.js";

export const PrReviewChatInputSchema = z.object({
  contextText: z.string(),
  historyJson: z.string(),
  /** Optional Agent Skills block appended to the system prompt. The Rust
   *  caller composes this from the user's `review` and `implementation`
   *  skills so the chat can reference codebase-specific conventions. */
  skillsBlock: z.string().nullish(),
});

export type PrReviewChatInput = z.infer<typeof PrReviewChatInputSchema>;

export const PrReviewChatHistorySchema = z.array(ChatHistoryItemSchema);

export function buildPrReviewChatSystemPrompt(input: PrReviewChatInput): string {
  const skills = input.skillsBlock?.trim() ?? "";
  return (
    `You are an expert code reviewer who has just completed a structured review of a pull request. The review report, PR comments, and PR context are below.\n\n` +
    `${input.contextText}\n\n` +
    `The engineer is now asking you follow-up questions about your findings. Your role:\n` +
    `- Explain your reasoning clearly when asked why you raised a finding\n` +
    `- When a finding was informed by a PR comment from another reviewer, say so explicitly: cite the comment author by name and quote the relevant part of their comment. Do not present their observation as your own independent conclusion.\n` +
    `- When a finding comes from your own analysis of the diff (not from any comment), say so clearly: explain which lines or patterns led you to the conclusion.\n` +
    `- Reconsider or soften a finding if the engineer provides additional context that changes its relevance\n` +
    `- Point to specific parts of the diff or specific comments when relevant\n` +
    `- Be concise and direct — this is a conversation, not another report\n` +
    `- Do NOT produce JSON — reply in plain prose only\n` +
    `- When writing or suggesting code examples, follow the project-specific conventions below. For example: if the standards specify Vitest, use Vitest syntax — not Jest or any other framework.\n\n` +
    `TOOLS — USE THEM PROACTIVELY:\n` +
    `You have access to repo-inspection tools that read the local git worktree. Whenever a question requires knowledge of files, build setup, tests, or configuration that is not already in the diff or report above, you MUST call the relevant tool before answering. Do NOT speculate or answer from general knowledge when the answer can be verified from the codebase. Do NOT announce that you are about to use tools — just use them, then answer.\n` +
    `- glob_repo_files — find files by pattern\n` +
    `- grep_repo_files — search file contents for a regex\n` +
    `- read_repo_file — read a specific file when you need its full contents\n` +
    `- get_repo_diff — get the diff between branches if the report's diff is insufficient\n` +
    `Typical pattern: glob_repo_files to locate candidates → grep_repo_files or read_repo_file to inspect → answer with concrete file paths and line references.` +
    (skills ? `\n\n${skills}` : "")
  );
}
