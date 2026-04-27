import { Wrench, X } from "lucide-react";

export interface ToolRequest {
  id: string;
  name: string;
  description: string;
  whyNeeded: string;
  exampleCall: string;
  dismissed: boolean;
}

interface Props {
  request: ToolRequest;
  onDismiss: (id: string) => void;
}

/**
 * Rendered in the chat whenever an agent autonomously calls `request_tool`.
 * Shows what tool the agent wanted, why it needed it, and an example call.
 */
export function ToolRequestCard({ request, onDismiss }: Props) {
  if (request.dismissed) return null;

  return (
    <div className="flex justify-start w-full">
      <div className="max-w-[92%] w-full rounded-lg border border-amber-500/40 bg-amber-500/8 px-3 py-2.5 text-sm space-y-2">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 font-medium">
            <Wrench className="h-3.5 w-3.5 shrink-0" />
            <span>Agent requested a tool</span>
          </div>
          <button
            onClick={() => onDismiss(request.id)}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Tool name + description */}
        <div>
          <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-foreground">
            {request.name}
          </code>
          <p className="mt-1 text-foreground leading-snug">{request.description}</p>
        </div>

        {/* Why needed */}
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-0.5">
            Why it was needed
          </p>
          <p className="text-muted-foreground leading-snug text-xs">{request.whyNeeded}</p>
        </div>

        {/* Example call */}
        {request.exampleCall && (
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-0.5">
              Example
            </p>
            <code className="text-xs font-mono text-muted-foreground break-all">
              {request.exampleCall}
            </code>
          </div>
        )}
      </div>
    </div>
  );
}
