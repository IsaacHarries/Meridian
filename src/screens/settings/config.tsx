import { CredentialField } from "@/components/CredentialField";
import { Badge } from "@/components/ui/badge";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { getPreferences, setPreference } from "@/lib/preferences";
import { getNonSecretConfig } from "@/lib/tauri/credentials";
import { AlertCircle, CheckCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useDebouncedPrefSave } from "./_shared";

/**
 * Integrations metadata card — JIRA board id and Bitbucket repo slug.
 *
 * The worktree-related fields that used to live here (mode toggle,
 * source repo path, per-workflow paths, base branch, terminal app)
 * moved to `WorktreesSection`, mounted under Settings → Workflows
 * because they're a per-workflow setup concern rather than an
 * integration credential.
 */
export function ConfigSection({
  jiraBoardId,
  bitbucketRepoSlug,
  onSaved,
}: {
  jiraBoardId: boolean;
  bitbucketRepoSlug: boolean;
  onSaved: () => void;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [boardId, setBoardId] = useState("");
  const [repoSlug, setRepoSlug] = useState("");
  const [hydratedSnapshot, setHydratedSnapshot] = useState({
    boardId: "",
    repoSlug: "",
  });

  // Hydrate once from the merged config map (preferences ∪ credential
  // store) so legacy values stored in the credential store before the
  // prefs migration land in the inputs as well.
  useEffect(() => {
    let alive = true;
    void Promise.all([getNonSecretConfig(), getPreferences()])
      .then(([config, prefs]) => {
        if (!alive) return;
        const snap = {
          boardId: config["jira_board_id"] ?? "",
          repoSlug: config["bitbucket_repo_slug"] ?? "",
        };
        setBoardId(snap.boardId);
        setRepoSlug(snap.repoSlug);
        setHydratedSnapshot(snap);
        setHydrated(true);

        // One-shot migration: copy any cred-store-only value into
        // preferences so the new save path owns it from here on.
        const migrations: Array<[string, string]> = [
          ["jira_board_id", snap.boardId],
          ["bitbucket_repo_slug", snap.repoSlug],
        ];
        for (const [key, value] of migrations) {
          if (value && !prefs[key]) {
            void setPreference(key, value).catch(() => {
              /* migration is best-effort */
            });
          }
        }
      })
      .catch(() => {
        if (alive) setHydrated(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useDebouncedPrefSave({
    hydrated,
    prefKey: "jira_board_id",
    value: boardId,
    hydratedValue: hydratedSnapshot.boardId,
    transform: (v) => v.trim(),
    onSaved,
  });
  useDebouncedPrefSave({
    hydrated,
    prefKey: "bitbucket_repo_slug",
    value: repoSlug,
    hydratedValue: hydratedSnapshot.repoSlug,
    transform: (v) => v.trim(),
    onSaved,
  });

  const allSet = jiraBoardId && bitbucketRepoSlug;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Configuration</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Which board and repository to work with
            </CardDescription>
          </div>
          {allSet ? (
            <Badge variant="success" className="gap-1">
              <CheckCircle className="h-3 w-3" /> Configured
            </Badge>
          ) : (
            <Badge variant="warning" className="gap-1">
              <AlertCircle className="h-3 w-3" /> Incomplete
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hydrated ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3">
            <CredentialField
              id="cfg-board-id"
              label="JIRA Board ID"
              placeholder="15"
              value={boardId}
              onChange={setBoardId}
              helperText="Found in your JIRA board URL: /jira/software/projects/…/boards/15"
            />
            <CredentialField
              id="cfg-repo-slug"
              label="Bitbucket Repository Slug"
              placeholder="my-repo"
              value={repoSlug}
              onChange={setRepoSlug}
              helperText="The repo slug from your Bitbucket URL: /repositories/workspace/my-repo"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
