// ── Mock data for development / demo without JIRA or Bitbucket access ────────
// Claude / agent calls use the real API unless Mock AI responses is on (see Settings).

import type {
  JiraSprint,
  JiraIssue,
  JiraUser,
  BitbucketPr,
  BitbucketUser,
  BitbucketComment,
} from "./tauri";

// ── Users ─────────────────────────────────────────────────────────────────────

export const ME: JiraUser = {
  accountId: "user-1",
  displayName: "Isaac Chen",
  emailAddress: "isaac@example.com",
};

const ALICE: JiraUser = {
  accountId: "user-2",
  displayName: "Alice Park",
  emailAddress: "alice@example.com",
};

const BOB: JiraUser = {
  accountId: "user-3",
  displayName: "Bob Reyes",
  emailAddress: "bob@example.com",
};

const CAROL: JiraUser = {
  accountId: "user-4",
  displayName: "Carol Nguyen",
  emailAddress: "carol@example.com",
};

const DAN: JiraUser = {
  accountId: "user-5",
  displayName: "Dan Kowalski",
  emailAddress: "dan@example.com",
};

// ── Active sprint ─────────────────────────────────────────────────────────────

export const ACTIVE_SPRINT: JiraSprint = {
  id: 23,
  name: "Sprint 23 — Q2 Feature Push",
  state: "active",
  startDate: "2026-03-31T09:00:00.000Z",
  endDate: "2026-04-14T17:00:00.000Z",
  goal: "Deliver user settings overhaul, fix search pagination, and land the file upload validation hardening.",
};

// ── Issues ────────────────────────────────────────────────────────────────────

const makeIssue = (
  key: string,
  summary: string,
  status: string,
  statusCategory: string,
  assignee: JiraUser | null,
  storyPoints: number | null,
  issueType: string,
  priority: string,
  description: string | null,
  labels: string[] = [],
  epicKey: string | null = null,
  epicSummary: string | null = null
): JiraIssue => ({
  id: key.replace("-", ""),
  key,
  url: `https://example.atlassian.net/browse/${key}`,
  summary,
  description,
  descriptionSections: [],
  status,
  statusCategory,
  assignee,
  reporter: ME,
  issueType,
  priority,
  storyPoints,
  labels,
  epicKey,
  epicSummary,
  created: "2026-03-28T10:00:00.000Z",
  updated: "2026-04-09T15:30:00.000Z",
  acceptanceCriteria: null,
  stepsToReproduce: null,
  observedBehavior: null,
  expectedBehavior: null,
  namedFields: {},
  discoveredFieldIds: {},
});

// ── Demo tickets for testing the Implement a Ticket pipeline from a blank worktree ──
//
// DEMO-1: Small program — comprehensive enough to exercise every pipeline stage.
//   A TypeScript CLI that generates a linked table of contents from a markdown file.
//   ~4 files, clear AC, real edge cases, good fit for a single sitting end-to-end run.
//
// DEMO-2: Medium program — stress-tests the pipeline with more files and complexity.
//   A Node.js/TypeScript in-memory REST API for managing tasks with CRUD + filtering.
//   ~10 files, multiple layers (routes, services, models, middleware, tests).

export const DEMO_ISSUE_1: JiraIssue = {
  id: "DEMO1",
  key: "DEMO-1",
  url: "https://example.atlassian.net/browse/DEMO-1",
  summary: "CLI tool: generate a linked table of contents from a markdown file",
  description: null,
  descriptionSections: [
    {
      heading: "Overview",
      content:
        "Build a small TypeScript CLI tool (`md-toc`) that reads a markdown file and outputs a linked table of contents. " +
        "The tool is invoked as `npx ts-node src/cli.ts <file.md>` (or compiled to `dist/cli.js`). " +
        "It scans the file for ATX-style headings (`# h1`, `## h2`, `### h3`) and prints a nested markdown list " +
        "where each item links to the corresponding anchor. The tool must also support an `--in-place` flag that " +
        "rewrites the source file, replacing any existing `<!-- TOC -->…<!-- /TOC -->` block with the fresh TOC.\n\n" +
        "This is a greenfield project — the worktree directory is empty. You will need to create all files from scratch.",
    },
    {
      heading: "Acceptance Criteria",
      content:
        "- Running `ts-node src/cli.ts <file>` prints the TOC to stdout\n" +
        "- Each TOC entry is an indented markdown list item: `- [Heading Text](#anchor-slug)` (h2 indented 2 spaces, h3 indented 4)\n" +
        "- Anchor slugs are lowercase, spaces replaced by hyphens, all non-alphanumeric chars (except hyphens) removed\n" +
        "- Headings deeper than h3 are ignored\n" +
        "- If the input file does not exist, exit with code 1 and print an error to stderr\n" +
        "- If no headings are found, output exactly `<!-- No headings found -->`\n" +
        "- `--in-place` flag rewrites the file: replaces a `<!-- TOC -->…<!-- /TOC -->` block if present, " +
        "or inserts one immediately after the first heading if no block exists\n" +
        "- A `package.json` with `ts-node` and `typescript` as devDependencies is included\n" +
        "- A `tsconfig.json` targeting Node 18 is included\n" +
        "- Unit tests (using Node's built-in `node:test` module) cover: slug generation, heading parsing, " +
        "TOC formatting, missing-file error, no-headings output, and in-place rewrite",
    },
    {
      heading: "Technical Notes",
      content:
        "Keep dependencies minimal — `ts-node`, `typescript`, and nothing else (no external markdown parsers). " +
        "Parse headings with a single regex pass. The slug function should match GitHub's anchor algorithm. " +
        "Structure: `src/cli.ts` (entry point + arg parsing), `src/parser.ts` (heading extraction + slug), " +
        "`src/toc.ts` (TOC string assembly + in-place rewrite), `tests/parser.test.ts`, `tests/toc.test.ts`.",
    },
  ],
  status: "To Do",
  statusCategory: "new",
  assignee: ME,
  reporter: ME,
  issueType: "Story",
  priority: "Medium",
  storyPoints: 5,
  labels: ["demo", "greenfield", "cli"],
  epicKey: null,
  epicSummary: null,
  created: "2026-04-14T09:00:00.000Z",
  updated: "2026-04-14T09:00:00.000Z",
  acceptanceCriteria:
    "- Running `ts-node src/cli.ts <file>` prints the TOC to stdout\n" +
    "- Each entry is an indented markdown list item with anchor link\n" +
    "- Anchor slugs: lowercase, spaces → hyphens, non-alphanumeric stripped\n" +
    "- Headings deeper than h3 are ignored\n" +
    "- Non-existent file → exit 1, error to stderr\n" +
    "- No headings found → output `<!-- No headings found -->`\n" +
    "- `--in-place` flag rewrites the file with a `<!-- TOC -->…<!-- /TOC -->` block\n" +
    "- `package.json`, `tsconfig.json`, and unit tests (node:test) are included",
  stepsToReproduce: null,
  observedBehavior: null,
  expectedBehavior: null,
  namedFields: {},
  discoveredFieldIds: {},
};

export const DEMO_ISSUE_2: JiraIssue = {
  id: "DEMO2",
  key: "DEMO-2",
  url: "https://example.atlassian.net/browse/DEMO-2",
  summary: "REST API: in-memory task tracker with CRUD, filtering, and pagination",
  description: null,
  descriptionSections: [
    {
      heading: "Overview",
      content:
        "Build a standalone Node.js/TypeScript REST API server for managing tasks. " +
        "The server runs on port 3000 and exposes a `/tasks` resource. It uses an in-memory store " +
        "(no database — a plain Map or array) so the project is fully self-contained and runnable from a blank worktree. " +
        "The API must follow REST conventions, return JSON, and handle all error cases gracefully.\n\n" +
        "This is a greenfield project — the worktree directory is empty. Create all files from scratch.",
    },
    {
      heading: "Acceptance Criteria",
      content:
        "**Endpoints**\n" +
        "- `POST /tasks` — create a task; body: `{ title: string, description?: string, priority?: 'low'|'medium'|'high', tags?: string[] }`\n" +
        "- `GET /tasks` — list tasks with optional query params: `status`, `priority`, `tag`, `page` (1-based), `limit` (default 20, max 100)\n" +
        "- `GET /tasks/:id` — fetch single task by UUID\n" +
        "- `PATCH /tasks/:id` — partial update (any subset of writable fields)\n" +
        "- `DELETE /tasks/:id` — delete task; return 204\n" +
        "- `POST /tasks/:id/complete` — mark task complete; sets `completedAt` timestamp\n\n" +
        "**Task schema**\n" +
        "- `id`: UUID v4 (generated on create)\n" +
        "- `title`: required string (1–200 chars)\n" +
        "- `description`: optional string\n" +
        "- `priority`: `'low' | 'medium' | 'high'` (default `'medium'`)\n" +
        "- `status`: `'todo' | 'in_progress' | 'done'` (default `'todo'`)\n" +
        "- `tags`: string array (default `[]`)\n" +
        "- `createdAt`, `updatedAt`: ISO 8601 timestamps (auto-managed)\n" +
        "- `completedAt`: ISO 8601 timestamp or `null`\n\n" +
        "**Validation & errors**\n" +
        "- Missing/invalid `title` on create → 400 with `{ error: string, field: 'title' }`\n" +
        "- Invalid `priority` or `status` values → 400 with descriptive message\n" +
        "- Unknown task ID → 404 with `{ error: 'Task not found' }`\n" +
        "- All 5xx errors return `{ error: 'Internal server error' }` (never expose stack traces)\n\n" +
        "**Pagination**\n" +
        "- Response envelope: `{ data: Task[], total: number, page: number, limit: number, totalPages: number }`\n" +
        "- Out-of-range page returns empty `data` array (not 404)\n\n" +
        "**Project structure**\n" +
        "- `package.json` with `express`, `uuid` as dependencies; `typescript`, `@types/express`, `@types/node`, `ts-node` as devDependencies\n" +
        "- `tsconfig.json` targeting Node 18\n" +
        "- `src/server.ts` — Express app setup and `listen()`\n" +
        "- `src/app.ts` — Express app factory (exported without `listen` for testing)\n" +
        "- `src/routes/tasks.ts` — route handlers\n" +
        "- `src/services/taskService.ts` — business logic and in-memory store\n" +
        "- `src/models/task.ts` — TypeScript interfaces and type guards\n" +
        "- `src/middleware/errorHandler.ts` — centralised error handler\n" +
        "- `src/middleware/validateTask.ts` — request body validation\n" +
        "- `tests/tasks.test.ts` — integration tests using Node's built-in `node:test` + `fetch`\n\n" +
        "**Tests must cover**\n" +
        "- Create task (valid and invalid inputs)\n" +
        "- List with each filter type and pagination\n" +
        "- Get single task (found and not found)\n" +
        "- Update and complete task\n" +
        "- Delete task\n" +
        "- Error response shape consistency",
    },
    {
      heading: "Technical Notes",
      content:
        "Use Express 4.x. For UUID generation use the `uuid` npm package (v4 only). " +
        "The in-memory store should be a `Map<string, Task>` in `taskService.ts`. " +
        "Do not add authentication, rate limiting, or persistence — keep scope tight. " +
        "The app factory pattern (`app.ts` vs `server.ts`) is required so integration tests can " +
        "import the app without starting a listener. " +
        "Tests use `node:test` with the built-in test runner (`node --test`) — no Jest or Mocha.",
    },
    {
      heading: "Out of Scope",
      content:
        "- Authentication or authorisation\n" +
        "- Database persistence\n" +
        "- WebSocket or streaming endpoints\n" +
        "- Rate limiting\n" +
        "- File uploads",
    },
  ],
  status: "To Do",
  statusCategory: "new",
  assignee: ME,
  reporter: ME,
  issueType: "Story",
  priority: "High",
  storyPoints: 8,
  labels: ["demo", "greenfield", "api", "stress-test"],
  epicKey: null,
  epicSummary: null,
  created: "2026-04-14T09:00:00.000Z",
  updated: "2026-04-14T09:00:00.000Z",
  acceptanceCriteria:
    "- POST /tasks creates a task with UUID, timestamps, and defaults\n" +
    "- GET /tasks supports filtering by status, priority, tag + pagination\n" +
    "- GET /tasks/:id returns 404 for unknown IDs\n" +
    "- PATCH /tasks/:id performs partial updates\n" +
    "- DELETE /tasks/:id returns 204\n" +
    "- POST /tasks/:id/complete sets completedAt and status=done\n" +
    "- All validation errors return 400 with descriptive message\n" +
    "- Response envelope includes total, page, limit, totalPages\n" +
    "- package.json, tsconfig.json, and integration tests (node:test) included\n" +
    "- App factory pattern: app.ts (no listen) + server.ts (entry point)",
  stepsToReproduce: null,
  observedBehavior: null,
  expectedBehavior: null,
  namedFields: {},
  discoveredFieldIds: {},
};

export const MY_SPRINT_ISSUES: JiraIssue[] = [
  // Demo tickets — appear first so they're easy to find during pipeline testing
  DEMO_ISSUE_1,
  DEMO_ISSUE_2,
  makeIssue(
    "PROJ-142",
    "Add dark mode and accent colour support to user settings",
    "In Progress",
    "indeterminate",
    ME,
    5,
    "Story",
    "Medium",
    `h2. Overview
Allow users to switch between light and dark mode, and choose an accent colour from a preset palette.

h2. Acceptance Criteria
- User can toggle light / dark / system mode from the Settings screen
- Six accent colour presets are available (slate, blue, violet, green, orange, rose)
- Selection is persisted across app restarts
- Theme applies immediately without page reload
- Settings screen shows a live preview of the selected theme

h2. Technical Notes
Apply via CSS variables on the root element. Use localStorage for persistence.`,
    ["frontend", "ux"],
    "PROJ-130",
    "Settings Overhaul"
  ),
  makeIssue(
    "PROJ-145",
    "Fix pagination bug: search results skip page 2 under high load",
    "To Do",
    "new",
    ME,
    3,
    "Bug",
    "High",
    `h2. Bug Report
When the search index has >1000 results, navigating to page 2 returns page 1 results again. Reproducible consistently in staging with the full dataset loaded.

h2. Root Cause (suspected)
The offset parameter is not being passed correctly to the search backend when results are cached. The cache key ignores the offset.

h2. Acceptance Criteria
- Page 2 through N all return the correct, distinct result sets
- Regression test covers paginated search with >1000 results
- Fix does not degrade search performance`,
    ["bug", "search"],
    null,
    null
  ),
  makeIssue(
    "PROJ-148",
    "Implement file upload size and MIME type validation",
    "In Review",
    "indeterminate",
    ME,
    2,
    "Story",
    "High",
    `h2. Overview
Validate file uploads on both frontend and backend before accepting them. Currently any file type and size is accepted.

h2. Acceptance Criteria
- Maximum file size: 10MB (configurable via env var)
- Allowed MIME types: image/png, image/jpeg, image/gif, application/pdf
- Frontend shows a clear error message for invalid files before upload starts
- Backend rejects invalid files with HTTP 422 and a descriptive error body
- Validation logic is unit-tested independently of the upload handler

h2. Security Note
Do not rely solely on the Content-Type header — validate the magic bytes.`,
    ["security", "uploads"],
    "PROJ-140",
    "File Handling Hardening"
  ),
];

const ALL_SPRINT_ISSUES: JiraIssue[] = [
  ...MY_SPRINT_ISSUES,
  makeIssue(
    "PROJ-141",
    "Migrate authentication middleware to JWT RS256",
    "Done",
    "done",
    ALICE,
    8,
    "Story",
    "High",
    `Migrate from HS256 symmetric signing to RS256 asymmetric signing. Public key served via JWKS endpoint.`,
    ["security", "auth"],
    "PROJ-139",
    "Auth Hardening"
  ),
  makeIssue(
    "PROJ-143",
    "Add rate limiting to public API endpoints",
    "In Review",
    "indeterminate",
    ALICE,
    5,
    "Story",
    "Medium",
    `Apply per-IP and per-user rate limiting using a sliding window algorithm. Expose X-RateLimit headers.`,
    ["security", "api"],
    "PROJ-139",
    "Auth Hardening"
  ),
  makeIssue(
    "PROJ-144",
    "Refactor database connection pool configuration",
    "Done",
    "done",
    BOB,
    3,
    "Task",
    "Low",
    `Pool size, idle timeout, and max lifetime are currently hardcoded. Move to environment-variable config with sensible defaults.`,
    ["infra"],
    null,
    null
  ),
  makeIssue(
    "PROJ-146",
    "Write integration tests for the billing webhook handler",
    "In Progress",
    "indeterminate",
    BOB,
    5,
    "Story",
    "Medium",
    `The billing webhook has no integration tests. Cover: successful payment, failed payment, refund, and replay attack scenarios.`,
    ["testing"],
    "PROJ-138",
    "Billing Reliability"
  ),
  makeIssue(
    "PROJ-147",
    "Dashboard: add weekly active user chart",
    "To Do",
    "new",
    CAROL,
    3,
    "Story",
    "Low",
    `Add a WAU time-series chart to the admin dashboard. Data is already available in the analytics DB.`,
    ["frontend", "analytics"],
    null,
    null
  ),
  makeIssue(
    "PROJ-149",
    "BLOCKED: Upgrade third-party OAuth provider SDK",
    "In Progress",
    "indeterminate",
    CAROL,
    5,
    "Story",
    "High",
    `The OAuth provider deprecated the v2 SDK. We must upgrade to v3 before June 1st or lose SSO functionality. Blocked on provider's migration guide (pending).`,
    ["blocked", "auth"],
    "PROJ-139",
    "Auth Hardening"
  ),
  makeIssue(
    "PROJ-150",
    "Set up staging environment smoke tests in CI",
    "To Do",
    "new",
    DAN,
    3,
    "Task",
    "Medium",
    `After each staging deploy, run a suite of smoke tests that hit real endpoints. Fail the pipeline if critical paths are down.`,
    ["infra", "ci"],
    null,
    null
  ),
  makeIssue(
    "PROJ-151",
    "Improve error messages for form validation failures",
    "Done",
    "done",
    DAN,
    2,
    "Story",
    "Low",
    `Current validation errors show generic "Invalid input" messages. Replace with field-specific messages matching the validation rule that failed.`,
    ["frontend", "ux"],
    null,
    null
  ),
];

// ── Completed sprints ─────────────────────────────────────────────────────────

export const COMPLETED_SPRINTS: JiraSprint[] = [
  {
    id: 22,
    name: "Sprint 22 — Auth & Stability",
    state: "closed",
    startDate: "2026-03-17T09:00:00.000Z",
    endDate: "2026-03-30T17:00:00.000Z",
    goal: "Complete auth hardening track and improve test coverage across billing.",
  },
  {
    id: 21,
    name: "Sprint 21 — Search Overhaul",
    state: "closed",
    startDate: "2026-03-03T09:00:00.000Z",
    endDate: "2026-03-16T17:00:00.000Z",
    goal: "Ship rewritten search service with relevance scoring.",
  },
  {
    id: 20,
    name: "Sprint 20 — Performance",
    state: "closed",
    startDate: "2026-02-17T09:00:00.000Z",
    endDate: "2026-03-02T17:00:00.000Z",
    goal: "Cut p95 API latency by 30%. Database query optimisation.",
  },
  {
    id: 19,
    name: "Sprint 19 — Onboarding",
    state: "closed",
    startDate: "2026-02-03T09:00:00.000Z",
    endDate: "2026-02-16T17:00:00.000Z",
    goal: "New user onboarding flow with guided setup wizard.",
  },
  {
    id: 18,
    name: "Sprint 18 — API v2",
    state: "closed",
    startDate: "2026-01-20T09:00:00.000Z",
    endDate: "2026-02-02T17:00:00.000Z",
    goal: "Launch public API v2 with versioning and deprecation headers.",
  },
];

const makeSprintIssues = (
  sprintId: number,
  done: number,
  total: number
): JiraIssue[] => {
  const statuses = ["Done", "Done", "In Progress", "To Do"];
  return Array.from({ length: total }, (_, i) => {
    const isDone = i < done;
    return makeIssue(
      `PROJ-${100 + sprintId * 10 + i}`,
      `Sprint ${sprintId} task ${i + 1}`,
      isDone ? "Done" : statuses[i % statuses.length],
      isDone ? "done" : "indeterminate",
      [ME, ALICE, BOB, CAROL, DAN][i % 5],
      [2, 3, 5, 8, 3, 2, 5][i % 7],
      "Story",
      "Medium",
      null
    );
  });
};

export const SPRINT_ISSUES_BY_ID: Record<number, JiraIssue[]> = {
  23: ALL_SPRINT_ISSUES,
  22: makeSprintIssues(22, 9, 11),
  21: makeSprintIssues(21, 8, 10),
  20: makeSprintIssues(20, 10, 12),
  19: makeSprintIssues(19, 7, 10),
  18: makeSprintIssues(18, 9, 10),
};

// ── Bitbucket users ───────────────────────────────────────────────────────────

const makeBbUser = (displayName: string, nickname: string): BitbucketUser => ({
  displayName,
  nickname,
  accountId: null,
});

const BB_ME = makeBbUser("Isaac Chen", "isaac.chen");
const BB_ALICE = makeBbUser("Alice Park", "alice.park");
const BB_BOB = makeBbUser("Bob Reyes", "bob.reyes");
const BB_CAROL = makeBbUser("Carol Nguyen", "carol.nguyen");

// ── Pull requests ─────────────────────────────────────────────────────────────

export const OPEN_PRS: BitbucketPr[] = [
  {
    id: 87,
    title: "PROJ-143: Add sliding-window rate limiting to public API endpoints",
    description: `## Summary
Implements per-IP and per-user rate limiting using a Redis-backed sliding window algorithm.

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
];

export const MERGED_PRS: BitbucketPr[] = [
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

// ── PR comments ───────────────────────────────────────────────────────────────

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
      "Should the rate limit key include the user ID for authenticated requests, not just the IP? An IP could be shared by a whole office behind NAT.",
    author: BB_ME,
    createdOn: "2026-04-09T09:45:00.000Z",
    updatedOn: "2026-04-09T09:45:00.000Z",
    inline: { path: "src/routes/api.rs", fromLine: 22, toLine: 22 },
    parentId: null,
  },
];

// ── Individual issue lookup ───────────────────────────────────────────────────

export const ALL_ISSUES_BY_KEY: Record<string, JiraIssue> = {
  ...Object.fromEntries(ALL_SPRINT_ISSUES.map((i) => [i.key, i])),
  // Demo issues are in MY_SPRINT_ISSUES (which is part of ALL_SPRINT_ISSUES)
  // but also registered here explicitly so getIssue("DEMO-1") always works
  // even if the sprint lookup changes.
  [DEMO_ISSUE_1.key]: DEMO_ISSUE_1,
  [DEMO_ISSUE_2.key]: DEMO_ISSUE_2,
};
