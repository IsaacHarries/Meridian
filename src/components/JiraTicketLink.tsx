import { cn } from "@/lib/utils";
import { openUrl } from "@/lib/tauri";

interface JiraTicketLinkProps {
  ticketKey: string;
  url?: string | null;
  className?: string;
}

export function JiraTicketLink({ ticketKey, url, className }: JiraTicketLinkProps) {
  const base = "font-mono text-xs shrink-0";
  if (url) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); openUrl(url); }}
        className={cn(
          base,
          "text-primary hover:underline underline-offset-2 cursor-pointer",
          className
        )}
      >
        {ticketKey}
      </button>
    );
  }
  return (
    <span className={cn(base, "text-muted-foreground", className)}>
      {ticketKey}
    </span>
  );
}


