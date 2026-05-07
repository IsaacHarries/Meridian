import { CredentialField } from "@/components/CredentialField";
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
import { getNonSecretConfig } from "@/lib/tauri/credentials";
import {
    validateBaseBranch,
    validateGroomingWorktree,
    validatePrAddressWorktree,
    validatePrReviewWorktree,
    validateSourceRepo,
    validateWorktree,
} from "@/lib/tauri/worktree";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { type SectionStatus, useDebouncedPrefSave } from "./_shared";

/**
 * Worktree configuration card. Two modes:
 *   - "auto":  user enters a single source-repo path; Meridian
 *              derives the four per-workflow worktrees as siblings
 *              and lazy-creates each one on first use (the resolvers
 *              in `src-tauri/src/commands/repo/_shared.rs` call
 *              `git worktree add` on demand).
 *   - "manual": user enters each workflow's worktree path explicitly
 *               and tests them with the per-field validate buttons.
 *
 * Lives under Settings → Workflows because the worktrees are a
 * per-workflow setup concern, not an integration credential.
 */
export function WorktreesSection({ onSaved }: { onSaved?: () => void }) {
  const [hydrated, setHydrated] = useState(false);
  const [worktreeMode, setWorktreeMode] = useState<"manual" | "auto">("manual");
  const [repoSourcePath, setRepoSourcePath] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [baseBranch, setBaseBranch] = useState("develop");
  const [prReviewWorktreePath, setPrReviewWorktreePath] = useState("");
  const [prAddressWorktreePath, setPrAddressWorktreePath] = useState("");
  const [groomingWorktreePath, setGroomingWorktreePath] = useState("");
  const [prTerminal, setPrTerminal] = useState("iTerm2");
  const [hydratedSnapshot, setHydratedSnapshot] = useState({
    worktreeMode: "manual" as "manual" | "auto",
    repoSourcePath: "",
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
  const [prAddressWorktreeStatus, setPrAddressWorktreeStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [groomingWorktreeStatus, setGroomingWorktreeStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [sourceRepoStatus, setSourceRepoStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [baseBranchStatus, setBaseBranchStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });

  // Hydrate from the merged config map (preferences ∪ credential
  // store) so legacy values stored in the credential store before the
  // prefs migration land in the inputs as well — same pattern the
  // ConfigSection uses for board id / repo slug.
  useEffect(() => {
    let alive = true;
    void Promise.all([getNonSecretConfig(), getPreferences()])
      .then(([config, prefs]) => {
        if (!alive) return;
        const rawMode = (config["worktree_mode"] ?? "").toLowerCase();
        const snap = {
          worktreeMode: (rawMode === "auto" ? "auto" : "manual") as "manual" | "auto",
          repoSourcePath: config["repo_source_path"] ?? "",
          worktreePath: config["repo_worktree_path"] ?? "",
          baseBranch: config["repo_base_branch"] || "develop",
          prReviewWorktreePath: config["pr_review_worktree_path"] ?? "",
          prAddressWorktreePath: config["pr_address_worktree_path"] ?? "",
          groomingWorktreePath: config["grooming_worktree_path"] ?? "",
          prTerminal: config["pr_review_terminal"] || "iTerm2",
        };
        setWorktreeMode(snap.worktreeMode);
        setRepoSourcePath(snap.repoSourcePath);
        setWorktreePath(snap.worktreePath);
        setBaseBranch(snap.baseBranch);
        setPrReviewWorktreePath(snap.prReviewWorktreePath);
        setPrAddressWorktreePath(snap.prAddressWorktreePath);
        setGroomingWorktreePath(snap.groomingWorktreePath);
        setPrTerminal(snap.prTerminal);
        setHydratedSnapshot(snap);
        setHydrated(true);

        // One-shot migration mirror: copy any cred-store-only value
        // into preferences so the new save path owns it from here on.
        const migrations: Array<[string, string]> = [
          ["worktree_mode", snap.worktreeMode],
          ["repo_source_path", snap.repoSourcePath],
          ["repo_worktree_path", snap.worktreePath],
          ["repo_base_branch", snap.baseBranch],
          ["pr_review_worktree_path", snap.prReviewWorktreePath],
          ["pr_address_worktree_path", snap.prAddressWorktreePath],
          ["grooming_worktree_path", snap.groomingWorktreePath],
          ["pr_review_terminal", snap.prTerminal],
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
    prefKey: "worktree_mode",
    value: worktreeMode,
    hydratedValue: hydratedSnapshot.worktreeMode,
    onSaved,
  });
  useDebouncedPrefSave({
    hydrated,
    prefKey: "repo_source_path",
    value: repoSourcePath,
    hydratedValue: hydratedSnapshot.repoSourcePath,
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

  async function handleValidateSourceRepo() {
    if (!repoSourcePath.trim()) return;
    setSourceRepoStatus({ state: "loading", message: "Verifying…" });
    // Persist the entered value first so the Rust side reads the same
    // string the user is looking at — mirrors the per-worktree validate
    // buttons; on failure we restore the previous value so a typo
    // doesn't silently overwrite a known-good path.
    const prefs = await getPreferences();
    const prev = prefs["repo_source_path"] ?? "";
    await setPreference("repo_source_path", repoSourcePath.trim());
    try {
      const info = await validateSourceRepo();
      setSourceRepoStatus({
        state: "success",
        message: `✓ Repo accessible — branch: ${info.branch}, HEAD: ${info.headCommit}`,
      });
    } catch (err) {
      await setPreference("repo_source_path", prev).catch(() => {});
      setSourceRepoStatus({ state: "error", message: String(err) });
    }
  }

  async function handleValidateBaseBranch() {
    if (!baseBranch.trim()) return;
    setBaseBranchStatus({ state: "loading", message: "Verifying…" });
    // Same persist-then-validate dance: the Rust resolver reads
    // `repo_base_branch` from prefs.
    const prefs = await getPreferences();
    const prev = prefs["repo_base_branch"] ?? "";
    const trimmed = baseBranch.trim() || "develop";
    await setPreference("repo_base_branch", trimmed);
    try {
      const info = await validateBaseBranch();
      const presence = [
        info.localExists ? "local" : null,
        info.remoteExists ? `origin/${info.branch}` : null,
      ]
        .filter(Boolean)
        .join(" + ");
      setBaseBranchStatus({
        state: "success",
        message: `✓ Branch '${info.branch}' resolves (${presence}, HEAD: ${info.headCommit})`,
      });
    } catch (err) {
      await setPreference("repo_base_branch", prev).catch(() => {});
      setBaseBranchStatus({ state: "error", message: String(err) });
    }
  }

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
    await setPreference("pr_address_worktree_path", prAddressWorktreePath.trim());
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Worktrees</CardTitle>
        <CardDescription className="text-xs mt-0.5">
          Where each workflow reads and writes code on disk
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hydrated ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Setup mode</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={worktreeMode === "auto" ? "default" : "outline"}
                    onClick={() => setWorktreeMode("auto")}
                  >
                    Auto-managed (single repo)
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={worktreeMode === "manual" ? "default" : "outline"}
                    onClick={() => setWorktreeMode("manual")}
                  >
                    Manual paths
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {worktreeMode === "auto"
                    ? "Meridian will create per-workflow worktrees as siblings of the source repo the first time each workflow needs one — no manual git worktree add required."
                    : "Enter each workflow's worktree path explicitly. Use this when your worktrees already exist or live in non-standard locations."}
                </p>
              </div>
              <CredentialField
                id="cfg-base-branch"
                label="Base Branch"
                placeholder="develop"
                value={baseBranch}
                onChange={setBaseBranch}
                helperText="The branch each workflow worktree is anchored to (usually develop or main)."
              />
              {baseBranch.trim() && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleValidateBaseBranch}
                    disabled={baseBranchStatus.state === "loading"}
                  >
                    {baseBranchStatus.state === "loading" ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : null}
                    Verify base branch
                  </Button>
                  {baseBranchStatus.state !== "idle" && (
                    <span
                      className={`text-xs ${baseBranchStatus.state === "success" ? "text-green-600" : "text-destructive"}`}
                    >
                      {baseBranchStatus.message}
                    </span>
                  )}
                </div>
              )}
            </div>
            {worktreeMode === "auto" && (
              <div className="border-t pt-3 mt-1 space-y-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Source Repo
                </p>
                <CredentialField
                  id="cfg-repo-source-path"
                  label="Source repo path"
                  placeholder="/Users/you/REPOS/MyRepo"
                  value={repoSourcePath}
                  onChange={setRepoSourcePath}
                  helperText="Absolute path to your working git repository. Meridian will create per-workflow worktrees as siblings (named <repo>-meridian-implement, -pr-review, -pr-address, -grooming) on demand."
                />
                {repoSourcePath.trim() && (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleValidateSourceRepo}
                      disabled={sourceRepoStatus.state === "loading"}
                    >
                      {sourceRepoStatus.state === "loading" ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : null}
                      Verify source repo
                    </Button>
                    {sourceRepoStatus.state !== "idle" && (
                      <span
                        className={`text-xs ${sourceRepoStatus.state === "success" ? "text-green-600" : "text-destructive"}`}
                      >
                        {sourceRepoStatus.message}
                      </span>
                    )}
                  </div>
                )}
                {repoSourcePath.trim() && (
                  <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground space-y-0.5">
                    <p className="font-medium text-foreground">Will create on demand:</p>
                    {AUTO_SUFFIXES.map(([label, suffix]) => (
                      <p key={suffix} className="font-mono">
                        <span className="text-foreground">{label}:</span>{" "}
                        {deriveAutoPath(repoSourcePath, suffix)}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
            {worktreeMode === "manual" && (
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
            )}
            {worktreeMode === "manual" && (
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
              </div>
            )}
            <div className="border-t pt-3 mt-1 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                PR Review Terminal
              </p>
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
            {worktreeMode === "manual" && (
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
            )}
            {worktreeMode === "manual" && (
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
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Auto-mode path derivation ─────────────────────────────────────────────────
//
// Mirror of the suffixes in `src-tauri/src/commands/repo/_shared.rs` —
// kept as a flat const here so the Settings preview can render the
// derived paths without an IPC round-trip. Stays in lock-step with the
// Rust constants by manual review (only four of them, rarely touched).

const AUTO_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ["Implementation", "-meridian-implement"],
  ["PR Review", "-meridian-pr-review"],
  ["Address PR Comments", "-meridian-pr-address"],
  ["Grooming", "-meridian-grooming"],
];

function deriveAutoPath(source: string, suffix: string): string {
  const trimmed = source.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const lastSlash = trimmed.lastIndexOf("/");
  const parent = lastSlash >= 0 ? trimmed.slice(0, lastSlash) : "";
  const name = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  return parent ? `${parent}/${name}${suffix}` : `${name}${suffix}`;
}
