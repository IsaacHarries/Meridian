import { ArrowLeft, Construction } from "lucide-react";
import { Button } from "@/components/ui/button";

export type WorkflowId =
  | "implement-ticket"
  | "review-pr"
  | "sprint-dashboard"
  | "retrospectives"
  | "standup"
  | "workload-balancer"
  | "ticket-quality"
  | "knowledge-base";

const WORKFLOW_META: Record<WorkflowId, { title: string; description: string; step: number }> = {
  "implement-ticket": {
    title: "Implement a Ticket",
    description: "Full 8-agent pipeline from JIRA ticket to raised PR.",
    step: 12,
  },
  "review-pr": {
    title: "Review a Pull Request",
    description: "AI-assisted code review across four analysis lenses.",
    step: 11,
  },
  "sprint-dashboard": {
    title: "Sprint Dashboard",
    description: "Real-time sprint health, team performance, and blockers.",
    step: 5,
  },
  "retrospectives": {
    title: "Sprint Retrospectives",
    description: "Metrics and AI summaries for completed sprints.",
    step: 6,
  },
  "standup": {
    title: "Daily Standup Briefing",
    description: "Auto-generated standup agenda from JIRA and Bitbucket activity.",
    step: 7,
  },
  "workload-balancer": {
    title: "Team Workload Balancer",
    description: "Visualise and rebalance work across the team.",
    step: 8,
  },
  "ticket-quality": {
    title: "Ticket Quality Checker",
    description: "Readiness assessment for backlog and sprint tickets.",
    step: 10,
  },
  "knowledge-base": {
    title: "Knowledge Base",
    description: "Searchable log of decisions, patterns, and retrospective learnings.",
    step: 9,
  },
};

interface WorkflowScreenProps {
  workflowId: WorkflowId;
  onBack: () => void;
}

export function WorkflowScreen({ workflowId, onBack }: WorkflowScreenProps) {
  const meta = WORKFLOW_META[workflowId];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="font-semibold">{meta.title}</h1>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-16 flex flex-col items-center text-center gap-4 bg-background/60 rounded-xl">
        <div className="rounded-full bg-muted p-4">
          <Construction className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{meta.title}</h2>
          <p className="text-sm text-muted-foreground max-w-sm">{meta.description}</p>
        </div>
        <p className="text-xs text-muted-foreground border rounded-full px-3 py-1">
          Build step {meta.step}
        </p>
      </main>
    </div>
  );
}
