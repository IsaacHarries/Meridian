import { type ToolRequest } from "@/components/ToolRequestCard";
import { useImplementTicketStore } from "@/stores/implementTicket/store";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

/**
 * Wires up the long-running Tauri event listeners that pipe sidecar
 * progress / streaming text events into the implementTicketStore.
 *
 * The listeners are session-aware: each one captures the active session
 * id at event time and silently drops writes for stale sessions, which
 * prevents in-flight tokens from a cancelled run polluting a new ticket's
 * panels.
 *
 * Tool-request prompts are surfaced via local state on the screen, so
 * the setter is passed in rather than written to the store.
 */
export function usePipelineEventListeners(
  setToolRequests: React.Dispatch<React.SetStateAction<ToolRequest[]>>,
) {
  // Grooming progress phase + message (worktree pull, file probe, etc.)
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    const listenPromise = listen<{ phase: string; message: string }>(
      "grooming-progress",
      (event) => {
        const store = useImplementTicketStore.getState();
        const sessionId = store.activeSessionId;
        if (event.payload.phase === "done") {
          setTimeout(() => {
            if (
              useImplementTicketStore.getState().activeSessionId === sessionId
            ) {
              useImplementTicketStore.getState()._set({ groomingProgress: "" });
            }
          }, 1200);
        } else {
          store._set({ groomingProgress: event.payload.message });
        }
      },
    );

    listenPromise.then((f) => {
      unlistenFn = f;
    });

    return () => {
      if (unlistenFn) {
        unlistenFn();
      } else {
        listenPromise.then((f) => f());
      }
    };
  }, []);

  // Grooming token stream
  useEffect(() => {
    const acc = { text: "", sessionId: "" };
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let unlistenFn: (() => void) | null = null;
    const listenPromise = listen<{ delta: string }>(
      "grooming-stream",
      (event) => {
        const currentSessionId =
          useImplementTicketStore.getState().activeSessionId;
        if (acc.sessionId !== currentSessionId) {
          acc.text = "";
          acc.sessionId = currentSessionId;
        }
        acc.text += event.payload.delta;
        if (flushTimer !== null) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          if (
            useImplementTicketStore.getState().activeSessionId === acc.sessionId
          ) {
            useImplementTicketStore
              .getState()
              ._set({ groomingStreamText: acc.text });
          }
        }, 80);
      },
    );

    listenPromise.then((f) => {
      unlistenFn = f;
    });

    return () => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      if (unlistenFn) {
        unlistenFn();
      } else {
        listenPromise.then((f) => f());
      }
    };
  }, []);

  // Implementation token stream
  useEffect(() => {
    const acc = { text: "", sessionId: "" };
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let unlistenFn: (() => void) | null = null;
    const listenPromise = listen<{ delta: string }>(
      "implementation-stream",
      (event) => {
        const currentSessionId =
          useImplementTicketStore.getState().activeSessionId;
        if (acc.sessionId !== currentSessionId) {
          acc.text = "";
          acc.sessionId = currentSessionId;
        }
        acc.text += event.payload.delta;
        if (flushTimer !== null) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          if (
            useImplementTicketStore.getState().activeSessionId === acc.sessionId
          ) {
            useImplementTicketStore
              .getState()
              ._set({ implementationStreamText: acc.text });
          }
        }, 80);
      },
    );

    listenPromise.then((f) => {
      unlistenFn = f;
    });

    return () => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      if (unlistenFn) {
        unlistenFn();
      } else {
        listenPromise.then((f) => f());
      }
    };
  }, []);

  // Stream listeners for all other pipeline stages — same batched-flush pattern.
  useEffect(() => {
    type StreamKey =
      | "impactStreamText"
      | "triageStreamText"
      | "planStreamText"
      | "testsStreamText"
      | "reviewStreamText"
      | "prStreamText"
      | "retroStreamText"
      | "groomingStreamText"
      | "orchestratorStreamText"
      | "buildCheckStreamText";
    // Workflow event channels: deltas arrive as `{kind: "stream", node, delta}`
    // (sidecar bridge format). Filter for stream events and accumulate.
    const workflowStreams: Array<[string, StreamKey]> = [
      ["orchestrator-workflow-event", "orchestratorStreamText"],
      ["grooming-chat-workflow-event", "groomingStreamText"],
    ];
    const cleanups = workflowStreams.map(([event, key]) => {
      const acc = { text: "", sessionId: "" };
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const unlisten = listen<{ kind?: string; delta?: string }>(event, (e) => {
        if (e.payload.kind !== "stream" || !e.payload.delta) return;
        const currentSessionId =
          useImplementTicketStore.getState().activeSessionId;
        if (acc.sessionId !== currentSessionId) {
          acc.text = "";
          acc.sessionId = currentSessionId;
        }
        acc.text += e.payload.delta;
        if (flushTimer !== null) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          if (
            useImplementTicketStore.getState().activeSessionId === acc.sessionId
          ) {
            useImplementTicketStore
              .getState()
              ._set({ [key]: acc.text } as Record<StreamKey, string>);
          }
        }, 80);
      });
      return () => {
        if (flushTimer !== null) clearTimeout(flushTimer);
        unlisten.then((f) => f());
      };
    });
    return () => cleanups.forEach((f) => f());
  }, []);

  // Tool-request prompts (a tool the agent wishes existed but doesn't)
  useEffect(() => {
    const unlisten = listen<{
      name: string;
      description: string;
      why_needed: string;
      example_call: string;
    }>("agent-tool-request", (event) => {
      const { name, description, why_needed, example_call } = event.payload;
      setToolRequests((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${name}`,
          name,
          description,
          whyNeeded: why_needed,
          exampleCall: example_call,
          dismissed: false,
        },
      ]);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [setToolRequests]);
}
