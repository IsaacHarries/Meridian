/**
 * Cross-meetings RAG chat — "ask AI a question about anything you've
 * discussed across all your meetings".
 *
 * Flow per user message:
 *   1. Run hybrid retrieval via `searchMeetings` (Rust SQLite FTS5 +
 *      Ollama-embedding cosine, when Ollama is up).
 *   2. Pass the top hits + chat history into `chatCrossMeetings`. The
 *      sidecar workflow synthesises an answer and is instructed to
 *      cite every claim by [Meeting Title @ HH:MM:SS].
 *   3. Render the answer with the cited hits as clickable cards
 *      underneath. Clicking a card jumps the user to that meeting.
 *
 * Persistence: chat history lives in the existing chatHistoryStore
 * keyed under panel="meetings", contextKey="cross-meetings". That
 * keeps the conversation across screen navigation but doesn't survive
 * an app restart (matches the rest of the chat panels).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  Sparkles,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  searchMeetings,
  chatCrossMeetings,
  type MeetingSearchHit,
} from "@/lib/tauri";
import { useChatHistoryStore, type ChatTurn } from "@/stores/chatHistoryStore";
import { useMeetingsStore } from "@/stores/meetingsStore";
import { SlashCommandInput } from "@/components/SlashCommandInput";
import {
  createGlobalCommands,
  parseSlashInput,
  type SlashCommand,
} from "@/lib/slashCommands";
import {
  parseTaggedQuery,
  meetingMatchesTags,
  meetingMatchesNames,
} from "@/lib/taggedQuery";
import {
  participantsForMeeting,
  gatherNamePool,
  gatherTagPool,
} from "@/lib/meetingPeople";

const PANEL_KEY = "meetings" as const;
const CONTEXT_KEY = "cross-meetings";

/** Three preset retrieval modes the user can toggle between, each
 *  mapped to a fixed cosine-score threshold. The "default" mode
 *  passes `undefined` so Rust falls through to the user's saved
 *  preference (Settings → Meetings → Search relevance threshold).
 *  The "broad" / "narrow" presets override that for the next query
 *  only — they don't mutate the saved preference. */
type RetrievalMode = "broad" | "default" | "narrow";

const MODE_THRESHOLDS: Record<RetrievalMode, number | undefined> = {
  broad: 0.45, // "loosely related" floor — surfaces topical-but-not-paraphrase
  default: undefined, // resolved server-side from saved pref
  narrow: 0.75, // "near-paraphrase" — highest-precision results only
};

const MODE_LABELS: Record<RetrievalMode, string> = {
  broad: "broad",
  default: "default",
  narrow: "narrow",
};

const EXPERIMENT_THRESHOLDS = [0.4, 0.5, 0.6, 0.7, 0.8] as const;

interface Props {
  /** When provided, the panel header shows a back button that calls
   *  this. Omit when the panel is the *default* surface (e.g. the
   *  always-on right-side aside in the Meetings panel) — there's
   *  nothing to navigate "back" to in that mode. */
  onClose?: () => void;
  /** Selecting a citation chip jumps to the source meeting. The
   *  caller decides what "open" means in their layout (the full-screen
   *  variant closes itself first; the docked aside just selects the
   *  meeting in place). */
  onOpenMeeting: (meetingId: string) => void;
  /** Compact mode strips chrome optimised for the 420px right-side
   *  aside: no back button, no max-w-3xl center column, tighter
   *  paddings. The full-screen variant in the main area uses the
   *  defaults (compact=false). */
  compact?: boolean;
}

export function CrossMeetingsChatPanel({
  onClose,
  onOpenMeeting,
  compact = false,
}: Props) {
  const history = useChatHistoryStore(
    (s) => s.histories[PANEL_KEY]?.[CONTEXT_KEY] ?? EMPTY_HISTORY,
  );
  const setStoredHistory = useChatHistoryStore((s) => s.setHistory);
  const clearChat = useChatHistoryStore((s) => s.clear);
  // Tag → meeting-id resolution lives here so the search call can
  // restrict its hybrid retrieval to the meetings the user named via
  // `#tag`. We subscribe to the meetings list so newly-tagged meetings
  // become searchable without a remount.
  const meetingsList = useMeetingsStore((s) => s.meetings);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Active retrieval mode — applied to plain (non-slash) queries.
  // Slash-command queries override this for their single invocation
  // without mutating the toggle.
  const [mode, setMode] = useState<RetrievalMode>("default");
  // Per-turn retrieval — keyed by turn index so the user can scroll
  // up and see which sources fed each previous answer. Lost on
  // navigation away (only the chat history persists). Worth keeping
  // ephemeral since stale source lists can be confusing.
  const [hitsByTurn, setHitsByTurn] = useState<MeetingSearchHit[][]>([]);
  const [warningByTurn, setWarningByTurn] = useState<(string | null)[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the chat to the latest message when new content lands.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history.length, busy]);

  const setHistory = useCallback(
    (next: ChatTurn[]) => setStoredHistory(PANEL_KEY, CONTEXT_KEY, next),
    [setStoredHistory],
  );

  const runAsk = useCallback(
    async (
      rawText: string,
      query: string,
      threshold: number | undefined,
      meetingIds?: string[],
    ) => {
      const userTurn: ChatTurn = { role: "user", content: rawText };
      const optimistic: ChatTurn[] = [...history, userTurn];
      setHistory(optimistic);
      setInput("");
      setBusy(true);

      try {
        const search = await searchMeetings(query, {
          limit: 16,
          minScore: threshold,
          meetingIds,
        });
        setHitsByTurn((prev) => [...prev, search.hits]);
        setWarningByTurn((prev) => [
          ...prev,
          search.semanticUnavailable
            ? search.semanticMessage ??
              "Semantic search unavailable — keyword matches only."
            : null,
        ]);

        if (search.hits.length === 0) {
          const thresholdHint =
            threshold != null
              ? ` (no hits cleared the ${threshold.toFixed(2)} threshold — try /broad or lower the threshold in Settings)`
              : " (try rephrasing, or lower the threshold in Settings → Meetings)";
          const reply: ChatTurn = {
            role: "assistant",
            content: `I couldn't find anything in your meetings that matches this question${thresholdHint}.`,
          };
          setHistory([...optimistic, reply]);
          return;
        }

        const replyText = await chatCrossMeetings(
          search.hits,
          JSON.stringify(optimistic),
          !search.semanticUnavailable,
        );
        const reply: ChatTurn = {
          role: "assistant",
          content: replyText.trim(),
        };
        setHistory([...optimistic, reply]);
      } catch (e) {
        toast.error("Cross-meetings chat failed", {
          description: e instanceof Error ? e.message : String(e),
        });
        setHistory(history);
        setHitsByTurn((prev) => prev.slice(0, -1));
        setWarningByTurn((prev) => prev.slice(0, -1));
      } finally {
        setBusy(false);
      }
    },
    [history, setHistory],
  );

  const runExperiment = useCallback(
    async (rawText: string, query: string, meetingIds?: string[]) => {
      const userTurn: ChatTurn = { role: "user", content: rawText };
      const optimistic: ChatTurn[] = [...history, userTurn];
      setHistory(optimistic);
      setInput("");
      setBusy(true);

      try {
        // Run the same query at every threshold in parallel. Each call
        // hits the same Rust command with a different `min_score`,
        // so total latency ≈ slowest single call (cosine over the
        // index is microseconds and the bulk of each call is the
        // single Ollama embed request, which is reused across the
        // parallel batch via Ollama's request queue).
        const results = await Promise.all(
          EXPERIMENT_THRESHOLDS.map((t) =>
            searchMeetings(query, { limit: 16, minScore: t, meetingIds }),
          ),
        );
        const lines: string[] = [];
        lines.push(`📊 Threshold experiment for: "${query}"`);
        lines.push("");
        lines.push("threshold  hits  meetings  top hit");
        lines.push("─────────  ────  ────────  ─────────────────────────────");
        for (let i = 0; i < EXPERIMENT_THRESHOLDS.length; i++) {
          const t = EXPERIMENT_THRESHOLDS[i];
          const r = results[i];
          const meetingCount = new Set(r.hits.map((h) => h.meetingId)).size;
          const top = r.hits[0];
          const topPreview = top
            ? `${top.score.toFixed(2)} "${truncate(top.text, 50)}"`
            : "—";
          lines.push(
            `${t.toFixed(2)}       ${String(r.hits.length).padEnd(4)}  ${String(meetingCount).padEnd(8)}  ${topPreview}`,
          );
        }
        lines.push("");
        lines.push(
          "Use /strict, /narrow, /broad, or the mode toggle to query at a chosen threshold.",
        );
        const reply: ChatTurn = {
          role: "assistant",
          content: lines.join("\n"),
        };
        setHistory([...optimistic, reply]);
        // Experiments don't carry a single "sources" set — each
        // threshold has its own. Push empty so the per-turn arrays
        // stay aligned with assistant turns.
        setHitsByTurn((prev) => [...prev, []]);
        setWarningByTurn((prev) => [...prev, null]);
      } catch (e) {
        toast.error("Experiment failed", {
          description: e instanceof Error ? e.message : String(e),
        });
        setHistory(history);
      } finally {
        setBusy(false);
      }
    },
    [history, setHistory],
  );

  // Pull `#tag` and `@name` filters out of a body and resolve them to
  // a meeting-id allowlist (or undefined when no filters were given).
  // Returns the residual prose and a synthetic assistant message when
  // the filters can't yield any results — the caller short-circuits
  // the search in that case instead of sending an empty query down to
  // Rust.
  const resolveTaggedQuery = useCallback(
    (
      body: string,
    ): {
      residual: string;
      meetingIds: string[] | undefined;
      tags: string[];
      names: string[];
      filterTokens: string[];
      blockReason: string | null;
    } => {
      const { tags, names, residual } = parseTaggedQuery(body);
      const filterTokens = [
        ...tags.map((t) => `#${t}`),
        ...names.map((n) => `@${n}`),
      ];
      const hasFilter = tags.length > 0 || names.length > 0;
      if (!hasFilter) {
        return {
          residual,
          meetingIds: undefined,
          tags,
          names,
          filterTokens,
          blockReason: null,
        };
      }
      const meetingIds = meetingsList
        .filter(
          (m) =>
            meetingMatchesTags(m.tags, tags) &&
            meetingMatchesNames(participantsForMeeting(m), names),
        )
        .map((m) => m.id);
      if (meetingIds.length === 0) {
        return {
          residual,
          meetingIds,
          tags,
          names,
          filterTokens,
          blockReason: `No meetings match ${filterTokens.map((t) => `\`${t}\``).join(" ")}.`,
        };
      }
      return {
        residual,
        meetingIds,
        tags,
        names,
        filterTokens,
        blockReason: null,
      };
    },
    [meetingsList],
  );

  // Push a synthetic assistant turn into history without hitting the
  // search/chat backends — used to short-circuit error / hint cases
  // (empty residual, tag with no meetings) so the UX stays consistent.
  const appendSyntheticTurn = useCallback(
    (rawText: string, replyContent: string) => {
      const next: ChatTurn[] = [
        ...history,
        { role: "user", content: rawText },
        { role: "assistant", content: replyContent },
      ];
      setHistory(next);
      setHitsByTurn((prev) => [...prev, []]);
      setWarningByTurn((prev) => [...prev, null]);
      setInput("");
    },
    [history, setHistory],
  );

  // Unified dispatcher: runs a previously-typed query string. Used both
  // by /retry's sendMessage callback (which replays the stored user
  // turn verbatim, leading slash and all) and as a single source of
  // truth for routing slash text → runAsk/runExperiment with the right
  // threshold. Plain text falls through to runAsk at the active mode's
  // threshold.
  const dispatch = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      const parsed = parseSlashInput(trimmed);
      if (parsed) {
        const handleSearchish = async (
          threshold: number | undefined,
          cmdHint: string,
        ) => {
          const { residual, meetingIds, filterTokens, blockReason } =
            resolveTaggedQuery(parsed.args);
          if (blockReason) {
            appendSyntheticTurn(trimmed, blockReason);
            return;
          }
          if (!residual) {
            appendSyntheticTurn(
              trimmed,
              filterTokens.length > 0
                ? `Add a query alongside ${filterTokens.map((t) => `\`${t}\``).join(" ")}, e.g. \`${cmdHint} ${filterTokens[0]} what was decided\`.`
                : `Add a query after \`${cmdHint}\`.`,
            );
            return;
          }
          await runAsk(trimmed, residual, threshold, meetingIds);
        };
        switch (parsed.name) {
          case "strict":
          case "narrow":
            if (parsed.args) await handleSearchish(0.75, "/strict");
            return;
          case "broad":
          case "loose":
            if (parsed.args) await handleSearchish(0.45, "/broad");
            return;
          case "experiment":
          case "compare":
            if (parsed.args) {
              const { residual, meetingIds, filterTokens, blockReason } =
                resolveTaggedQuery(parsed.args);
              if (blockReason) {
                appendSyntheticTurn(trimmed, blockReason);
                return;
              }
              if (!residual) {
                appendSyntheticTurn(
                  trimmed,
                  filterTokens.length > 0
                    ? `Add a query alongside ${filterTokens.map((t) => `\`${t}\``).join(" ")}, e.g. \`/experiment ${filterTokens[0]} what was decided\`.`
                    : "Add a query after `/experiment`.",
                );
                return;
              }
              await runExperiment(trimmed, residual, meetingIds);
            }
            return;
          // Anything else (including unknown commands) falls through and
          // gets sent as a plain query so a stray slash doesn't silently
          // swallow the user's question.
        }
      }
      const { residual, meetingIds, filterTokens, blockReason } =
        resolveTaggedQuery(trimmed);
      if (blockReason) {
        appendSyntheticTurn(trimmed, blockReason);
        return;
      }
      if (!residual) {
        appendSyntheticTurn(
          trimmed,
          filterTokens.length > 0
            ? `Add a query alongside ${filterTokens.map((t) => `\`${t}\``).join(" ")}, e.g. \`${filterTokens[0]} what was decided\`.`
            : "",
        );
        return;
      }
      await runAsk(trimmed, residual, MODE_THRESHOLDS[mode], meetingIds);
    },
    [
      mode,
      runAsk,
      runExperiment,
      resolveTaggedQuery,
      appendSyntheticTurn,
    ],
  );

  const clearAll = useCallback(() => {
    clearChat(PANEL_KEY, CONTEXT_KEY);
    setHitsByTurn([]);
    setWarningByTurn([]);
  }, [clearChat]);

  const dropLastAssistantTurn = useCallback(() => {
    if (history.length === 0) return;
    if (history[history.length - 1].role !== "assistant") return;
    setHistory(history.slice(0, -1));
    setHitsByTurn((prev) => prev.slice(0, -1));
    setWarningByTurn((prev) => prev.slice(0, -1));
  }, [history, setHistory]);

  const commands: SlashCommand[] = useMemo(
    () => [
      ...createGlobalCommands({
        history,
        clearHistory: clearAll,
        sendMessage: dispatch,
        removeLastAssistantMessage: dropLastAssistantTurn,
      }),
      {
        name: "strict",
        aliases: ["narrow"],
        description: "Narrow search (threshold 0.75, paraphrase only)",
        args: "<query>",
        execute: async ({ args, setInput: prefill }) => {
          if (!args) {
            prefill("/strict ");
            return;
          }
          await dispatch(`/strict ${args}`);
        },
      },
      {
        name: "broad",
        aliases: ["loose"],
        description: "Broad search (threshold 0.45, loosely related)",
        args: "<query>",
        execute: async ({ args, setInput: prefill }) => {
          if (!args) {
            prefill("/broad ");
            return;
          }
          await dispatch(`/broad ${args}`);
        },
      },
      {
        name: "experiment",
        aliases: ["compare"],
        description: "Run the same query at multiple thresholds and compare",
        args: "<query>",
        execute: async ({ args, setInput: prefill }) => {
          if (!args) {
            prefill("/experiment ");
            return;
          }
          await dispatch(`/experiment ${args}`);
        },
      },
    ],
    [history, clearAll, dispatch, dropLastAssistantTurn],
  );

  // Compact mode skips the centered max-w-3xl column so the chat fills
  // the (already-narrow) aside. Padding shrinks too — the full-screen
  // variant breathes more.
  const innerWidth = compact ? "w-full" : "max-w-3xl mx-auto w-full";
  const headerPad = compact ? "p-3" : "p-4";
  const bodyPad = compact ? "p-3" : "p-4";
  // Canonical "fixed header / scrolling body / fixed footer" layout:
  //   outer  →  flex flex-col h-full   (constrains to the aside's height)
  //   header →  shrink-0                (never shrinks, never grows)
  //   body   →  flex-1 min-h-0 overflow-y-auto
  //                                     (min-h-0 is the key — without
  //                                     it, the body can't shrink below
  //                                     its content size, so overflow
  //                                     spills out of the panel and
  //                                     the citations list becomes
  //                                     unreachable)
  //   footer →  shrink-0
  return (
    <div className="flex flex-col h-full bg-background/50">
      <header className="shrink-0 bg-background/95 backdrop-blur border-b">
        <div className={cn(headerPad, "flex items-center gap-2", innerWidth)}>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-8 w-8"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold leading-tight">
              Ask across meetings
            </h2>
            {!compact && (
              <p className="text-[11px] text-muted-foreground leading-tight">
                AI searches every indexed transcript and answers with citations.
              </p>
            )}
          </div>
          {history.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-[11px]"
              onClick={clearAll}
            >
              Clear
            </Button>
          )}
        </div>
      </header>

      <div
        className={cn(
          "flex-1 min-h-0 overflow-y-auto space-y-4",
          bodyPad,
          innerWidth,
        )}
      >
        {history.length === 0 ? (
          <EmptyState compact={compact} />
        ) : (
          <ConversationList
            history={history}
            hitsByTurn={hitsByTurn}
            warningByTurn={warningByTurn}
            onOpenMeeting={onOpenMeeting}
          />
        )}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {compact ? "Searching…" : "Searching transcripts and synthesising an answer…"}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <footer className="shrink-0 bg-background/95 backdrop-blur border-t">
        <ModeBar
          mode={mode}
          onChange={setMode}
          paddingX={compact ? "px-3" : "px-4"}
          innerWidth={innerWidth}
          showHint={!compact && history.length === 0}
        />
        <div className={cn(headerPad, "pt-1", innerWidth)}>
          <SlashCommandInput
            value={input}
            onChange={setInput}
            onSend={async (text) => {
              try {
                await dispatch(text);
              } catch (e) {
                toast.error("Cross-meetings chat failed", {
                  description: e instanceof Error ? e.message : String(e),
                });
              }
            }}
            commands={commands}
            busy={busy}
            placeholder={
              compact
                ? "Ask anything… / for commands. Filter with #tag or @name."
                : "Ask a question — / for commands, /strict, /broad, /experiment to override the threshold; filter with #tag or @name"
            }
            tagPool={gatherTagPool(meetingsList)}
            namePool={gatherNamePool(meetingsList)}
          />
        </div>
      </footer>
    </div>
  );
}

const EMPTY_HISTORY: ChatTurn[] = [];

function EmptyState({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center gap-3 text-muted-foreground",
        compact ? "py-8" : "py-16",
      )}
    >
      <Sparkles className={compact ? "h-6 w-6" : "h-8 w-8"} />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          Ask anything that came up in a meeting.
        </p>
        {!compact && (
          <p className="text-xs">
            Examples: "What did we decide about onboarding?", "When did Alice
            talk about the migration?", "Summarise everything we said about the
            auth rewrite this sprint."
          </p>
        )}
        {compact && (
          <p className="text-[11px]">
            Searches every indexed meeting and answers with citations.
          </p>
        )}
      </div>
    </div>
  );
}

function ConversationList({
  history,
  hitsByTurn,
  warningByTurn,
  onOpenMeeting,
}: {
  history: ChatTurn[];
  hitsByTurn: MeetingSearchHit[][];
  warningByTurn: (string | null)[];
  onOpenMeeting: (meetingId: string) => void;
}) {
  // Pair each assistant turn with the hits/warning that fed it. The
  // user submits → we push hits → we push reply, so hitsByTurn[i]
  // belongs to the i-th assistant turn (which is the (2i+1)-th overall
  // turn after the user message). We walk the list and tally an
  // assistant-turn counter to look up sources.
  let assistantIdx = -1;
  return (
    <ul className="space-y-3">
      {history.map((turn, i) => {
        if (turn.role === "user") {
          return <UserBubble key={i} content={turn.content} />;
        }
        assistantIdx += 1;
        const hits = hitsByTurn[assistantIdx] ?? [];
        const warning = warningByTurn[assistantIdx] ?? null;
        return (
          <AssistantBubble
            key={i}
            content={turn.content}
            hits={hits}
            warning={warning}
            onOpenMeeting={onOpenMeeting}
          />
        );
      })}
    </ul>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <li className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-3 py-2 text-sm whitespace-pre-wrap break-words">
        {content}
      </div>
    </li>
  );
}

function AssistantBubble({
  content,
  hits,
  warning,
  onOpenMeeting,
}: {
  content: string;
  hits: MeetingSearchHit[];
  warning: string | null;
  onOpenMeeting: (id: string) => void;
}) {
  return (
    <li className="space-y-2">
      <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-muted/60 px-3 py-2 text-sm whitespace-pre-wrap break-words">
        {content}
      </div>
      {warning && (
        <div className="max-w-[90%] flex items-start gap-2 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{warning}</span>
        </div>
      )}
      {hits.length > 0 && (
        <SourcesList hits={hits} onOpenMeeting={onOpenMeeting} />
      )}
    </li>
  );
}

function SourcesList({
  hits,
  onOpenMeeting,
}: {
  hits: MeetingSearchHit[];
  onOpenMeeting: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const grouped = useMemo(() => groupByMeeting(hits), [hits]);
  return (
    <div className="max-w-[90%] text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {hits.length} source{hits.length === 1 ? "" : "s"} from{" "}
        {grouped.size} meeting{grouped.size === 1 ? "" : "s"}
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1.5">
          {[...grouped.entries()].map(([meetingId, items]) => (
            <li key={meetingId}>
              <button
                type="button"
                onClick={() => onOpenMeeting(meetingId)}
                className="w-full text-left rounded-md border bg-background hover:bg-accent/50 transition-colors p-2"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-[12px] truncate">
                    {items[0].meetingTitle}
                  </span>
                  <span className="text-muted-foreground text-[10px] shrink-0">
                    {items[0].meetingStartedAt.slice(0, 10)}
                  </span>
                </div>
                {items.slice(0, 2).map((h) => (
                  <p
                    key={h.segmentId}
                    className="text-muted-foreground text-[11px] mt-0.5"
                  >
                    <span
                      className={cn(
                        "inline-block min-w-[36px] text-center mr-1.5 rounded px-1 py-px text-[9px] font-mono",
                        scoreBadgeClass(h.score),
                      )}
                      title={`Cosine similarity (or 0.45 baseline for keyword-only hits): ${h.score.toFixed(3)}. Threshold: 0.55 ("likely relevant"). Higher = more relevant.`}
                    >
                      {h.score.toFixed(2)}
                    </span>
                    <span className="text-foreground/70">
                      {formatMs(h.startMs)}{" "}
                    </span>
                    {h.speaker && (
                      <span className="text-foreground/80">
                        {h.speaker}:{" "}
                      </span>
                    )}
                    <span className="break-words">
                      {h.text.length > 160
                        ? `${h.text.slice(0, 160)}…`
                        : h.text}
                    </span>
                    <span
                      className={cn(
                        "ml-1 text-[9px] uppercase tracking-wide",
                        h.matchedSemantic && h.matchedKeyword
                          ? "text-violet-500"
                          : h.matchedSemantic
                            ? "text-blue-500"
                            : "text-emerald-500",
                      )}
                      title={matchTypeTooltip(h)}
                    >
                      {h.matchedSemantic && h.matchedKeyword
                        ? "hybrid"
                        : h.matchedSemantic
                          ? "semantic"
                          : "keyword"}
                    </span>
                  </p>
                ))}
                {items.length > 2 && (
                  <p className="text-muted-foreground text-[10px] mt-0.5">
                    +{items.length - 2} more snippet
                    {items.length - 2 === 1 ? "" : "s"} from this meeting
                  </p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function groupByMeeting(
  hits: MeetingSearchHit[],
): Map<string, MeetingSearchHit[]> {
  const out = new Map<string, MeetingSearchHit[]>();
  for (const h of hits) {
    const arr = out.get(h.meetingId) ?? [];
    arr.push(h);
    out.set(h.meetingId, arr);
  }
  return out;
}

/** Tooltip text for the match-type badge. The badge labels are short
 *  on purpose; the tooltip is where we explain what "semantic" /
 *  "keyword" / "hybrid" actually mean. */
function matchTypeTooltip(h: MeetingSearchHit): string {
  if (h.matchedSemantic && h.matchedKeyword) {
    return "Hybrid match: this chunk was retrieved by BOTH the semantic (embedding cosine similarity) and keyword (SQLite FTS5) retrievers — strongest signal. Score gets a small boost when both fire.";
  }
  if (h.matchedSemantic) {
    return "Semantic match: this chunk was retrieved because its meaning is similar to your query, even if no exact words overlap. Uses cosine similarity over Ollama embeddings. Good at catching paraphrase.";
  }
  return "Keyword match: this chunk was retrieved because it contains one or more of your query's words (after stopword removal). Uses SQLite FTS5 with bm25 ranking. Doesn't catch paraphrase but is precise on proper nouns.";
}

/** Heatmap-style colour for the relevance score badge. Thresholds
 *  match the raw-cosine calibration documented in the Rust merge
 *  block: ≥0.70 paraphrase, ≥0.55 likely relevant, ≥0.45 loosely
 *  related, <0.45 noise. */
function scoreBadgeClass(score: number): string {
  if (score >= 0.70) return "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
  if (score >= 0.55) return "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30";
  if (score >= 0.45) return "bg-orange-500/20 text-orange-400 border border-orange-500/30";
  return "bg-red-500/20 text-red-400 border border-red-500/30";
}

/** Three-pill segmented control above the chat input. Lets the user
 *  override the saved relevance threshold for the next query without
 *  digging into Settings. The "default" pill maps to `undefined`,
 *  which falls through server-side to the saved preference.
 *
 *  Slash commands take precedence over this — a `/broad` query
 *  always uses 0.45 regardless of which pill is active. */
function ModeBar({
  mode,
  onChange,
  paddingX,
  innerWidth,
  showHint,
}: {
  mode: RetrievalMode;
  onChange: (m: RetrievalMode) => void;
  paddingX: string;
  innerWidth: string;
  showHint: boolean;
}) {
  const pills: Array<{ id: RetrievalMode; tooltip: string }> = [
    { id: "broad", tooltip: "Broad: threshold 0.45 (loosely related matches)" },
    { id: "default", tooltip: "Default: use threshold from Settings" },
    { id: "narrow", tooltip: "Narrow: threshold 0.75 (paraphrase only)" },
  ];
  return (
    <div className={cn(paddingX, innerWidth, "pt-2 flex items-center gap-2 flex-wrap")}>
      <div className="flex items-center gap-0.5 rounded-full border bg-muted/30 p-0.5">
        {pills.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            title={p.tooltip}
            className={cn(
              "text-[10px] px-2 py-0.5 rounded-full transition-colors",
              mode === p.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {MODE_LABELS[p.id]}
          </button>
        ))}
      </div>
      {showHint && (
        <span className="text-[10px] text-muted-foreground">
          /strict · /broad · /experiment · /help
        </span>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).trimEnd()}…`;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "00:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
