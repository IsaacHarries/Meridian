// Proposal collector + describer for the Implement-Ticket Orchestrator.
//
// The propose_* pipeline-control tools record the orchestrator's chosen
// action into a ProposalCollector instance shared with the chat node, so
// the node can read the proposal after the tool loop terminates without
// mutating reducer channels mid-loop.

import type { PendingProposal } from "./types.js";

export interface ProposalCollector {
  current: PendingProposal | undefined;
}

/** Short human-readable summary of a proposal for thread breadcrumbs. */
export function describeProposal(p: PendingProposal): string {
  if (p.kind === "proceed") return `pipeline ${p.action}${p.reason ? ` (${p.reason})` : ""}`;
  if (p.kind === "rewind") return `rewind to ${p.toStage}`;
  if (p.kind === "reply") {
    const trim = p.message.length > 80 ? `${p.message.slice(0, 80)}…` : p.message;
    return `triage reply — "${trim}"`;
  }
  if (p.kind === "edit_plan") {
    return `edit plan (${p.edits.length} op${p.edits.length === 1 ? "" : "s"})`;
  }
  if (p.kind === "accept_grooming_edit") {
    return `${p.newStatus} grooming edit ${p.editId}`;
  }
  return "unknown";
}
