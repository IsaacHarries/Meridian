import { cn } from "@/lib/utils";

interface JiraTicketLinkProps {
  /** The ticket key, e.g. "FJP-123" */
  ticketKey: string;
  /** Full JIRA URL. If omitted the key is rendered as plain text. */
  url?: string | null;
  className?: string;
}

/**
 * Renders a JIRA ticket key as a clickable link that opens in the browser.
 * Falls back to a plain <span> when no URL is available.
 */
export function JiraTicketLink({ ticketKey, url, className }: JiraTicketLinkProps) {
  const base = "font-mono text-xs shrink-0";
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          base,
          "text-primary hover:underline underline-offset-2 cursor-pointer",
          className
        )}
      >
        {ticketKey}
      </a>
    );
  }
  return (
    <span className={cn(base, "text-muted-foreground", className)}>
      {ticketKey}
    </span>
  );
}

