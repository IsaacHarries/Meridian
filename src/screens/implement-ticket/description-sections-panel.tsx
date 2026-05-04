import { type DescriptionSection } from "@/lib/tauri/jira";
import { BookOpen } from "lucide-react";
import { CollapsibleSection } from "./_shared";

/**
 * Parse a flat description string into sections by detecting common heading
 * patterns used in JIRA tickets:
 *   - "h1." / "h2." / "h3." (Confluence wiki markup)
 *   - "## Heading" (Markdown)
 *   - "**Heading**" on its own line (bold heading)
 *   - "Heading:" on its own line where the heading is 1–5 words (short label)
 */
export function parseDescriptionText(text: string): DescriptionSection[] {
  if (!text.trim()) return [];

  const lines = text.split("\n");
  const sections: DescriptionSection[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  const headingPattern =
    /^(?:h[1-6]\.\s*(.+)|#{1,3}\s+(.+)|(\*{1,2})(.+)\3\s*$)/;
  // A line that is just a short phrase (1-6 words) ending in ":" and nothing else
  const labelPattern = /^([A-Z][^:\n]{2,40}):\s*$/;

  function flush() {
    const content = currentLines.join("\n").trim();
    if (content || currentHeading !== null) {
      sections.push({ heading: currentHeading, content });
    }
    currentLines = [];
  }

  for (const line of lines) {
    const hMatch = line.match(headingPattern);
    const labelMatch = !hMatch && line.match(labelPattern);
    const heading = hMatch
      ? (hMatch[1] || hMatch[2] || hMatch[4] || "").trim()
      : labelMatch
        ? labelMatch[1].trim()
        : null;

    if (heading) {
      flush();
      currentHeading = heading;
    } else {
      currentLines.push(line);
    }
  }
  flush();

  // Drop empty leading/trailing sections
  return sections.filter(
    (s) => s.heading !== null || s.content.trim().length > 0,
  );
}

export function DescriptionSectionsPanel({
  sections,
  fallbackDescription,
}: {
  sections: DescriptionSection[];
  fallbackDescription?: string | null;
}) {
  // Use structured sections from ADF if available; otherwise parse the flat text.
  const resolved: DescriptionSection[] =
    sections.length > 0
      ? sections
      : fallbackDescription
        ? parseDescriptionText(fallbackDescription)
        : [];

  if (resolved.length === 0) return null;

  // If there's only one section with no heading it's just prose — show it simply.
  if (resolved.length === 1 && !resolved[0].heading) {
    return (
      <div className="border rounded-md overflow-hidden">
        <div className="px-3 py-2 bg-muted/30 text-sm font-medium">
          Description
        </div>
        <div className="px-3 py-2">
          <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed">
            {resolved[0].content}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="border rounded-md overflow-hidden divide-y">
      <div className="px-3 py-2 bg-muted/30 text-sm font-medium flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        Key Details
      </div>
      {resolved.map((section, i) => (
        <CollapsibleSection
          key={i}
          heading={section.heading}
          content={section.content}
        />
      ))}
    </div>
  );
}
