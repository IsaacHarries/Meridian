// Implement-Ticket Orchestrator workflow — entrypoint.
//
// A long-lived chat agent that survives across the entire ticket lifecycle.
// Unlike the per-stage `checkpoint_chat` workflow this replaces, the
// orchestrator carries its own message thread + summarised stage history +
// persistent user notes via a LangGraph SQLite checkpointer.
//
// Architecture:
//   - One persistent thread per ticket (orchestratorThreadId, distinct from
//     the sibling implementation_pipeline thread that drives stages).
//   - Single chat node + tool loop. Each user message is one graph invocation
//     with `pendingUserMessage` set; the node consumes it, runs the model,
//     appends both turns to `thread`, then ends.
//   - Subsequent invocations on the same thread_id rehydrate the prior state
//     from the checkpointer; the `thread` reducer appends new turns.
//
// Step-2 capabilities:
//   - Repo-inspection tools (glob/grep/read/diff) — same set sub-agents use.
//   - `get_pipeline_state` — reads the sibling pipeline workflow's checkpoint
//     so the orchestrator can ground review without the frontend supplying
//     contextText every turn.
//   - `propose_*` pipeline-control tools — they DO NOT execute the pipeline
//     action; they write a `pendingProposal` to orchestrator state. The
//     frontend renders a confirm card; the user accepts or rejects; the
//     pipeline is then resumed via the existing Tauri command. This honours
//     the "all mutations require user confirmation" guardrail.
//   - Reviewer-style turns: when the runner is invoked with
//     `messageKind: "system_note"`, the synthesised message is rendered in
//     the chat thread as an inline marker (e.g. "Pipeline reached impact —
//     reviewing…") rather than a user bubble.
//
// Implementation lives under `./orchestrator/`. This file is now strictly the
// `buildOrchestratorGraph` entrypoint — every other symbol must be imported
// directly from its defining submodule.

export { buildOrchestratorGraph } from "./orchestrator/graph.js";
