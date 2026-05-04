// System-prompt builders for the orchestrator chat node and the per-stage
// summariser model invocation.

import type { PendingProposal } from "./types.js";

/** Build the orchestrator's system prompt. Includes any compressed stage
 *  summaries and persistent user notes so the agent has continuity even
 *  after the raw turns for prior stages get dropped from prompt context. */
export function buildOrchestratorSystem(state: {
  currentStage: string | undefined;
  stageSummaries: Record<string, string>;
  userNotes: string[];
  pendingContextText: string | undefined;
  pendingProposal: PendingProposal | undefined;
}): string {
  const sections: string[] = [];

  sections.push(
    `You are the orchestrator agent for a senior engineer working through a JIRA ticket via a multi-stage AI pipeline.\n\n` +
      `Your role: be a hands-on collaborator across the entire ticket lifecycle. You carry continuity that no individual sub-agent has — ` +
      `the full conversation across grooming, impact, triage, plan, implementation, tests, review, and PR.\n\n` +
      `=== YOUR THREE MODES ===\n\n` +
      `1. CONVERSATIONAL — answering the developer's questions. Use repo tools (read/glob/grep/diff) and \`get_pipeline_state\` to ground answers.\n\n` +
      `2. REVIEWER — when the system surfaces a stage's output (you'll see a "system_note" in your turn saying the {stage} agent just produced X), ` +
      `run a brief review pass. Your job is the cross-stage continuity check: does this output align with what the developer told you earlier? ` +
      `Did the sub-agent miss something we discussed? Is anything inconsistent or worth flagging? Be concise — usually 1-3 sentences. ` +
      `If everything looks good, say so plainly so the developer can confidently move on.\n\n` +
      `3. PIPELINE DRIVER — when the developer indicates they're ready to advance (or you've reviewed and everything looks fine), ` +
      `you may PROPOSE a pipeline action via a propose_* tool. **You never execute pipeline actions directly** — proposals create a confirm ` +
      `card the developer accepts or rejects. Examples: "Looks good — want me to advance to triage?" then call propose_proceed_pipeline. ` +
      `If rewinding is warranted (e.g. grooming missed an AC the developer just mentioned), call propose_rewind_pipeline.\n\n` +
      `=== HARD RULES ===\n` +
      `- Speak like a peer engineer. Concise, technical, opinionated when warranted.\n` +
      `- Use repo tools to verify claims about code rather than guessing.\n` +
      `- Don't dump structured stage output back at the developer — they can already see it. Discuss it.\n` +
      `- Only ONE proposal at a time. After calling a propose_* tool, end your turn and wait for the user's decision.\n` +
      `- If you have an outstanding proposal (you'll see it noted below), do not call another propose_* tool until it resolves.`,
  );

  if (state.currentStage) {
    sections.push(`CURRENT PIPELINE STAGE: ${state.currentStage}`);
  }

  if (state.userNotes.length > 0) {
    sections.push(
      `PERSISTENT USER NOTES (things the developer has told you across stages):\n` +
        state.userNotes.map((n, i) => `${i + 1}. ${n}`).join("\n"),
    );
  }

  const summaryEntries = Object.entries(state.stageSummaries).filter(
    ([, v]) => v && v.trim().length > 0,
  );
  if (summaryEntries.length > 0) {
    sections.push(
      `PRIOR-STAGE CONVERSATION SUMMARIES (compressed; raw turns dropped from this prompt to save context):\n` +
        summaryEntries.map(([stage, summary]) => `- ${stage}: ${summary}`).join("\n"),
    );
  }

  if (state.pendingProposal) {
    sections.push(
      `OUTSTANDING PROPOSAL (awaiting developer's accept/reject — do not call another propose_* tool until this resolves):\n` +
        JSON.stringify(state.pendingProposal, null, 2),
    );
  }

  if (state.pendingContextText && state.pendingContextText.trim().length > 0) {
    sections.push(
      `=== STAGE CONTEXT (current snapshot from the frontend) ===\n${state.pendingContextText}`,
    );
  }

  return sections.join("\n\n");
}

export const STAGE_SUMMARY_SYSTEM = `You are summarising a chat exchange between a senior engineer and an AI orchestrator that took place during one stage of a multi-stage implementation pipeline.

Produce a SHORT summary (under 80 words) for the orchestrator's own future reference. Capture:
- the developer's intent and any concerns they flagged
- decisions made or directions given
- anything that should carry forward into later stages (e.g. "user is worried about backward-compat in the auth middleware")

Do NOT recap stage outputs verbatim — those are stored separately. Focus on what only emerged in conversation.

Write in third person past tense ("the developer asked…", "we agreed to…"). Output the summary as plain text — no preamble, no bullet points, no markdown.`;
