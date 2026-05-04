import { HumanMessage } from "@langchain/core/messages";
import { buildModel } from "../../../models/factory.js";
import type { ModelSelection } from "../../../protocol.js";
import {
  readRepoFileDirect,
  statRepoFile,
} from "../../../tools/repo-tools.js";
import { resolveModelSelection } from "../../../tools/refresh-credentials.js";
import type {
  FileVerification,
  ImplementationFileResult,
  ImplementationOutput,
} from "../../pipeline-schemas.js";
import { IMPLEMENTATION_PER_FILE_SYSTEM } from "../../pipeline-prompts.js";
import { PerFileResponseSchema } from "../schemas.js";
import {
  appendSkill,
  extractText,
  isTransientModelError,
  parseStructuredResponse,
} from "../helpers.js";
import {
  runToolLoop,
  runToolLoopFrom,
  type ToolLoopResult,
} from "../tool-loop.js";
import type { PipelineGraphContext, PipelineState } from "../state.js";

export type FileVerificationOutcome = FileVerification["outcome"];

export interface VerifyResult {
  outcome: FileVerificationOutcome;
  detail?: string;
}

/** Compare pre/post on-disk state to the planned action. Returns "ok" only
 *  when the disk truly reflects the planned change. The `unchanged` case is
 *  only detectable when we successfully snapshotted pre-content; without a
 *  snapshot we err on the side of trusting the size+exists signal. */
export function classifyVerification(
  action: "create" | "modify" | "delete",
  post: { exists: boolean; sizeBytes: number },
  preContent: string | undefined,
  postContent: string | undefined,
): VerifyResult {
  if (action === "delete") {
    return post.exists
      ? { outcome: "still_present", detail: `file still on disk (${post.sizeBytes} bytes)` }
      : { outcome: "ok" };
  }
  if (!post.exists) {
    return { outcome: "missing", detail: "file not found on disk after iteration" };
  }
  if (post.sizeBytes === 0) {
    return { outcome: "empty", detail: "file is empty after iteration" };
  }
  if (action === "modify" && preContent !== undefined && postContent !== undefined) {
    if (postContent === preContent) {
      return {
        outcome: "unchanged",
        detail: "file contents are byte-for-byte identical to before the iteration",
      };
    }
  }
  return { outcome: "ok" };
}

export function buildVerificationReprompt(
  file: { path: string; action: "create" | "modify" | "delete" },
  result: VerifyResult,
): string {
  return (
    `Verification failed for ${file.path} (planned action: ${file.action}). ` +
    `On-disk check reports: ${result.outcome}` +
    `${result.detail ? ` — ${result.detail}` : ""}. ` +
    (file.action === "delete"
      ? `The file should NOT be on disk. Remove it (the worktree write tool can't delete; if you can't satisfy this, return the JSON with skipped:true and explain).`
      : `Call write_repo_file with the COMPLETE new content, then return the JSON summary again.`) +
    ` This is the final retry — if the file is still not correct after this turn, the iteration will be marked as a verification failure.`
  );
}

export function makeImplementationNode(ctx: PipelineGraphContext) {
  const { tools, workflowId, emit } = ctx;
  return async function implementationNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    if (!state.plan) throw new Error("Implementation node ran before plan was finalised");

    const system = appendSkill(
      IMPLEMENTATION_PER_FILE_SYSTEM,
      state.input.skills?.implementation,
      "IMPLEMENTATION CONVENTIONS",
    );

    const filesChanged: ImplementationFileResult[] = [];
    const deviations: string[] = [];
    const skipped: string[] = [];
    const verificationFailures: FileVerification[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };

    // Re-resolve the full ModelSelection before each file. This both keeps
    // OAuth tokens fresh (Gemini CodeAssist tokens are ~1h) and picks up any
    // model/provider change the user has made via the header dropdown since
    // the workflow started — the workflow doesn't have to be restarted.
    let currentSelection: ModelSelection = state.model;

    const totalFiles = state.plan.files.length;
    for (let fileIndex = 0; fileIndex < totalFiles; fileIndex++) {
      const file = state.plan.files[fileIndex];
      // Surface per-file progress so the frontend can show
      // "Writing src/cli.ts (3/8)…" instead of a static "Writing code…".
      emit({
        id: workflowId,
        type: "progress",
        node: "implementation",
        status: "started",
        data: {
          phase: "file_started",
          file: file.path,
          fileIndex: fileIndex + 1,
          totalFiles,
        },
      });

      try {
        currentSelection = await resolveModelSelection({
          workflowId,
          panel: "implement_ticket",
          stage: "pipeline",
          emit,
        });
        console.error(
          `[implementation] ${file.path}: using ${currentSelection.provider}/${currentSelection.model}`,
        );
      } catch (err) {
        console.error(
          `[implementation] model refresh failed before ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Snapshot pre-state so we can verify what actually changed on disk.
      // For modify-actions we also snapshot prior content so we can detect
      // the "model wrote the same bytes back" case (which the size+exists
      // signal alone misses).
      let preContent: string | undefined;
      try {
        const pre = await statRepoFile({ workflowId, emit, path: file.path });
        if (file.action === "modify" && pre.exists) {
          try {
            preContent = await readRepoFileDirect({
              workflowId,
              emit,
              path: file.path,
            });
          } catch {
            // Pre-content snapshot is best-effort; we'll still verify exists+size.
          }
        }
      } catch (err) {
        console.error(
          `[implementation] pre-stat failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const userPrompt =
        `Plan entry: ${JSON.stringify(file, null, 2)}\n\n` +
        `Full ticket context:\n${state.input.ticketText}\n\n` +
        `Full plan summary:\n${state.plan.summary}\n\n` +
        `Implement ONLY this single file. Use read_repo_file first if you need context, then write_repo_file with the COMPLETE new content.`;

      // Try the file once; on a transient model-quality / quota error
      // (Gemini MALFORMED_FUNCTION_CALL, 429, etc.) retry once with a fresh
      // model build before giving up.
      const emitCtx = {
        emit: ctx.emit,
        workflowId: ctx.workflowId,
        nodeName: "implementation",
      };
      let attempt: ToolLoopResult | undefined;
      let lastErr: unknown;
      for (let tries = 0; tries < 2; tries++) {
        try {
          const model = buildModel(currentSelection);
          attempt = await runToolLoop(model, tools, system, userPrompt, emitCtx);
          break;
        } catch (err) {
          lastErr = err;
          if (tries === 0 && isTransientModelError(err)) {
            console.error(
              `[implementation] transient error on ${file.path}, retrying: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
          break;
        }
      }

      if (!attempt) {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        skipped.push(`${file.path}: tool-loop failed (${msg})`);
        verificationFailures.push({
          path: file.path,
          expected_action: file.action,
          outcome: "read_error",
          detail: `tool loop failed: ${msg}`,
        });
        continue;
      }

      // Verify what actually happened on disk. This is the source of truth —
      // not `writtenPaths` (which the model can lie about) and not the JSON
      // final response (which can claim success without a real write_repo_file
      // call). On verification failure, give the model ONE re-prompt to fix
      // it within the same conversation so it has full context.
      const verify = async (): Promise<VerifyResult> => {
        let post: { exists: boolean; sizeBytes: number };
        try {
          post = await statRepoFile({ workflowId, emit, path: file.path });
        } catch (err) {
          return {
            outcome: "read_error",
            detail: err instanceof Error ? err.message : String(err),
          };
        }
        let postContent: string | undefined;
        if (
          file.action === "modify" &&
          preContent !== undefined &&
          post.exists &&
          post.sizeBytes > 0
        ) {
          try {
            postContent = await readRepoFileDirect({
              workflowId,
              emit,
              path: file.path,
            });
          } catch {
            // Be lenient if we can't read post-content — exists+size is enough.
          }
        }
        return classifyVerification(file.action, post, preContent, postContent);
      };

      let outcome = await verify();

      if (outcome.outcome !== "ok") {
        emit({
          id: workflowId,
          type: "progress",
          node: "implementation",
          status: "started",
          data: {
            phase: "verification_retry",
            file: file.path,
            outcome: outcome.outcome,
            detail: outcome.detail,
          },
        });
        attempt.messages.push(new HumanMessage(buildVerificationReprompt(file, outcome)));
        try {
          const model = buildModel(currentSelection);
          const retry = await runToolLoopFrom(
            model,
            tools,
            attempt.messages,
            emitCtx,
          );
          attempt.usage.inputTokens += retry.usage.inputTokens;
          attempt.usage.outputTokens += retry.usage.outputTokens;
          attempt.writtenPaths.push(...retry.writtenPaths);
          attempt.finalMessage = retry.finalMessage;
          attempt.messages = retry.messages;
          outcome = await verify();
        } catch (err) {
          console.error(
            `[implementation] verification re-prompt failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      usage.inputTokens += attempt.usage.inputTokens;
      usage.outputTokens += attempt.usage.outputTokens;

      const action: ImplementationFileResult["action"] =
        file.action === "delete"
          ? "deleted"
          : file.action === "create"
            ? "created"
            : "modified";

      // Parse the structured summary for descriptive text + deviations. The
      // verification result, not this parse, decides success/failure now.
      let parsedSummary = "";
      let parsedDeviations: string[] = [];
      let modelDeclaredSkip = false;
      try {
        const raw =
          extractText(attempt.finalMessage.content) || attempt.finalMessage.text;
        const parsed = PerFileResponseSchema.parse(parseStructuredResponse(raw));
        parsedSummary = parsed.summary;
        parsedDeviations = parsed.deviations;
        modelDeclaredSkip = parsed.skipped;
      } catch {
        // Tolerate malformed structured output — disk truth is what matters.
      }

      if (outcome.outcome === "ok") {
        filesChanged.push({
          path: file.path,
          action,
          summary:
            parsedSummary ||
            `Implementation ${action}; structured summary not provided.`,
        });
      } else {
        emit({
          id: workflowId,
          type: "progress",
          node: "implementation",
          status: "completed",
          data: {
            phase: "verification_failed",
            file: file.path,
            outcome: outcome.outcome,
            detail: outcome.detail,
          },
        });
        verificationFailures.push({
          path: file.path,
          expected_action: file.action,
          outcome: outcome.outcome,
          detail: outcome.detail,
        });
        if (modelDeclaredSkip) {
          skipped.push(
            `${file.path}: ${parsedSummary || "model declined to implement"}`,
          );
        } else {
          skipped.push(
            `${file.path}: verification failed (${outcome.outcome}${outcome.detail ? ` — ${outcome.detail}` : ""})`,
          );
        }
      }
      if (parsedDeviations.length) {
        deviations.push(...parsedDeviations.map((d) => `${file.path}: ${d}`));
      }
    }

    const output: ImplementationOutput = {
      summary: `Implemented ${filesChanged.length} of ${state.plan.files.length} planned file(s)${skipped.length ? `, skipped ${skipped.length}` : ""}${verificationFailures.length ? `, ${verificationFailures.length} verification failure(s)` : ""}.`,
      files_changed: filesChanged,
      deviations,
      skipped,
    };
    // Persist the most recently-refreshed credentials so downstream nodes
    // (test_gen, code_review) see them too. `verificationFailures` is read by
    // the upcoming `replan_check` routing edge.
    return {
      implementationOutput: output,
      verificationFailures,
      usage,
      model: currentSelection,
    };
  };
}
