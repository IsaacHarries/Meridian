import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type BitbucketComment } from "@/lib/tauri/bitbucket";
import { type ReviewLens, type ReviewReport } from "@/lib/tauri/pr-review";
import {
    ClipboardList,
    Cpu,
    FlaskConical,
    Loader2,
    Shield,
    Star,
    ThumbsDown,
    ThumbsUp,
} from "lucide-react";
import { BugTestStepsCard, VerdictBadge } from "./_shared";
import { LensPanel } from "./finding-card";

interface ReviewSummaryProps {
  displayReport: Partial<ReviewReport> | null;
  report: ReviewReport | null;
  blockingTotal: number;
  reviewing: boolean;
  rawError: string | null;
  submitAction: "approve" | "needs_work" | null;
  submitStatus: "idle" | "submitting" | "done" | "error";
  submitError: string;
  onSubmitReview: (action: "approve" | "needs_work") => void;
  onJumpToFile: (path: string, line?: number) => void;
  onPostComment: (content: string, file: string | null, lineRange: string | null) => Promise<BitbucketComment>;
  safeLens: (lens?: Partial<ReviewLens>) => ReviewLens;
}

export function ReviewSummary({
  displayReport,
  report,
  blockingTotal,
  reviewing,
  rawError,
  submitAction,
  submitStatus,
  submitError,
  onSubmitReview,
  onJumpToFile,
  onPostComment,
  safeLens,
}: ReviewSummaryProps) {
  const lensTabLabel = (key: keyof ReviewReport["lenses"], icon: React.ReactNode, label: string) => {
    if (!displayReport?.lenses) return <>{icon}<span className="hidden sm:inline ml-1">{label}</span></>;
    const findings = safeLens(displayReport.lenses[key]).findings;
    const hasBlocking = findings.some((f) => f.severity === "blocking");
    const hasNonBlocking = findings.some((f) => f.severity === "non_blocking");
    const dotColor = hasBlocking ? "bg-red-500" : hasNonBlocking ? "bg-amber-500" : null;
    const dotTitle = hasBlocking
      ? "Has blocking findings"
      : hasNonBlocking
        ? "Has non-blocking findings"
        : undefined;
    return (
      <span className="flex items-center gap-1">
        {icon}
        <span className="hidden sm:inline">{label}</span>
        {dotColor && (
          <span
            className={`h-2 w-2 rounded-full inline-block ${dotColor}`}
            title={dotTitle}
            aria-label={dotTitle}
          />
        )}
      </span>
    );
  };

  return (
    <>
      {(displayReport || rawError) && (
        <div className="p-4 border-b space-y-3">
          {displayReport && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                {displayReport.overall ? (
                  <VerdictBadge overall={displayReport.overall} />
                ) : (
                  <span className="text-xs text-muted-foreground italic">Verdict pending…</span>
                )}
                {blockingTotal > 0 && (
                  <span className="text-xs text-red-600 dark:text-red-400 font-medium">
                    {blockingTotal} blocking {blockingTotal === 1 ? "issue" : "issues"}
                  </span>
                )}
              </div>
              {displayReport.summary && (
                <p className="text-sm text-muted-foreground leading-relaxed">{displayReport.summary}</p>
              )}

              {/* Bug test steps — only show on the final report */}
              {report && report.bug_test_steps && (
                <BugTestStepsCard steps={report.bug_test_steps} />
              )}

              {/* Submit to Bitbucket — only after the final, validated report */}
              {report && !reviewing && (
              <div className="pt-1 space-y-2">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Submit to Bitbucket</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => onSubmitReview("approve")}
                    disabled={submitStatus === "submitting"}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border transition-colors disabled:opacity-50 ${
                      submitAction === "approve" && submitStatus === "done"
                        ? "bg-green-600 text-white border-green-600 hover:bg-green-700"
                        : "border-green-600 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/30"
                    }`}
                    title={submitAction === "approve" && submitStatus === "done" ? "Click to remove your approval" : "Approve this PR in Bitbucket"}
                  >
                    {submitStatus === "submitting" && submitAction !== "needs_work" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ThumbsUp className="h-3.5 w-3.5" />
                    )}
                    {submitAction === "approve" && submitStatus === "done" ? "Approved ✓" : "Approve"}
                  </button>

                  <button
                    onClick={() => onSubmitReview("needs_work")}
                    disabled={submitStatus === "submitting"}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border transition-colors disabled:opacity-50 ${
                      submitAction === "needs_work" && submitStatus === "done"
                        ? "bg-amber-600 text-white border-amber-600 hover:bg-amber-700"
                        : "border-amber-600 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30"
                    }`}
                    title={submitAction === "needs_work" && submitStatus === "done" ? "Click to remove 'Needs work'" : "Mark as Needs work in Bitbucket"}
                  >
                    {submitStatus === "submitting" && submitAction !== "approve" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ThumbsDown className="h-3.5 w-3.5" />
                    )}
                    {submitAction === "needs_work" && submitStatus === "done" ? "Needs work ✓" : "Needs work"}
                  </button>

                  {submitStatus === "error" && (
                    <span className="text-xs text-destructive leading-tight max-w-[200px]" title={submitError}>
                      {submitError.includes("Write")
                        ? "App Password needs 'Pull requests: Write' scope — update it in Settings"
                        : "Failed — see title for details"}
                    </span>
                  )}
                </div>
              </div>
              )}
            </div>
          )}

          {rawError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
              <p className="text-xs font-medium text-destructive mb-1">Review error</p>
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                {rawError}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Findings tabs — render against displayReport so cards
          populate live as the synthesis JSON streams in. */}
      {displayReport?.lenses && (
        <div className="p-4">
          <Tabs defaultValue="acceptance_criteria">
            <TabsList className="grid grid-cols-5 w-full">
              <TabsTrigger value="acceptance_criteria" className="px-1">
                {lensTabLabel("acceptance_criteria", <ClipboardList className="h-3.5 w-3.5" />, "AC")}
              </TabsTrigger>
              <TabsTrigger value="security" className="px-1">
                {lensTabLabel("security", <Shield className="h-3.5 w-3.5" />, "Security")}
              </TabsTrigger>
              <TabsTrigger value="logic" className="px-1">
                {lensTabLabel("logic", <Cpu className="h-3.5 w-3.5" />, "Logic")}
              </TabsTrigger>
              <TabsTrigger value="quality" className="px-1">
                {lensTabLabel("quality", <Star className="h-3.5 w-3.5" />, "Quality")}
              </TabsTrigger>
              <TabsTrigger value="testing" className="px-1">
                {lensTabLabel("testing", <FlaskConical className="h-3.5 w-3.5" />, "Testing")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="acceptance_criteria" className="mt-4">
              <LensPanel lens={safeLens(displayReport.lenses.acceptance_criteria)} onJumpToFile={onJumpToFile} onPostComment={onPostComment} />
            </TabsContent>
            <TabsContent value="security" className="mt-4">
              <LensPanel lens={safeLens(displayReport.lenses.security)} onJumpToFile={onJumpToFile} onPostComment={onPostComment} />
            </TabsContent>
            <TabsContent value="logic" className="mt-4">
              <LensPanel lens={safeLens(displayReport.lenses.logic)} onJumpToFile={onJumpToFile} onPostComment={onPostComment} />
            </TabsContent>
            <TabsContent value="quality" className="mt-4">
              <LensPanel lens={safeLens(displayReport.lenses.quality)} onJumpToFile={onJumpToFile} onPostComment={onPostComment} />
            </TabsContent>
            <TabsContent value="testing" className="mt-4">
              <LensPanel lens={safeLens(displayReport.lenses.testing) ?? { assessment: "No testing analysis available.", findings: [] }} onJumpToFile={onJumpToFile} onPostComment={onPostComment} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </>
  );
}
