# Meridian — Code Cleanup & Testing Plan

This document is a self-contained implementation guide for an AI agent.
It is structured into phases that can be parallelised using `/batch` mode in Claude Code.
Each task is scoped to specific files so there are no write-conflicts between parallel tasks.

---

## How to use this plan with `/batch` mode

`/batch <instruction>` takes a natural language instruction, decomposes it into independent units, and runs each in its own isolated git worktree (separate branch, no inter-agent conflicts). You review the decomposition plan before any agents run.

Use it for phases where tasks touch **different files** — the agents cannot coordinate, so tasks that depend on each other must be run sequentially.

Each phase below includes the exact `/batch` prompt to paste into Claude Code.

---

## Phase 1 — Quick Wins (run in parallel with `/batch`)

These 4 tasks touch completely different files. Paste this prompt into Claude Code:

```
/batch Complete 4 independent cleanup tasks in the Meridian codebase at /Users/isaac/REPOS/Meridian. Run them in parallel — they touch different files and have no dependencies on each other.

Task 1 — Fix Rust compiler warnings:
In src-tauri/src/commands/claude.rs: remove the dead function `dispatch_multi_streaming` (around line 807) and `parse_history_to_sidecar_messages` (around line 988) — confirm they are never called before deleting. Prefix the two unused `app` parameters (lines ~2699 and ~2734) with an underscore: `_app`. In src-tauri/src/commands/preferences.rs: remove the unused `OnceLock` import on line 13. Run `cargo build` in src-tauri/ and confirm zero warnings about these items.

Task 2 — Set up Vitest test infrastructure:
Install dev dependencies: `npm install --save-dev vitest @vitest/ui jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event`. Create `vitest.config.ts` in the project root with: environment='jsdom', globals=true, setupFiles=['src/__tests__/setup.ts'], resolve alias '@' pointing to './src'. Create `src/__tests__/setup.ts` that imports '@testing-library/jest-dom'. Create a Tauri mock at `src/__mocks__/@tauri-apps/api/core.ts` that exports a vi.fn() `invoke` returning Promise.resolve(null). Add "test": "vitest run" and "test:watch": "vitest" to package.json scripts. Create `src/__tests__/smoke.test.ts` asserting 1+1===2 and run it to confirm setup works.

Task 3 — Remove debug console statements:
Remove console.log() debug calls from these files (keep console.error() safety nets and keep all console.warn() in src/lib/storeCache.ts): src/screens/SettingsScreen.tsx (~lines 1108, 1110), src/screens/TicketQualityScreen.tsx (~line 552), src/screens/AgentSkillsScreen.tsx (~lines 105, 128, 149), src/screens/KnowledgeBaseScreen.tsx (~line 472), src/components/ToolRequestCard.tsx (~line 53), src/stores/implementTicketStore.ts (~lines 616, 677), src/lib/tauri.ts (~line 77). For any catch block left with no error handling after removal, add `// error intentionally swallowed`. Run `npx tsc --noEmit` to confirm no type errors.

Task 4 — Fix the `as any` type assertion:
In src/screens/ImplementTicketScreen.tsx find the `as any` cast (~line 2068, inside an onClickStage handler). Read the store to find the correct type for `viewingStage`, then replace `as any` with the proper type. Run `npx tsc --noEmit` to confirm.
```

---

## Phase 2 — Pure Logic Tests (run in parallel with `/batch`)

**Prerequisite**: Phase 1 Task 2 (Vitest setup) must be merged first.

```
/batch Write 3 independent test suites for the Meridian codebase at /Users/isaac/REPOS/Meridian. Run them in parallel — each creates a new file with no conflicts.

Task 1 — workloadClassifier tests:
Create src/__tests__/lib/workloadClassifier.test.ts. The module src/lib/workloadClassifier.ts has NO Tauri dependency — import and test it directly. The function classifyWorkloads(issues, openPrs) takes JiraIssue[] and BitbucketPr[] and returns DevWorkload[]. Build minimal fixture objects inline. Cover: (1) empty input returns []. (2) all-zero story points — nobody overloaded or underutilised. (3) average computed only from devs with >0 pts (zero-pt dev doesn't skew baseline). (4) remainingTickets > 140% of average → 'overloaded'. (5) remainingTickets < 60% of average → 'underutilised'. (6) exactly 140% → 'balanced' (strict boundary). (7) exactly 60% → 'balanced'. (8) single dev with points → no classification (needs withWork.length > 1). (9) reviewCount counts PRs where dev is a reviewer. (10) issues with no assignee group under 'Unassigned'. Run `npm test` to confirm all pass.

Task 2 — storeCache tests:
Create src/__tests__/lib/storeCache.test.ts. The file src/lib/storeCache.ts has two pure functions (replacer, reviver) and two Tauri-dependent functions (loadCache, saveCache). Test replacer/reviver directly. For loadCache/saveCache, mock '@tauri-apps/api/core' invoke. Tests: replacer serialises Set to {__set:[...]} and Map to {__map:[[k,v]...]}. reviver reconstructs Set and Map. Set+Map round-trip through JSON.stringify/parse. loadCache returns null on empty/null Tauri response. loadCache returns null (no throw) on malformed JSON. loadCache returns parsed object on valid JSON. saveCache: use vi.useFakeTimers() — verify Tauri is NOT called before delay, IS called after delay, and multiple rapid calls produce only ONE Tauri call. Run `npm test` to confirm all pass.

Task 3 — Rust PKCE tests:
Add a #[cfg(test)] module at the bottom of src-tauri/src/commands/validate.rs testing the private helpers: generate_random_base64url, sha256_base64url, percent_encode, percent_decode. Tests: generate_random_base64url(32) produces 43 chars of URL-safe base64. generate_random_base64url(16) produces 22 chars. Two calls produce different output. sha256_base64url("hello") matches the known SHA-256 of "hello" base64url-encoded. percent_encode turns spaces to %20, / to %2F, : to %3A, leaves A-Z a-z 0-9 - _ . ~ unchanged. percent_decode reverses %20→space, %3A→colon, +→space. Encoded+decoded strings round-trip. Run `cargo test` in src-tauri/ to confirm all pass.
```

---

## Phase 3 — Store Tests (run in parallel with `/batch`)

**Prerequisite**: Phase 1 Task 2 (Vitest setup) must be merged.

```
/batch Write 2 independent Zustand store test suites for the Meridian codebase at /Users/isaac/REPOS/Meridian. Run them in parallel — each creates a new file.

Task 1 — workloadAlertStore tests:
Create src/__tests__/stores/workloadAlertStore.test.ts. First read src/stores/workloadAlertStore.ts to understand its shape. Mock all Tauri invocations. Test: initial state has no alerts and is not loading. Setting workload data updates badge count correctly. Alert state clears correctly. Store handles empty/null Tauri responses without throwing. Focus on pure state logic, not polling intervals. Run `npm test` to confirm all pass.

Task 2 — implementTicketStore tests:
Create src/__tests__/stores/implementTicketStore.test.ts. First read src/stores/implementTicketStore.ts (it is ~1174 lines). Mock all Tauri commands and all @tauri-apps/api/event listeners. Focus on the 6 highest-regression-risk behaviours: (1) snapshotSession() copies all required fields from state. (2) startPipeline() generates a new activeSessionId UUID each call — two consecutive calls must produce different IDs. (3) After grooming data is set, currentStage advances correctly. (4) setError() sets the error message and resets loading flags. (5) Incomplete grooming session (grooming===null AND stage==='grooming') is NOT written to the cache — verify the guard condition. (6) A completed grooming session IS persisted. If any test requires too much internal wiring, note it with a comment explaining what would need integration-level testing instead. Run `npm test` to confirm all pass.
```

---

## Phase 4 — Manual / Sequential Tasks

These tasks are NOT suitable for batch mode because they require judgment, are risky, or are sequential.
Run them one at a time and review the output before proceeding.

### Task 4.1 — Add CI test script (run directly in Claude Code, not via /batch)

```
In /Users/isaac/REPOS/Meridian/package.json add "test:ci": "vitest run --reporter=verbose". Confirm `npm run test:ci` passes all tests. Then confirm `cd src-tauri && cargo test` runs the Rust tests added in Phase 2. Do not create any new test files — just wire up the scripts.
```

### Task 4.2 — Verify everything still builds (run directly, not via /batch)

```
In /Users/isaac/REPOS/Meridian run: npx tsc --noEmit && npm run build && cd src-tauri && cargo build. Fix any issues introduced by the earlier phases. Report what (if anything) needed fixing.
```

---

## What is intentionally NOT in this plan

| Area | Reason excluded |
|------|----------------|
| Large file refactors (PrReviewScreen, SettingsScreen, ImplementTicketScreen) | Too risky to batch; these 2000+ line screens are working correctly. Refactor only when a screen needs a new feature. |
| E2E / UI tests | High maintenance cost, require a running Tauri app. Not worth it yet. |
| prReviewStore tests | The store has deep Tauri event listener dependencies that make unit testing impractical without significant mocking infrastructure. Add when the mocking setup is mature. |
| MCP server integration | Assessed separately — not appropriate for this app. |
| claude.rs tests | At 4155 lines with streaming, network, and subprocess dependencies, meaningful unit tests require significant test harness work. Prioritise after store tests are established. |

---

## Expected outcomes

After all phases complete:

- Zero Rust compiler warnings
- No debug `console.log` pollution in production builds
- Full type safety (zero `as any`)
- Vitest running with `npm test`
- ~25 passing test cases covering the highest-regression-risk logic
- Rust PKCE tests passing with `cargo test`
