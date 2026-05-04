// ── Pull requests ─────────────────────────────────────────────────────────────
import { type BitbucketPr, type BitbucketUser } from "@/lib/tauri/bitbucket";
import { BB_ALICE, BB_BOB, BB_CAROL, BB_ME } from "./users";

/**
 * Compact builder for a merged/declined PR tied to a completed sprint. Keeps
 * per-PR mock entries readable by letting us specify only what varies — the
 * cycle (updatedOn = createdOn + cycleHours) and other ceremony are derived.
 */
function makeSprintPr(args: {
  id: number;
  title: string;
  author: BitbucketUser;
  reviewer: BitbucketUser;
  createdOn: string;
  cycleHours: number;
  commentCount: number;
  jiraIssueKey: string;
  state?: "MERGED" | "DECLINED";
}): BitbucketPr {
  const state = args.state ?? "MERGED";
  const created = new Date(args.createdOn);
  const updated = new Date(created.getTime() + args.cycleHours * 3_600_000);
  const branchSlug = args.jiraIssueKey.toLowerCase();
  return {
    id: args.id,
    title: `${args.jiraIssueKey}: ${args.title}`,
    description: args.title + ".",
    state,
    author: args.author,
    reviewers: [
      {
        user: args.reviewer,
        approved: state === "MERGED",
        state: state === "MERGED" ? "approved" : "unapproved",
      },
    ],
    sourceBranch: `feature/${branchSlug}`,
    destinationBranch: "main",
    createdOn: created.toISOString(),
    updatedOn: updated.toISOString(),
    commentCount: args.commentCount,
    taskCount: 0,
    url: `https://bitbucket.org/example/repo/pull-requests/${args.id}`,
    jiraIssueKey: args.jiraIssueKey,
    changesRequested: false,
    draft: false,
  };
}

export const OPEN_PRS: BitbucketPr[] = [
  {
    id: 87,
    title: "PROJ-143: Add sliding-window rate limiting to public API endpoints",
    description: `## Summary
Implements per-IP and per-user rate limiting using a Redis-backed sliding window algorithm.

## Before / After

Latency under load before the change:

![p99 before](https://placehold.co/640x240/1f2937/f87171?text=p99%3A+1.8s+%E2%80%94+spikes+at+overload)

After the change, p99 stays flat as load climbs:

![p99 after](https://placehold.co/640x240/1f2937/4ade80?text=p99%3A+220ms+%E2%80%94+steady)

## Changes
- New \`RateLimiter\` middleware in \`src/middleware/rate_limit.rs\`
- Configurable limits via environment variables (\`RATE_LIMIT_REQUESTS\`, \`RATE_LIMIT_WINDOW_SECS\`)
- \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\`, \`X-RateLimit-Reset\` response headers
- Unit tests for the sliding window logic
- Integration test hitting the API at the limit threshold

## Testing
Ran the integration test suite locally. All passing.`,
    state: "OPEN",
    author: BB_ALICE,
    reviewers: [
      { user: BB_ME, approved: false, state: "unapproved" },
      { user: BB_BOB, approved: false, state: "unapproved" },
    ],
    sourceBranch: "feature/PROJ-143-rate-limiting",
    destinationBranch: "main",
    createdOn: "2026-04-07T11:20:00.000Z",
    updatedOn: "2026-04-09T09:45:00.000Z",
    commentCount: 3,
    taskCount: 1,
    url: "https://bitbucket.org/example/repo/pull-requests/87",
    jiraIssueKey: "PROJ-143",
    changesRequested: false,
    draft: false,
  },
  {
    id: 88,
    title: "PROJ-146: Integration tests for billing webhook handler",
    description: `## Summary
Adds integration test coverage for all billing webhook event types.

## Test scenarios covered
- \`payment.succeeded\` — happy path, balance credited
- \`payment.failed\` — user notified, subscription paused
- \`payment.refunded\` — balance adjustment, email triggered
- Replay attack — duplicate event_id rejected with 200 (idempotency)

## Notes
Uses a test double for the payment provider's webhook signature verification.`,
    state: "OPEN",
    author: BB_BOB,
    reviewers: [
      { user: BB_ME, approved: false, state: "unapproved" },
    ],
    sourceBranch: "feature/PROJ-146-billing-webhook-tests",
    destinationBranch: "main",
    createdOn: "2026-04-08T14:00:00.000Z",
    updatedOn: "2026-04-09T16:10:00.000Z",
    commentCount: 1,
    taskCount: 0,
    url: "https://bitbucket.org/example/repo/pull-requests/88",
    jiraIssueKey: "PROJ-146",
    changesRequested: false,
    draft: false,
  },
  {
    id: 89,
    title: "PROJ-148: File upload size and MIME type validation",
    description: `## Summary
Validates uploaded files on both frontend (before upload) and backend (before processing).

## UI

Inline error state when the user picks a file that's too large:

![Upload validation UI](https://placehold.co/720x320/1f2937/fbbf24?text=%E2%9A%A0+File+exceeds+10+MB+limit)

## Changes
- Frontend: validates size and MIME type, shows inline error
- Backend: validates magic bytes (not just Content-Type header), returns HTTP 422 on rejection
- Max size: 10MB (configurable via \`MAX_UPLOAD_BYTES\`)
- Allowed types: image/png, image/jpeg, image/gif, application/pdf
- Unit tests for magic byte validator`,
    state: "OPEN",
    author: BB_ME,
    reviewers: [
      { user: BB_ALICE, approved: false, state: "unapproved" },
      { user: BB_CAROL, approved: false, state: "unapproved" },
    ],
    sourceBranch: "feature/PROJ-148-upload-validation",
    destinationBranch: "main",
    createdOn: "2026-04-09T09:00:00.000Z",
    updatedOn: "2026-04-09T17:00:00.000Z",
    commentCount: 0,
    taskCount: 0,
    url: "https://bitbucket.org/example/repo/pull-requests/89",
    jiraIssueKey: "PROJ-148",
    changesRequested: false,
    draft: false,
  },
  // ── Ready for QA: 2+ approvals, no changes requested, tasks resolved/empty.
  // Recent dates so classifyPr → "good" (won't show up in PR Attention).
  {
    id: 90,
    title: "PROJ-152: WebSocket notification channel with polling fallback",
    description: `## Summary
Adds a WebSocket server on \`/ws/notifications\` for logged-in clients. Falls back to 30s polling when the socket can't be established.`,
    state: "OPEN",
    author: BB_ALICE,
    reviewers: [
      { user: BB_ME, approved: true, state: "approved" },
      { user: BB_BOB, approved: true, state: "approved" },
    ],
    sourceBranch: "feature/PROJ-152-websockets",
    destinationBranch: "main",
    createdOn: "2026-04-22T10:00:00.000Z",
    updatedOn: "2026-04-24T08:15:00.000Z",
    commentCount: 4,
    taskCount: 2,
    url: "https://bitbucket.org/example/repo/pull-requests/90",
    jiraIssueKey: "PROJ-152",
    changesRequested: false,
    draft: false,
  },
  {
    id: 91,
    title: "PROJ-153: Redis-backed user profile cache",
    description: `## Summary
Caches profile lookups in Redis with a 10-minute TTL. Invalidates on PATCH /users/:id.`,
    state: "OPEN",
    author: BB_BOB,
    reviewers: [
      { user: BB_ME, approved: true, state: "approved" },
      { user: BB_ALICE, approved: true, state: "approved" },
    ],
    sourceBranch: "feature/PROJ-153-profile-cache",
    destinationBranch: "main",
    createdOn: "2026-04-23T09:00:00.000Z",
    updatedOn: "2026-04-24T09:30:00.000Z",
    commentCount: 2,
    taskCount: 1,
    url: "https://bitbucket.org/example/repo/pull-requests/91",
    jiraIssueKey: "PROJ-153",
    changesRequested: false,
    draft: false,
  },
];

export const MERGED_PRS: BitbucketPr[] = [
  // ── Sprint 18 (Jan 20 – Feb 2) — API v2 ───────────────────────────────────
  makeSprintPr({ id: 200, title: "Route versioning middleware", author: BB_ALICE, reviewer: BB_ME, createdOn: "2026-01-20T10:00:00.000Z", cycleHours: 96, commentCount: 9, jiraIssueKey: "PROJ-280" }),
  makeSprintPr({ id: 201, title: "Deprecation headers on v1 routes", author: BB_BOB, reviewer: BB_ALICE, createdOn: "2026-01-21T14:00:00.000Z", cycleHours: 48, commentCount: 4, jiraIssueKey: "PROJ-281" }),
  makeSprintPr({ id: 202, title: "Add /v2/users endpoints", author: BB_CAROL, reviewer: BB_ME, createdOn: "2026-01-22T09:00:00.000Z", cycleHours: 120, commentCount: 7, jiraIssueKey: "PROJ-282" }),
  makeSprintPr({ id: 203, title: "API key migration tooling", author: BB_ME, reviewer: BB_ALICE, createdOn: "2026-01-23T11:00:00.000Z", cycleHours: 72, commentCount: 6, jiraIssueKey: "PROJ-283" }),
  makeSprintPr({ id: 204, title: "v2 OpenAPI spec generator", author: BB_ALICE, reviewer: BB_BOB, createdOn: "2026-01-24T10:00:00.000Z", cycleHours: 144, commentCount: 12, jiraIssueKey: "PROJ-284" }),
  makeSprintPr({ id: 205, title: "Rate-limit config per API version", author: BB_BOB, reviewer: BB_CAROL, createdOn: "2026-01-28T13:00:00.000Z", cycleHours: 24, commentCount: 3, jiraIssueKey: "PROJ-285" }),
  makeSprintPr({ id: 206, title: "Docs site updates for v2", author: BB_CAROL, reviewer: BB_ME, createdOn: "2026-01-29T15:00:00.000Z", cycleHours: 48, commentCount: 2, jiraIssueKey: "PROJ-286" }),
  makeSprintPr({ id: 207, title: "Rewrite custom serializer (abandoned)", author: BB_ALICE, reviewer: BB_ME, createdOn: "2026-01-30T10:00:00.000Z", cycleHours: 24, commentCount: 5, jiraIssueKey: "PROJ-287", state: "DECLINED" }),

  // ── Sprint 19 (Feb 3 – Feb 16) — Onboarding ───────────────────────────────
  makeSprintPr({ id: 210, title: "Welcome wizard component", author: BB_ALICE, reviewer: BB_CAROL, createdOn: "2026-02-03T10:00:00.000Z", cycleHours: 72, commentCount: 5, jiraIssueKey: "PROJ-290" }),
  makeSprintPr({ id: 211, title: "Sample data seeding on signup", author: BB_BOB, reviewer: BB_ME, createdOn: "2026-02-04T12:00:00.000Z", cycleHours: 24, commentCount: 2, jiraIssueKey: "PROJ-291" }),
  makeSprintPr({ id: 212, title: "Tooltip system for guided tour", author: BB_CAROL, reviewer: BB_ALICE, createdOn: "2026-02-05T09:00:00.000Z", cycleHours: 96, commentCount: 8, jiraIssueKey: "PROJ-292" }),
  makeSprintPr({ id: 213, title: "Onboarding completion tracking", author: BB_ME, reviewer: BB_BOB, createdOn: "2026-02-09T11:00:00.000Z", cycleHours: 48, commentCount: 3, jiraIssueKey: "PROJ-293" }),
  makeSprintPr({ id: 214, title: "Skip-tour option", author: BB_ALICE, reviewer: BB_ME, createdOn: "2026-02-10T14:00:00.000Z", cycleHours: 8, commentCount: 1, jiraIssueKey: "PROJ-294" }),
  makeSprintPr({ id: 215, title: "Fix wizard step state bug", author: BB_BOB, reviewer: BB_CAROL, createdOn: "2026-02-12T10:00:00.000Z", cycleHours: 12, commentCount: 2, jiraIssueKey: "PROJ-295" }),

  // ── Sprint 20 (Feb 17 – Mar 2) — Performance ──────────────────────────────
  makeSprintPr({ id: 220, title: "Optimize user list query", author: BB_CAROL, reviewer: BB_ME, createdOn: "2026-02-17T09:00:00.000Z", cycleHours: 24, commentCount: 2, jiraIssueKey: "PROJ-300" }),
  makeSprintPr({ id: 221, title: "Add index on events.created_at", author: BB_BOB, reviewer: BB_ALICE, createdOn: "2026-02-18T13:00:00.000Z", cycleHours: 4, commentCount: 1, jiraIssueKey: "PROJ-301" }),
  makeSprintPr({ id: 222, title: "Cache user permissions", author: BB_ALICE, reviewer: BB_BOB, createdOn: "2026-02-19T10:00:00.000Z", cycleHours: 72, commentCount: 7, jiraIssueKey: "PROJ-302" }),
  makeSprintPr({ id: 223, title: "Reduce N+1 in billing", author: BB_ME, reviewer: BB_CAROL, createdOn: "2026-02-20T11:00:00.000Z", cycleHours: 48, commentCount: 5, jiraIssueKey: "PROJ-303" }),
  makeSprintPr({ id: 224, title: "Connection pool tuning", author: BB_BOB, reviewer: BB_ME, createdOn: "2026-02-23T14:00:00.000Z", cycleHours: 24, commentCount: 3, jiraIssueKey: "PROJ-304" }),
  makeSprintPr({ id: 225, title: "Batch DB writes in webhook handler", author: BB_ALICE, reviewer: BB_BOB, createdOn: "2026-02-24T10:00:00.000Z", cycleHours: 48, commentCount: 4, jiraIssueKey: "PROJ-305" }),
  makeSprintPr({ id: 226, title: "Remove sync logging in hot path", author: BB_CAROL, reviewer: BB_ALICE, createdOn: "2026-02-25T15:00:00.000Z", cycleHours: 6, commentCount: 1, jiraIssueKey: "PROJ-306" }),
  makeSprintPr({ id: 227, title: "Aggressive caching attempt (rolled back)", author: BB_ME, reviewer: BB_ALICE, createdOn: "2026-02-26T10:00:00.000Z", cycleHours: 24, commentCount: 6, jiraIssueKey: "PROJ-307", state: "DECLINED" }),

  // ── Sprint 21 (Mar 3 – Mar 16) — Search Overhaul ──────────────────────────
  makeSprintPr({ id: 230, title: "Elasticsearch client upgrade", author: BB_BOB, reviewer: BB_ME, createdOn: "2026-03-03T10:00:00.000Z", cycleHours: 96, commentCount: 6, jiraIssueKey: "PROJ-310" }),
  makeSprintPr({ id: 231, title: "Relevance scoring algorithm", author: BB_ALICE, reviewer: BB_CAROL, createdOn: "2026-03-04T11:00:00.000Z", cycleHours: 120, commentCount: 10, jiraIssueKey: "PROJ-311" }),
  makeSprintPr({ id: 232, title: "Search result highlighting", author: BB_CAROL, reviewer: BB_ME, createdOn: "2026-03-05T09:00:00.000Z", cycleHours: 48, commentCount: 2, jiraIssueKey: "PROJ-312" }),
  makeSprintPr({ id: 233, title: "Remove old search shim", author: BB_ME, reviewer: BB_ALICE, createdOn: "2026-03-09T13:00:00.000Z", cycleHours: 6, commentCount: 0, jiraIssueKey: "PROJ-313" }),
  makeSprintPr({ id: 234, title: "Fix edge case in query parser", author: BB_CAROL, reviewer: BB_BOB, createdOn: "2026-03-10T10:00:00.000Z", cycleHours: 24, commentCount: 4, jiraIssueKey: "PROJ-314" }),
  makeSprintPr({ id: 235, title: "Old search cache cleanup (abandoned)", author: BB_ALICE, reviewer: BB_ME, createdOn: "2026-03-11T14:00:00.000Z", cycleHours: 36, commentCount: 3, jiraIssueKey: "PROJ-315", state: "DECLINED" }),

  // ── Sprint 22 (Mar 17 – Mar 30) — Auth & Stability ────────────────────────
  makeSprintPr({ id: 240, title: "OAuth refresh token rotation", author: BB_ALICE, reviewer: BB_ME, createdOn: "2026-03-17T10:00:00.000Z", cycleHours: 120, commentCount: 8, jiraIssueKey: "PROJ-320" }),
  makeSprintPr({ id: 241, title: "Session timeout enforcement", author: BB_BOB, reviewer: BB_CAROL, createdOn: "2026-03-18T13:00:00.000Z", cycleHours: 48, commentCount: 3, jiraIssueKey: "PROJ-321" }),
  makeSprintPr({ id: 242, title: "Password reset email template", author: BB_CAROL, reviewer: BB_ALICE, createdOn: "2026-03-19T11:00:00.000Z", cycleHours: 24, commentCount: 1, jiraIssueKey: "PROJ-322" }),
  makeSprintPr({ id: 243, title: "Rate-limit auth endpoints", author: BB_ALICE, reviewer: BB_BOB, createdOn: "2026-03-20T10:00:00.000Z", cycleHours: 72, commentCount: 5, jiraIssueKey: "PROJ-323" }),
  makeSprintPr({ id: 244, title: "Fix race condition in login", author: BB_ME, reviewer: BB_ALICE, createdOn: "2026-03-23T09:00:00.000Z", cycleHours: 18, commentCount: 2, jiraIssueKey: "PROJ-324" }),
  makeSprintPr({ id: 245, title: "MFA enrollment flow refactor", author: BB_BOB, reviewer: BB_ME, createdOn: "2026-03-24T10:00:00.000Z", cycleHours: 144, commentCount: 12, jiraIssueKey: "PROJ-325" }),

  // ── Active sprint (unchanged) ─────────────────────────────────────────────
  {
    id: 84,
    title: "PROJ-141: Migrate auth middleware to JWT RS256",
    description: "Migrates from HS256 to RS256 asymmetric signing.",
    state: "MERGED",
    author: BB_ALICE,
    reviewers: [{ user: BB_ME, approved: true, state: "approved" }],
    sourceBranch: "feature/PROJ-141-jwt-rs256",
    destinationBranch: "main",
    createdOn: "2026-04-01T10:00:00.000Z",
    updatedOn: "2026-04-04T14:30:00.000Z",
    commentCount: 5,
    taskCount: 0,
    url: "https://bitbucket.org/example/repo/pull-requests/84",
    jiraIssueKey: "PROJ-141",
    changesRequested: false,
    draft: false,
  },
  {
    id: 85,
    title: "PROJ-144: Refactor DB connection pool config",
    description: "Move pool config to environment variables.",
    state: "MERGED",
    author: BB_BOB,
    reviewers: [{ user: BB_CAROL, approved: true, state: "approved" }],
    sourceBranch: "chore/PROJ-144-pool-config",
    destinationBranch: "main",
    createdOn: "2026-04-03T09:00:00.000Z",
    updatedOn: "2026-04-05T11:00:00.000Z",
    commentCount: 2,
    taskCount: 0,
    url: "https://bitbucket.org/example/repo/pull-requests/85",
    jiraIssueKey: "PROJ-144",
    changesRequested: false,
    draft: false,
  },
  {
    id: 86,
    title: "PROJ-151: Improve form validation error messages",
    description: "Field-specific error messages replacing generic fallback.",
    state: "MERGED",
    author: BB_CAROL,
    reviewers: [{ user: BB_ME, approved: true, state: "approved" }],
    sourceBranch: "fix/PROJ-151-validation-messages",
    destinationBranch: "main",
    createdOn: "2026-04-04T13:00:00.000Z",
    updatedOn: "2026-04-06T10:00:00.000Z",
    commentCount: 1,
    taskCount: 0,
    url: "https://bitbucket.org/example/repo/pull-requests/86",
    jiraIssueKey: "PROJ-151",
    changesRequested: false,
    draft: false,
  },
];

// ── PR diff (realistic example for PR #87) ────────────────────────────────────

export const PR_87_DIFF = `diff --git a/src/middleware/rate_limit.rs b/src/middleware/rate_limit.rs
new file mode 100644
index 0000000..a3f9c21
--- /dev/null
+++ b/src/middleware/rate_limit.rs
@@ -0,0 +1,89 @@
+use std::time::{Duration, SystemTime, UNIX_EPOCH};
+use actix_web::{dev::ServiceRequest, Error, HttpResponse};
+use redis::AsyncCommands;
+
+const DEFAULT_LIMIT: u32 = 100;
+const DEFAULT_WINDOW_SECS: u64 = 60;
+
+pub struct RateLimiter {
+    limit: u32,
+    window: Duration,
+}
+
+impl RateLimiter {
+    pub fn new() -> Self {
+        let limit = std::env::var("RATE_LIMIT_REQUESTS")
+            .ok()
+            .and_then(|v| v.parse().ok())
+            .unwrap_or(DEFAULT_LIMIT);
+        let window_secs = std::env::var("RATE_LIMIT_WINDOW_SECS")
+            .ok()
+            .and_then(|v| v.parse().ok())
+            .unwrap_or(DEFAULT_WINDOW_SECS);
+        Self {
+            limit,
+            window: Duration::from_secs(window_secs),
+        }
+    }
+
+    pub async fn check(&self, redis: &mut redis::aio::Connection, key: &str) -> Result<RateLimitResult, Error> {
+        let now = SystemTime::now()
+            .duration_since(UNIX_EPOCH)
+            .unwrap()
+            .as_millis() as u64;
+        let window_ms = self.window.as_millis() as u64;
+        let window_start = now - window_ms;
+
+        // Remove timestamps outside the current window
+        let _: () = redis.zremrangebyscore(key, 0u64, window_start).await
+            .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
+
+        // Count requests in window
+        let count: u32 = redis.zcard(key).await
+            .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
+
+        if count >= self.limit {
+            let oldest: Option<u64> = redis.zrange_withscores(key, 0, 0).await
+                .map(|v: Vec<(String, f64)>| v.first().map(|(_, s)| *s as u64))
+                .unwrap_or(None);
+            let reset = oldest.map(|t| t + window_ms).unwrap_or(now + window_ms);
+            return Ok(RateLimitResult::Limited { reset_at: reset });
+        }
+
+        // Record this request
+        let _: () = redis.zadd(key, now.to_string(), now).await
+            .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
+        let _: () = redis.expire(key, self.window.as_secs() as usize).await
+            .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
+
+        Ok(RateLimitResult::Allowed {
+            remaining: self.limit - count - 1,
+            reset_at: now + window_ms,
+        })
+    }
+}
+
+pub enum RateLimitResult {
+    Allowed { remaining: u32, reset_at: u64 },
+    Limited { reset_at: u64 },
+}
+
+impl RateLimitResult {
+    pub fn remaining(&self) -> u32 {
+        match self { Self::Allowed { remaining, .. } => *remaining, Self::Limited { .. } => 0 }
+    }
+    pub fn reset_at(&self) -> u64 {
+        match self { Self::Allowed { reset_at, .. } | Self::Limited { reset_at, .. } => *reset_at }
+    }
+    pub fn is_limited(&self) -> bool {
+        matches!(self, Self::Limited { .. })
+    }
+}
diff --git a/src/middleware/mod.rs b/src/middleware/mod.rs
index 1b2e4f3..7d9a801 100644
--- a/src/middleware/mod.rs
+++ b/src/middleware/mod.rs
@@ -1,3 +1,4 @@
 pub mod auth;
 pub mod cors;
 pub mod logging;
+pub mod rate_limit;
diff --git a/src/routes/api.rs b/src/routes/api.rs
index 9c3f712..e84a201 100644
--- a/src/routes/api.rs
+++ b/src/routes/api.rs
@@ -1,5 +1,6 @@
 use actix_web::{web, HttpRequest, HttpResponse};
 use crate::middleware::auth::require_auth;
+use crate::middleware::rate_limit::{RateLimiter, RateLimitResult};

 pub fn configure(cfg: &mut web::ServiceConfig) {
     cfg.service(
@@ -12,6 +13,28 @@ pub fn configure(cfg: &mut web::ServiceConfig) {
 }

+pub async fn apply_rate_limit(
+    req: &HttpRequest,
+    redis: &mut redis::aio::Connection,
+    limiter: &RateLimiter,
+) -> Result<(), HttpResponse> {
+    let ip = req
+        .connection_info()
+        .realip_remote_addr()
+        .unwrap_or("unknown")
+        .to_string();
+    let key = format!("rl:{}", ip);
+    match limiter.check(redis, &key).await {
+        Ok(result) => {
+            if result.is_limited() {
+                Err(HttpResponse::TooManyRequests()
+                    .insert_header(("X-RateLimit-Reset", result.reset_at().to_string()))
+                    .finish())
+            } else {
+                Ok(())
+            }
+        }
+        Err(_) => Ok(()), // fail open on Redis errors
+    }
+}
`;
