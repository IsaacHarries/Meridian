import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { isMockMode } from "@/lib/tauri/core";
import { getNonSecretConfig } from "@/lib/tauri/credentials";
import { type JiraIssue, getIssue } from "@/lib/tauri/jira";
import { type SkillType, loadAgentSkills } from "@/lib/tauri/templates";
import { type PipelineResumeAction, type PipelineWorkflowArgs, parseAgentJson, resumeImplementationPipelineWorkflow, runGroomingFileProbe, runImplementationPipelineWorkflow } from "@/lib/tauri/workflows";
import { commitWorktreeChanges, createFeatureBranch, createPullRequest, grepGroomingFiles, pushWorktreeBranch, readGroomingFile, squashWorktreeCommits, syncGroomingWorktree, syncWorktree } from "@/lib/tauri/worktree";
import { NEXT_STAGE_AFTER_PROCEED } from "../constants";
import {
    applyWorkflowResult,
    compileTicketText,
    snapshotSession,
} from "../helpers";
import { INITIAL } from "../initial";
import type { ImplementTicketState, Stage } from "../types";

type Set = (
  partial:
    | Partial<ImplementTicketState>
    | ((s: ImplementTicketState) => Partial<ImplementTicketState>),
) => void;
type Get = () => ImplementTicketState;

export function createImplementationActions(set: Set, get: Get) {
  return {
    startPipeline: async (issue: JiraIssue) => {
      const current = get();

      // ── Save current session into the map before switching ─────────────
      // Skip if grooming never completed — no point restoring a half-run agent.
      if (
        current.selectedIssue &&
        current.currentStage !== "select" &&
        !(current.currentStage === "grooming" && current.grooming === null)
      ) {
        const snapshot = snapshotSession(current);
        const sessions = new Map(current.sessions);
        sessions.set(current.selectedIssue.key, snapshot);
        set({ sessions });
      }

      // ── Restore an existing session for this ticket ───────────────────
      // Only restorable if the session was driven by the LangGraph workflow
      // path and has a live thread we can resume from. Sessions created by
      // the old per-stage flow are discarded — restoring them would leave
      // `pipelineThreadId` null and the next Proceed click would fail with
      // "Pipeline workflow has no active thread".
      const existingSession = get().sessions.get(issue.key);
      if (
        existingSession &&
        existingSession.currentStage !== "select" &&
        existingSession.pipelineThreadId
      ) {
        // Assign a fresh session ID — the old backend process is gone.
        set({
          ...existingSession,
          selectedIssue: issue,
          isSessionActive: true,
          activeSessionId: crypto.randomUUID(),
        });
        return;
      }

      // ── Fresh start for a new ticket ──────────────────────────────────
      const sessions = get().sessions;
      set({
        ...INITIAL,
        sessions, // preserve the sessions map across resets
        selectedIssue: issue,
        currentStage: "grooming",
        viewingStage: "grooming",
        isSessionActive: true,
        activeSessionId: crypto.randomUUID(),
      });

      // Fetch full issue details
      let fullIssue = issue;
      try {
        fullIssue = await getIssue(issue.key);
        set({ selectedIssue: fullIssue });
      } catch {
        /* fall back to sprint-list version */
      }

      const text = compileTicketText(fullIssue);
      set({ ticketText: text });

      let skills: Partial<Record<SkillType, string>> = {};
      try {
        skills = await loadAgentSkills();
      } catch {
        /* no skills */
      }
      set({ skills });

      // Sync worktrees
      try {
        const config = await getNonSecretConfig();
        if (config["repo_worktree_path"]) {
          const info = await syncWorktree();
          set({ worktreeInfo: info });
        }
        // Pull latest on the grooming worktree so file reads are from develop
        if (config["grooming_worktree_path"] || config["repo_worktree_path"]) {
          await syncGroomingWorktree();
        }
      } catch (e) {
        console.warn("[Meridian] Worktree sync failed:", e);
      }

      // ── Pre-load codebase context via the grooming file probe ─────────
      // The grooming agent expects file contents in its prompt. Without them
      // the model often replies "I need to read X first" rather than
      // producing the schema-conformant JSON. Run the probe step now and
      // pass the result through to the workflow.
      const { worktreeInfo: probeWorktreeInfo } = get();
      const repoContext = probeWorktreeInfo
        ? `\n\n=== CODEBASE CONTEXT ===\nWorktree: ${probeWorktreeInfo.path}\nBranch: ${probeWorktreeInfo.branch} (HEAD: ${probeWorktreeInfo.headCommit})\nCommit: ${probeWorktreeInfo.headMessage}\nYou have access to this codebase. File contents will be injected below after a probe step.`
        : "";

      let codebaseContext = "";
      const readFilesForProbe: string[] = [];
      if (repoContext) {
        try {
          set({
            groomingProgress: "Identifying relevant files in the codebase…",
          });
          const probeRaw = await runGroomingFileProbe(text + repoContext);
          const probe = parseAgentJson<{
            files: string[];
            grep_patterns: string[];
          }>(probeRaw);
          if (probe) {
            const MAX_TOTAL = 40 * 1024;
            let totalSize = 0;
            const parts: string[] = [];
            for (const filePath of (probe.files ?? []).slice(0, 12)) {
              try {
                set({ groomingProgress: `Reading ${filePath}…` });
                const content = await readGroomingFile(filePath);
                const chunk = `--- ${filePath} ---\n${content}\n`;
                if (totalSize + chunk.length > MAX_TOTAL) break;
                parts.push(chunk);
                totalSize += chunk.length;
                readFilesForProbe.push(filePath);
              } catch (e) {
                console.warn("[Meridian] file probe read failed:", filePath, e);
              }
            }
            for (const pattern of (probe.grep_patterns ?? []).slice(0, 6)) {
              try {
                set({
                  groomingProgress: `Searching codebase for "${pattern}"…`,
                });
                const lines = await grepGroomingFiles(pattern);
                if (lines.length === 0) continue;
                const chunk = `--- grep: ${pattern} ---\n${lines.join("\n")}\n`;
                if (totalSize + chunk.length > MAX_TOTAL) break;
                parts.push(chunk);
                totalSize += chunk.length;
              } catch (e) {
                console.warn("[Meridian] file probe grep failed:", pattern, e);
              }
            }
            codebaseContext = parts.join("\n");
            set({ filesRead: readFilesForProbe, groomingProgress: "" });
          }
        } catch (e) {
          console.warn("[Meridian] file probe failed:", e);
          set({ groomingProgress: "" });
        }
      }

      // ── Pipeline workflow: run all stages via LangGraph in the sidecar ─
      // Dynamic import to break the circular dep: `../listeners` imports
      // `useImplementTicketStore` from `../store`, which imports this
      // action factory. Importing listeners eagerly here would race with
      // the store's `create()` call.
      const { ensurePipelineListener } = await import("../listeners");
      await ensurePipelineListener();

      // Build worktree path from settings (used by the workflow for tool calls).
      let worktreePath = "";
      try {
        const config = await getNonSecretConfig();
        worktreePath = (config["repo_worktree_path"] as string) ?? "";
      } catch {
        /* fall back to empty — workflow tools won't function, but the
           workflow itself will at least surface the missing config */
      }

      const runId = crypto.randomUUID();
      const args: PipelineWorkflowArgs = {
        ticketText: text + (repoContext || ""),
        ticketKey: fullIssue.key,
        ticketType: fullIssue.issueType,
        worktreePath,
        codebaseContext,
        skills: {
          grooming: skills.grooming ?? null,
          patterns: (skills as Record<string, string | undefined>).patterns ?? null,
          implementation: skills.implementation ?? null,
          review: skills.review ?? null,
          testing: (skills as Record<string, string | undefined>).testing ?? null,
        },
        runId,
      };

      set({ proceeding: true, currentRunId: runId });
      try {
        const result = await runImplementationPipelineWorkflow(args);
        applyWorkflowResult((updater) => set((s) => updater(s)), result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set((s) => ({
          errors: { ...s.errors, [s.currentStage]: msg },
          proceeding: false,
        }));
      }
    },

    finalizePlan: async () => {
      // Finalising the triage chat == approving the triage checkpoint. The
      // workflow then runs the plan + guidance nodes silently and interrupts
      // at the implementation checkpoint, where the user reviews the plan
      // before the implementation agent starts writing code.
      const runId = crypto.randomUUID();
      set({
        pendingApproval: null,
        proceeding: true,
        currentRunId: runId,
        // Optimistically advance the visible stage to "plan" so the
        // plan-finalising panel renders immediately — same pattern as
        // proceedFromStage. The plan partial fills in as it streams.
        currentStage: "plan",
        viewingStage: "plan",
      });
      try {
        // Create the feature branch BEFORE implementation runs — once the
        // workflow advances past triage it'll execute plan → guidance →
        // implementation in sequence, and the implementation agent's
        // write_repo_file calls need to land on the feature branch, not
        // the base branch.
        const { selectedIssue, featureBranch } = get();
        if (selectedIssue && !featureBranch) {
          try {
            const info = await createFeatureBranch(
              selectedIssue.key,
              selectedIssue.summary ?? "",
            );
            set({ featureBranch: info.branch, worktreeInfo: info });
          } catch (e) {
            console.warn("[Meridian] createFeatureBranch failed:", e);
          }
        }

        const threadId = get().pipelineThreadId;
        if (!threadId) {
          throw new Error(
            "Pipeline workflow has no active thread — cannot finalize plan.",
          );
        }
        const result = await resumeImplementationPipelineWorkflow(
          threadId,
          { action: "approve" },
          runId,
        );
        applyWorkflowResult((updater) => set((s) => updater(s)), result);
        get().markComplete("triage");
      } catch (e) {
        set({ proceeding: false });
        get().setError("plan", String(e));
      }
    },

    submitDraftPr: async () => {
      const { selectedIssue, prDescription, featureBranch, createdPr } = get();
      if (createdPr) return; // idempotent
      if (!selectedIssue || !prDescription) {
        set({
          prSubmitStatus: "error",
          prSubmitError: "PR description is not ready yet.",
        });
        return;
      }

      // Mock-mode short-circuit: skip squash / push / createPullRequest so we
      // never touch a real git remote or Bitbucket when the user is driving
      // the pipeline with mock JIRA tickets. Stamp a synthetic BitbucketPr so
      // the UI flow can still advance to Retrospective.
      if (isMockMode()) {
        const now = new Date().toISOString();
        const mockPr: BitbucketPr = {
          id: 0,
          title: prDescription.title,
          description: prDescription.description,
          state: "OPEN",
          author: { displayName: "Mock", nickname: "mock", accountId: null },
          reviewers: [],
          sourceBranch: featureBranch ?? `feature/${selectedIssue.key}`,
          destinationBranch: "develop",
          createdOn: now,
          updatedOn: now,
          commentCount: 0,
          taskCount: 0,
          url: "",
          jiraIssueKey: selectedIssue.key,
          changesRequested: false,
          draft: true,
        };
        set({ createdPr: mockPr, prSubmitStatus: "idle", prSubmitError: null });
        return;
      }

      if (!featureBranch) {
        set({
          prSubmitStatus: "error",
          prSubmitError:
            "No feature branch was recorded for this session — re-run Implementation to create one.",
        });
        return;
      }

      const baseBranch =
        (await getNonSecretConfig().catch(
          () => ({}) as Record<string, string>,
        ))["repo_base_branch"] || "develop";

      // Commit message: use the PR title as subject; the description as body.
      // Keeping the JIRA key first means Bitbucket's JIRA integration picks it
      // up from the commit too, not just the branch name.
      const subject = prDescription.title.startsWith(selectedIssue.key)
        ? prDescription.title
        : `${selectedIssue.key}: ${prDescription.title}`;
      const squashMessage = `${subject}\n\n${prDescription.description}`;

      set({ prSubmitStatus: "squashing", prSubmitError: null });
      try {
        await squashWorktreeCommits(squashMessage);
      } catch (e) {
        set({
          prSubmitStatus: "error",
          prSubmitError: `Squash failed: ${String(e)}`,
        });
        return;
      }

      set({ prSubmitStatus: "pushing" });
      try {
        await pushWorktreeBranch();
      } catch (e) {
        set({
          prSubmitStatus: "error",
          prSubmitError: `Push failed: ${String(e)}`,
        });
        return;
      }

      set({ prSubmitStatus: "creating" });
      try {
        const pr = await createPullRequest(
          prDescription.title,
          prDescription.description,
          featureBranch,
          baseBranch,
        );
        set({ createdPr: pr, prSubmitStatus: "idle" });
      } catch (e) {
        set({
          prSubmitStatus: "error",
          prSubmitError: `Create PR failed: ${String(e)}`,
        });
      }
    },

    proceedFromStage: async (
      stage: Stage,
      action: PipelineResumeAction = { action: "approve" },
    ) => {
      // Advance the visible stage immediately on Proceed so the user
      // jumps to the next stage's panel and watches its partial output
      // stream in, rather than seeing the loading icon on the prior
      // stage for the duration of the workflow round-trip. Only applies
      // to forward-moving actions: revise loops back to plan; abort and
      // reply stay where they are.
      const nextStage =
        action.action === "approve" ? NEXT_STAGE_AFTER_PROCEED[stage] : null;
      // Mint a fresh runId for this resume call so the listener can
      // distinguish events of this run from any prior run that may
      // still be in-flight (the most common case being the user
      // clicking through stages quickly enough that resume N+1's
      // events overlap with resume N's tail).
      const runId = crypto.randomUUID();
      const advanceUpdates: Partial<ImplementTicketState> = {
        pendingApproval: null,
        proceeding: true,
        currentRunId: runId,
      };
      if (nextStage) {
        advanceUpdates.currentStage = nextStage;
        if (nextStage !== "complete") {
          advanceUpdates.viewingStage = nextStage as Exclude<Stage, "select">;
        }
      }
      set(advanceUpdates);
      try {
        // Side-effects that the old per-stage proceed flow handled around the
        // implementation/tests boundary. The workflow itself doesn't commit;
        // the user's local feature branch needs the commits to accumulate
        // real history that the PR stage can squash later. Skip when revising
        // — the partial work hasn't reached an approved state yet.
        const isApprove = action.action === "approve";
        if (isApprove && (stage === "implementation" || stage === "tests")) {
          const { selectedIssue } = get();
          if (selectedIssue) {
            const msg = `${selectedIssue.key}: ${stage}`;
            try {
              await commitWorktreeChanges(msg);
            } catch (e) {
              console.warn(`[Meridian] commit after ${stage} failed:`, e);
            }
          }
        }

        const threadId = get().pipelineThreadId;
        if (!threadId) {
          throw new Error(
            "Pipeline workflow has no active thread — cannot resume. Restart the pipeline.",
          );
        }
        const result = await resumeImplementationPipelineWorkflow(
          threadId,
          action,
          runId,
        );
        applyWorkflowResult((updater) => set((s) => updater(s)), result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set((s) => ({
          errors: { ...s.errors, [stage]: msg },
          proceeding: false,
        }));
      }
    },
  };
}
