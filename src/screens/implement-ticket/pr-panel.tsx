import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonLines } from "@/components/ui/skeleton";
import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { isMockMode, openUrl } from "@/lib/tauri/core";
import { type PrDescriptionOutput } from "@/lib/tauri/workflows";
import {
    CheckCircle2,
    ExternalLink,
    GitPullRequest,
    Loader2,
} from "lucide-react";
import { CopyButton } from "./_shared";

interface PrPanelProps {
  data: PrDescriptionOutput;
  createdPr: BitbucketPr | null;
  submitStatus: "idle" | "squashing" | "pushing" | "creating" | "error";
  submitError: string | null;
  onSubmit: () => void;
  isStreaming?: boolean;
}

export function PrPanel({
  data,
  createdPr,
  submitStatus,
  submitError,
  onSubmit,
  isStreaming,
}: PrPanelProps) {
  const mock = isMockMode();
  const submitting =
    submitStatus === "squashing" ||
    submitStatus === "pushing" ||
    submitStatus === "creating";
  const submitLabel: Record<PrPanelProps["submitStatus"], string> = mock
    ? {
        idle: "Skip PR creation (mock mode)",
        squashing: "Working…",
        pushing: "Working…",
        creating: "Working…",
        error: "Retry",
      }
    : {
        idle: "Create Draft PR on Bitbucket",
        squashing: "Squashing commits…",
        pushing: "Pushing branch…",
        creating: "Creating PR on Bitbucket…",
        error: "Retry: Create Draft PR",
      };

  const hasTitle = data.title.trim().length > 0;
  const hasDescription = data.description.trim().length > 0;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground font-medium mb-1">
            PR Title
          </p>
          {hasTitle ? (
            <p className="text-sm font-semibold">{data.title}</p>
          ) : isStreaming ? (
            <Skeleton className="h-4 w-3/4" />
          ) : null}
        </div>
        <CopyButton
          text={`${data.title}\n\n${data.description}`}
          label="Copy PR"
        />
      </div>
      <div>
        <p className="text-xs text-muted-foreground font-medium mb-1">
          Description
        </p>
        {hasDescription ? (
          <pre className="text-sm font-sans leading-relaxed whitespace-pre-wrap bg-muted/30 rounded-md p-3 max-h-80 overflow-y-auto">
            {data.description}
          </pre>
        ) : isStreaming ? (
          <div className="bg-muted/30 rounded-md p-3 space-y-2">
            <SkeletonLines count={5} />
          </div>
        ) : null}
      </div>

      {/* Submission area — squash + push + draft PR creation on Bitbucket. */}
      {createdPr ? (
        createdPr.url ? (
          <div className="border rounded-md p-3 bg-emerald-500/5 border-emerald-500/30 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              Draft PR created on Bitbucket
            </div>
            <p className="text-xs text-muted-foreground">
              Created with no reviewers so nobody is notified. Add reviewers
              from the Bitbucket UI when you're ready for real review.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => createdPr.url && openUrl(createdPr.url)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open PR #{createdPr.id}
            </Button>
          </div>
        ) : (
          <div className="border rounded-md p-3 bg-muted/30 space-y-1.5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
              PR creation skipped (mock mode)
            </div>
            <p className="text-xs text-muted-foreground">
              Nothing was pushed to origin and no PR was opened on Bitbucket.
              You can proceed to the retrospective.
            </p>
          </div>
        )
      ) : (
        <div className="border rounded-md p-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            {mock
              ? "Mock mode is on — clicking below will mark the PR stage complete without pushing anything to origin or opening a PR on Bitbucket."
              : "Submitting will squash your implementation + tests commits into one, push the feature branch to origin, and open a PR on Bitbucket with no reviewers attached — use the Bitbucket UI to add reviewers when you're ready."}
          </p>
          {submitStatus === "error" && submitError && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/30 rounded p-2">
              {submitError}
            </div>
          )}
          <Button
            onClick={onSubmit}
            disabled={submitting}
            className="gap-2"
            size="sm"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <GitPullRequest className="h-4 w-4" />
            )}
            {submitLabel[submitStatus]}
          </Button>
        </div>
      )}
    </div>
  );
}
