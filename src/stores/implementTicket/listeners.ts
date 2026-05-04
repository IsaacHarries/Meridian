/**
 * Module-level side effects for the Implement-a-Ticket store:
 *  - the long-lived Tauri pipeline-event listener
 *  - HMR teardown of the listener
 *  - the streaming-partials runtime gate
 *  - file-backed persistence subscription + hydration
 */

import { getAppPreferences } from "@/lib/appPreferences";
import { loadCache, saveCache } from "@/lib/storeCache";
import { useAiSelectionStore } from "@/stores/aiSelectionStore";
import {
    modelKey,
    useTokenUsageStore,
    type RateLimitSnapshot,
} from "@/stores/tokenUsageStore";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

import { PIPELINE_EVENT_NAME, type PipelineEvent } from "@/lib/tauri/workflows";
import { IMPLEMENT_STORE_KEY, NODE_TO_PARTIAL_FIELD, NODE_TO_STAGE, NODE_TO_STREAM_FIELD } from "./constants";
import { applyInterruptToState, serializableState, setPendingResume } from "./helpers";
import { useImplementTicketStore } from "./store";
import type { ImplementTicketState, PipelineSession, Stage } from "./types";

// ── Pipeline workflow event wiring ────────────────────────────────────────────
//
// The implementation pipeline runs as a single LangGraph workflow in the
// sidecar. We dispatch one `runImplementationPipelineWorkflow` to start the
// run, then subscribe to PIPELINE_EVENT_NAME events to learn about progress
// and interrupts. On each interrupt the relevant store slice is updated and
// `pendingApproval` is set so the UI can render the checkpoint.

let pipelineUnlisten: (() => void) | null = null;

// Vite HMR replaces this module on save — drop the old listener so the
// fresh module's `ensurePipelineListener` re-subscribes against the
// (potentially recreated) store instance. Without this, the old listener
// keeps writing to a stale store and the UI sees no updates until reload.
if (
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { hot?: { dispose?: (cb: () => void) => void } })
    .hot
) {
  (
    import.meta as unknown as { hot: { dispose: (cb: () => void) => void } }
  ).hot.dispose(() => {
    if (pipelineUnlisten) {
      pipelineUnlisten();
      pipelineUnlisten = null;
    }
  });
}

/** Module-level flag the pipeline listener consults to decide whether
 *  to surface streamed partial-JSON events into the per-stage panels.
 *  Hydrated from preferences at startup; updated live when the user
 *  toggles the Settings switch. False means skip the partial path
 *  entirely — the panel still streams text via the existing
 *  `*StreamText` fields, but the structured panel only renders once
 *  the final output lands. */
let streamingPartialsEnabled = true;

export function setStreamingPartialsEnabledRuntime(enabled: boolean): void {
  streamingPartialsEnabled = enabled;
}

export async function ensurePipelineListener(): Promise<void> {
  if (pipelineUnlisten) return;
  pipelineUnlisten = await listen<PipelineEvent>(
    PIPELINE_EVENT_NAME,
    (event) => {
      const e = event.payload;
      // Always go through the live store API rather than a captured set —
      // Vite HMR can replace the create() closure during development and
      // leave us writing to a stale store instance.
      const setState = useImplementTicketStore.setState;
      const updaterAdapter = (
        updater: (s: ImplementTicketState) => Partial<ImplementTicketState>,
      ) => {
        setState((s) => updater(s));
      };

      // Stale-event guard: each pipeline event carries the runId of the
      // workflow.start/resume/rewind call that produced it. If the user
      // has since cancelled / superseded that run (e.g. via Retry at an
      // earlier stage), `currentRunId` won't match and the event is
      // dropped — otherwise the orphan run's late-arriving interrupt
      // would jump the UI back to a later stage. We do allow events
      // through when currentRunId is null, since some store consumers
      // (e.g. session-restore) may not have set it yet.
      const eventRunId = (e as { runId?: string }).runId;
      const expectedRunId = useImplementTicketStore.getState().currentRunId;
      if (expectedRunId && eventRunId && eventRunId !== expectedRunId) {
        return;
      }

      if (e.kind === "progress" && e.status === "started") {
        // Anthropic rate-limit headers forwarded from the sidecar's
        // OAuth fetch interceptor. Updates the per-provider snapshot so
        // the HeaderModelPicker can render % remaining + reset time.
        const rateData = e.data as
          | {
              rateLimits?: { provider?: string; snapshot?: RateLimitSnapshot };
            }
          | undefined;
        if (
          rateData?.rateLimits?.provider &&
          rateData.rateLimits.snapshot &&
          typeof rateData.rateLimits.snapshot === "object"
        ) {
          useTokenUsageStore
            .getState()
            .setRateLimits(
              rateData.rateLimits.provider,
              rateData.rateLimits.snapshot,
            );
          return;
        }

        // Live token-usage stream — keeps the panel header's
        // TokenUsageBadge climbing as the model emits chunks instead of
        // staying frozen until the call's final usage lands. Buckets
        // the running total against the active panel model so the
        // HeaderModelPicker dropdown shows per-model spend live.
        const usageData = e.data as
          | {
              usagePartial?: { inputTokens?: number; outputTokens?: number };
            }
          | undefined;
        if (
          usageData?.usagePartial &&
          typeof usageData.usagePartial === "object"
        ) {
          const inputTokens = usageData.usagePartial.inputTokens ?? 0;
          const outputTokens = usageData.usagePartial.outputTokens ?? 0;
          // Per-stage model resolution — implement-ticket is the one
          // panel where each stage can override its provider/model, so
          // bucket against whatever model is active for the current
          // stage.
          let mk: string | undefined;
          try {
            const ai = useAiSelectionStore.getState();
            const stageHint = useImplementTicketStore.getState().currentStage;
            const validStage =
              stageHint === "grooming" ||
              stageHint === "impact" ||
              stageHint === "triage" ||
              stageHint === "plan" ||
              stageHint === "implementation" ||
              stageHint === "review" ||
              stageHint === "pr" ||
              stageHint === "retro"
                ? stageHint
                : stageHint === "tests_plan" || stageHint === "tests"
                  ? "tests"
                  : null;
            const r = ai.resolve("implement_ticket", validStage);
            if (r.model) mk = modelKey(r.provider, r.model);
          } catch {
            /* hydration race — fall back to panel-only bucket */
          }
          useTokenUsageStore
            .getState()
            .setCurrentCallUsage(
              "implement_ticket",
              { inputTokens, outputTokens },
              mk,
            );
          return;
        }

        // Live partial-JSON streaming from any node that uses
        // `streamLLMJson` in the sidecar — surfaces a partial output as
        // the model emits tokens so the UI can render fields incrementally
        // instead of waiting for the full reply (mirrors PR Review's
        // `partialReport`).
        const partialData = e.data as { partial?: unknown } | undefined;
        const partialField = NODE_TO_PARTIAL_FIELD[e.node];
        if (
          streamingPartialsEnabled &&
          partialField &&
          partialData?.partial &&
          typeof partialData.partial === "object"
        ) {
          setState({
            [partialField]: partialData.partial,
          } as Partial<ImplementTicketState>);
          return;
        }

        // Per-file implementation progress: update the implementationProgress
        // field so the loading UI can show "Writing src/cli.ts (3/8)…".
        const data = e.data as
          | {
              phase?: string;
              file?: string;
              fileIndex?: number;
              totalFiles?: number;
              tool?: { name?: string; arg?: string };
            }
          | undefined;
        if (
          e.node === "implementation" &&
          data?.phase === "file_started" &&
          typeof data.file === "string" &&
          typeof data.fileIndex === "number" &&
          typeof data.totalFiles === "number"
        ) {
          setState({
            implementationProgress: {
              file: data.file,
              fileIndex: data.fileIndex,
              totalFiles: data.totalFiles,
            },
            pipelineActivity: {
              node: "implementation",
              file: data.file,
              fileIndex: data.fileIndex,
              totalFiles: data.totalFiles,
            },
          });
          return;
        }

        // Tool-call progress: emitted by repo-tools.ts before/after each
        // read/write/grep/glob. Updates the activity strip with the
        // currently-running tool so the user sees per-iteration progress
        // inside a single Implementation file. Cleared on `completed`
        // status so the strip falls back to the file-level summary
        // between tool calls.
        if (
          e.node === "tool" &&
          data?.tool &&
          typeof data.tool.name === "string"
        ) {
          const toolName = data.tool.name;
          const toolArg = data.tool.arg ?? "";
          setState((s) => {
            const prior = s.pipelineActivity;
            const next: ImplementTicketState["pipelineActivity"] = prior
              ? { ...prior }
              : { node: "implementation" };
            if (e.status === "started") {
              next.tool = toolName;
              next.toolArg = toolArg;
            } else {
              // status === "completed" — clear tool so the strip falls
              // back to the file/stage summary between calls.
              next.tool = undefined;
              next.toolArg = undefined;
            }
            return { pipelineActivity: next };
          });
          return;
        }

        const stage = NODE_TO_STAGE[e.node];
        if (stage && stage !== "select") {
          setState((s) => {
            const updates: Partial<ImplementTicketState> = {
              currentStage: stage,
              viewingStage: stage as Exclude<Stage, "select">,
              // Reset the activity strip to the new stage; per-file +
              // per-tool details get layered on by subsequent events.
              pipelineActivity: { node: e.node },
            };
            const streamField = NODE_TO_STREAM_FIELD[e.node];
            if (streamField) {
              (updates as Record<string, unknown>)[streamField] = "";
            }
            void s;
            return updates;
          });
        }
      } else if (e.kind === "stream") {
        const streamField = NODE_TO_STREAM_FIELD[e.node];
        if (streamField) {
          setState((s) => {
            const current = (s[streamField] as string | undefined) ?? "";
            return {
              [streamField]: current + e.delta,
            } as Partial<ImplementTicketState>;
          });
        }
      } else if (e.kind === "interrupt") {
        console.log(
          `[Meridian] pipeline interrupt: reason=${e.reason} payload=`,
          e.payload,
        );
        applyInterruptToState(updaterAdapter, e.reason, e.payload);
        setState({ pipelineThreadId: e.threadId, pipelineActivity: null });
        // Optional toast — fires once per interrupt when the user has
        // opted in. Useful when stepping away mid-run; the document-
        // hidden guard skips when the panel is in the foreground.
        if (typeof document !== "undefined" && document.hidden) {
          const reason = e.reason;
          void getAppPreferences().then((p) => {
            if (p.notifyAgentStageComplete) {
              toast.message(`Stage finished: ${reason}`, {
                description:
                  "Ready for your review in the Implement Ticket panel.",
              });
            }
          });
        }
      }
    },
  );
}

// ── File-backed persistence ─────────────────────────────────────────────────

/**
 * Hydrate the store from the file cache.
 * Call this once on app startup (e.g. from App.tsx or a boot hook).
 */
export async function hydrateImplementStore(): Promise<void> {
  const cached = await loadCache<ImplementTicketState>(IMPLEMENT_STORE_KEY);
  if (!cached) return;
  // Ensure non-serialisable types are always correct instances
  const completedStages =
    cached.completedStages instanceof Set
      ? cached.completedStages
      : new Set((cached.completedStages as unknown as Stage[]) ?? []);
  const sessions =
    cached.sessions instanceof Map
      ? cached.sessions
      : new Map(
          Object.entries(
            (cached.sessions ?? {}) as Record<string, PipelineSession>,
          ),
        );

  // Detect zombie mid-run stages — the Tauri command that was running when the app closed
  // is gone, but the store thinks it's still in progress. Record which stage needs to be
  // resumed so the screen can auto-rerun it when the user navigates back.
  const stage = cached.currentStage as Stage;
  if (stage && stage !== "select" && stage !== "complete") {
    const outputMissing =
      (stage === "grooming" && !cached.grooming) ||
      (stage === "impact" && !cached.impact) ||
      (stage === "plan" && !cached.plan) ||
      (stage === "implementation" && !cached.implementation) ||
      (stage === "tests" && !cached.tests) ||
      (stage === "review" && !cached.review) ||
      (stage === "pr" && !cached.prDescription) ||
      (stage === "retro" && !cached.retrospective);
    if (outputMissing && cached.pendingApproval !== stage) {
      setPendingResume(stage);
    }
  }

  // Discard tests data in the old plan format (pre-tool-loop) — it used `test_strategy`
  // instead of `files_written` and would crash TestsPanel on render.
  const tests =
    cached.tests && "files_written" in cached.tests ? cached.tests : null;

  useImplementTicketStore.setState({
    ...cached,
    tests,
    completedStages,
    sessions,
    // Fresh ID on hydration — no backend process from a prior app run is still alive.
    activeSessionId: crypto.randomUUID(),
  });
}

// Subscribe and save on every state change (debounced).
useImplementTicketStore.subscribe((state) => {
  saveCache(IMPLEMENT_STORE_KEY, serializableState(state));
});
