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
      name: "read:repository:bitbucket",
      reason: "list repositories, read commits, branches, and diffs",
      required: true,
    },
    {
      name: "read:pullrequest:bitbucket",
      reason: "read open and merged PRs, comments, and review status",
      required: true,
    },
    {
      name: "write:pullrequest:bitbucket",
      reason: "submit review comments and approve/request changes on PRs",
      required: true,
    },
  ] satisfies Scope[],
};

// JIRA — Classic API tokens (ATATT3x…) inherit your Atlassian account permissions.
// No scope selection exists when generating the token. This list shows the account-level
// project permissions your account needs in JIRA — not token scopes.
export const JIRA_PERMISSIONS = {
  title: "Required account permissions",
  note: "Classic API tokens have no scopes — they use your account's existing JIRA permissions. Create the token at id.atlassian.net → Security → API tokens (no scope picker = correct token type).",
  scopes: [
    {
      name: "Browse Projects",
      reason: "read issues, sprints, boards, and epics",
      required: true,
    },
    {
      name: "View Development Tools",
      reason: "agile board and sprint data via the Agile API",
      required: true,
    },
    {
      name: "View Members",
      reason: "team member profiles and assignee details",
      required: true,
    },
    {
      name: "Edit Issues",
      reason: "update ticket descriptions and reassign issues (future feature)",
      required: false,
    },
  ] satisfies Scope[],
};
