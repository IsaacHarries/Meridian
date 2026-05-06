import { CredentialField } from "@/components/CredentialField";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { getPreferences, setPreference } from "@/lib/preferences";
import { validateGroomingWorktree, validatePrAddressWorktree, validatePrReviewWorktree, validateWorktree } from "@/lib/tauri/worktree";
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { type SectionStatus } from "./_shared";

/**
 * Debounce a string-value pref write so the on-disk file isn't hammered
 * on every keystroke. Skips the write on the first render (so the
 * initial hydrate doesn't immediately re-save the values it just loaded)
 * and on the value the field was hydrated with. The trimmed-on-save
 * branch is the convention the prior explicit-save code used; preserved
 * here so the resulting prefs file matches what the previous flow wrote.
 *
 * `transform` lets callers post-process before writing — used to default
 * blanks (e.g. base branch falls back to "develop"). `onSaved` fires
 * after each successful write so the parent can refresh its
 * "configured?" badge without polling.
 */
function useDebouncedPrefSave(opts: {
  hydrated: boolean;
  prefKey: string;
  value: string;
  hydratedValue: string;
  transform?: (raw: string) => string;
  onSaved?: () => void;
  delayMs?: number;
}) {
  const { hydrated, prefKey, value, hydratedValue, transform, onSaved } = opts;
  const delayMs = opts.delayMs ?? 400;
  useEffect(() => {
    if (!hydrated) return;
    if (value === hydratedValue) return;
    const final = transform ? transform(value) : value;
    const id = setTimeout(() => {
      void setPreference(prefKey, final)
        .then(() => onSaved?.())
        .catch((err) => toast.error(`Failed to save ${prefKey}`, { description: String(err) }));
    }, delayMs);
    return () => clearTimeout(id);
    // hydratedValue / transform / onSaved are stable refs from the
    // caller's perspective; we intentionally don't include them so
    // changing the helper's identity each render doesn't fire spurious
    // saves. The value identity is what gates the actual write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, hydrated, prefKey, delayMs]);
}

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
  const [worktreePath, setWorktreePath] = useState("");
  const [baseBranch, setBaseBranch] = useState("develop");
  const [prReviewWorktreePath, setPrReviewWorktreePath] = useState("");
  const [prAddressWorktreePath, setPrAddressWorktreePath] = useState("");
  const [groomingWorktreePath, setGroomingWorktreePath] = useState("");
  const [prTerminal, setPrTerminal] = useState("iTerm2");
  // Snapshot of the values we hydrated with — used by the debounced
  // save hooks below to skip the initial-load no-op write.
  const [hydratedSnapshot, setHydratedSnapshot] = useState({
    boardId: "",
    repoSlug: "",
    worktreePath: "",
    baseBranch: "develop",
    prReviewWorktreePath: "",
    prAddressWorktreePath: "",
    groomingWorktreePath: "",
    prTerminal: "iTerm2",
  });

  const [worktreeStatus, setWorktreeStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [prWorktreeStatus, setPrWorktreeStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [prAddressWorktreeStatus, setPrAddressWorktreeStatus] =
    useState<SectionStatus>({ state: "idle", message: "" });
  const [groomingWorktreeStatus, setGroomingWorktreeStatus] =
    useState<SectionStatus>({ state: "idle", message: "" });

  // Hydrate once on mount.
  useEffect(() => {
    let alive = true;
    void getPreferences()
      .then((prefs) => {
        if (!alive) return;
        const snap = {
          boardId: prefs["jira_board_id"] ?? "",
          repoSlug: prefs["bitbucket_repo_slug"] ?? "",
          worktreePath: prefs["repo_worktree_path"] ?? "",
          baseBranch: prefs["repo_base_branch"] || "develop",
          prReviewWorktreePath: prefs["pr_review_worktree_path"] ?? "",
          prAddressWorktreePath: prefs["pr_address_worktree_path"] ?? "",
          groomingWorktreePath: prefs["grooming_worktree_path"] ?? "",
          prTerminal: prefs["pr_review_terminal"] || "iTerm2",
        };
        setBoardId(snap.boardId);
        setRepoSlug(snap.repoSlug);
        setWorktreePath(snap.worktreePath);
        setBaseBranch(snap.baseBranch);
        setPrReviewWorktreePath(snap.prReviewWorktreePath);
        setPrAddressWorktreePath(snap.prAddressWorktreePath);
        setGroomingWorktreePath(snap.groomingWorktreePath);
        setPrTerminal(snap.prTerminal);
        setHydratedSnapshot(snap);
        setHydrated(true);
      })
      .catch(() => {
        if (alive) setHydrated(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Per-field debounced save. Each call wires one local state value to
  // a single preference key; mismatches between local state and the
  // hydrated value queue a write 400ms after the user stops typing,
  // and `onSaved` re-checks the "Configured" badge.
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
  useDebouncedPrefSave({
    hydrated,
    prefKey: "repo_worktree_path",
    value: worktreePath,
    hydratedValue: hydratedSnapshot.worktreePath,
    transform: (v) => v.trim(),
    onSaved,
  });
  useDebouncedPrefSave({
    hydrated,
    prefKey: "repo_base_branch",
    value: baseBranch,
    hydratedValue: hydratedSnapshot.baseBranch,
    transform: (v) => v.trim() || "develop",
    onSaved,
  });
  useDebouncedPrefSave({
    hydrated,
    prefKey: "pr_review_worktree_path",
    value: prReviewWorktreePath,
    hydratedValue: hydratedSnapshot.prReviewWorktreePath,
    transform: (v) => v.trim(),
    onSaved,
  });
  useDebouncedPrefSave({
    hydrated,
    prefKey: "pr_address_worktree_path",
    value: prAddressWorktreePath,
    hydratedValue: hydratedSnapshot.prAddressWorktreePath,
    transform: (v) => v.trim(),
    onSaved,
  });
  useDebouncedPrefSave({
    hydrated,
    prefKey: "grooming_worktree_path",
    value: groomingWorktreePath,
    hydratedValue: hydratedSnapshot.groomingWorktreePath,
    transform: (v) => v.trim(),
    onSaved,
  });
  useDebouncedPrefSave({
    hydrated,
    prefKey: "pr_review_terminal",
    value: prTerminal,
    hydratedValue: hydratedSnapshot.prTerminal,
    transform: (v) => v.trim() || "iTerm2",
    onSaved,
  });

  async function handleValidateWorktree() {
    if (!worktreePath.trim()) return;
    setWorktreeStatus({ state: "loading", message: "Validating…" });
    const prefs = await getPreferences();
    const prev = prefs["repo_worktree_path"] ?? "";
    await setPreference("repo_worktree_path", worktreePath.trim());
    try {
      const info = await validateWorktree();
      setWorktreeStatus({
        state: "success",
        message: `✓ Valid git repo — branch: ${info.branch}, HEAD: ${info.headCommit}`,
      });
    } catch (err) {
      await setPreference("repo_worktree_path", prev).catch(() => {});
      setWorktreeStatus({ state: "error", message: String(err) });
    }
  }

  async function handleValidatePrWorktree() {
    if (!prReviewWorktreePath.trim()) return;
    setPrWorktreeStatus({ state: "loading", message: "Validating…" });
    const prefs = await getPreferences();
    const prev = prefs["pr_review_worktree_path"] ?? "";
    await setPreference("pr_review_worktree_path", prReviewWorktreePath.trim());
    try {
      const info = await validatePrReviewWorktree();
      setPrWorktreeStatus({
        state: "success",
        message: `✓ Valid git repo — branch: ${info.branch}, HEAD: ${info.headCommit}`,
      });
    } catch (err) {
      await setPreference("pr_review_worktree_path", prev).catch(() => {});
      setPrWorktreeStatus({ state: "error", message: String(err) });
    }
  }

  async function handleValidatePrAddressWorktree() {
    if (!prAddressWorktreePath.trim()) return;
    setPrAddressWorktreeStatus({ state: "loading", message: "Validating…" });
    const prefs = await getPreferences();
    const prev = prefs["pr_address_worktree_path"] ?? "";
    await setPreference(
      "pr_address_worktree_path",
      prAddressWorktreePath.trim(),
    );
    try {
      const info = await validatePrAddressWorktree();
      setPrAddressWorktreeStatus({
        state: "success",
        message: `✓ Valid git repo — branch: ${info.branch}, HEAD: ${info.headCommit}`,
      });
    } catch (err) {
      await setPreference("pr_address_worktree_path", prev).catch(() => {});
      setPrAddressWorktreeStatus({ state: "error", message: String(err) });
    }
  }

  async function handleValidateGroomingWorktree() {
    if (!groomingWorktreePath.trim()) return;
    setGroomingWorktreeStatus({ state: "loading", message: "Validating…" });
    const prev = (await getPreferences())["grooming_worktree_path"] ?? "";
    await setPreference("grooming_worktree_path", groomingWorktreePath.trim());
    try {
      const info = await validateGroomingWorktree();
      setGroomingWorktreeStatus({
        state: "success",
        message: `✓ Valid git repo — branch: ${info.branch}, HEAD: ${info.headCommit}`,
      });
    } catch (err) {
      await setPreference("grooming_worktree_path", prev).catch(() => {});
      setGroomingWorktreeStatus({ state: "error", message: String(err) });
    }
  }

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
            <div className="border-t pt-3 mt-1 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Implementation Worktree
              </p>
              <CredentialField
                id="cfg-worktree-path"
                label="Worktree Path"
                placeholder="/Users/you/REPOS/MyRepo-meridian"
                value={worktreePath}
                onChange={setWorktreePath}
                helperText={`Absolute path to a git worktree for the implementation pipeline (Grooming, Impact Analysis, Triage agents). Set up with: git worktree add ../MyRepo-meridian ${baseBranch || "develop"}`}
              />
              <CredentialField
                id="cfg-base-branch"
                label="Base Branch"
                placeholder="develop"
                value={baseBranch}
                onChange={setBaseBranch}
                helperText="The branch checked out in the worktree when a pipeline starts (usually develop or main)."
              />
              {worktreePath.trim() && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleValidateWorktree}
                    disabled={worktreeStatus.state === "loading"}
                  >
                    {worktreeStatus.state === "loading" ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : null}
                    Test worktree
                  </Button>
                  {worktreeStatus.state !== "idle" && (
                    <span
                      className={`text-xs ${worktreeStatus.state === "success" ? "text-green-600" : "text-destructive"}`}
                    >
                      {worktreeStatus.message}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="border-t pt-3 mt-1 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                PR Review Worktree
              </p>
              <CredentialField
                id="cfg-pr-review-worktree-path"
                label="PR Review Worktree Path"
                placeholder="/Users/you/REPOS/MyRepo-pr-review"
                value={prReviewWorktreePath}
                onChange={setPrReviewWorktreePath}
                helperText={`Optional dedicated worktree for PR reviews. Branches are checked out here when you open a PR for review, keeping it isolated from your implementation worktree. Leave blank to share the implementation worktree. Set up with: git worktree add ../MyRepo-pr-review ${baseBranch || "develop"}`}
              />
              {prReviewWorktreePath.trim() && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleValidatePrWorktree}
                    disabled={prWorktreeStatus.state === "loading"}
                  >
                    {prWorktreeStatus.state === "loading" ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : null}
                    Test PR review worktree
                  </Button>
                  {prWorktreeStatus.state !== "idle" && (
                    <span
                      className={`text-xs ${prWorktreeStatus.state === "success" ? "text-green-600" : "text-destructive"}`}
                    >
                      {prWorktreeStatus.message}
                    </span>
                  )}
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="cfg-pr-terminal" className="text-xs">
                  Terminal Application
                </Label>
                <select
                  id="cfg-pr-terminal"
                  value={prTerminal}
                  onChange={(e) => setPrTerminal(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
                >
                  <option value="iTerm2">iTerm2</option>
                  <option value="Terminal">Terminal</option>
                  <option value="Warp">Warp</option>
                  <option value="Kitty">Kitty</option>
                  <option value="Alacritty">Alacritty</option>
                </select>
                <p className="text-[11px] text-muted-foreground">
                  The terminal app that opens when you press the play button in
                  PR Review.
                </p>
              </div>
            </div>
            <div className="border-t pt-3 mt-1 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Address PR Comments Worktree
              </p>
              <CredentialField
                id="cfg-pr-address-worktree-path"
                label="PR Address Worktree Path"
                placeholder="/Users/you/REPOS/MyRepo-pr-address"
                value={prAddressWorktreePath}
                onChange={setPrAddressWorktreePath}
                helperText={`Optional dedicated worktree for addressing PR comments. Branches are checked out here when you work through reviewer comments, keeping it isolated from the implementation and review worktrees. If not set, falls back to the PR Review worktree, then the Implementation worktree. Set up with: git worktree add ../MyRepo-pr-address ${baseBranch || "develop"}`}
              />
              {prAddressWorktreePath.trim() && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleValidatePrAddressWorktree}
                    disabled={prAddressWorktreeStatus.state === "loading"}
                  >
                    {prAddressWorktreeStatus.state === "loading" ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : null}
                    Test PR address worktree
                  </Button>
                  {prAddressWorktreeStatus.state !== "idle" && (
                    <span
                      className={`text-xs ${prAddressWorktreeStatus.state === "success" ? "text-green-600" : "text-destructive"}`}
                    >
                      {prAddressWorktreeStatus.message}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="border-t pt-3 mt-1 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Grooming Context Worktree
              </p>
              <CredentialField
                id="cfg-grooming-worktree-path"
                label="Grooming Worktree Path"
                placeholder="/Users/you/REPOS/MyRepo-grooming"
                value={groomingWorktreePath}
                onChange={setGroomingWorktreePath}
                helperText={`Optional dedicated worktree that stays on ${baseBranch || "develop"} and is used for reading codebase context during Grooming and Groom Ticket checks. Meridian runs "git pull" here before each analysis to ensure it reads up-to-date code. If not set, falls back to the Implementation worktree. Set up with: git worktree add ../MyRepo-grooming ${baseBranch || "develop"}`}
              />
              {groomingWorktreePath.trim() && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleValidateGroomingWorktree}
                    disabled={groomingWorktreeStatus.state === "loading"}
                  >
                    {groomingWorktreeStatus.state === "loading" ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : null}
                    Test grooming worktree
                  </Button>
                  {groomingWorktreeStatus.state !== "idle" && (
                    <span
                      className={`text-xs ${groomingWorktreeStatus.state === "success" ? "text-green-600" : "text-destructive"}`}
                    >
                      {groomingWorktreeStatus.message}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
