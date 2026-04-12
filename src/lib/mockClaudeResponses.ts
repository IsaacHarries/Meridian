import type {
  GroomingOutput,
  ImpactOutput,
  ImplementationPlan,
  GuidanceOutput,
  TestOutput,
  PlanReviewOutput,
  PrDescriptionOutput,
  RetrospectiveOutput,
  QualityReport,
  ReviewReport,
} from "./tauri";

/** JSON agent outputs (no markdown fences) for parseAgentJson / parseQualityReport / parseReviewReport */

const grooming: GroomingOutput = {
  ticket_summary:
    "Mock grooming: implement rate limiting on the public API with Redis-backed counters and configurable thresholds.",
  ticket_type: "Story",
  acceptance_criteria: [
    "Requests beyond the limit receive HTTP 429 with Retry-After",
    "Limits are configurable per route",
    "Redis failure fails open with a warning log",
  ],
  relevant_areas: [
    {
      area: "HTTP middleware",
      reason: "Rate limiting is enforced at the edge of request handling.",
      files_to_check: ["src/routes/api.rs", "src/middleware/rate_limit.rs"],
    },
    {
      area: "Configuration",
      reason: "Thresholds and window sizes need to be loaded from config.",
      files_to_check: ["src/config.rs"],
    },
  ],
  ambiguities: [
    "Whether authenticated users should have a separate (higher) limit than anonymous traffic.",
  ],
  dependencies: ["Redis cluster must be reachable from API tier"],
  estimated_complexity: "medium",
  grooming_notes:
    "This is static mock output for development. Real grooming would reference your ticket text.",
};

const impact: ImpactOutput = {
  risk_level: "medium",
  risk_justification:
    "Touches shared request path; misconfiguration could block legitimate traffic or disable limits silently.",
  affected_areas: ["api.rs", "middleware stack", "deployment config"],
  potential_regressions: [
    "Latency increase if Redis round-trip is on hot path",
    "False 429s if clocks or windows misaligned",
  ],
  cross_cutting_concerns: ["Observability for limit hits", "Documentation for operators"],
  files_needing_consistent_updates: ["src/middleware/rate_limit.rs", "tests/integration/api.rs"],
  recommendations:
    "Feature-flag the middleware, add metrics for allowed/denied, and integration tests for 429 + Retry-After.",
};

const implementationPlan: ImplementationPlan = {
  summary:
    "Add a Redis-backed rate limiter middleware, wire config, and cover happy path + fail-open behaviour in tests.",
  files: [
    {
      path: "src/middleware/rate_limit.rs",
      action: "create",
      description: "Token bucket / fixed window limiter with Redis backend",
    },
    {
      path: "src/routes/api.rs",
      action: "modify",
      description: "Register middleware on public routes",
    },
    {
      path: "src/config.rs",
      action: "modify",
      description: "Add limit and window configuration",
    },
  ],
  order_of_operations: [
    "Define config schema and defaults",
    "Implement limiter + unit tests",
    "Integrate middleware and integration tests",
  ],
  edge_cases: ["Redis down", "Clock skew", "Burst traffic at window boundary"],
  do_not_change: ["Business logic handlers beyond wrapping with middleware"],
  assumptions: ["Redis URL already available in app settings"],
  open_questions: [],
};

const guidance: GuidanceOutput = {
  steps: [
    {
      step: 1,
      title: "Scaffold middleware module",
      file: "src/middleware/rate_limit.rs",
      action: "create",
      details: "Expose axum/tower layer that checks a counter key per client IP or user id.",
      code_hints: "Use a Lua script or INCR with EXPIRE for atomic window reset.",
    },
    {
      step: 2,
      title: "Wire into router",
      file: "src/routes/api.rs",
      action: "modify",
      details: "Apply layer only to routes that need limiting; skip health checks.",
      code_hints: "Layer::new() before route handlers",
    },
  ],
  patterns_to_follow: ["Existing tracing patterns", "Config loading from env + file"],
  common_pitfalls: ["Blocking the async runtime on Redis", "Forgetting to strip health endpoints"],
  definition_of_done: ["Unit tests pass", "Integration test for 429", "Docs updated"],
};

const tests: TestOutput = {
  test_strategy: "Unit test limiter math; integration test full stack with test Redis or mock.",
  unit_tests: [
    {
      description: "Limiter window reset",
      target: "rate_limit::inner",
      cases: ["first request allowed", "over limit returns Err", "window rolls"],
    },
  ],
  integration_tests: [
    {
      description: "API returns 429",
      setup: "Spin app with test Redis",
      cases: ["burst exceeds limit", "Retry-After header present"],
    },
  ],
  edge_cases_to_test: ["Redis connection failure path", "Concurrent requests at boundary"],
  coverage_notes: "Mock test output — expand for your codebase.",
};

const planReview: PlanReviewOutput = {
  confidence: "ready",
  summary: "Mock plan review: structure is coherent and risks are acknowledged.",
  findings: [
    {
      severity: "suggestion",
      area: "Observability",
      feedback: "Add a metric for fail-open events when Redis errors.",
    },
  ],
  things_to_address: [],
  things_to_watch: ["Load test after deploy"],
};

const prDescription: PrDescriptionOutput = {
  title: "feat(api): add Redis-backed rate limiting",
  description: `## Summary
Mock PR description for Meridian demo mode.

## Test plan
- [ ] Unit tests
- [ ] Integration tests

## Ticket
Linked from JIRA (mock).`,
};

const retrospective: RetrospectiveOutput = {
  what_went_well: ["Plan stayed aligned with grooming output"],
  what_could_improve: ["Earlier spike on Redis client choice"],
  patterns_identified: ["Middleware-first cross-cutting concerns"],
  agent_skill_suggestions: [
    {
      skill: "implementation",
      suggestion: "Document preferred Redis client and connection pooling defaults.",
    },
  ],
  knowledge_base_entries: [
    {
      type: "learning",
      title: "Rate limit fail-open policy",
      body: "Chose fail-open with warning log to prioritise availability.",
    },
  ],
  summary: "Mock retrospective agent output.",
};

const quality: QualityReport = {
  overall: "needs_work",
  summary: "Mock quality report: ticket is close but has one ambiguity on auth vs anon limits.",
  criteria: [
    {
      name: "Acceptance criteria",
      result: "partial",
      feedback: "429 behaviour is clear; per-role limits not specified.",
    },
    {
      name: "Dependencies",
      result: "pass",
      feedback: "Redis dependency called out.",
    },
  ],
  open_questions: ["Should premium users bypass limits entirely?"],
  suggested_improvements: "Add a short table: route → limit → window.",
};

const review: ReviewReport = {
  overall: "request_changes",
  summary:
    "Mock PR review: one blocking security note and a few quality nits. Replace with real analysis when mock mode is off.",
  lenses: {
    acceptance_criteria: {
      assessment: "Partially meets criteria; integration test for 429 not visible in diff.",
      findings: [
        {
          severity: "non_blocking",
          title: "Missing test for Retry-After",
          description: "Add assertion on header value in integration test.",
          file: "tests/integration/api.rs",
          line_range: null,
        },
      ],
    },
    security: {
      assessment: "Fail-open on Redis errors reduces availability protection under infra failure.",
      findings: [
        {
          severity: "blocking",
          title: "Silent disable of rate limiting",
          description:
            "When Redis errors, limits stop applying. Ensure operators get alerts (metric + log).",
          file: "src/middleware/rate_limit.rs",
          line_range: "38-45",
        },
      ],
    },
    logic: {
      assessment: "No obvious off-by-one in mock review.",
      findings: [],
    },
    quality: {
      assessment: "Readable structure; could use more inline comments on window math.",
      findings: [
        {
          severity: "nitpick",
          title: "Naming",
          description: "Consider renaming `inner` to `check_limit`.",
          file: "src/middleware/rate_limit.rs",
          line_range: null,
        },
      ],
    },
  },
};

export const MOCK_GROOMING_JSON = JSON.stringify(grooming);
export const MOCK_IMPACT_JSON = JSON.stringify(impact);
export const MOCK_IMPLEMENTATION_PLAN_JSON = JSON.stringify(implementationPlan);
export const MOCK_GUIDANCE_JSON = JSON.stringify(guidance);
export const MOCK_TESTS_JSON = JSON.stringify(tests);
export const MOCK_PLAN_REVIEW_JSON = JSON.stringify(planReview);
export const MOCK_PR_DESCRIPTION_JSON = JSON.stringify(prDescription);
export const MOCK_RETROSPECTIVE_JSON = JSON.stringify(retrospective);
export const MOCK_QUALITY_JSON = JSON.stringify(quality);
export const MOCK_PR_REVIEW_JSON = JSON.stringify(review);

/** Plain-text / markdown responses */

export const MOCK_TRIAGE_ASSISTANT_REPLY = `Thanks for the context. Here is a concise take for **mock mode**:

**Understanding**  
We are adding Redis-backed rate limiting on the public API, with configurable thresholds and a fail-open path when Redis is unavailable.

**Proposed approach**  
1. Introduce a middleware module that keys limits by client identity (IP or user id).  
2. Load window size and max requests from existing config patterns.  
3. Return **429** with **Retry-After** when over limit.  
4. On Redis errors: log a warning, emit a metric, and allow the request (fail-open) so users are not hard-blocked by infra blips.

**Risks**  
- Mis-tuned limits could frustrate legitimate traffic.  
- Fail-open means brief loss of protection — acceptable if observable.

If that matches your intent, say **finalize** and I will lock an implementation plan (mock mode will inject a canned JSON plan).`;

export const MOCK_STANDUP_MARKDOWN = `## Daily standup (mock)

### Alice
- **Yesterday:** Merged rate limit spike; paired on Redis config.
- **Today:** Integration tests for 429 responses.
- **Blockers:** None.

### Bob
- **Yesterday:** Reviewed API middleware PR.
- **Today:** Dashboard burn-down tweaks.
- **Blockers:** Waiting on design for error copy.

### You
- **Yesterday:** Groomed backlog for next sprint.
- **Today:** SM ceremonies + unblock Bob on copy.
- **Blockers:** None.

_Mock AI mode — no live model call._`;

export const MOCK_SPRINT_RETRO_MARKDOWN = `## Sprint retrospective (mock)

### Went well
- Velocity stable; fewer carry-overs than last sprint.

### Did not go well
- Two PRs waited >3 days for first review.

### Actions
- Try a **review SLA** badge on stale PRs.
- Smaller batches mid-sprint to reduce review load.

_Mock AI mode — substitute real retro text when disabled._`;

export const MOCK_WORKLOAD_MARKDOWN = `## Workload suggestions (mock)

1. **Rebalance:** \`PROJ-214\` (unstarted, 3 pts) could move from **Alice** to **Bob** — Bob is under capacity after closing \`PROJ-198\`.
2. **Risk:** **Charlie** has 8 pts still in progress with 3 days left; consider pairing on the largest item.
3. **Review load:** Open PRs assigned to Alice; if she picks up new dev work, defer one review or reassign.

_Mock AI mode — suggestions are illustrative only._`;
