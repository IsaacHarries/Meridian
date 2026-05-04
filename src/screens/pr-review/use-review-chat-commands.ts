import { createGlobalCommands, type SlashCommand } from "@/lib/slashCommands";
import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { type ReviewReport } from "@/lib/tauri/pr-review";
import { enrichMessageWithUrls } from "@/lib/urlFetch";
import { usePrReviewStore } from "@/stores/prReview/store";
import { ask } from "@tauri-apps/plugin-dialog";
import { useMemo } from "react";

interface UseReviewChatCommandsArgs {
  reviewChat: { role: "user" | "assistant"; content: string }[];
  selectedPr: BitbucketPr | null;
  report: ReviewReport | null;
  setReviewChatSending: (sending: boolean) => void;
}

/**
 * Build the slash-command set for the post-review chat. Extracted from the
 * shell to keep PrReviewScreen.tsx under the project's per-file size budget.
 */
export function useReviewChatCommands({
  reviewChat,
  selectedPr,
  report,
  setReviewChatSending,
}: UseReviewChatCommandsArgs): SlashCommand[] {
  const store = usePrReviewStore.getState;

  return useMemo(() => {
    const send = async (text: string) => {
      setReviewChatSending(true);
      try {
        const enriched = await enrichMessageWithUrls(text);
        await store().sendReviewChatMessage(enriched);
      } finally {
        setReviewChatSending(false);
      }
    };

    return [
      ...createGlobalCommands({
        history: reviewChat,
        clearHistory: () => store().clearReviewChat(),
        sendMessage: send,
        removeLastAssistantMessage: () => store().dropLastReviewAssistantTurn(),
      }),
      {
        name: "approve",
        description: "Approve the PR (confirms first)",
        execute: async ({ toast: t }) => {
          if (!selectedPr) return;
          const ok = await ask(
            `Approve PR #${selectedPr.id}: ${selectedPr.title}?`,
            { title: "Approve PR", kind: "info" },
          );
          if (ok) {
            await store().submitReview("approve");
            t.success("PR approved");
          }
        },
      },
      {
        name: "request-changes",
        description: "Submit a request-changes review",
        execute: async ({ toast: t }) => {
          if (!selectedPr) return;
          const ok = await ask(
            `Request changes on PR #${selectedPr.id}?`,
            { title: "Request changes", kind: "warning" },
          );
          if (ok) {
            await store().submitReview("needs_work");
            t.success("Requested changes");
          }
        },
      },
      {
        name: "diff",
        description: "Ask the AI to discuss the current diff",
        args: "[file]",
        execute: async ({ args }) => {
          const prompt = args
            ? `Focus on the changes in ${args} and explain what changed and why.`
            : "Summarise the full diff — the key changes and any risks you see.";
          await send(prompt);
        },
      },
      {
        name: "findings",
        description: "Show the current review findings",
        execute: ({ toast: t }) => {
          if (!report) {
            t.info("No findings yet. Run the review first.");
            return;
          }
          const all: string[] = [];
          for (const [lensName, lens] of Object.entries(report.lenses)) {
            for (const f of lens.findings.slice(0, 6)) {
              const loc = [f.file, f.line_range].filter(Boolean).join(":");
              all.push(
                `[${f.severity}] ${lensName}: ${f.title}${loc ? ` — ${loc}` : ""}`,
              );
            }
          }
          if (all.length === 0) {
            t.info("No findings reported");
            return;
          }
          t("Findings", { description: all.slice(0, 20).join("\n") });
        },
      },
      {
        name: "lens",
        description: "Focus the chat on a single lens",
        args: "security|logic|ac|quality",
        execute: async ({ args, toast: t }) => {
          const lens = args.trim().toLowerCase();
          const known = ["security", "logic", "ac", "quality"];
          if (!known.includes(lens)) {
            t.error("Pick one of: security, logic, ac, quality");
            return;
          }
          await send(
            `Re-examine this PR strictly through the ${lens} lens. Surface anything you may have understated in the initial review.`,
          );
        },
      },
      {
        name: "comment",
        description: "Post a top-level PR comment",
        args: "<text>",
        execute: async ({ args, toast: t }) => {
          if (!args.trim()) {
            t.error("Provide the comment text, e.g. /comment LGTM pending tests");
            return;
          }
          try {
            await store().postComment(args);
            t.success("Comment posted");
          } catch (e) {
            t.error("Failed to post comment", { description: String(e) });
          }
        },
      },
    ];
    // store is a stable function reference (Zustand), so depending on the
    // captured arguments only matches the original useMemo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewChat, selectedPr, report]);
}
