// Workflow checkpointer.
//
// The implementation pipeline (Phase 3) requires interrupted runs to survive
// app restarts — a triage conversation paused for human input shouldn't
// disappear when the user closes the laptop. We back the checkpointer with
// SQLite at a path Rust passes via the MERIDIAN_CHECKPOINT_DB env var (it's
// typically <app data>/meridian-checkpoints.db).
//
// In test or dev contexts where the env var is absent we fall back to an
// in-memory saver so unit tests don't touch the disk.

import { MemorySaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

let cached: MemorySaver | SqliteSaver | undefined;

export function getCheckpointer(): MemorySaver | SqliteSaver {
  if (cached) return cached;
  const dbPath = process.env.MERIDIAN_CHECKPOINT_DB;
  if (dbPath && dbPath.trim().length > 0) {
    cached = SqliteSaver.fromConnString(dbPath);
  } else {
    cached = new MemorySaver();
  }
  return cached;
}

/** @deprecated prefer getCheckpointer() so the SQLite path is honoured */
export const checkpointer = getCheckpointer();
