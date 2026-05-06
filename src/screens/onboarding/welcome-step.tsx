import { BitbucketIcon, JiraIcon } from "@atlaskit/logo";
import { ArrowRight, FlaskRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiGlyph } from "./hero-svgs";

/** Feature row icons. The AI glyph is our own custom chip SVG; the JIRA and
 *  Bitbucket glyphs use Atlassian's official brand icons via @atlaskit/logo
 *  so the integrations are immediately recognisable. */
type FeatureGlyph = (props: { className?: string }) => React.ReactNode;

const JiraGlyphAtlas: FeatureGlyph = ({ className }) => (
  <span className={className}>
    <JiraIcon appearance="brand" size="small" label="Jira" />
  </span>
);

const BitbucketGlyphAtlas: FeatureGlyph = ({ className }) => (
  <span className={className}>
    <BitbucketIcon appearance="brand" size="small" label="Bitbucket" />
  </span>
);

const FEATURES = [
  {
    Glyph: AiGlyph,
    title: "AI-powered workflows",
    desc: "Pluggable AI agents handle implementation planning, PR reviews, and code analysis",
  },
  {
    Glyph: JiraGlyphAtlas,
    title: "JIRA integration",
    desc: "Tickets, sprint dashboards, and retrospectives pulled directly from your workspace",
  },
  {
    Glyph: BitbucketGlyphAtlas,
    title: "Bitbucket integration",
    desc: "PR reviews, team metrics, and workload balancing from your repos",
  },
] as const;

export function WelcomeStep({ onNext, onMockMode }: { onNext: () => void; onMockMode?: () => void }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-bold tracking-tight">Welcome to Meridian</h1>
        <p className="text-muted-foreground max-w-sm mx-auto">
          Your personal engineering productivity hub. Let's connect your tools to get started.
        </p>
      </div>

      <div className="space-y-2">
        {FEATURES.map(({ Glyph, title, desc }) => (
          <div
            key={title}
            className="flex items-center gap-3 rounded-lg border border-primary/15 bg-card/40 p-3 transition-colors hover:border-primary/30 hover:bg-card/60"
          >
            <span className="shrink-0 inline-flex h-9 w-9 items-center justify-center">
              <Glyph className="h-9 w-9" />
            </span>
            <div>
              <p className="text-sm font-medium">{title}</p>
              <p className="text-xs text-muted-foreground">{desc}</p>
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
        <div className="border-t border-primary/15 pt-4">
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
