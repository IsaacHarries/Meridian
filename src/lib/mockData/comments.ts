// ── PR comments ───────────────────────────────────────────────────────────────
import { type BitbucketComment } from "@/lib/tauri/bitbucket";
import { BB_ALICE, BB_BOB, BB_ME } from "./users";

export const PR_87_COMMENTS: BitbucketComment[] = [
  {
    id: 1001,
    content:
      "The `fail open on Redis errors` behaviour on line 40 of api.rs concerns me. If Redis goes down, rate limiting silently stops working. Should we at least log a warning?",
    author: BB_BOB,
    createdOn: "2026-04-08T09:15:00.000Z",
    updatedOn: "2026-04-08T09:15:00.000Z",
    inline: { path: "src/routes/api.rs", fromLine: 40, toLine: 40 },
    parentId: null,
  },
  {
    id: 1002,
    content:
      "Good point. I'll add a `tracing::warn!` there. The fail-open is intentional (don't block users if our infra blips) but we should definitely emit a metric.",
    author: BB_ALICE,
    createdOn: "2026-04-08T10:30:00.000Z",
    updatedOn: "2026-04-08T10:30:00.000Z",
    inline: null,
    parentId: 1001,
  },
  {
    id: 1003,
    content:
      "Should the rate limit key include the user ID for authenticated requests, not just the IP? An IP could be shared by a whole office behind NAT.\n\n" +
      "Quick sketch of the scenario I'm worried about — twelve users sharing one egress IP all hitting the limit together:\n\n" +
      "![Office NAT scenario](https://placehold.co/520x180/1f2937/93c5fd?text=12+users+%E2%86%92+1+IP+%E2%86%92+rate+limited)",
    author: BB_ME,
    createdOn: "2026-04-09T09:45:00.000Z",
    updatedOn: "2026-04-09T09:45:00.000Z",
    inline: { path: "src/routes/api.rs", fromLine: 22, toLine: 22 },
    parentId: null,
  },
];
