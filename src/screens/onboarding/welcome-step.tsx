import { ArrowRight, FlaskRound } from "lucide-react";
import { Button } from "@/components/ui/button";

export function WelcomeStep({ onNext, onMockMode }: { onNext: () => void; onMockMode?: () => void }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-bold tracking-tight">Welcome to Meridian</h1>
        <p className="text-muted-foreground max-w-sm mx-auto">
          Your personal engineering productivity hub. Let's connect your tools to get started.
        </p>
      </div>

      <div className="space-y-3">
        {[
          { icon: "🤖", title: "AI-powered workflows", desc: "Pluggable AI agents handle implementation planning, PR reviews, and code analysis" },
          { icon: "📋", title: "JIRA integration", desc: "Tickets, sprint dashboards, and retrospectives pulled directly from your workspace" },
          { icon: "🔀", title: "Bitbucket integration", desc: "PR reviews, team metrics, and workload balancing from your repos" },
        ].map((item) => (
          <div key={item.title} className="flex items-start gap-3 rounded-lg border p-3">
            <span className="text-xl">{item.icon}</span>
            <div>
              <p className="text-sm font-medium">{item.title}</p>
              <p className="text-xs text-muted-foreground">{item.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-center text-muted-foreground">
        You'll connect at least one AI provider (Claude, Gemini, Copilot, or a
        local LLM) plus credentials for JIRA and Bitbucket.
      </p>

      <Button className="w-full" size="lg" onClick={onNext}>
        Get started <ArrowRight className="h-4 w-4" />
      </Button>

      {onMockMode && (
        <div className="border-t pt-4">
          <button
            onClick={onMockMode}
            className="w-full flex items-center justify-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
          >
            <FlaskRound className="h-3.5 w-3.5" />
            Try with mock data (no API keys needed)
          </button>
        </div>
      )}
    </div>
  );
}
