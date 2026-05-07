// ── Issues ────────────────────────────────────────────────────────────────────
import { type JiraIssue, type JiraUser } from "@/lib/tauri/jira";
import { ALICE, BOB, CAROL, DAN, EVE, FRANK, GRACE, HENRY, ME } from "./users";

export const makeIssue = (
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
  resolutionDate: null,
  completedInSprint: null,
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
        "This is a **greenfield** project — the worktree directory is empty. You will need to create all files from scratch.",
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
    {
      heading: "Related",
      content:
        "Spec follow-up: [https://example.atlassian.net/wiki/spaces/ENG/pages/55102/Markdown+Tooling+Spec](https://example.atlassian.net/wiki/spaces/ENG/pages/55102/Markdown+Tooling+Spec)\n" +
        "GitHub anchor algorithm reference: [https://github.com/Flet/github-slugger](https://github.com/Flet/github-slugger)",
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
  resolutionDate: null,
  completedInSprint: null,
  acceptanceCriteria:
    "- Running `ts-node src/cli.ts <file>` prints the TOC to stdout\n" +
    "- Each entry is an indented markdown list item with anchor link\n" +
    "- Anchor slugs: lowercase, spaces → hyphens, non-alphanumeric stripped\n" +
    "- Headings deeper than h3 are ignored\n" +
    "- Non-existent file → exit 1, error to stderr\n" +
    "- No headings found → output `<!-- No headings found -->`\n" +
    "- `--in-place` flag rewrites the file with a `<!-- TOC -->…<!-- /TOC -->` block\n" +
    "- `package.json`, `tsconfig.json`, and unit tests (`node:test`) are included",
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
        "(no database — a plain `Map` or array) so the project is fully self-contained and runnable from a blank worktree. " +
        "The API must follow REST conventions, return JSON, and handle all error cases gracefully.\n\n" +
        "This is a **greenfield** project — the worktree directory is empty. Create all files from scratch.",
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
    {
      heading: "Related",
      content:
        "API design doc: [https://example.atlassian.net/wiki/spaces/ENG/pages/55180/Task+API+v1+Design](https://example.atlassian.net/wiki/spaces/ENG/pages/55180/Task+API+v1+Design)\n" +
        "Sibling spike on persistence options: [https://example.atlassian.net/browse/PROJ-205](https://example.atlassian.net/browse/PROJ-205)",
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
  resolutionDate: null,
  completedInSprint: null,
  acceptanceCriteria:
    "- `POST /tasks` creates a task with UUID, timestamps, and defaults\n" +
    "- `GET /tasks` supports filtering by `status`, `priority`, `tag` + pagination\n" +
    "- `GET /tasks/:id` returns 404 for unknown IDs\n" +
    "- `PATCH /tasks/:id` performs partial updates\n" +
    "- `DELETE /tasks/:id` returns 204\n" +
    "- `POST /tasks/:id/complete` sets `completedAt` and `status=done`\n" +
    "- All validation errors return 400 with descriptive message\n" +
    "- Response envelope includes `total`, `page`, `limit`, `totalPages`\n" +
    "- `package.json`, `tsconfig.json`, and integration tests (`node:test`) included\n" +
    "- App factory pattern: `app.ts` (no listen) + `server.ts` (entry point)",
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
    "In Progress",
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
Apply via CSS variables on the root element. Use localStorage for persistence.

h2. Related
Figma palette source: [https://www.figma.com/file/aB3xK9pQ/Meridian-Design-System](https://www.figma.com/file/aB3xK9pQ/Meridian-Design-System)
Theme tokens spec: [https://example.atlassian.net/wiki/spaces/DESIGN/pages/72104/Theme+Tokens+v2](https://example.atlassian.net/wiki/spaces/DESIGN/pages/72104/Theme+Tokens+v2)`,
    ["frontend", "ux"],
    "PROJ-130",
    "Settings Overhaul"
  ),
  {
    ...makeIssue(
      "PROJ-145",
      "Fix pagination bug: search results skip page 2 under high load",
      "Done",
      "Done",
      ME,
      3,
      "Bug",
      "High",
      `When the search index has >1000 results, navigating to page 2 returns page 1 results again. Reproducible consistently in staging with the full dataset loaded.

The offset parameter appears not to be passed correctly to the search backend when results are cached — the cache key ignores the offset.

Sentry issue: [https://example.sentry.io/issues/4081223/](https://example.sentry.io/issues/4081223/)
Customer ticket: [https://example.zendesk.com/agent/tickets/19432](https://example.zendesk.com/agent/tickets/19432)`,
      ["bug", "search"],
      null,
      null,
    ),
    acceptanceCriteria:
      "- Page 2 through N all return the correct, distinct result sets\n" +
      "- Regression test covers paginated search with >1000 results\n" +
      "- Fix does not degrade search baseline performance (p95 ≤ pre-fix)",
    stepsToReproduce:
      "1. Seed the staging search index with the 1,500-result fixture (`make seed-search-large`).\n" +
      "2. Navigate to `/search?q=invoice` and load page 1.\n" +
      "3. Click the page-2 pagination link.\n" +
      "4. Inspect the rendered result IDs and the `X-Search-Offset` response header.",
    observedBehavior:
      "Page 2 returns the same first-50 result IDs as page 1. `X-Search-Offset` header reads `0` despite the URL carrying `page=2`. Cache hit — server-side log shows `cache=HIT key=q:invoice` with no offset segment. Live trace: [https://example.grafana.net/explore?orgId=1&traceId=8a4b…](https://example.grafana.net/explore?orgId=1&traceId=8a4b9c2f1e7d33aa)",
    expectedBehavior:
      "Page 2 returns results 51-100 with `X-Search-Offset: 50`. Cache key includes the offset segment so each page is cached independently.",
  },
  makeIssue(
    "PROJ-148",
    "Implement file upload size and MIME type validation",
    "In Review",
    "In Progress",
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
Do not rely solely on the Content-Type header — validate the magic bytes.

h2. Related
Threat model: [https://example.atlassian.net/wiki/spaces/SEC/pages/61203/Upload+Threat+Model](https://example.atlassian.net/wiki/spaces/SEC/pages/61203/Upload+Threat+Model)
file-type library: [https://github.com/sindresorhus/file-type](https://github.com/sindresorhus/file-type)`,
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
    "Done",
    ALICE,
    8,
    "Story",
    "High",
    `Migrate from HS256 symmetric signing to RS256 asymmetric signing. Public key served via JWKS endpoint.

Related: ADR [https://example.atlassian.net/wiki/spaces/ENG/pages/48201/ADR-0014-JWT-Signing](https://example.atlassian.net/wiki/spaces/ENG/pages/48201/ADR-0014-JWT-Signing) · pairs with [https://example.atlassian.net/browse/PROJ-143](https://example.atlassian.net/browse/PROJ-143)`,
    ["security", "auth"],
    "PROJ-139",
    "Auth Hardening"
  ),
  makeIssue(
    "PROJ-143",
    "Add rate limiting to public API endpoints",
    "In Review",
    "In Progress",
    ALICE,
    5,
    "Story",
    "Medium",
    `Apply per-IP and per-user rate limiting using a sliding window algorithm. Expose X-RateLimit headers.

Related: PoC PR [https://github.com/example/api-gateway/pull/482](https://github.com/example/api-gateway/pull/482) · sliding-window write-up [https://example.atlassian.net/wiki/spaces/ENG/pages/48512/Sliding+Window+Rate+Limiting](https://example.atlassian.net/wiki/spaces/ENG/pages/48512/Sliding+Window+Rate+Limiting)`,
    ["security", "api"],
    "PROJ-139",
    "Auth Hardening"
  ),
  makeIssue(
    "PROJ-144",
    "Refactor database connection pool configuration",
    "Done",
    "Done",
    BOB,
    3,
    "Task",
    "Low",
    `Pool size, idle timeout, and max lifetime are currently hardcoded. Move to environment-variable config with sensible defaults.

Related: existing config doc [https://example.atlassian.net/wiki/spaces/ENG/pages/48933/DB+Connection+Pool](https://example.atlassian.net/wiki/spaces/ENG/pages/48933/DB+Connection+Pool)`,
    ["infra"],
    null,
    null
  ),
  makeIssue(
    "PROJ-146",
    "Write integration tests for the billing webhook handler",
    "In Progress",
    "In Progress",
    BOB,
    5,
    "Story",
    "Medium",
    `The billing webhook has no integration tests. Cover: successful payment, failed payment, refund, and replay attack scenarios.

Related: webhook spec [https://docs.stripe.com/webhooks](https://docs.stripe.com/webhooks) · last incident review [https://example.atlassian.net/wiki/spaces/ENG/pages/49120/2026-03-12+Billing+Outage](https://example.atlassian.net/wiki/spaces/ENG/pages/49120/2026-03-12+Billing+Outage)`,
    ["testing"],
    "PROJ-138",
    "Billing Reliability"
  ),
  makeIssue(
    "PROJ-147",
    "Dashboard: add weekly active user chart",
    "In Progress",
    "In Progress",
    CAROL,
    3,
    "Story",
    "Low",
    `Add a WAU time-series chart to the admin dashboard. Data is already available in the analytics DB.

Related: chart mock [https://www.figma.com/file/Mq9vT2nB/Admin-Dashboard?node-id=412-7012](https://www.figma.com/file/Mq9vT2nB/Admin-Dashboard?node-id=412-7012) · analytics schema [https://example.atlassian.net/wiki/spaces/DATA/pages/49504/WAU+Materialised+View](https://example.atlassian.net/wiki/spaces/DATA/pages/49504/WAU+Materialised+View)`,
    ["frontend", "analytics"],
    null,
    null
  ),
  makeIssue(
    "PROJ-149",
    "BLOCKED: Upgrade third-party OAuth provider SDK",
    "In Progress",
    "In Progress",
    CAROL,
    5,
    "Story",
    "High",
    `The OAuth provider deprecated the v2 SDK. We must upgrade to v3 before June 1st or lose SSO functionality. Blocked on provider's migration guide (pending).

Related: deprecation notice [https://www.oktadev.com/blog/2026/03/01/sdk-v2-deprecation](https://www.oktadev.com/blog/2026/03/01/sdk-v2-deprecation) · open vendor support ticket [https://support.okta.com/cases/00481923](https://support.okta.com/cases/00481923)`,
    ["blocked", "auth"],
    "PROJ-139",
    "Auth Hardening"
  ),
  makeIssue(
    "PROJ-150",
    "Set up staging environment smoke tests in CI",
    "In Review",
    "In Progress",
    DAN,
    3,
    "Task",
    "Medium",
    `After each staging deploy, run a suite of smoke tests that hit real endpoints. Fail the pipeline if critical paths are down.

Related: existing CI pipeline [https://example.atlassian.net/wiki/spaces/PLAT/pages/49801/CI+Pipeline](https://example.atlassian.net/wiki/spaces/PLAT/pages/49801/CI+Pipeline) · smoke harness PoC [https://github.com/example/platform/pull/611](https://github.com/example/platform/pull/611)`,
    ["infra", "ci"],
    null,
    null
  ),
  makeIssue(
    "PROJ-151",
    "Improve error messages for form validation failures",
    "Done",
    "Done",
    DAN,
    2,
    "Story",
    "Low",
    `Current validation errors show generic "Invalid input" messages. Replace with field-specific messages matching the validation rule that failed.

Related: copy guidelines [https://example.atlassian.net/wiki/spaces/DESIGN/pages/49911/Form+Error+Copy](https://example.atlassian.net/wiki/spaces/DESIGN/pages/49911/Form+Error+Copy)`,
    ["frontend", "ux"],
    null,
    null
  ),

  // ── Ready-for-QA PR targets (tickets backing PRs #90 and #91 below) ─────
  makeIssue(
    "PROJ-152",
    "Add WebSocket support for real-time notifications",
    "In Review",
    "In Progress",
    ALICE,
    5,
    "Story",
    "Medium",
    `Push notifications to connected clients via WebSocket. Fall back to polling when the socket is unavailable.

Related: realtime architecture doc [https://example.atlassian.net/wiki/spaces/ENG/pages/50214/Realtime+Notifications](https://example.atlassian.net/wiki/spaces/ENG/pages/50214/Realtime+Notifications) · ws library eval [https://github.com/websockets/ws](https://github.com/websockets/ws)`,
    ["frontend", "realtime"],
    null,
    null
  ),
  makeIssue(
    "PROJ-153",
    "Cache user profile data to reduce DB load",
    "In Review",
    "In Progress",
    BOB,
    3,
    "Task",
    "Medium",
    `User profile lookups hit Postgres on every request. Cache in Redis with a 10-minute TTL and bust on profile update.

Related: latency dashboard [https://example.grafana.net/d/profile-svc/profile-service-latency](https://example.grafana.net/d/profile-svc/profile-service-latency) · cache invalidation pattern [https://example.atlassian.net/wiki/spaces/ENG/pages/50320/Cache+Invalidation+Patterns](https://example.atlassian.net/wiki/spaces/ENG/pages/50320/Cache+Invalidation+Patterns)`,
    ["performance", "caching"],
    null,
    null
  ),

  // ── Needs-Verification tickets (exercise the new QA list on the dashboard) ──
  makeIssue(
    "PROJ-154",
    "Profile picture upload endpoint",
    "Needs Verification",
    "In Progress",
    CAROL,
    3,
    "Story",
    "Medium",
    `POST /users/:id/avatar accepts a multipart upload, resizes to 256x256, and stores in object storage. PR merged; awaiting QA sign-off.

Related: merged PR [https://github.com/example/api/pull/734](https://github.com/example/api/pull/734) · QA test plan [https://example.atlassian.net/wiki/spaces/QA/pages/50421/Avatar+Upload+QA](https://example.atlassian.net/wiki/spaces/QA/pages/50421/Avatar+Upload+QA)`,
    ["backend", "uploads"],
    null,
    null
  ),
  {
    ...makeIssue(
      "PROJ-155",
      "Fix login redirect loop on SSO",
      "Needs Verification",
      "In Progress",
      DAN,
      2,
      "Bug",
      "High",
      `SSO users are being redirected back to the login page after successful auth. Suspected root cause: the session cookie's SameSite attribute is set to "Strict", which drops the cookie on the cross-site redirect from the IdP back to our app.

Sentry occurrences: [https://example.sentry.io/issues/4099821/](https://example.sentry.io/issues/4099821/)
PagerDuty incident: [https://example.pagerduty.com/incidents/PT3X9YA](https://example.pagerduty.com/incidents/PT3X9YA)`,
      ["bug", "auth"],
      "PROJ-139",
      "Auth Hardening",
    ),
    acceptanceCriteria:
      "- SSO sign-in completes in a single round-trip from each supported IdP (Okta, Azure AD, Google Workspace).\n" +
      "- Session cookie is `SameSite=Lax` and survives the IdP-→-app redirect.\n" +
      "- E2E test covers a fresh browser session for each IdP.\n" +
      "- No regressions for password-flow login.",
    stepsToReproduce:
      "1. Open an incognito window in Chrome 122+.\n" +
      "2. Visit [https://app.example.com/login](https://app.example.com/login) and click \"Sign in with Okta\".\n" +
      "3. Authenticate with a valid Okta test account from the [QA accounts vault](https://example.atlassian.net/wiki/spaces/QA/pages/50531/Okta+Test+Accounts).\n" +
      "4. Observe the redirect chain back to the app.",
    observedBehavior:
      "After successful Okta auth, the browser is redirected to `/login` again instead of `/dashboard`. The session cookie set by the callback handler is not present on the next request — `document.cookie` is empty for the app domain. DevTools shows the cookie was set with `SameSite=Strict`.",
    expectedBehavior:
      "User lands on `/dashboard` immediately after IdP auth. The session cookie is preserved across the IdP redirect and present on every subsequent request.",
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
      isDone ? "Done" : "In Progress",
      [ME, ALICE, BOB, CAROL, DAN][i % 5],
      [2, 3, 5, 8, 3, 2, 5][i % 7],
      "Story",
      "Medium",
      null
    );
  });
};

const SPRINT_24_ISSUES: JiraIssue[] = [
  makeIssue(
    "PROJ-201",
    "Set up distributed tracing with OpenTelemetry across all services",
    "Done",
    "Done",
    EVE,
    8,
    "Story",
    "High",
    `Instrument all backend services with OpenTelemetry SDK. Export traces to our Jaeger instance. Ensure trace context propagates across service boundaries via HTTP headers.

Related: rollout plan [https://example.atlassian.net/wiki/spaces/PLAT/pages/51080/OTel+Rollout](https://example.atlassian.net/wiki/spaces/PLAT/pages/51080/OTel+Rollout) · Jaeger UI [https://jaeger.example.com/search?service=api-gateway](https://jaeger.example.com/search?service=api-gateway)`,
    ["observability", "platform"],
    "PROJ-190",
    "Observability Track"
  ),
  makeIssue(
    "PROJ-202",
    "Expose Prometheus metrics endpoint on API gateway",
    "Done",
    "Done",
    FRANK,
    5,
    "Story",
    "High",
    `Add a /metrics endpoint to the API gateway exposing request rate, error rate, and latency histograms per route. Scrape interval: 15s.

Related: existing dashboard [https://example.grafana.net/d/api-gateway/api-gateway](https://example.grafana.net/d/api-gateway/api-gateway) · Prometheus best practices [https://prometheus.io/docs/practices/naming/](https://prometheus.io/docs/practices/naming/)`,
    ["observability", "platform"],
    "PROJ-190",
    "Observability Track"
  ),
  {
    ...makeIssue(
      "PROJ-203",
      "Fix N+1 query in user profile endpoint",
      "Done",
      "Done",
      GRACE,
      3,
      "Bug",
      "High",
      `GET /users/:id currently fires one SQL query per role association. The endpoint should be served by a single JOIN. Production p99 for this endpoint is 420ms; target is under 80ms.

Related: latency dashboard [https://example.grafana.net/d/users-svc/users-service-latency](https://example.grafana.net/d/users-svc/users-service-latency) · perf retro [https://example.atlassian.net/wiki/spaces/ENG/pages/51322/Q1+Perf+Retro](https://example.atlassian.net/wiki/spaces/ENG/pages/51322/Q1+Perf+Retro)`,
      ["performance", "database"],
      null,
      null,
    ),
    acceptanceCriteria:
      "- GET /users/:id issues at most 2 queries (user + roles JOIN), regardless of role count.\n" +
      "- p99 latency under load drops below 80ms (verified in the perf test suite).\n" +
      "- Integration test asserts the query count via the existing `expectQueries(n)` helper.\n" +
      "- No change to the response shape — JSON payload identical.",
    stepsToReproduce:
      "1. Seed a user with 10 role associations: `npm run seed:user-with-roles 10`.\n" +
      "2. Curl `GET /users/<id>` while tailing the SQL log: `tail -f logs/sql.log`.\n" +
      "3. Run `npm run perf -- --route=/users/:id --concurrency=50 --duration=60s`.",
    observedBehavior:
      "SQL log shows `SELECT * FROM users WHERE id = ?` followed by 10 separate `SELECT * FROM roles WHERE user_id = ?` queries. Perf run reports p99 = 420ms (target 80ms).",
    expectedBehavior:
      "Single JOIN query: `SELECT users.*, roles.* FROM users LEFT JOIN user_roles … WHERE users.id = ?`. p99 < 80ms under the same load. Reference benchmark: [https://example.grafana.net/d/perf-baseline/users-endpoint?from=now-7d&to=now](https://example.grafana.net/d/perf-baseline/users-endpoint?from=now-7d&to=now)",
  },
  makeIssue(
    "PROJ-204",
    "Standardise structured logging format across all services",
    "In Review",
    "In Progress",
    HENRY,
    5,
    "Task",
    "Medium",
    `All services should emit JSON logs with consistent fields: timestamp, level, service, trace_id, span_id, message. Replace ad-hoc string logs. Update log shipper config to parse new format.

Related: log schema RFC [https://example.atlassian.net/wiki/spaces/PLAT/pages/51440/RFC-0021-Structured-Logs](https://example.atlassian.net/wiki/spaces/PLAT/pages/51440/RFC-0021-Structured-Logs) · sample dashboard [https://example.grafana.net/d/logs-overview/logs-overview](https://example.grafana.net/d/logs-overview/logs-overview)`,
    ["observability", "platform"],
    "PROJ-190",
    "Observability Track"
  ),
  makeIssue(
    "PROJ-205",
    "Wire p99 latency SLO breach alerts into PagerDuty",
    "In Review",
    "In Progress",
    EVE,
    3,
    "Task",
    "High",
    `Create Prometheus alerting rules for p99 > 200ms sustained over 5 minutes. Route to the on-call PagerDuty service. Include runbook link in alert annotations.

Related: PagerDuty service [https://example.pagerduty.com/services/PA1B2C3](https://example.pagerduty.com/services/PA1B2C3) · runbook [https://example.atlassian.net/wiki/spaces/RUNBOOKS/pages/51580/p99+SLO+Breach](https://example.atlassian.net/wiki/spaces/RUNBOOKS/pages/51580/p99+SLO+Breach)`,
    ["observability", "alerting"],
    "PROJ-190",
    "Observability Track"
  ),
  makeIssue(
    "PROJ-206",
    "Cache user session lookups in Redis to cut DB load",
    "In Progress",
    "In Progress",
    FRANK,
    5,
    "Story",
    "Medium",
    `Session validation currently hits Postgres on every request. Cache session tokens in Redis with a 15-minute TTL. Invalidate on logout and password change.

Related: session model [https://example.atlassian.net/wiki/spaces/ENG/pages/51720/Session+Model](https://example.atlassian.net/wiki/spaces/ENG/pages/51720/Session+Model) · Redis Cluster runbook [https://example.atlassian.net/wiki/spaces/RUNBOOKS/pages/51725/Redis+Cluster](https://example.atlassian.net/wiki/spaces/RUNBOOKS/pages/51725/Redis+Cluster)`,
    ["performance", "caching"],
    null,
    null
  ),
  {
    ...makeIssue(
      "PROJ-207",
      "Reduce connection pool contention in reporting service",
      "In Progress",
      "In Progress",
      GRACE,
      5,
      "Bug",
      "High",
      `The reporting service exhausts its Postgres connection pool under moderate load, causing 503s for downstream consumers that share the same database. Suspect a combination of long-running aggregation queries and an undersized pool.

Related: live trace [https://jaeger.example.com/trace/3f8a921d4b](https://jaeger.example.com/trace/3f8a921d4b) · Sentry rollup [https://example.sentry.io/issues/4112007/](https://example.sentry.io/issues/4112007/)`,
      ["performance", "database"],
      null,
      null,
    ),
    acceptanceCriteria:
      "- Reporting service no longer exhausts its pool under the standard 100 RPS soak test.\n" +
      "- New metrics: `db_pool_wait_seconds` histogram and `db_pool_in_use` gauge, scraped by Prometheus.\n" +
      "- Long-running aggregation queries (>500ms) are identified and either optimised or moved to a read replica.\n" +
      "- Runbook updated with pool sizing guidance and the new dashboard panels.",
    stepsToReproduce:
      "1. Deploy reporting service to staging with `pool_size=10` (current production setting).\n" +
      "2. Run the standard soak test: `npm run soak -- --service=reporting --rps=100 --duration=10m`.\n" +
      "3. Monitor the Postgres `pg_stat_activity` view and the staging service logs.",
    observedBehavior:
      "Within 60s the reporting pool is fully checked out. Subsequent requests block on `Pool::acquire()` and time out after 30s, returning HTTP 503 to callers. Other services sharing the database (billing, search) see their query times balloon as they compete for connections.",
    expectedBehavior:
      "Pool stays below 80% utilisation under the soak test. Queries complete within their per-route SLO. No 503s; no contention bleed-through to neighbouring services. Pool sizing reference: [https://example.atlassian.net/wiki/spaces/ENG/pages/51812/Postgres+Pool+Sizing+Guide](https://example.atlassian.net/wiki/spaces/ENG/pages/51812/Postgres+Pool+Sizing+Guide)",
  },
  makeIssue(
    "PROJ-208",
    "Define and document SLOs for all public API endpoints",
    "To Do",
    "new",
    HENRY,
    3,
    "Task",
    "Medium",
    `Write SLO targets (availability, p99 latency, error rate) for each public endpoint. Publish to the internal runbook. Align with on-call team before finalising.

Related: SLO template [https://example.atlassian.net/wiki/spaces/SRE/pages/51920/SLO+Template](https://example.atlassian.net/wiki/spaces/SRE/pages/51920/SLO+Template) · current latency baseline [https://example.grafana.net/d/api-slo/api-slo-overview](https://example.grafana.net/d/api-slo/api-slo-overview)`,
    ["observability", "documentation"],
    "PROJ-190",
    "Observability Track"
  ),
  makeIssue(
    "PROJ-209",
    "Audit and retire unused background jobs",
    "To Do",
    "new",
    EVE,
    2,
    "Task",
    "Low",
    `Several Sidekiq jobs appear to have zero enqueue rate over the past 90 days. Confirm they are safe to remove, delete the worker classes, and remove the schedules from config.

Related: Sidekiq dashboard [https://sidekiq.example.com/queues](https://sidekiq.example.com/queues) · job ownership map [https://example.atlassian.net/wiki/spaces/PLAT/pages/52015/Background+Job+Ownership](https://example.atlassian.net/wiki/spaces/PLAT/pages/52015/Background+Job+Ownership)`,
    ["cleanup", "platform"],
    null,
    null
  ),
];

const SPRINT_23_ISSUES: JiraIssue[] = ALL_SPRINT_ISSUES;

export const SPRINT_ISSUES_BY_ID: Record<number, JiraIssue[]> = {
  23: SPRINT_23_ISSUES,
  24: SPRINT_24_ISSUES,
  22: makeSprintIssues(22, 9, 11),
  21: makeSprintIssues(21, 8, 10),
  20: makeSprintIssues(20, 10, 12),
  19: makeSprintIssues(19, 7, 10),
  18: makeSprintIssues(18, 9, 10),
};

// ── Individual issue lookup ───────────────────────────────────────────────────

export const ALL_ISSUES_BY_KEY: Record<string, JiraIssue> = {
  ...Object.fromEntries(ALL_SPRINT_ISSUES.map((i) => [i.key, i])),
  // Demo issues are in MY_SPRINT_ISSUES (which is part of ALL_SPRINT_ISSUES)
  // but also registered here explicitly so getIssue("DEMO-1") always works
  // even if the sprint lookup changes.
  [DEMO_ISSUE_1.key]: DEMO_ISSUE_1,
  [DEMO_ISSUE_2.key]: DEMO_ISSUE_2,
};
