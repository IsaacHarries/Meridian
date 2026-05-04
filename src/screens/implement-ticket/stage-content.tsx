import { Button } from "@/components/ui/button";
import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { type JiraIssue } from "@/lib/tauri/jira";
import { type GroomingOutput, type ImpactOutput, type ImplementationOutput, type ImplementationPlan, type PlanReviewOutput, type PrDescriptionOutput, type RetrospectiveOutput, type SuggestedEdit, type TestOutput, type TestPlan, type TriageMessage, type TriageTurnOutput } from "@/lib/tauri/workflows";
import { type BuildCheckResult, type ReplanCheckpointPayload } from "@/lib/tauri/worktree";
import { useImplementTicketStore } from "@/stores/implementTicket/store";
import { type ImplementTicketState, type Stage } from "@/stores/implementTicket/types";
import { Loader2, RefreshCw } from "lucide-react";
import {
    BlockerBanner,
    STAGE_LABELS,
    StageApprovalRow,
    StreamingLoader,
} from "./_shared";
import { GroomingPanel, GroomingProgressBanner } from "./grooming-panel";
import { ImpactPanel } from "./impact-panel";
import { ImplementationPanel } from "./implementation-panel";
import { PlanPanel } from "./plan-panel";
import { PrPanel } from "./pr-panel";
import { ReplanApprovalRow, ReplanPanel } from "./replan-panel";
import { RetroPanel } from "./retro-panel";
import { ReviewPanel } from "./review-panel";
import { TestPlanPanel, TestsPanel } from "./test-panels";
import { TriagePanel } from "./triage-panel";

interface StageContentProps {
  stage: Stage;
  selectedIssue: JiraIssue | null;
  errors: Partial<Record<Stage, string>>;
  completedStages: Set<Stage>;
  proceeding: boolean;

  // Stage outputs (final + partial coalesced for display)
  grooming: GroomingOutput | null;
  partialGrooming: ImplementTicketState["partialGrooming"];
  impact: ImpactOutput | null;
  partialImpact: ImplementTicketState["partialImpact"];
  plan: ImplementationPlan | null;
  partialPlan: ImplementTicketState["partialPlan"];
  implementation: ImplementationOutput | null;
  implementationStreamText: string;
  implementationProgress: ImplementTicketState["implementationProgress"];
  buildVerification: BuildCheckResult | null;
  buildCheckStreamText: string;
  replanCheckpoint: ReplanCheckpointPayload | null;
  testPlan: TestPlan | null;
  tests: TestOutput | null;
  testsStreamText: string;
  review: PlanReviewOutput | null;
  partialReview: ImplementTicketState["partialReview"];
  prDescription: PrDescriptionOutput | null;
  partialPrDescription: ImplementTicketState["partialPrDescription"];
  createdPr: BitbucketPr | null;
  prSubmitStatus: "idle" | "squashing" | "pushing" | "creating" | "error";
  prSubmitError: string | null;
  retrospective: RetrospectiveOutput | null;
  partialRetrospective: ImplementTicketState["partialRetrospective"];

  // Grooming-only fields
  groomingEdits: SuggestedEdit[];
  clarifyingQuestions: string[];
  clarifyingQuestionsInitial: string[];
  groomingHighlights: { editIds: string[]; questions: boolean };
  showHighlights: boolean;
  filesRead: string[];
  groomingBaseline: GroomingOutput | null;
  jiraUpdateStatus: "idle" | "saving" | "saved" | "error";
  jiraUpdateError: string;
  groomingProgress: string;
  groomingStreamText: string;
  groomingBlockers: ImplementTicketState["groomingBlockers"];

  // Triage-only fields
  triageHistory: TriageMessage[];
  triageTurns: TriageTurnOutput[];
  triageStreamText: string;
  planFinalizing: boolean;

  // Implementation panel local UI
  implementationTab: "status" | "diff";

  // Pipeline-level
  currentStage: Stage;
}

export function StageContent(props: StageContentProps) {
  const {
    stage,
    selectedIssue,
    errors,
    completedStages,
    proceeding,
    grooming,
    partialGrooming,
    impact,
    partialImpact,
    plan,
    partialPlan,
    implementation,
    implementationStreamText,
    implementationProgress,
    buildVerification,
    buildCheckStreamText,
    replanCheckpoint,
    testPlan,
    tests,
    testsStreamText,
    review,
    partialReview,
    prDescription,
    partialPrDescription,
    createdPr,
    prSubmitStatus,
    prSubmitError,
    retrospective,
    partialRetrospective,
    groomingEdits,
    clarifyingQuestions,
    clarifyingQuestionsInitial,
    groomingHighlights,
    showHighlights,
    filesRead,
    groomingBaseline,
    jiraUpdateStatus,
    jiraUpdateError,
    groomingProgress,
    groomingStreamText,
    groomingBlockers,
    triageHistory,
    triageTurns,
    triageStreamText,
    planFinalizing,
    implementationTab,
    currentStage,
  } = props;

  const store = useImplementTicketStore.getState;

  function renderCheckpoint(s: Stage) {
    if (!completedStages.has(s)) return null;
    return (
      <StageApprovalRow
        stage={s}
        onProceed={() => store().proceedFromStage(s)}
        proceeding={proceeding}
        hasBlockingIssues={
          s === "review" &&
          (review?.findings.some((f) => f.severity === "blocking") ?? false)
        }
        onRetry={() => store().retryStage(s)}
        disabledReason={
          s === "pr" && !createdPr
            ? "Create the draft PR on Bitbucket before moving on."
            : undefined
        }
      />
    );
  }

  // Coalesce final + partial agent outputs into a guaranteed-non-null
  // object so each panel can render its full structure on stage entry,
  // even before any data has streamed. Empty fields render as skeleton
  // glow (`isStreaming` flag flips false the moment the final output
  // lands, swapping the placeholders for real content).
  const groomingForDisplay: GroomingOutput = grooming ?? {
    ticket_summary: partialGrooming?.ticket_summary ?? "",
    ticket_type: partialGrooming?.ticket_type ?? "task",
    acceptance_criteria: partialGrooming?.acceptance_criteria ?? [],
    relevant_areas: partialGrooming?.relevant_areas ?? [],
    dependencies: partialGrooming?.dependencies ?? [],
    estimated_complexity: partialGrooming?.estimated_complexity ?? "low",
    grooming_notes: partialGrooming?.grooming_notes ?? "",
    suggested_edits: partialGrooming?.suggested_edits ?? [],
    clarifying_questions: partialGrooming?.clarifying_questions ?? [],
  };
  const impactForDisplay: ImpactOutput = impact ?? {
    risk_level: partialImpact?.risk_level ?? "low",
    risk_justification: partialImpact?.risk_justification ?? "",
    affected_areas: partialImpact?.affected_areas ?? [],
    potential_regressions: partialImpact?.potential_regressions ?? [],
    cross_cutting_concerns: partialImpact?.cross_cutting_concerns ?? [],
    files_needing_consistent_updates:
      partialImpact?.files_needing_consistent_updates ?? [],
    recommendations: partialImpact?.recommendations ?? "",
  };
  const planForDisplay: ImplementationPlan = plan ?? {
    summary: partialPlan?.summary ?? "",
    files: partialPlan?.files ?? [],
    order_of_operations: partialPlan?.order_of_operations ?? [],
    edge_cases: partialPlan?.edge_cases ?? [],
    do_not_change: partialPlan?.do_not_change ?? [],
    assumptions: partialPlan?.assumptions ?? [],
    open_questions: partialPlan?.open_questions ?? [],
  };
  const reviewForDisplay: PlanReviewOutput = review ?? {
    confidence: partialReview?.confidence ?? "needs_attention",
    summary: partialReview?.summary ?? "",
    findings: partialReview?.findings ?? [],
    things_to_address: partialReview?.things_to_address ?? [],
    things_to_watch: partialReview?.things_to_watch ?? [],
  };
  const prDescriptionForDisplay: PrDescriptionOutput = prDescription ?? {
    title: partialPrDescription?.title ?? "",
    description: partialPrDescription?.description ?? "",
  };
  const retrospectiveForDisplay: RetrospectiveOutput = retrospective ?? {
    what_went_well: partialRetrospective?.what_went_well ?? [],
    what_could_improve: partialRetrospective?.what_could_improve ?? [],
    patterns_identified: partialRetrospective?.patterns_identified ?? [],
    agent_skill_suggestions:
      partialRetrospective?.agent_skill_suggestions ?? [],
    summary: partialRetrospective?.summary ?? "",
  };

  const err = errors[stage];
  if (err) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 space-y-3">
        <p className="text-sm font-medium text-destructive">
          Error in {STAGE_LABELS[stage as keyof typeof STAGE_LABELS]}
        </p>
        <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
          {err}
        </pre>
        <Button
          size="sm"
          variant="outline"
          className="gap-2"
          onClick={() => store().retryStage(stage)}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (stage === "grooming") {
    // Always render the panel — empty fields show skeleton glow rows,
    // and they fill in as the grooming agent streams. The probe banner
    // (worktree pull / file discovery) only shows when we're still in
    // pre-stream setup AND haven't received any partial data yet.
    const inPreStream =
      !grooming && !partialGrooming && groomingProgress.length > 0;
    return (
      <div className="space-y-3">
        {inPreStream && (
          <GroomingProgressBanner
            message={groomingProgress}
            streamText={groomingStreamText}
          />
        )}
        {!grooming && !inPreStream && (
          <p className="text-xs text-muted-foreground italic flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            Streaming grooming analysis…
          </p>
        )}
        <GroomingPanel
          data={groomingForDisplay}
          isStreaming={!grooming}
          baseline={groomingBaseline}
          descriptionSections={selectedIssue?.descriptionSections}
          description={selectedIssue?.description}
          stepsToReproduce={selectedIssue?.stepsToReproduce}
          observedBehavior={selectedIssue?.observedBehavior}
          expectedBehavior={selectedIssue?.expectedBehavior}
          suggestedEdits={groomingEdits}
          clarifyingQuestions={clarifyingQuestions}
          clarifyingQuestionsInitial={clarifyingQuestionsInitial}
          highlights={groomingHighlights}
          showHighlights={showHighlights}
          onToggleHighlights={() => store().toggleHighlights()}
          filesRead={filesRead}
          onApproveEdit={(id) => store().handleApproveEdit(id)}
          onDeclineEdit={(id) => store().handleDeclineEdit(id)}
          onEditSuggested={(id, text) =>
            store().handleEditSuggested(id, text)
          }
          onUpdateJira={() => store().pushGroomingToJira()}
          jiraUpdateStatus={jiraUpdateStatus}
          jiraUpdateError={jiraUpdateError}
        />
        {groomingBlockers.length > 0 && (
          <BlockerBanner blockers={groomingBlockers} />
        )}
        {grooming && renderCheckpoint("grooming")}
      </div>
    );
  }
  if (stage === "impact") {
    return (
      <>
        {!impact && (
          <p className="text-xs text-muted-foreground italic flex items-center gap-1.5 mb-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            Streaming impact analysis…
          </p>
        )}
        <ImpactPanel data={impactForDisplay} isStreaming={!impact} />
        {impact && renderCheckpoint(stage)}
      </>
    );
  }
  if (stage === "triage" || stage === "plan") {
    if (plan && completedStages.has("plan")) {
      return (
        <>
          <PlanPanel data={plan} />
          {renderCheckpoint("plan")}
        </>
      );
    }
    if (triageHistory.length === 0) {
      return (
        <StreamingLoader
          label="Starting triage conversation…"
          streamText={triageStreamText}
        />
      );
    }
    if (planFinalizing) {
      // Render the plan panel always — empty fields glow as skeletons
      // and fill in as the plan agent streams.
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground italic flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            Streaming implementation plan…
          </p>
          <PlanPanel data={planForDisplay} isStreaming={!plan} />
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <TriagePanel
          history={triageHistory}
          turns={triageTurns}
          streamText={triageStreamText}
        />
        <div className="rounded-md border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          Refine via the chat on the right. Click{" "}
          <span className="font-medium text-foreground">Finalise Plan</span>{" "}
          when ready.
        </div>
      </div>
    );
  }
  if (stage === "implementation") {
    if (!implementation) {
      const label = implementationProgress
        ? `Writing ${implementationProgress.file} (${implementationProgress.fileIndex}/${implementationProgress.totalFiles})…`
        : "Writing code…";
      return (
        <StreamingLoader
          label={label}
          streamText={implementationStreamText}
        />
      );
    }
    // Implementation written but build check still running (no buildVerification yet,
    // but buildCheckStreamText is accumulating)
    if (!buildVerification && buildCheckStreamText) {
      return (
        <StreamingLoader
          label="Verifying build…"
          streamText={buildCheckStreamText}
        />
      );
    }
    return (
      <>
        <ImplementationPanel
          data={implementation}
          tab={implementationTab}
          buildVerification={buildVerification}
        />
        {renderCheckpoint(stage)}
      </>
    );
  }
  if (stage === "replan") {
    if (!replanCheckpoint) {
      return (
        <div className="rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground">
          Waiting for plan-revision checkpoint payload…
        </div>
      );
    }
    return (
      <>
        <ReplanPanel data={replanCheckpoint} />
        <ReplanApprovalRow
          onRevise={() =>
            store().proceedFromStage("replan", { action: "revise" })
          }
          onAccept={() =>
            store().proceedFromStage("replan", { action: "approve" })
          }
          onAbort={() =>
            store().proceedFromStage("replan", {
              action: "abort",
              reason: "user aborted at plan-revision checkpoint",
            })
          }
          proceeding={proceeding}
          canRevise={replanCheckpoint.revisions_remaining > 0}
        />
      </>
    );
  }
  if (stage === "tests_plan") {
    if (!testPlan)
      return (
        <StreamingLoader
          label="Proposing test plan…"
          streamText={testsStreamText}
        />
      );
    return (
      <>
        <TestPlanPanel data={testPlan} />
        {renderCheckpoint(stage)}
      </>
    );
  }
  if (stage === "tests") {
    if (!tests)
      return (
        <StreamingLoader
          label="Writing tests…"
          streamText={testsStreamText}
        />
      );
    return (
      <>
        <TestsPanel data={tests} />
        {renderCheckpoint(stage)}
      </>
    );
  }
  if (stage === "review") {
    return (
      <>
        {!review && (
          <p className="text-xs text-muted-foreground italic flex items-center gap-1.5 mb-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            Streaming code review…
          </p>
        )}
        <ReviewPanel data={reviewForDisplay} isStreaming={!review} />
        {review && renderCheckpoint(stage)}
      </>
    );
  }
  if (stage === "pr") {
    return (
      <>
        {!prDescription && (
          <p className="text-xs text-muted-foreground italic flex items-center gap-1.5 mb-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            Streaming PR description…
          </p>
        )}
        <PrPanel
          data={prDescriptionForDisplay}
          createdPr={createdPr}
          submitStatus={prSubmitStatus}
          submitError={prSubmitError}
          onSubmit={() => store().submitDraftPr()}
          isStreaming={!prDescription}
        />
        {prDescription && renderCheckpoint(stage)}
      </>
    );
  }
  if (stage === "retro") {
    return (
      <>
        {!retrospective && (
          <p className="text-xs text-muted-foreground italic flex items-center gap-1.5 mb-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            Streaming retrospective…
          </p>
        )}
        <RetroPanel
          data={retrospectiveForDisplay}
          isStreaming={!retrospective}
        />
        {retrospective &&
          currentStage !== "complete" &&
          renderCheckpoint(stage)}
      </>
    );
  }
  return null;
}
