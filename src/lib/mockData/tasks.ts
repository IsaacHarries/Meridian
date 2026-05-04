import { type BitbucketTask } from "@/lib/tauri/bitbucket";

// ── PR tasks ──────────────────────────────────────────────────────────────────
// Map of PR id → tasks. The Sprint Dashboard's "Ready for QA" list fetches
// tasks for any PR with 2+ approvals; tasks only block promotion if they're
// unresolved AND not in EXEMPT_TASK_PREFIXES ("qa review", "design review").
export const PR_TASKS_BY_ID: Record<number, BitbucketTask[]> = {
  90: [
    { id: 9001, content: "Add reconnect backoff jitter", resolved: true, commentId: null },
    { id: 9002, content: "QA review: smoke test on Safari iOS", resolved: false, commentId: null },
  ],
  91: [
    { id: 9101, content: "Design review: confirm cache TTL with product", resolved: false, commentId: null },
  ],
};
