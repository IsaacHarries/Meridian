import { SlashCommandInput } from "@/components/SlashCommandInput";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type SlashCommand } from "@/lib/slashCommands";
import { type BitbucketComment, type BitbucketPr } from "@/lib/tauri/bitbucket";
import { GitBranch, Loader2, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { type RefObject } from "react";
import { type ChatMessage, type FixProposal } from "./_shared";
import { FixPlanCard } from "./fix-plan-card";

export function FixPlanStep({
  selectedPr,
  comments,
  chatHistory,
  chatLoading,
  chatStreamReply,
  chatInput,
  setChatInput,
  sendChatRaw,
  addressChatCommands,
  chatEndRef,
  fixPlan,
  toggleApprove,
  toggleSkip,
  setAnnotation,
  stepError,
  handleApplyFixes,
  loadDiff,
  onBackToList,
}: {
  selectedPr: BitbucketPr;
  comments: BitbucketComment[];
  chatHistory: ChatMessage[];
  chatLoading: boolean;
  chatStreamReply: string;
  chatInput: string;
  setChatInput: (s: string) => void;
  sendChatRaw: (text: string) => void | Promise<void>;
  addressChatCommands: SlashCommand[];
  chatEndRef: RefObject<HTMLDivElement>;
  fixPlan: FixProposal[];
  toggleApprove: (i: number) => void;
  toggleSkip: (i: number) => void;
  setAnnotation: (i: number, text: string) => void;
  stepError: string | null;
  handleApplyFixes: () => void;
  loadDiff: () => void;
  onBackToList: () => void;
}) {
  return (
    <div className="space-y-4">
      {/* PR info header */}
      <div className="rounded-xl border bg-card/60 p-4 flex items-center gap-3">
        <GitBranch className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{selectedPr.title}</p>
          <p className="text-xs text-muted-foreground">
            {selectedPr.sourceBranch} → {selectedPr.destinationBranch}
          </p>
        </div>
        <Badge variant="outline">{comments.length} comment{comments.length !== 1 ? "s" : ""}</Badge>
      </div>

      {/* Chat / assistant message */}
      {chatHistory.length > 0 && (
        <div className="rounded-xl border bg-card/60 p-4 space-y-3">
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {chatHistory.map((msg, i) => (
              <div
                key={i}
                className={`text-sm rounded-lg px-3 py-2 ${
                  msg.role === "assistant"
                    ? "bg-muted/50 text-foreground"
                    : "bg-primary/10 text-primary ml-auto max-w-[80%]"
                }`}
              >
                <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
              </div>
            ))}
            {chatLoading && chatStreamReply ? (
              <div className="text-sm rounded-lg px-3 py-2 bg-muted/50 text-foreground">
                <p className="whitespace-pre-wrap leading-relaxed">
                  {chatStreamReply}
                  <span
                    aria-hidden
                    className="inline-block ml-0.5 w-1.5 h-3.5 align-text-bottom bg-foreground/60 animate-pulse"
                  />
                </p>
              </div>
            ) : (
              chatLoading && (
                <div className="bg-muted/50 rounded-lg px-3 py-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                </div>
              )
            )}
            <div ref={chatEndRef} />
          </div>
          {/* Chat input */}
          <div className="pt-1 border-t">
            <SlashCommandInput
              value={chatInput}
              onChange={setChatInput}
              onSend={(text) => sendChatRaw(text)}
              commands={addressChatCommands}
              busy={chatLoading}
              placeholder="Ask about the fix plan. Enter to send. / for commands."
            />
          </div>
        </div>
      )}

      {/* Fix proposals */}
      {fixPlan.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              {fixPlan.length} Proposed Fix{fixPlan.length !== 1 ? "es" : ""}
            </h3>
            <div className="flex gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <ThumbsUp className="h-3 w-3" />
                {fixPlan.filter((f) => f.approved && !f.skipped).length} approved
              </span>
              <span className="flex items-center gap-1">
                <ThumbsDown className="h-3 w-3" />
                {fixPlan.filter((f) => f.skipped).length} skipped
              </span>
            </div>
          </div>

          {fixPlan.map((fix, i) => (
            <FixPlanCard
              key={fix.commentId}
              fix={fix}
              index={i}
              onToggleApprove={toggleApprove}
              onToggleSkip={toggleSkip}
              onAnnotationChange={setAnnotation}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border bg-card/60 p-6 text-center text-muted-foreground text-sm">
          No automatic fixes could be generated. The comments may require manual attention.
        </div>
      )}

      {stepError && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <X className="h-4 w-4 shrink-0" /> {stepError}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={handleApplyFixes} disabled={fixPlan.filter((f) => f.approved && !f.skipped).length === 0 && fixPlan.length > 0}>
          Apply {fixPlan.filter((f) => f.approved && !f.skipped).length} Approved Fix{fixPlan.filter((f) => f.approved && !f.skipped).length !== 1 ? "es" : ""}
        </Button>
        <Button
          variant="outline"
          onClick={loadDiff}
        >
          Skip to Diff Review
        </Button>
        <Button
          variant="ghost"
          onClick={onBackToList}
        >
          Back to PR List
        </Button>
      </div>
    </div>
  );
}
