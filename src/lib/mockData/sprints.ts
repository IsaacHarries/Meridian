import { type JiraSprint } from "@/lib/tauri/jira";

// ── Sprints ───────────────────────────────────────────────────────────────────
// ── Active sprint ─────────────────────────────────────────────────────────────

export const ACTIVE_SPRINT: JiraSprint = {
  id: 23,
  name: "Sprint 23 — Q2 Feature Push",
  state: "active",
  startDate: "2020-01-01T09:00:00.000Z",
  endDate: "2040-01-01T17:00:00.000Z",
  completeDate: null,
  goal: "Deliver user settings overhaul, fix search pagination, and land the file upload validation hardening.",
};

export const ACTIVE_SPRINT_2: JiraSprint = {
  id: 24,
  name: "Sprint 24 — Platform Reliability",
  state: "active",
  startDate: "2020-01-01T09:00:00.000Z",
  endDate: "2040-01-01T17:00:00.000Z",
  completeDate: null,
  goal: "Improve observability, reduce p99 latency, and address top error-budget burn alerts.",
};

// ── Completed sprints ─────────────────────────────────────────────────────────

export const COMPLETED_SPRINTS: JiraSprint[] = [
  {
    id: 22,
    name: "Sprint 22 — Auth & Stability",
    state: "closed",
    startDate: "2026-03-17T09:00:00.000Z",
    endDate: "2026-03-30T17:00:00.000Z",
    completeDate: "2026-03-31T10:15:00.000Z",
    goal: "Complete auth hardening track and improve test coverage across billing.",
  },
  {
    id: 21,
    name: "Sprint 21 — Search Overhaul",
    state: "closed",
    startDate: "2026-03-03T09:00:00.000Z",
    endDate: "2026-03-16T17:00:00.000Z",
    completeDate: "2026-03-17T09:30:00.000Z",
    goal: "Ship rewritten search service with relevance scoring.",
  },
  {
    id: 20,
    name: "Sprint 20 — Performance",
    state: "closed",
    startDate: "2026-02-17T09:00:00.000Z",
    endDate: "2026-03-02T17:00:00.000Z",
    completeDate: "2026-03-03T08:45:00.000Z",
    goal: "Cut p95 API latency by 30%. Database query optimisation.",
  },
  {
    id: 19,
    name: "Sprint 19 — Onboarding",
    state: "closed",
    startDate: "2026-02-03T09:00:00.000Z",
    endDate: "2026-02-16T17:00:00.000Z",
    completeDate: "2026-02-17T09:00:00.000Z",
    goal: "New user onboarding flow with guided setup wizard.",
  },
  {
    id: 18,
    name: "Sprint 18 — API v2",
    state: "closed",
    startDate: "2026-01-20T09:00:00.000Z",
    endDate: "2026-02-02T17:00:00.000Z",
    completeDate: "2026-02-03T08:30:00.000Z",
    goal: "Launch public API v2 with versioning and deprecation headers.",
  },
];
