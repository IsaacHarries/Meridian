import { useState } from "react";
import { MarkdownBlock } from "@/components/MarkdownBlock";
import { cn } from "@/lib/utils";

// ── PR description panel (above the diff) ─────────────────────────────────────
//
// Bitbucket returns the description as raw markdown. We feed it through the
// same `renderCommentContent` used for inline comments, so embedded images
// (via Bitbucket attachment URLs or data URIs) flow through `BitbucketImage`
// — Bitbucket-hosted ones get auth-proxied, data URIs render inline, public
// URLs load directly. Long descriptions collapse to a clamped preview with
// a "Show more" toggle so the diff isn't pushed below the fold on PRs with
// detailed write-ups.

export function PrDescriptionPanel({ description }: { description: string }) {
  const [expanded, setExpanded] = useState(false);
  // Heuristic: descriptions over ~6 lines or 600 chars get the collapsible
  // treatment. Anything shorter renders fully without the toggle so short
  // PRs don't carry unnecessary chrome.
  const isLong =
    description.split("\n").length > 6 || description.length > 600;
  return (
    <section className="pt-4 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Description
        </p>
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
      <div
        className={cn(
          "rounded-md border border-border/60 bg-muted/20 px-3 py-2",
          // When clamped, cap the height with a soft fade at the bottom so
          // the truncation is obvious and the user knows there's more.
          isLong && !expanded && "max-h-48 overflow-hidden relative",
        )}
      >
        <MarkdownBlock text={description} />
        {isLong && !expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background/80 to-transparent" />
        )}
      </div>
    </section>
  );
}
