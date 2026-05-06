# Meridian — Development Reference

## Overview

Meridian is a personal productivity desktop app for a senior engineer and scrum master.
It combines AI-assisted feature delivery (a multi-stage implementation pipeline) with
engineering leadership tooling (sprint dashboard, retrospectives, sprint trends, workload
balancer, ticket quality assessment, meeting transcription). Built on Tauri + React +
TypeScript with a TypeScript sidecar that owns all LLM provider integration via
LangChain.js + LangGraph.js. Data sources: JIRA API and Bitbucket API. Built for
individual use — not distributed.

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
- **TypeScript sidecar (Node) + LangGraph.js** — owns all workflow orchestration and LLM provider integration; the Rust backend never makes LLM HTTP calls directly and holds no pipeline state
- **LangChain.js model adapters** — `@langchain/anthropic`, `@langchain/google-genai`, `@langchain/ollama`, plus two custom adapters: a Claude OAuth subscription adapter (Claude.ai bearer-token billing envelope, in `src-sidecar/src/models/anthropic-oauth.ts`) and a Gemini CodeAssist adapter (`cloudcode-pa.googleapis.com/v1internal:generateContent` for personal Google OAuth tokens, in `src-sidecar/src/models/gemini-codeassist.ts`). A custom Copilot adapter wraps GitHub Copilot's chat-completions endpoint.
- **Zod** — schema validation for every inter-agent structured-output handoff
- **JIRA API + Bitbucket API** — data sources

---

## Repo Layout

```
src/                    React frontend
  screens/              one file per top-level workflow screen
  stores/               Zustand stores; one per long-running screen
  components/           shadcn/ui-based shared components
  lib/tauri.ts          single source of truth for Tauri command wrappers + types
  lib/preferences.ts    typed wrapper around the prefs store

src-tauri/              Rust backend (Tauri host process)
  src/commands/         Tauri command modules — one file per domain
  src/integrations/     sidecar IPC bridge, Bitbucket/JIRA HTTP clients
  src/llms/             provider helpers (OAuth refresh, model picker, ping)
  src/agents/dispatch.rs only — config/override resolution, no LLM calls
  src/storage/          keychain credentials + plain-JSON preferences
  target/debug/bundle.cjs  ← runtime sidecar bundle (copied from src-sidecar/dist)

src-sidecar/            TypeScript sidecar (Node, supervised by Rust)
  src/workflows/        one file per workflow + registry.ts (the entrypoint)
  src/models/           LangChain model adapters (incl. custom Anthropic OAuth + Gemini CodeAssist)
  src/tools/            repo-tools.ts (LangGraph tools) + bridge.ts (IPC promise registry)
  src/protocol.ts       inbound/outbound message shapes — mirror in src-tauri/src/integrations/sidecar.rs

docs/                   supplementary architecture docs
```

---

## Dev Workflow

- **Run the app**: `pnpm tauri dev` (from repo root). The Tauri config's `beforeDevCommand` runs `pnpm sidecar:bundle` first, so the sidecar bundle is always rebuilt before vite + Tauri start. Vite serves the frontend with HMR; Tauri rebuilds Rust on file change and restarts the app, which kills the supervised sidecar so the next IPC request spawns a fresh one.
- **Run tests**: `pnpm test` at repo root for the React layer, `pnpm test` inside `src-sidecar/` for sidecar units. **New code should land with tests.** Default to writing unit tests for: pure functions (op application, classifiers, reducers), schema validators (Zod parsing edge cases including rejection paths), routing logic (LangGraph conditional edges), and any code with non-obvious branching. Tests live next to the source as `*.test.ts` / `*.test.tsx`. End-to-end validation by running workflows in dev is still useful, but it's a complement to unit tests, not a substitute.
- **Mid-session sidecar refresh**: when you edit `src-sidecar/` source while `tauri dev` is already running, the in-memory sidecar process won't pick up the change on its own. Run `pnpm sidecar:rebuild` from the repo root — it bundles, copies to the runtime path, and kills the long-lived child process so the next IPC request spawns a fresh one with the new code.
- **Tauri command additions** must be wired in *three* places: the `pub use` re-export in `src-tauri/src/commands/mod.rs`, the import block in `src-tauri/src/lib.rs`, and the handler list inside `tauri::generate_handler![ … ]`. Skipping any one yields a runtime "command not found" rather than a compile error.

---

## Layer Responsibilities

Three layers, with strict boundaries:

### React frontend (`src/`)
- UI only. Renders state; emits user intent via Tauri commands.
- **Never** holds credentials, calls LLM providers, or touches the filesystem.

### Rust backend (`src-tauri/`)
- Owns: credentials (keychain), settings store, JIRA/Bitbucket API calls, repo worktree tools, sidecar process supervision.
- Triggers workflow runs over IPC and surfaces sidecar progress, interrupts (human checkpoints), and final results to the frontend.
- Does **not** own prompt assembly, pipeline state, or workflow logic — those live in the sidecar.
- Sandboxes all filesystem operations to the configured worktree path.
- Executes tool callbacks invoked by the sidecar (read/write file, glob, grep, exec) — the sidecar never touches the filesystem directly.

### TypeScript sidecar (`src-sidecar/`)
- Owns: workflow orchestration — every workflow is a LangGraph `StateGraph` (or, for one-shot workflows, a thin runner that reuses a shared scaffold).
- Owns: all LLM provider integration via LangChain.js model adapters; tool-call loops; structured-output validation (Zod); streaming; per-call token-usage tracking.
- Owns: human-in-the-loop checkpoints (LangGraph `interrupt()`), checkpointed state (resumable runs), and conditional routing (e.g. the build-check sub-loop's retry-with-error-context edges).
- Receives credentials per-request from Rust over stdio IPC; never caches them across calls, never logs them.
- A single Node process supervised by Rust; restarted on crash. Workflow checkpointer state survives restarts (SQLite-backed via `@langchain/langgraph-checkpoint-sqlite`).

---

## Provider Model

### Supported providers

| Provider | Auth |
|---|---|
| **Anthropic** (Claude) | API key or OAuth (Claude.ai subscription) |
| **Google** (Gemini) | API key or OAuth (CodeAssist) |
| **GitHub Copilot** | OAuth |
| **Ollama** (local, e.g. Qwen3) | None (local) |

Every workflow — including tool-loop workflows like the implementation pipeline and Address PR Comments — supports every provider. LangChain.js model adapters normalise structured tool-calling across providers, so the architecture is uniform regardless of which provider/model the user picks.

### Default and model-quality variance

What varies between providers is *quality* on long, multi-step agent loops, not capability. As a rule of thumb:

- **Claude** is the recommended default for tool-loop workflows — best multi-step planning and tool-calling reliability in practice.
- **Gemini** and **Copilot** are reliable for one-shot workflows and usable for tool loops, but expect more retries on complex pipelines.
- **Ollama** quality depends heavily on the chosen model — Qwen3 handles tool-calling well; smaller models may not. Treat it primarily as a token-budget fallback.

The per-panel provider/model picker exposes all providers for all workflows. In `auto` priority mode, Claude is tried first and other providers form the fallback chain. Pipeline workflows pick up the active model on **every per-file iteration** (see "Mid-pipeline provider switching" below).

### Mid-pipeline provider switching

The implementation pipeline does not lock a provider for the run. Before each per-file iteration in the implementation node, the sidecar calls back into Rust to re-resolve the active `ModelSelection` (provider + model + fresh credentials). Effects:

- Switching providers/models in the header dropdown takes effect on the next file — no workflow restart needed.
- OAuth access tokens (Gemini CodeAssist tokens have a ~1h TTL) get refreshed mid-stage automatically; long pipeline runs don't 401 between files.
- Resume and rewind both refresh credentials before invoking the graph.

---

## Workflows (implemented)

1. **Implement a Ticket** — 9-agent pipeline (user-visible stages with checkpoints): Grooming → Impact Analysis → Triage → Implementation → Test Plan → Test Generation → Code Review → PR Description → Retrospective. The LangGraph also contains silent intermediate nodes (Plan + Guidance after Triage, an optional Build sub-loop after Implementation) and a per-stage checkpoint after each user-visible stage. Test stage is intentionally split: the agent proposes a test plan first, the user approves it, then a separate node implements the approved plan.
2. **PR Review Assistant** — AI-assisted review of assigned PRs across 5 lenses (see below)
3. **Sprint Dashboard** — real-time sprint health, blockers, team performance, and team workload with AI rebalancing suggestions. Also the launch point for standup recordings (header record button auto-tags the meeting `standup`).
4. **Sprint Retrospectives** — completed sprint analysis, trend charts, AI summary
5. **Multi-Sprint Trends** — analysis across multiple completed sprints; pre-computed stats table + AI-driven pattern analysis.
6. **Groom Ticket** — runs the grooming workflow against any chosen ticket without committing to the implementation pipeline. Use case: triaging tickets in sprint planning to surface blockers (missing AC, story points, ambiguity) before they're picked up.
7. **Address PR Comments** — AI reads reviewer comments, checks out branch in worktree, proposes and applies fixes
8. **Meetings** — local whisper transcription _or_ freeform notes (when recording is not allowed); both are tagged, timestamped, and AI-summarisable, and feed into Sprint Retrospectives. Start a recording from any screen via the header record button (auto-tags `standup` from Sprint Dashboard, `retro` from Retrospectives); notes are created from the Meetings screen via the split-button dropdown, which remembers the last mode chosen.

---

## Agent Pipeline

### Flow

```
JIRA API
    ↓
[1. Grooming Agent]  ── pre-step: file probe + read/grep for codebase context
    — blocker checks (AC, description, story points) —
    ↓ USER checkpoint: review findings, resolve blockers, approve
[2. Impact Analysis Agent]
    ↓ USER checkpoint: review blast radius & risk, approve
[3. Triage Agent]  ←→  USER (iterative planning conversation)
    ↓ USER explicitly approves the agreed approach (Finalise Plan)
[4. Plan Agent]            (silent — produces structured implementation plan)
[5. Guidance Agent]        (silent — produces per-file patterns + pitfalls)
[6. Implementation Agent]  ── per-file tool loop with mid-stage model refresh
    ↓ (optional, when Build Verification is enabled in Settings)
    [Build Check]  →  passes? continue : [Build Fix]  →  loop (max 3 attempts)
    ↓ USER checkpoint: review diff, request revisions, approve
[7. Test Plan Agent]
    ↓ USER checkpoint: review proposed test files & cases, approve
[8. Test Generation Agent]  ── writes the approved tests
    ↓ USER checkpoint: review test coverage, request additions, approve
[9. Code Review Agent]
    ↓ USER checkpoint: review findings, direct fixes or override blockers, approve
[10. PR Description Agent]
    ↓ USER checkpoint: review & edit PR description, confirm submission
USER confirms → PR raised to Bitbucket

(After merge)
    ↓
[11. Retrospective/Learning Agent]
    ↓ USER checkpoint: review retrospective, apply skill updates one-by-one
Agent Skills updated
```

### Key Behavioral Constraints

**Grooming Agent blocking conditions** — pipeline must not advance until resolved:
- Missing or empty ticket description
- Missing acceptance criteria (Story or Task type)
- Missing story point estimate (Story or Task type)
- Ambiguous or internally contradictory description

**Implementation Agent**: must not write tests — that is the Test Generation Agent's responsibility. Writes one file per iteration; the model is rebuilt before each iteration so provider/model changes and OAuth refreshes apply mid-stage.

**Test Plan vs Test Generation**: intentionally split so the engineer reviews the proposed file list and case coverage before any test files are written. Prevents the agent silently adding tests the user doesn't actually want, and prevents an agent from writing tests that just validate its own assumptions.

**All agents**: read/write codebase via the local git worktree only — never via Bitbucket API for file access. Use `glob_repo_files`, `grep_repo_files`, and `read_repo_file` tools targeted at specific files, not whole-codebase loads. The Implementation, Verification, Test Generation, and Code Review agents have access to `write_repo_file`. The Verification agent and the orchestrator/implementation chats also have `exec_in_worktree` for running shell commands (typecheck/test/build).

### Verification (post-implementation)

After the Implementation agent finishes writing every planned file, a **`verification` node** runs as a tool-loop with full repo access plus `exec_in_worktree`. The agent infers the project's commands from its manifests (`package.json`, `Cargo.toml`, etc.), then verifies the change in order — typecheck → tests for affected modules → build — fixing any failures it can with `write_repo_file` along the way. Modeled after Claude Code's behaviour: don't trust that a write compiled, run the checks.

- Always runs; there is no Settings toggle. The agent skips checks that don't apply to the project (e.g. no typecheck step for a pure-shell project).
- Iteration cap: `VERIFICATION_MAX_ITERATIONS` (currently 30 tool-loop steps) — generous because each cycle takes multiple exec/read/write calls.
- Result: a `VerificationOutput` (summary, per-step log, files fixed, unresolved issues, `clean: boolean`) surfaced in the Implementation panel alongside the implementation summary at the implementation checkpoint.
- Per-file post-write verification (file missing/empty/etc on disk after the implementation iteration) still routes to `replan_check` ahead of `verification` when there's plan-revision budget — that's a different failure mode (the agent never wrote the file) and replan is the right tool.

---

## PR Review: Analysis Lenses

**Architecture**: chunk-aware. Small PRs go through a single `single_pass` synthesis node; large PRs are split by the `prepare` node into chunks and reviewed sequentially in `chunk_review`, then the `synthesis` node combines per-chunk findings into the final report. Both paths are nodes in the same `StateGraph` chosen by a conditional edge.

The PR Review Assistant analyses every diff across five lenses. Each finding must be categorised as Blocking / Non-blocking / Nitpick. Security and logic findings default to Blocking; testing findings default to Non-blocking unless safety-critical or tests were explicitly promised.

1. **Acceptance Criteria Compliance** — does the implementation address all AC? Does the PR description match what was actually built? If criteria are blank or not provided, return zero findings for this lens.
2. **Security & Vulnerability Analysis** — injection (SQL, XSS, path traversal, command), auth/authz issues, sensitive data exposure, insecure dependencies, input validation gaps, cryptographic weaknesses. Each finding must cite the specific file and line range. Never flag test/spec files.
3. **Logic Error Analysis** — off-by-one errors, race conditions, null/undefined assumptions, swallowed exceptions, inverted conditionals, unexpected state mutations. Each finding must cite the specific file and line range.
4. **Testing** — missing tests for non-trivial business logic, gaps in edge-case coverage, weak assertions. Skip config/build/asset files (json/yaml/toml, Dockerfile, lockfiles, css/svg/md, generated files, type-only definitions). For Bug-typed tickets, check that new/modified unit tests carry a `@tags <KEY>` annotation.
5. **General Code Quality** — adherence to codebase patterns, readability, performance, duplicate/redundant code (must cite two distinct line labels). Do not flag test framework function choice (test/it/describe/expect) as inconsistency.

A separate **PR Review chat** workflow (`pr_review_chat`) supports interactive follow-up after the report — the chat agent can re-read the worktree via the same tool callbacks and stream replies token-by-token to the frontend.

---

## Address PR Comments: Worktree

Uses a **dedicated third worktree** (`pr_address_worktree_path`), separate from the implementation and PR review worktrees to prevent branch conflicts when all three workflows run simultaneously. Falls back to `pr_review_worktree_path`, then `repo_worktree_path`. Branch is always checked out fresh from `origin/<branch>` before analysis. Fixes are written via the worktree write tool, sandboxed to the worktree root.

The workflow is split: a one-shot `analyze_pr_comments` workflow produces a structured fix plan from the diff + reviewer comments; an `address_pr_chat` workflow streams interactive replies and runs a tool loop when the engineer asks the agent to revise or apply specific fixes.

---

## Codebase Access (Worktree)

All agents operate against a **local git worktree**, not the Bitbucket API.

**Configuration** (in Meridian's settings store):
- `repo_worktree_path` — absolute path to the worktree (e.g. `/Users/you/REPOS/MyRepo-meridian`)
- `repo_base_branch` — branch the worktree tracks (default: `develop`)

**Pipeline startup**:
1. Validate `repo_worktree_path` is set and is a valid git worktree
2. Run `git -C <path> fetch origin && git -C <path> reset --hard origin/<base_branch>`
3. Record `{ worktreePath, headCommit }` in the pipeline session
4. Pass `worktreePath` to every agent as the root for all file operations

**Agent tools** — defined as LangGraph tools in the sidecar, executed by callback into the Rust backend over IPC, sandboxed to `worktreePath`:
- `glob_repo_files(pattern)`
- `grep_repo_files(pattern, path?)`
- `read_repo_file(path)`
- `write_repo_file(path, content)` — Implementation, Test Generation, Build-fix, Implementation chat, and Address PR Chat agents only
- `get_repo_diff()` — used by the Code Review and PR Description agents and the Address PR fix workflows. Diffs against `repo_base_branch` configured in settings.

A separate `exec_in_worktree(command, timeoutSecs?)` IPC callback runs an arbitrary shell command inside the worktree. It is **not** registered as a regular agent tool — only the build-check sub-loop calls it directly, with a fixed budget.

---

## Credential & Security Rules

- All credentials stored via **Tauri's secure OS keychain** — never written to disk in plaintext.
- Credentials are **never passed to the React frontend** — read in the Rust backend only.
- Credentials are passed to the sidecar **per-request over stdio IPC** — the sidecar never caches them across calls and never logs them.
- No credential ever appears in a Tauri command response to the frontend.
- Never use environment variables for credentials — all entered via the UI settings screen.
- Never expose raw credential values in logs or error messages.

**Credentials in use**: Anthropic API key **or** Claude.ai subscription OAuth tokens, JIRA Base URL + Email + API Token, Bitbucket Workspace + Username + App Password, Google API key **or** Google OAuth (CodeAssist), GitHub Copilot OAuth tokens, Ollama base URL (no auth).

**Claude.ai subscription support is a first-class auth mode**, not a side-feature. OAuth tokens (`sk-ant-oat01-…`) must be usable for **every workflow**. Anthropic's subscription endpoint requires the request to look like it originated from the Claude Code CLI — specifically: bearer-token auth, `system[]` array with a computed `x-anthropic-billing-header` and the Claude Code identity string, and the caller's actual system prompt prepended into the first user message. This envelope is implemented in the sidecar's custom Anthropic OAuth model adapter (`src-sidecar/src/models/anthropic-oauth.ts`); standard `@langchain/anthropic` does not handle it.

---

## General Guidelines

- **TypeScript throughout** the frontend and sidecar; **Rust** for backend, IPC, filesystem, and credential boundaries.
- **Structured outputs (JSON)** for all inter-agent handoffs, validated with Zod schemas in the sidecar — keeps the pipeline type-safe end-to-end.
- **shadcn/ui components** for all UI — do not build custom components where shadcn/ui has a suitable option.
- **Consistent Tailwind theme** via CSS variables — do not hardcode colours.
- **LLM-neutral UI copy** — say "AI", not "Claude". The app supports multiple providers.
- **Token-usage tracking** — LangChain.js model calls return usage metadata per invocation; the sidecar emits `{ inputTokens, outputTokens }` alongside each workflow result.
- **No LLM calls from the frontend or Rust backend** — every model call goes through the sidecar.
- **Workflow logic lives in the sidecar** — every workflow is a LangGraph `StateGraph` or a thin runner around the shared single-shot scaffold. Rust orchestration is reduced to triggering runs and ferrying interrupts/results.

---

## PipelineProgress Component

**File**: `src/components/PipelineProgress.tsx`

Dual-mode animated SVG (960×116 viewBox). Renders the Meridian logo when idle; expands into a pipeline progress indicator during the Implement a Ticket workflow. Full documentation (geometry, constants, animation logic, what not to change) in [`docs/PipelineProgress.md`](docs/PipelineProgress.md).
