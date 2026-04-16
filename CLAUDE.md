# Meridian — Development Reference

## Overview

Meridian is a personal productivity desktop app for a senior engineer and scrum master.
It combines AI-assisted feature delivery (8-agent implementation pipeline) with engineering
leadership tooling (sprint dashboard, retrospectives, standup briefing, workload balancer,
ticket quality checker, knowledge base). Built on Tauri + React + TypeScript + Claude Agent SDK.
Data sources: JIRA API and Bitbucket API. Built for individual use — not distributed.

---

## Core Philosophy

- Each agent has a single, focused responsibility
- Human remains in the loop at **every step** of the implementation pipeline — no step advances automatically
- Each agent presents its findings and waits for explicit user approval before the next agent runs
- The user can converse with the agent at any step: ask questions, provide clarifications, correct misunderstandings, or abort
- Agents may surface blocking issues that must be resolved before the pipeline can proceed
- Code is never written before a plan is agreed upon
- Nothing is merged without tests and a review pass
- The system improves over time via Agent Skills that encode accumulated knowledge
- Data from JIRA and Bitbucket is the source of truth for all metrics — no manual input

---

## Tech Stack

- **Tauri** — desktop shell (Rust backend, no browser tab required)
- **React + TypeScript** — frontend
- **shadcn/ui + Tailwind CSS** — component library and styling
- **Claude Agent SDK (TypeScript)** — all sub-agents and the pipeline
- **JIRA API + Bitbucket API** — data sources
- **Anthropic API key** — pay-as-you-go, individual account

---

## Workflows (implemented)

1. **Implement a Ticket** — 8-agent pipeline: Grooming → Impact Analysis → Triage → Implementation → Test Generation → Code Review → PR Description → Retrospective
2. **PR Review Assistant** — AI-assisted review of assigned PRs across 4 lenses (see below)
3. **Sprint Dashboard** — real-time sprint health, team performance, blockers
4. **Sprint Retrospectives** — completed sprint analysis, trend charts, AI summary
5. **Daily Standup Briefing** — per-person standup agenda from JIRA/Bitbucket activity
6. **Team Workload Balancer** — remaining story points per dev, AI rebalancing suggestions
7. **Ticket Quality Checker** — readiness assessment against AC completeness, scope, dependencies
8. **Knowledge Base / Decision Log** — searchable log of decisions, patterns, retro learnings
9. **Address PR Comments** — AI reads reviewer comments, checks out branch in worktree, proposes and applies fixes

---

## Agent Pipeline

### Flow

```
JIRA API
    ↓
[1. Grooming Agent]
    — blocker checks (AC, description, story points) —
    ↓ USER checkpoint: review findings, resolve blockers, approve
[2. Impact Analysis Agent]
    ↓ USER checkpoint: review blast radius & risk, approve
[3. Triage Agent] ←→ USER (iterative planning conversation)
    ↓ USER explicitly approves final implementation plan
[4. Implementation Agent]
    ↓ USER checkpoint: review diff, request revisions, approve
[5. Test Generation Agent]
    ↓ USER checkpoint: review test coverage, request additions, approve
[6. Code Review Agent]
    ↓ USER checkpoint: review findings, direct fixes or override blockers, approve
[7. PR Description Agent]
    ↓ USER checkpoint: review & edit PR description, confirm submission
USER confirms → PR raised to Bitbucket

(After merge)
    ↓
[8. Retrospective/Learning Agent]
    ↓ USER checkpoint: review retrospective, approve Skill updates
Skills / Knowledge Base updated
```

### Key Behavioral Constraints

**Grooming Agent blocking conditions** — pipeline must not advance until resolved:
- Missing or empty ticket description
- Missing acceptance criteria (Story or Task type)
- Missing story point estimate (Story or Task type)
- Ambiguous or internally contradictory description

**Implementation Agent**: must not write tests — that is the Test Generation Agent's responsibility.

**Test Generation Agent**: intentionally separate from Implementation Agent to avoid an agent writing tests that simply validate its own assumptions.

**All agents**: read/write codebase via the local git worktree only — never via Bitbucket API for file access. Use `glob`, `grep`, and `read_file` tools targeted at specific files, not whole-codebase loads.

---

## PR Review: Analysis Lenses

The PR Review Assistant analyses every diff across four lenses. Each finding must be categorised as Blocking / Non-blocking / Nitpick. Security and logic findings default to Blocking.

1. **Acceptance Criteria Compliance** — does the implementation address all AC? Does the PR description match what was actually built?
2. **Security & Vulnerability Analysis** — injection (SQL, XSS, path traversal, command), auth/authz issues, sensitive data exposure, insecure dependencies, input validation gaps, cryptographic weaknesses. Each finding must cite the specific file and line range.
3. **Logic Error Analysis** — off-by-one errors, race conditions, null/undefined assumptions, swallowed exceptions, inverted conditionals, unexpected state mutations. Each finding must cite the specific file and line range.
4. **General Code Quality** — test coverage gaps, adherence to codebase patterns, readability, performance.

---

## Address PR Comments: Worktree

Uses a **dedicated third worktree** (`pr_address_worktree_path`), separate from the implementation and PR review worktrees to prevent branch conflicts when all three workflows run simultaneously. Falls back to `pr_review_worktree_path`, then `repo_worktree_path`. Branch is always checked out fresh from `origin/<branch>` before analysis. Fixes are written via `write_pr_address_file`, sandboxed to the worktree root.

---

## Codebase Access (Worktree)

All agents operate against a **local git worktree**, not the Bitbucket API.

**Configuration** (in Meridian's settings store):
- `repo_worktree_path` — absolute path to the worktree (e.g. `/Users/you/REPOS/MyRepo-meridian`)
- `repo_base_branch` — branch the worktree tracks (default: `develop`)

**Pipeline startup** (`startPipeline`):
1. Validate `repo_worktree_path` is set and is a valid git worktree
2. Run `git -C <path> fetch origin && git -C <path> reset --hard origin/<base_branch>`
3. Record `{ worktreePath, headCommit }` in the pipeline session
4. Pass `worktreePath` to every agent as root for all file operations

**Agent tools** (Tauri backend commands, sandboxed to `worktreePath`):
- `glob_repo_files(pattern)`
- `grep_repo_files(pattern, path?)`
- `read_repo_file(path)`
- `write_repo_file(path, content)` — Implementation Agent only
- `get_repo_diff(base_branch)` — PR Description Agent

**Prompt caching**: file contents passed forward from the Grooming Agent use `cache_control: { type: "ephemeral" }` so subsequent agents get cache hits on the same files.

---

## Credential & Security Rules

- All credentials stored via **Tauri's secure OS keychain** — never written to disk in plaintext
- Credentials are **never passed to the React frontend** — read in the Tauri backend and used directly in API calls
- No credential ever appears in a Tauri command response to the frontend
- Never use environment variables for credentials — all entered via the UI settings screen
- Never expose raw credential values in logs or error messages

**Credentials in use**: Anthropic API key, JIRA Base URL + Email + API Token, Bitbucket Workspace + Username + App Password.

---

## General Guidelines

- **TypeScript throughout** — frontend and Agent SDK layer
- **Structured outputs (JSON)** for all inter-agent handoffs — keeps the pipeline type-safe
- **shadcn/ui components** for all UI — do not build custom components where shadcn/ui has a suitable option
- **Consistent Tailwind theme** via CSS variables — do not hardcode colours
- **Cost tracking** — surface per-agent and per-pipeline token costs in the UI; use Claude Agent SDK's built-in tracking
- **Prompt caching** for codebase context shared across multiple agents in a pipeline run
- **Agent SDK calls in the Tauri backend** — never in the React frontend; only pass results forward via Tauri commands

---

## PipelineProgress Component

**File**: `src/components/PipelineProgress.tsx`

Dual-mode animated SVG (960×116 viewBox). Renders the Meridian logo when idle; expands into a pipeline progress indicator during the Implement a Ticket workflow. Full documentation (geometry, constants, animation logic, what not to change) in [`docs/PipelineProgress.md`](docs/PipelineProgress.md).
