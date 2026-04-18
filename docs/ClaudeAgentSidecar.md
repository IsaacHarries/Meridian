# Claude Agent Sidecar — Implementation Plan

## Goal

Replace Meridian's direct `api.anthropic.com` HTTP calls (in `src-tauri/src/commands/claude.rs`) with a Node.js sidecar process that uses the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). This mirrors exactly how `@agentclientprotocol/claude-agent-acp` works in Zed, giving Meridian access to the same Claude Pro/Max rate limit pool and the full agentic loop (tool use, session resumption, multi-turn).

---

## How `claude-agent-acp` Actually Works (from source)

The installed adapter at `~/Library/Application Support/Zed/node/cache/_npx/.../dist/` reveals:

1. **Entry point (`index.js`)** — redirects stdout→stderr (so JSON-RPC over stdio is clean), then calls `runAcp()`.
2. **`acp-agent.js`** — the core. It imports two things:
   - `query` from `@anthropic-ai/claude-agent-sdk` — runs a Claude Code agent session
   - `AgentSideConnection` from `@agentclientprotocol/sdk` — handles the ACP JSON-RPC protocol over stdin/stdout
3. **Session lifecycle** — `loadSession` / `resumeSession` spin up a `query()` call with a given `cwd`, system prompt, and MCP servers. A session fingerprint detects when parameters change and tears down / recreates the process.
4. **Streaming** — each `query()` emits typed events (`text`, `tool_use`, `tool_result`, etc.) which the adapter translates into ACP `agentOutput` messages streamed back over JSON-RPC.
5. **Authentication** — zero explicit auth code. The SDK uses `~/.claude/` credentials automatically (the same session Claude Code CLI uses).

Meridian does **not** need the ACP protocol layer — that exists so any editor can plug in. We own both sides, so we can talk to the sidecar directly over a simpler interface.

---

## Architecture

```
React UI (TypeScript)
    ↕  Tauri invoke / events (unchanged)
Tauri Rust backend
    ↕  spawn + stdin/stdout JSON-RPC (new)
Node.js Sidecar  (src-sidecar/index.ts)
    ↕  @anthropic-ai/claude-agent-sdk query()
Claude Code CLI session  (~/.claude/)
    ↕  Claude Pro/Max API
```

The sidecar is a long-lived Node.js process spawned once at app start. The Rust backend sends JSON requests on stdin and receives streaming JSON responses on stdout — a simple line-delimited protocol we define ourselves (no ACP needed).

---

## Sidecar Protocol (stdin/stdout, newline-delimited JSON)

### Request (Rust → Sidecar)

```json
{
  "id": "uuid-v4",
  "type": "query",
  "system": "You are the Grooming Agent...",
  "messages": [{ "role": "user", "content": "..." }],
  "model": "claude-sonnet-4-6",
  "cwd": "/Users/isaac/REPOS/MyProject-meridian",
  "sessionId": null
}
```

- `sessionId`: pass `null` to start fresh; pass a prior session ID to resume (useful for triage agent back-and-forth).
- `cwd`: working directory for the agent (the repo worktree path).
- `messages`: full conversation history for multi-turn stages.

### Response events (Sidecar → Rust, one JSON object per line)

```json
{ "id": "uuid-v4", "type": "text",   "delta": "Hello, here is my analysis..." }
{ "id": "uuid-v4", "type": "tool",   "name": "read_file", "input": {...} }
{ "id": "uuid-v4", "type": "result", "sessionId": "...", "costUsd": 0.04, "inputTokens": 1200, "outputTokens": 340 }
{ "id": "uuid-v4", "type": "error",  "message": "..." }
```

The Rust backend:
- Emits Tauri events for `text` deltas (same `{ "delta": "..." }` format the frontend already consumes).
- Stores `sessionId` from `result` for triage agent resumption.
- Surfaces `error` as the existing stage error state.

---

## Implementation Steps

### Step 1 — Create the sidecar package

```
src-sidecar/
  package.json
  tsconfig.json
  index.ts          ← entry point
  agent.ts          ← wraps claude-agent-sdk query()
  protocol.ts       ← types for the JSON-RPC messages
```

`package.json` dependencies:
```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest"
  }
}
```

**`index.ts`** — read stdin line by line, dispatch to `agent.ts`, write response events to stdout:

```typescript
import * as readline from "node:readline";
import { runQuery } from "./agent.js";

// Silence console.log so it doesn't corrupt the stdout protocol
console.log = console.error;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  let req: QueryRequest;
  try { req = JSON.parse(line); } catch { return; }

  for await (const event of runQuery(req)) {
    process.stdout.write(JSON.stringify(event) + "\n");
  }
});
```

**`agent.ts`** — call `query()` from the SDK and yield typed events:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

export async function* runQuery(req: QueryRequest): AsyncGenerator<ResponseEvent> {
  try {
    for await (const event of query({
      prompt: formatMessages(req.messages),
      options: {
        model: req.model,
        systemPrompt: req.system,
        cwd: req.cwd,
        // resume: req.sessionId ?? undefined,  // enable for triage agent
      },
    })) {
      if (event.type === "text") {
        yield { id: req.id, type: "text", delta: event.text };
      }
      // surface tool events if useful for UI later
    }
    // yield result with session ID and cost
    yield { id: req.id, type: "result", sessionId: "...", costUsd: 0, inputTokens: 0, outputTokens: 0 };
  } catch (err) {
    yield { id: req.id, type: "error", message: String(err) };
  }
}
```

> **Note:** Check the actual `query()` API shape in `@anthropic-ai/claude-agent-sdk` — the options object and event types need to match the installed version. The source is at `~/Library/Application Support/Zed/node/cache/_npx/.../node_modules/@anthropic-ai/claude-agent-sdk/`.

### Step 2 — Build the sidecar into a binary

Use `bun build --compile` or `pkg` to produce a standalone executable that Tauri can bundle:

```bash
bun build src-sidecar/index.ts --compile --outfile src-tauri/binaries/claude-agent-sidecar-aarch64-apple-darwin
```

Tauri requires sidecar binaries to be named with the target triple. Add to `tauri.conf.json`:

```json
{
  "bundle": {
    "externalBin": ["binaries/claude-agent-sidecar"]
  }
}
```

### Step 3 — Rust sidecar manager (`src-tauri/src/sidecar.rs`)

```rust
// Spawn the sidecar once at app start, keep a handle in AppState.
// Send requests via child.stdin, read responses via child.stdout.
// Route text deltas to Tauri events, route results/errors back to the caller.
```

Key Tauri APIs:
- `tauri::api::process::Command` (Tauri v1) or `tauri_plugin_shell::process` (Tauri v2) for sidecar spawning with the bundled binary path.
- `app.manage(SidecarState { ... })` to hold the child handle and a pending-request map.

### Step 4 — Wire into existing dispatch functions

In `claude.rs`, when `claude_auth_method == "oauth"`, call the sidecar instead of `complete_via_claude_cli_streaming`. The sidecar call replaces the current CLI subprocess approach with a persistent, SDK-backed process.

```rust
// Current (interim) approach:
complete_via_claude_cli_streaming(app, system, user, model, stream_event).await

// Target approach:
sidecar::dispatch(app, system, messages, model, cwd, stream_event).await
```

### Step 5 — Remove interim CLI subprocess code

Once the sidecar is working, remove:
- `complete_via_claude_cli` 
- `complete_via_claude_cli_streaming`
- `flatten_history_for_cli`
- The `oauth` branches in `dispatch_streaming`, `dispatch_multi_streaming`, `dispatch_multi_streaming_with_tools`, `try_provider_single`, `try_provider_multi`

Replace all of them with a single `sidecar::dispatch` call.

---

## Key Files to Reference

| File | Purpose |
|------|---------|
| `~/Library/Application Support/Zed/node/cache/_npx/6d0246552550f0f3/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js` | Full source of the adapter — session management, streaming, tool handling |
| `~/Library/Application Support/Zed/node/cache/_npx/6d0246552550f0f3/node_modules/@anthropic-ai/claude-agent-sdk/` | The SDK itself — check `query()` types here |
| `src-tauri/src/commands/claude.rs` | All current dispatch functions to be replaced |
| `src-tauri/tauri.conf.json` | Bundle config for the sidecar binary |

---

## What This Unlocks vs the Current Interim Approach

| | Interim (claude -p subprocess) | Full sidecar |
|---|---|---|
| Auth | ✅ Pro/Max session | ✅ Pro/Max session |
| Rate limits | ✅ Same pool as Claude Code | ✅ Same pool as Claude Code |
| Streaming | ✅ (text arrives at once per turn) | ✅ True token-level streaming |
| Tool use | ❌ | ✅ (bash, file ops, etc.) |
| Session resumption | ❌ | ✅ (triage back-and-forth) |
| Process overhead | ⚠️ New process per call | ✅ One persistent process |
| Multi-turn history | ⚠️ Flattened string | ✅ Native message array |

---

## Notes

- The `@anthropic-ai/claude-agent-sdk` package is separate from `@anthropic-ai/sdk` (the plain API client). It's the one that runs the full Claude Code agent loop.
- The SDK finds credentials from `~/.claude/` automatically — no API key needed in the sidecar at all.
- For the Gemini / Local LLM fallback providers, keep the existing Rust HTTP code. The sidecar is only for the `oauth` / Claude Pro path.
- Session resumption with `resume` is how the triage agent can have a real back-and-forth conversation rather than passing a flattened history string.
