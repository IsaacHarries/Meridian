import { Check } from "lucide-react";

interface Scope {
  name: string;
  reason: string;
  required: boolean;
}

interface ScopeListProps {
  title: string;
  note?: string;
  scopes: Scope[];
}

export function ScopeList({ title, note, scopes }: ScopeListProps) {
  return (
    <div className="rounded-md border bg-muted/40 p-3 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {note && <p className="text-xs text-muted-foreground italic">{note}</p>}
      <ul className="space-y-1.5">
        {scopes.map((scope) => (
          <li key={scope.name} className="flex items-start gap-2 text-xs">
            <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
            <span>
              <code className="font-mono bg-muted px-1 py-0.5 rounded text-[11px]">
                {scope.name}
              </code>
              {!scope.required && (
                <span className="ml-1.5 text-muted-foreground">(future feature)</span>
              )}
              <span className="text-muted-foreground ml-1.5">— {scope.reason}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Bitbucket HTTP access token scopes — select these when creating the token at
// bitbucket.org → Workspace settings → Access tokens (or Repository settings → Access tokens)
export const BITBUCKET_SCOPES = {
  title: "Required access token scopes",
  note: "Select these when creating the token at bitbucket.org → Workspace settings → Access tokens.",
  scopes: [
    {
      name: "read:account",
      reason: "authenticate and read your account profile",
      required: true,
    },
    {
      name: "read:repository:bitbucket",
      reason: "read commit history and file content for code analysis",
      required: true,
    },
    {
      name: "read:pullrequest:bitbucket",
      reason: "read PR diffs, comments, review times, and team metrics",
      required: true,
    },
    {
      name: "write:pullrequest:bitbucket",
      reason: "submit review comments and raise PRs (future feature — enable now)",
      required: false,
    },
  ] satisfies Scope[],
};

// JIRA — Personal API tokens use Basic auth and inherit your account's project
// permissions. These are the Atlassian OAuth scope strings that correspond to
// what your account needs access to.
export const JIRA_PERMISSIONS = {
  title: "Required scopes",
  note: "Personal API tokens inherit your account permissions — no scope selection needed when generating the token. Ensure your account has these on the relevant JIRA projects.",
  scopes: [
    {
      name: "read:jira-work",
      reason: "sprint boards, issues, story points, and ticket data",
      required: true,
    },
    {
      name: "read:jira-user",
      reason: "team member info and assignee details",
      required: true,
    },
    {
      name: "write:jira-work",
      reason: "update ticket descriptions and reassign issues (future feature)",
      required: false,
    },
  ] satisfies Scope[],
};
