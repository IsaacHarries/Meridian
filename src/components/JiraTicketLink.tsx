import { openUrl } from "@/lib/tauri/core";
import { cn } from "@/lib/utils";

interface JiraTicketLinkProps {
  ticketKey: string;
  url?: string | null;
  className?: string;
}

export function JiraTicketLink({
  ticketKey,
  url,
  className,
}: JiraTicketLinkProps) {
  const base = "font-mono text-xs shrink-0";
  if (url) {
    return (
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          openUrl(url);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            openUrl(url);
          }
        }}
        className={cn(
          base,
          "text-primary hover:underline underline-offset-2 cursor-pointer",
          className,
        )}
      >
        {ticketKey}
      </span>
    );
  }
  return (
    <span className={cn(base, "text-muted-foreground", className)}>
      {ticketKey}
    </span>
  );
}
