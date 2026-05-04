// ── Types ─────────────────────────────────────────────────────────────────────

export interface FixProposal {
  commentId: number;
  file: string | null;
  fromLine: number | null;
  toLine: number | null;
  reviewerName: string;
  commentSummary: string;
  proposedFix: string;
  confidence: "High" | "Medium" | "Needs human judgment";
  affectedFiles: string[];
  newContent: string | null;
  skippable: boolean;
  // UI-only state
  approved: boolean;
  skipped: boolean;
  annotation: string;
}

export type WorkflowStep =
  | "pr-list"       // Selecting which PR to work on
  | "checkout"      // Checking out the branch
  | "analyzing"     // Agent reading diff + comments
  | "fix-plan"      // User reviews fix plan
  | "applying"      // Agent applies approved fixes
  | "diff-review"   // User reviews diff before commit
  | "committing"    // User enters commit message
  | "pushing"       // Pushing to origin
  | "done";         // Complete

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Stable empty-array ref so the chat-history selector returns the same
 *  reference between renders when no chat has started yet — avoids
 *  unnecessary re-renders. */
export const EMPTY_CHAT: ChatMessage[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

export function prAge(createdOn: string): string {
  const ms = Date.now() - new Date(createdOn).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

export function confidenceBadgeVariant(confidence: FixProposal["confidence"]) {
  if (confidence === "High") return "success";
  if (confidence === "Medium") return "warning";
  return "destructive";
}

export function buildFixPlanFromPartial(arr: unknown[]): FixProposal[] {
  return arr
    .filter((item): item is Record<string, unknown> =>
      item != null && typeof item === "object",
    )
    .map((item) => ({
      commentId: Number(item.commentId ?? 0),
      file: (item.file as string) ?? null,
      fromLine: item.fromLine != null ? Number(item.fromLine) : null,
      toLine: item.toLine != null ? Number(item.toLine) : null,
      reviewerName: String(item.reviewerName ?? "Reviewer"),
      commentSummary: String(item.commentSummary ?? ""),
      proposedFix: String(item.proposedFix ?? ""),
      confidence: (item.confidence as FixProposal["confidence"]) ?? "Medium",
      affectedFiles: Array.isArray(item.affectedFiles)
        ? (item.affectedFiles as string[])
        : item.file ? [item.file as string] : [],
      newContent: (item.newContent as string) ?? null,
      skippable: Boolean(item.skippable),
      approved: (item.confidence as string) !== "Needs human judgment",
      skipped: false,
      annotation: "",
    }));
}

export function parseFixPlan(raw: string): FixProposal[] {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const arr = JSON.parse(cleaned);
    if (!Array.isArray(arr)) return [];
    return arr.map((item: Record<string, unknown>) => ({
      commentId: Number(item.commentId ?? 0),
      file: (item.file as string) ?? null,
      fromLine: item.fromLine != null ? Number(item.fromLine) : null,
      toLine: item.toLine != null ? Number(item.toLine) : null,
      reviewerName: String(item.reviewerName ?? "Reviewer"),
      commentSummary: String(item.commentSummary ?? ""),
      proposedFix: String(item.proposedFix ?? ""),
      confidence: (item.confidence as FixProposal["confidence"]) ?? "Medium",
      affectedFiles: Array.isArray(item.affectedFiles)
        ? (item.affectedFiles as string[])
        : item.file ? [item.file as string] : [],
      newContent: (item.newContent as string) ?? null,
      skippable: Boolean(item.skippable),
      approved: (item.confidence as string) !== "Needs human judgment",
      skipped: false,
      annotation: "",
    }));
  } catch {
    return [];
  }
}
