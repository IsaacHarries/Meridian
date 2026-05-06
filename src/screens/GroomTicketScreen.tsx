import { APP_HEADER_TITLE, WorkflowPanelHeader } from "@/components/appHeaderLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type SlashCommand, createGlobalCommands } from "@/lib/slashCommands";
import { type CredentialStatus, aiProviderComplete, jiraComplete } from "@/lib/tauri/credentials";
import { type JiraIssue, type JiraSprint, getAllActiveSprints, getFutureSprints, getIssue, getSprintIssues, updateJiraFields } from "@/lib/tauri/jira";
import { type GroomingChatResponse, type GroomingOutput, type SuggestedEditField, parseAgentJson, runGroomingChatTurn, runGroomingFileProbe, runGroomingWorkflow } from "@/lib/tauri/workflows";
import { grepGroomingFiles, readGroomingFile, syncGroomingWorktree, validateGroomingWorktree } from "@/lib/tauri/worktree";
import {
    type GroomChatMessage,
    type GroomSession,
    buildOpeningMessage,
    getCurrentFieldValue,
    hasOrphanDrafts,
    isOrphanDraft,
    preserveImagesFromOriginal,
    resolveJiraFieldId,
    suggestedEditsToDraftChanges,
} from "@/screens/groom-ticket/_shared";
import { ChatPanel } from "@/screens/groom-ticket/chat-panel";
import { DraftChangesPanel } from "@/screens/groom-ticket/draft-changes-panel";
import { TicketFieldsPanel, type TicketFieldsPanelHandle } from "@/screens/groom-ticket/ticket-fields-panel";
import { TicketSelector } from "@/screens/groom-ticket/ticket-selector";
import { TicketSummaryCard } from "@/screens/groom-ticket/ticket-summary-card";
import { useAiSelectionStore } from "@/stores/aiSelectionStore";
import { useChatHistoryStore } from "@/stores/chatHistoryStore";
import { compileTicketText } from "@/stores/implementTicket/helpers";
import {
    type RateLimitSnapshot,
    modelKey,
    useTokenUsageStore,
} from "@/stores/tokenUsageStore";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
    ArrowLeft,
    PanelLeftClose,
    PanelLeftOpen,
    PanelRightClose,
    PanelRightOpen,
    RefreshCw,
} from "lucide-react";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";

interface GroomTicketScreenProps {
  credStatus: CredentialStatus;
  onBack: () => void;
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function GroomTicketScreen({ credStatus, onBack }: GroomTicketScreenProps) {
  const [sprints, setSprints] = useState<JiraSprint[]>([]);
  const [selectedSprintId, setSelectedSprintId] = useState<number | null>(null);
  const [sprintIssues, setSprintIssues] = useState<JiraIssue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(true);
  const [session, setSession] = useState<GroomSession | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [recentlyUpdated, setRecentlyUpdated] = useState<Set<string>>(new Set());
  const recentlyUpdatedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Imperative handle on the fields panel — used to flush dirty in-line
  // field edits to JIRA when the user switches tickets, so unsaved typed
  // or accepted-suggestion text doesn't get silently dropped or carried
  // over into the next ticket's editor.
  const fieldsPanelRef = useRef<TicketFieldsPanelHandle | null>(null);

  // Mirror the live session chat into the chat-history store so it
  // survives navigating away from this screen. Rehydrated in
  // `loadTicket` when the same ticket is re-opened.
  useEffect(() => {
    if (!session) return;
    useChatHistoryStore
      .getState()
      .setHistory("ticket_quality", session.issue.key, session.chat);
  }, [session]);

  // ── Resizable pane widths ─────────────────────────────────────────────────
  const [leftWidth, setLeftWidth] = useState(340);
  const [chatWidth, setChatWidth] = useState(360);
  // When collapsed, the left pane shrinks to a slim icon-only strip so the
  // middle/right panes get the screen back. Resize and pane content are
  // hidden until the user expands again. Stored as a separate flag (rather
  // than just leftWidth = 0) so we can restore the user's last sized
  // width when they expand. Same pattern for the chat pane on the right.
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartValRef = useRef(0);

  const makeDragHandler = useCallback(
    (setter: (w: number) => void, min: number, max: number, inverted = false) =>
      (e: React.MouseEvent) => {
        e.preventDefault();
        isDraggingRef.current = true;
        dragStartXRef.current = e.clientX;
        dragStartValRef.current = inverted ? chatWidth : leftWidth;
        const onMouseMove = (ev: MouseEvent) => {
          if (!isDraggingRef.current) return;
          const delta = inverted
            ? dragStartXRef.current - ev.clientX
            : ev.clientX - dragStartXRef.current;
          setter(Math.min(max, Math.max(min, dragStartValRef.current + delta)));
        };
        const onMouseUp = () => {
          isDraggingRef.current = false;
          window.removeEventListener("mousemove", onMouseMove);
          window.removeEventListener("mouseup", onMouseUp);
        };
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
      },
    [leftWidth, chatWidth]
  );

  const onLeftDividerMouseDown = makeDragHandler(setLeftWidth, 240, 520);
  const onChatDividerMouseDown = makeDragHandler(setChatWidth, 280, 600, true);

  const claudeAvailable = aiProviderComplete(credStatus);
  const jiraAvailable = jiraComplete(credStatus);

  useEffect(() => {
    if (!jiraAvailable) { setLoadingIssues(false); return; }
    Promise.all([
      getAllActiveSprints().catch(() => [] as JiraSprint[]),
      getFutureSprints(5).catch(() => [] as JiraSprint[]),
    ]).then(([active, future]) => {
      const all = [...active, ...future];
      setSprints(all);
      if (all.length > 0) setSelectedSprintId(all[0].id);
    });
  }, [jiraAvailable]);

  useEffect(() => {
    if (selectedSprintId === null) { setSprintIssues([]); setLoadingIssues(false); return; }
    setLoadingIssues(true);
    getSprintIssues(selectedSprintId).then(setSprintIssues).catch(() => setSprintIssues([])).finally(() => setLoadingIssues(false));
  }, [selectedSprintId]);

  const selectSprint = useCallback((sprint: JiraSprint) => {
    setSelectedSprintId(sprint.id);
    setSession(null);
    setInitError(null);
  }, []);

  /**
   * Pull a fresh copy of the issue from JIRA and seed the session with it.
   * Crucially does NOT call the AI grooming agent — `analyzeTicket()` does
   * that, and it's gated behind an explicit user click so opening a ticket
   * never burns model tokens unprompted.
   */
  async function loadTicket(issue: JiraIssue) {
    setInitError(null);
    let freshIssue: JiraIssue;
    try {
      freshIssue = await getIssue(issue.key);
    } catch (e) {
      console.warn("[Meridian] getIssue failed, using sprint-list snapshot:", e);
      freshIssue = issue;
    }
    // Rehydrate any prior chat for this ticket so navigating away and
    // back doesn't wipe the conversation. The drafts intentionally
    // start fresh — JIRA may have moved on since the user last looked.
    const priorChat = useChatHistoryStore
      .getState()
      .getHistory("ticket_quality", freshIssue.key) as GroomChatMessage[];
    setSession({
      issue: freshIssue,
      chat: priorChat,
      drafts: [],
      thinking: false,
      applying: false,
      probeStatus: "",
      analyzed: false,
      partialOutput: null,
    });
  }

  /** Run the AI grooming agent against the currently-loaded ticket. */
  async function analyzeTicket() {
    if (!session) return;
    const sessionKey = session.issue.key;
    const freshIssue = session.issue;
    setInitError(null);
    setSession((prev) =>
      prev?.issue.key === sessionKey
        ? { ...prev, thinking: true, chat: [], drafts: [], partialOutput: null }
        : prev,
    );

    // Subscribe to streaming partial-output events from the sidecar so the
    // panel renders fields as the model emits them, instead of waiting for
    // the full reply. Throttled to 80ms to avoid flooding React on token-
    // heavy streams. Mirrors the PR Review streaming wiring.
    let pendingPartial: Partial<GroomingOutput> | null = null;
    let partialFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPartial = () => {
      partialFlushTimer = null;
      if (!pendingPartial) return;
      const next = pendingPartial;
      pendingPartial = null;
      setSession((prev) =>
        prev?.issue.key === sessionKey ? { ...prev, partialOutput: next } : prev,
      );
    };
    const unlistenPartial = await listen<{
      kind?: string;
      node?: string;
      status?: "started" | "completed";
      data?: {
        partial?: Partial<GroomingOutput>;
        usagePartial?: { inputTokens?: number; outputTokens?: number };
        rateLimits?: { provider?: string; snapshot?: RateLimitSnapshot };
      };
    }>("grooming-workflow-event", (event) => {
      if (event.payload.kind !== "progress") return;

      // Live token-usage stream — the standalone grooming workflow
      // uses streamLLMJson in the sidecar which emits these events as
      // input/output tokens accumulate. Routing them through the
      // tokenUsageStore keeps the HeaderModelPicker count climbing
      // while the agent is still talking, instead of jumping in one
      // shot at the end.
      const usagePartial = event.payload.data?.usagePartial;
      if (usagePartial && typeof usagePartial === "object") {
        let mk: string | undefined;
        try {
          const r = useAiSelectionStore.getState().resolve("ticket_quality");
          if (r.model) mk = modelKey(r.provider, r.model);
        } catch {
          /* hydration race — fall back to panel-only bucket */
        }
        useTokenUsageStore.getState().setCurrentCallUsage(
          "ticket_quality",
          {
            inputTokens: usagePartial.inputTokens ?? 0,
            outputTokens: usagePartial.outputTokens ?? 0,
          },
          mk,
        );
        return;
      }

      // Anthropic rate-limit headers from the OAuth fetch interceptor.
      const rateLimits = event.payload.data?.rateLimits;
      if (
        rateLimits?.provider &&
        rateLimits.snapshot &&
        typeof rateLimits.snapshot === "object"
      ) {
        useTokenUsageStore
          .getState()
          .setRateLimits(rateLimits.provider, rateLimits.snapshot);
        return;
      }

      const partial = event.payload.data?.partial;
      if (!partial || typeof partial !== "object") return;
      pendingPartial = partial;
      if (partialFlushTimer === null) {
        partialFlushTimer = setTimeout(flushPartial, 80);
      }
    });

    try {
      const ticketText = compileTicketText(freshIssue);

      // Pull latest on the grooming worktree, then probe for relevant files
      let fileContentsBlock = "";
      let worktreeContext = "";
      try {
        await syncGroomingWorktree();
        const worktreeInfo = await validateGroomingWorktree();
        worktreeContext = `\n\n=== CODEBASE CONTEXT ===\nWorktree: ${worktreeInfo.path}\nBranch: ${worktreeInfo.branch}`;
        const ticketWithContext = ticketText + worktreeContext;

        setSession((prev) => prev?.issue.key === sessionKey ? { ...prev, probeStatus: "Identifying relevant files…" } : prev);
        const probeRaw = await runGroomingFileProbe(ticketWithContext);
        const probe = parseAgentJson<{ files: string[]; grep_patterns: string[] }>(probeRaw);
        if (probe) {
          const MAX_TOTAL = 40 * 1024;
          let totalSize = 0;
          const parts: string[] = [];
          for (const filePath of (probe.files ?? []).slice(0, 12)) {
            try {
              setSession((prev) => prev?.issue.key === sessionKey ? { ...prev, probeStatus: `Reading ${filePath}…` } : prev);
              const content = await readGroomingFile(filePath);
              const chunk = `--- ${filePath} ---\n${content}\n`;
              if (totalSize + chunk.length > MAX_TOTAL) break;
              parts.push(chunk);
              totalSize += chunk.length;
            } catch { /* skip missing files */ }
          }
          for (const pattern of (probe.grep_patterns ?? []).slice(0, 6)) {
            try {
              setSession((prev) => prev?.issue.key === sessionKey ? { ...prev, probeStatus: `Searching for "${pattern}"…` } : prev);
              const lines = await grepGroomingFiles(pattern);
              if (lines.length === 0) continue;
              const chunk = `--- grep: ${pattern} ---\n${lines.join("\n")}\n`;
              if (totalSize + chunk.length > MAX_TOTAL) break;
              parts.push(chunk);
              totalSize += chunk.length;
            } catch { /* skip */ }
          }
          if (parts.length > 0) fileContentsBlock = parts.join("\n");
        }
      } catch { /* no worktree configured — proceed without codebase context */ }

      setSession((prev) => prev?.issue.key === sessionKey ? { ...prev, probeStatus: "" } : prev);
      const ticketWithContext = ticketText + worktreeContext;
      const output = await runGroomingWorkflow(
        ticketWithContext,
        fileContentsBlock,
        freshIssue.issueType,
      );
      const drafts = suggestedEditsToDraftChanges(output.suggested_edits, freshIssue);
      const openingMsg = buildOpeningMessage(freshIssue, output);
      setSession((prev) =>
        prev?.issue.key === sessionKey
          ? {
              ...prev,
              drafts,
              chat: [{ role: "assistant", content: openingMsg }],
              thinking: false,
              analyzed: true,
              partialOutput: null,
            }
          : prev,
      );
    } catch (e) {
      setInitError(String(e));
      setSession((prev) => (prev?.issue.key === sessionKey ? { ...prev, thinking: false, partialOutput: null } : prev));
    } finally {
      if (partialFlushTimer !== null) clearTimeout(partialFlushTimer);
      unlistenPartial();
    }
  }

  const selectTicket = useCallback(async (issue: JiraIssue) => {
    const hasUnapplied = session?.drafts.some((d) => d.status === "approved" && d.applyResult !== "ok");
    if (hasUnapplied && !confirm("You have approved changes not yet applied to JIRA. Leave anyway?")) return;
    // Push any in-flight dirty field edits to JIRA against the OUTGOING
    // ticket before swapping. If a save fails we surface a toast and
    // continue; the field-editor remount on issue.id ensures stale text
    // never leaks into the new ticket either way.
    try {
      await fieldsPanelRef.current?.flushAllDirty();
    } catch (e) {
      toast.error("Couldn't auto-save field edits", { description: String(e) });
    }
    void loadTicket(issue);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  async function sendChatMessage(text: string) {
    if (!session) return;
    const issueKey = session.issue.key;
    const userMsg: GroomChatMessage = { role: "user", content: text };
    setSession((prev) => prev ? { ...prev, chat: [...prev.chat, userMsg], thinking: true } : prev);
    try {
      const ticketText = compileTicketText(session.issue);
      const contextText = `=== TICKET ===\n${ticketText}\n\n=== CURRENT DRAFT CHANGES ===\n${JSON.stringify(session.drafts)}`;
      const historyJson = JSON.stringify([...session.chat, userMsg]);
      const raw = await runGroomingChatTurn(contextText, historyJson);
      const response = parseAgentJson<GroomingChatResponse>(raw);
      if (!response) {
        // Model returned prose instead of JSON — show it directly as the assistant reply
        setSession((prev) => {
          if (!prev || prev.issue.key !== issueKey) return prev;
          return { ...prev, chat: [...prev.chat, { role: "assistant", content: raw.trim() }], thinking: false };
        });
        return;
      }
      setSession((prev) => {
        // Discard if the user switched tickets while this request was in-flight
        if (!prev || prev.issue.key !== issueKey) return prev;
        let drafts = [...prev.drafts];
        const touchedIds: string[] = [];
        for (const updated of response.updated_edits) {
          const idx = drafts.findIndex((d) => d.id === updated.id);
          if (idx >= 0) {
            const existing = drafts[idx];
            drafts[idx] = { ...existing, suggested: updated.suggested, editedSuggested: existing.userEdited ? existing.editedSuggested : updated.suggested, reasoning: updated.reasoning };
          } else {
            drafts.push({
              id: updated.id, field: updated.field, section: updated.section,
              current: updated.current ?? getCurrentFieldValue(updated.field, prev.issue),
              suggested: updated.suggested, editedSuggested: updated.suggested,
              userEdited: false, reasoning: updated.reasoning, status: "pending",
            });
          }
          touchedIds.push(updated.id);
        }
        if (touchedIds.length > 0) {
          setRecentlyUpdated(new Set(touchedIds));
          if (recentlyUpdatedTimerRef.current) clearTimeout(recentlyUpdatedTimerRef.current);
          recentlyUpdatedTimerRef.current = setTimeout(() => setRecentlyUpdated(new Set()), 2500);
        }
        return { ...prev, drafts, chat: [...prev.chat, { role: "assistant", content: response.message }], thinking: false };
      });
    } catch (e) {
      setSession((prev) => {
        if (!prev || prev.issue.key !== issueKey) return prev;
        return { ...prev, chat: [...prev.chat, { role: "assistant", content: `Sorry, something went wrong: ${String(e)}` }], thinking: false };
      });
    }
  }

  function approveDraft(id: string) {
    setSession((prev) => prev ? { ...prev, drafts: prev.drafts.map((d) => d.id === id ? { ...d, status: "approved", applyResult: undefined, applyError: undefined } : d) } : prev);
  }
  function declineDraft(id: string) {
    setSession((prev) => prev ? { ...prev, drafts: prev.drafts.map((d) => d.id === id ? { ...d, status: "declined" } : d) } : prev);
  }
  function editSuggested(id: string, value: string) {
    setSession((prev) => prev ? { ...prev, drafts: prev.drafts.map((d) => d.id === id ? { ...d, editedSuggested: value, userEdited: value !== d.suggested } : d) } : prev);
  }

  /**
   * Mark an inline AI suggestion as accepted in session state. The actual
   * loading of the suggestion text into the editor happens locally inside
   * FieldEditor — accepting does NOT push to JIRA. The user must click
   * Save on the field afterwards to submit the change.
   */
  function acceptSuggestion(draftId: string) {
    setSession((prev) =>
      prev
        ? {
            ...prev,
            drafts: prev.drafts.map((d) =>
              d.id === draftId ? { ...d, status: "approved" } : d,
            ),
          }
        : prev,
    );
  }

  /**
   * Persist a single edited field back to JIRA, then refetch so the panel
   * reflects whatever JIRA actually stored (round-trips can lose ADF
   * formatting when we send plain text). Throws on failure so the caller
   * can surface the error inline; doesn't touch session state on success
   * other than swapping in the fresh issue.
   */
  async function saveFieldEdit(field: SuggestedEditField, newValue: string) {
    if (!session) return;
    const fieldId = resolveJiraFieldId(field, session.issue);
    if (!fieldId) {
      throw new Error(
        `JIRA field ID for "${field}" hasn't been discovered yet — open the AI analysis once to populate it.`,
      );
    }
    await updateJiraFields(
      session.issue.key,
      JSON.stringify({ [fieldId]: newValue }),
    );
    const fresh = await getIssue(session.issue.key).catch(() => session.issue);
    setSession((prev) => (prev ? { ...prev, issue: fresh } : prev));
  }

  async function applyChanges() {
    if (!session) return;
    const toApply = session.drafts.filter((d) => d.status === "approved" && d.applyResult !== "ok");
    if (toApply.length === 0) return;
    setSession((prev) => (prev ? { ...prev, applying: true } : prev));
    const results: Record<string, { ok: boolean; error?: string }> = {};
    for (const draft of toApply) {
      const fieldId = resolveJiraFieldId(draft.field, session.issue);
      if (!fieldId) { results[draft.id] = { ok: false, error: "Field ID not auto-discovered." }; continue; }
      try {
        // Same image-preservation safety net as the inline confirm path:
        // images in the original field that the AI's suggestion dropped
        // get re-appended so applying the draft never silently strips
        // attachments from the JIRA ticket.
        const original =
          draft.current ?? getCurrentFieldValue(draft.field, session.issue);
        const valueToSave = preserveImagesFromOriginal(
          original,
          draft.editedSuggested,
        );
        await updateJiraFields(session.issue.key, JSON.stringify({ [fieldId]: valueToSave }));
        results[draft.id] = { ok: true };
      } catch (e) {
        results[draft.id] = { ok: false, error: String(e) };
      }
    }
    const freshIssue = await getIssue(session.issue.key).catch(() => session.issue);
    setSession((prev) => prev ? {
      ...prev, issue: freshIssue, applying: false,
      drafts: prev.drafts.map((d) => {
        const r = results[d.id];
        if (!r) return d;
        return { ...d, applyResult: r.ok ? "ok" : "error", applyError: r.error, current: r.ok ? d.editedSuggested : d.current };
      }),
    } : prev);
  }

  const selectedSprint = sprints.find((s) => s.id === selectedSprintId) ?? null;

  const groomingCommands: SlashCommand[] = useMemo(() => {
    const history = session?.chat ?? [];
    return [
      ...createGlobalCommands({
        history,
        clearHistory: () => {
          setSession((prev) => (prev ? { ...prev, chat: [] } : prev));
          useTokenUsageStore.getState().clearPanelChatLastInput("ticket_quality");
        },
        sendMessage: (text: string) => sendChatMessage(text),
        removeLastAssistantMessage: () => {
          setSession((prev) => {
            if (!prev) return prev;
            const chat = prev.chat;
            if (chat.length === 0 || chat[chat.length - 1].role !== "assistant") return prev;
            return { ...prev, chat: chat.slice(0, -1) };
          });
        },
      }),
      {
        name: "blockers",
        description: "Show grooming blockers the assistant flagged",
        execute: ({ toast: t }) => {
          if (!session) { t.info("No session active"); return; }
          const blockers = session.drafts
            .filter((d) => d.reasoning?.toLowerCase().includes("block"))
            .map((d) => `• ${d.field}: ${d.reasoning}`);
          if (blockers.length === 0) {
            t.info("No blockers flagged in the current session");
            return;
          }
          t("Blockers", { description: blockers.join("\n") });
        },
      },
      {
        name: "ac",
        description: "Show the current acceptance criteria",
        execute: async () => {
          await sendChatMessage("Show me the current acceptance criteria verbatim.");
        },
      },
      {
        name: "revise",
        description: "Ask the assistant to revise a specific field",
        args: "<field>",
        execute: async ({ args, toast: t }) => {
          if (!args.trim()) {
            t.error("Provide a field name, e.g. /revise acceptance-criteria");
            return;
          }
          await sendChatMessage(`Please revise the ${args.trim()} field and surface a new suggested value.`);
        },
      },
      {
        name: "apply",
        description: "Push all approved field revisions to JIRA",
        execute: async ({ toast: t }) => {
          if (!session) { t.info("No session active"); return; }
          const toApply = session.drafts.filter((d) => d.status === "approved" && d.applyResult !== "ok");
          if (toApply.length === 0) {
            t.info("Nothing to apply — approve some changes first");
            return;
          }
          await applyChanges();
          t.success(`Applied ${toApply.length} change${toApply.length === 1 ? "" : "s"}`);
        },
      },
      {
        name: "template",
        description: "Remind the assistant of the grooming format template",
        execute: async () => {
          await sendChatMessage(
            "What's the active grooming format template you're working against?",
          );
        },
      },
    ];
    // sendChatMessage + applyChanges close over `session`, so we tie the
    // memo to that. They're stable otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <WorkflowPanelHeader
        panel="ticket_quality"
        leading={
          <>
            <Button variant="ghost" size="icon" className="shrink-0" onClick={onBack}><ArrowLeft className="h-4 w-4" /></Button>
            <div className="min-w-0 flex-1">
              <h1 className={`${APP_HEADER_TITLE} leading-none`}>Groom Tickets</h1>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {selectedSprint ? `${selectedSprint.name}${selectedSprint.state === "future" ? " · upcoming" : ""}` : "AI-assisted ticket grooming with JIRA write-back"}
              </p>
            </div>
          </>
        }
      />

      {/* Credential warnings */}
      {(!jiraAvailable || !claudeAvailable) && (
        <div className="shrink-0 px-4 pt-3 space-y-2">
          {!jiraAvailable && (
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
              JIRA credentials not configured — ticket search unavailable.
            </div>
          )}
          {!claudeAvailable && (
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
              No AI provider configured — grooming assistant unavailable.
            </div>
          )}
        </div>
      )}

      {/* Three-pane resizable layout — flush edge to edge */}
      <div className="flex-1 min-h-0 flex flex-row overflow-hidden">

        {/* ── Left pane: ticket selector ──
            When collapsed, the pane shrinks to a slim strip with just an
            expand button so the middle/right panes get more room. Drag
            divider hides in that mode (resize would be meaningless). */}
        {leftCollapsed ? (
          <div
            className="flex flex-col min-h-0 py-4 pl-4 pr-2"
            style={{ width: 44, minWidth: 44, maxWidth: 44 }}
          >
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setLeftCollapsed(false)}
              title="Show ticket list"
              aria-label="Show ticket list"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-col min-h-0 p-4 pr-0" style={{ width: leftWidth, minWidth: leftWidth, maxWidth: leftWidth }}>
              <Card className="flex flex-col flex-1 min-h-0">
                <CardHeader className="pb-3 shrink-0">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm font-semibold">Select a Ticket</CardTitle>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 -mr-1"
                      onClick={() => setLeftCollapsed(true)}
                      title="Hide ticket list"
                      aria-label="Hide ticket list"
                    >
                      <PanelLeftClose className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 flex flex-col flex-1 min-h-0">
                  <TicketSelector
                    sprints={sprints} selectedSprintId={selectedSprintId} onSelectSprint={selectSprint}
                    sprintIssues={sprintIssues} loadingIssues={loadingIssues}
                    selected={session?.issue ?? null} onSelect={selectTicket}
                  />
                </CardContent>
              </Card>
            </div>

            {/* ── Drag handle 1 (left ↔ middle) ── */}
            <div
              onMouseDown={onLeftDividerMouseDown}
              className="w-1.5 shrink-0 mx-2 rounded-full cursor-col-resize hover:bg-muted-foreground/30 active:bg-muted-foreground/50 transition-colors self-stretch mt-4 mb-4"
              title="Drag to resize"
            />
          </>
        )}

        {/* ── Middle pane: ticket summary + draft changes (scrollable) ── */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-y-auto py-4 gap-4 pr-0">
          {!session && !initError && (
            <div className="flex items-center justify-center rounded-lg border border-dashed h-48 text-muted-foreground text-sm mx-2">
              Select a ticket to start an AI grooming session
            </div>
          )}

          {session && (
            <>
              <div className="mx-2">
                <TicketSummaryCard
                  issue={session.issue}
                  analyzed={session.analyzed}
                  analyzing={session.thinking}
                  onAnalyze={analyzeTicket}
                  claudeAvailable={claudeAvailable}
                />
              </div>

              {initError && !session.thinking && (
                <Card className="border-destructive/50 shrink-0 mx-2">
                  <CardContent className="pt-4 space-y-3">
                    <p className="text-sm text-destructive">{initError}</p>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={analyzeTicket}>
                      <RefreshCw className="h-3.5 w-3.5" /> Retry
                    </Button>
                  </CardContent>
                </Card>
              )}

              <div className="mx-2">
                <TicketFieldsPanel
                  ref={fieldsPanelRef}
                  issue={session.issue}
                  drafts={session.drafts}
                  onSaveField={saveFieldEdit}
                  onAcceptSuggestion={acceptSuggestion}
                  onDeclineSuggestion={declineDraft}
                />
              </div>

              {/* DraftChangesPanel still surfaces drafts whose target field
                  isn't rendered inline above (e.g. summary, future custom
                  fields). Hidden when every pending draft has an inline
                  home so the panel doesn't show empty chrome. */}
              {session.analyzed && hasOrphanDrafts(session.drafts, session.issue) && (
                <div className="mx-2">
                  <DraftChangesPanel
                    drafts={session.drafts.filter((d) =>
                      isOrphanDraft(d, session.issue),
                    )}
                    issue={session.issue}
                    applying={session.applying}
                    highlightedIds={recentlyUpdated}
                    onApprove={approveDraft} onDecline={declineDraft} onEditSuggested={editSuggested}
                    onApply={applyChanges}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Right pane: grooming assistant ──
            Mirror of the left collapse: collapsed mode shrinks to a slim
            strip with an expand button so the middle column reclaims the
            screen, and the resize divider hides because resize is a no-op
            in that mode. */}
        {chatCollapsed ? (
          <div
            className="flex flex-col min-h-0 py-4 pl-2 pr-4"
            style={{ width: 44, minWidth: 44, maxWidth: 44 }}
          >
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setChatCollapsed(false)}
              title="Show chat"
              aria-label="Show chat"
            >
              <PanelRightOpen className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <>
            {/* ── Drag handle 2 (middle ↔ chat) ── */}
            <div
              onMouseDown={onChatDividerMouseDown}
              className="w-1.5 shrink-0 mx-2 rounded-full cursor-col-resize hover:bg-muted-foreground/30 active:bg-muted-foreground/50 transition-colors self-stretch mt-4 mb-4"
              title="Drag to resize"
            />

            <div className="flex flex-col min-h-0 py-4 pl-0 pr-4" style={{ width: chatWidth, minWidth: chatWidth, maxWidth: chatWidth }}>
              {session ? (
                <ChatPanel
                  messages={session.chat}
                  thinking={session.thinking}
                  probeStatus={session.probeStatus}
                  partialOutput={session.partialOutput}
                  onSend={sendChatMessage}
                  commands={groomingCommands}
                  onCollapse={() => setChatCollapsed(true)}
                />
              ) : (
                <Card className="flex flex-col flex-1 min-h-0">
                  <CardHeader className="pb-2 shrink-0 border-b">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="text-sm font-semibold">Grooming Assistant</CardTitle>
                        <p className="text-xs text-muted-foreground">Ask questions or request field changes</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => setChatCollapsed(true)}
                        title="Hide chat"
                        aria-label="Hide chat"
                      >
                        <PanelRightClose className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 flex items-center justify-center">
                    <p className="text-xs text-muted-foreground text-center leading-relaxed">
                      Select a ticket to start<br />a grooming session
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </>
        )}

      </div>
    </div>
  );
}
