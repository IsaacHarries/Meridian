import { useState, useEffect, useRef, useMemo } from "react";
import { useTheme } from "@/providers/ThemeProvider";
import { type AccentColor, ACCENT_LABELS, ACCENT_SWATCH } from "@/lib/theme";
import { cn } from "@/lib/utils";
import {
  isMockMode,
  setMockMode,
  isMockClaudeMode,
  setMockClaudeMode,
} from "@/lib/tauri";
import { getPreferences, setPreference } from "@/lib/preferences";
import { BACKGROUNDS, CATEGORY_LABELS, BackgroundRenderer, type BgCategory, getBackgroundId, setBackgroundId } from "@/lib/backgrounds";
import { CheckCircle, AlertCircle, Loader2, X, RotateCcw, FlaskConical, Sparkles, ChevronRight, FlaskRound, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeaderSettingsButton } from "@/components/HeaderSettingsButton";
import { APP_HEADER_BAR, APP_HEADER_ROW_PANEL, APP_HEADER_TITLE } from "@/components/appHeaderLayout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CredentialField } from "@/components/CredentialField";
import { ScopeList, JIRA_PERMISSIONS, BITBUCKET_SCOPES } from "@/components/ScopeList";
import {
  type CredentialStatus,
  anthropicComplete,
  jiraComplete,
  jiraCredentialsSet,
  bitbucketComplete,
  bitbucketCredentialsSet,
  getCredentialStatus,
  getNonSecretConfig,
  validateAnthropic,
  validateGemini,
  validateLocalLlm,
  validateJira,
  validateBitbucket,
  testAnthropicStored,
  testJiraStored,
  testBitbucketStored,
  testGeminiStored,
  testLocalLlmStored,
  debugJiraEndpoints,
  deleteCredential,
  saveCredential,
  getGeminiModels,
  getLocalModels,
  getActiveSprint,
  getOpenPrs,
  importClaudeProToken,
  getClaudeModels,
  setLocalLlmUrlCache,
  getStoreCacheInfo,
  clearAllStoreCaches,
} from "@/lib/tauri";
import { useImplementTicketStore, IMPLEMENT_STORE_KEY, INITIAL as IMPLEMENT_INITIAL } from "@/stores/implementTicketStore";
import { usePrReviewStore, PR_REVIEW_STORE_KEY } from "@/stores/prReviewStore";

// ── Theme section ─────────────────────────────────────────────────────────────

const ACCENTS: AccentColor[] = ["slate", "blue", "violet", "green", "orange", "rose"];


const BG_CATEGORIES: BgCategory[] = ["meridian", "space", "jwst", "abstract", "patterns", "minimal"];

function ThemeSection() {
  const { config, setAccent } = useTheme();
  const [selectedBg, setSelectedBg] = useState(() => getBackgroundId());

  function pickBackground(id: string) {
    setSelectedBg(id);
    setBackgroundId(id);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Appearance</CardTitle>
        <CardDescription>Choose your accent colour and background.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">

        {/* Accent */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Accent colour</p>
          <div className="flex flex-wrap gap-2">
            {ACCENTS.map((accent) => (
              <button
                key={accent}
                onClick={() => setAccent(accent)}
                title={ACCENT_LABELS[accent]}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm transition-colors ${
                  config.accent === accent
                    ? "border-primary ring-2 ring-primary ring-offset-2 font-medium"
                    : "border-border hover:bg-muted"
                }`}
              >
                <span
                  className="w-3.5 h-3.5 rounded-full shrink-0"
                  style={{ background: ACCENT_SWATCH[accent] }}
                />
                {ACCENT_LABELS[accent]}
              </button>
            ))}
          </div>
        </div>

        {/* Background */}
        <div className="space-y-3">
          <p className="text-sm font-medium">Background</p>
          {BG_CATEGORIES.map((cat) => {
            const bgs = BACKGROUNDS.filter((b) => b.category === cat);
            return (
              <div key={cat}>
                <p className="text-xs text-muted-foreground mb-2">{CATEGORY_LABELS[cat]}</p>
                <div className="flex flex-wrap gap-2">
                  {bgs.map((bg) => (
                    <button
                      key={bg.id}
                      onClick={() => pickBackground(bg.id)}
                      title={bg.name}
                      className={`relative rounded-md border overflow-hidden transition-all ${
                        selectedBg === bg.id
                          ? "border-primary ring-2 ring-primary ring-offset-2"
                          : "border-border hover:border-primary/50"
                      }`}
                      style={{ width: 88, height: 56 }}
                    >
                      {/* Thumbnail — mini render of the background */}
                      <div className="absolute inset-0 bg-background" />
                      <div className="absolute inset-0">
                        <BgThumbnail id={bg.id} />
                      </div>
                      {/* Label overlay */}
                      <div className="absolute bottom-0 inset-x-0 bg-background/80 backdrop-blur-sm px-1 py-0.5">
                        <p className="text-[10px] text-center font-medium leading-tight truncate">{bg.name}</p>
                      </div>
                      {selectedBg === bg.id && (
                        <div className="absolute top-1 right-1 w-3 h-3 rounded-full bg-primary" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function BgThumbnail({ id }: { id: string }) {
  return (
    <div className="w-full h-full overflow-hidden">
      <BackgroundRenderer id={id} />
    </div>
  );
}

type SectionState = "idle" | "editing" | "loading" | "success" | "error";

interface SectionStatus {
  state: SectionState;
  message: string;
}

interface SettingsScreenProps {
  onClose: () => void;
  onNavigate?: (screen: string) => void;
}

function StatusBadge({ complete }: { complete: boolean }) {
  return complete ? (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <CheckCircle className="h-3 w-3" /> Saved
    </Badge>
  ) : (
    <Badge variant="warning" className="gap-1">
      <AlertCircle className="h-3 w-3" /> Not configured
    </Badge>
  );
}

type TestResult = "untested" | "success" | "error";

function VerifiedBadge({ result }: { result: TestResult }) {
  if (result === "success") {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle className="h-3 w-3" /> Connected
      </Badge>
    );
  }
  if (result === "error") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertCircle className="h-3 w-3" /> Failed
      </Badge>
    );
  }
  return null;
}

function SectionMessage({ state, message }: { state: SectionState; message: string }) {
  if (state === "idle" || state === "editing" || !message) return null;
  return (
    <div
      className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm mt-3 ${
        state === "loading"
          ? "bg-muted text-muted-foreground"
          : state === "success"
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-destructive/10 text-destructive"
      }`}
    >
      {state === "loading" && <Loader2 className="h-4 w-4 animate-spin shrink-0 mt-0.5" />}
      {state === "success" && <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />}
      {state === "error" && <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />}
      <span>{message}</span>
    </div>
  );
}

function AnthropicSection({ isConfigured, onSaved }: { isConfigured: boolean; onSaved: () => void }) {
  const [authMethod, setAuthMethod] = useState<"api_key" | "oauth">("api_key");
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<SectionStatus>({ state: "idle", message: "" });
  const [testResult, setTestResult] = useState<TestResult>("untested");
  const [importing, setImporting] = useState(false);
  const [models, setModels] = useState<[string, string][]>([]);
  const [selectedModel, setSelectedModel] = useState("");

  useEffect(() => {
    getClaudeModels().then(setModels).catch(() => {});
    getNonSecretConfig().then(cfg => {
      if (cfg.claude_model) setSelectedModel(cfg.claude_model);
      if (cfg.claude_auth_method === "oauth") setAuthMethod("oauth");
    }).catch(() => {});
  }, []);

  async function handleModelChange(modelId: string) {
    setSelectedModel(modelId);
    try { await saveCredential("claude_model", modelId); } catch { /* non-critical */ }
  }

  async function handleAuthMethodChange(method: "api_key" | "oauth") {
    setAuthMethod(method);
    setEditing(false);
    setStatus({ state: "idle", message: "" });
    setTestResult("untested");
    try { await saveCredential("claude_auth_method", method); } catch { /* non-critical */ }
  }

  function startEditing() {
    setApiKey(isConfigured ? MASKED_SENTINEL : "");
    setStatus({ state: "idle", message: "" });
    setTestResult("untested");
    setEditing(true);
  }

  async function handleImportClaudePro() {
    setImporting(true);
    setStatus({ state: "loading", message: "Reading Claude Pro token from keychain…" });
    try {
      const msg = await importClaudeProToken();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
      setEditing(false);
      onSaved();
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    } finally {
      setImporting(false);
    }
  }

  async function handleSave() {
    if (!apiKey.trim() || apiKey === MASKED_SENTINEL) return;
    setStatus({ state: "loading", message: "Saving and testing…" });
    try {
      const msg = await validateAnthropic(apiKey.trim());
      const verified = msg.toLowerCase().includes("successfully");
      setTestResult(verified ? "success" : "untested");
      setStatus({ state: "success", message: msg });
      onSaved();
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTest() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = apiKey === MASKED_SENTINEL
        ? await testAnthropicStored()
        : await validateAnthropic(apiKey.trim());
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTestStored() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = await testAnthropicStored();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  function handleCancel() {
    setEditing(false);
    setApiKey("");
    setStatus({ state: "idle", message: "" });
  }

  async function handleReset() {
    try {
      await deleteCredential("anthropic_api_key");
      setTestResult("untested");
      onSaved();
    } catch { /* fine if not present */ }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Anthropic</CardTitle>
            <CardDescription className="text-xs mt-0.5">Claude authentication for all AI workflows</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <VerifiedBadge result={testResult} />
            <StatusBadge complete={isConfigured} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Auth method toggle */}
        <div className="flex rounded-md border overflow-hidden w-fit">
          <button
            onClick={() => handleAuthMethodChange("api_key")}
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors",
              authMethod === "api_key"
                ? "bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted"
            )}
          >
            API Key
          </button>
          <button
            onClick={() => handleAuthMethodChange("oauth")}
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors border-l",
              authMethod === "oauth"
                ? "bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted"
            )}
          >
            Claude Pro / Max
          </button>
        </div>

        {/* API Key flow */}
        {authMethod === "api_key" && (
          !editing ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={startEditing}>
                {isConfigured ? "Update key" : "Add key"}
              </Button>
              {isConfigured && (
                <Button variant="outline" size="sm" onClick={handleTestStored} disabled={status.state === "loading"}>
                  {status.state === "loading" ? <><Loader2 className="h-3 w-3 animate-spin" /> Testing…</> : "Test connection"}
                </Button>
              )}
              {isConfigured && (
                <Button variant="ghost" size="sm" className="text-muted-foreground gap-1" onClick={handleReset}>
                  <RotateCcw className="h-3 w-3" /> Reset
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <CredentialField
                id="settings-anthropic-key"
                label="API Key"
                placeholder="sk-ant-api03-…"
                masked
                value={apiKey}
                onChange={(v) => { setApiKey(v); setTestResult("untested"); }}
                disabled={status.state === "loading"}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSave} disabled={!apiKey.trim() || apiKey === MASKED_SENTINEL || status.state === "loading"}>
                  {status.state === "loading" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save key"}
                </Button>
                <Button size="sm" variant="outline" onClick={handleTest} disabled={!apiKey.trim() || status.state === "loading"}>
                  Test connection
                </Button>
                <Button variant="ghost" size="sm" onClick={handleCancel}>Cancel</Button>
              </div>
            </div>
          )
        )}

        {/* OAuth flow */}
        {authMethod === "oauth" && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Uses your Claude Pro / Max subscription via Claude Code. Run{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">claude</code> in a terminal and log in
              with Claude.ai first.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleImportClaudePro}
                disabled={importing || status.state === "loading"}
                className="gap-1.5"
              >
                {importing
                  ? <><Loader2 className="h-3 w-3 animate-spin" /> Importing…</>
                  : isConfigured ? "Re-import token" : "Import from Claude Code"}
              </Button>
              {isConfigured && (
                <Button variant="outline" size="sm" onClick={handleTestStored} disabled={status.state === "loading"}>
                  {status.state === "loading" ? <><Loader2 className="h-3 w-3 animate-spin" /> Testing…</> : "Test connection"}
                </Button>
              )}
            </div>
          </div>
        )}

        <SectionMessage {...status} />

        {/* Model picker — visible when Anthropic is configured */}
        {isConfigured && models.length > 0 && (
          <div className="space-y-1.5 pt-2 border-t">
            <label className="text-xs font-medium text-muted-foreground">Claude Model</label>
            <select
              value={selectedModel}
              onChange={e => handleModelChange(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {!selectedModel && <option value="">— select a model —</option>}
              {models.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              Used for all AI features. Sonnet is recommended for quality; Haiku is faster and lower cost.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const MASKED_SENTINEL = "••••••••";

// ── AI Provider selector ───────────────────────────────────────────────────────

const AI_PROVIDER_MODES = [
  { value: "auto",   label: "Auto (ordered fallback)" },
  { value: "claude", label: "Claude only"  },
  { value: "gemini", label: "Gemini only"  },
  { value: "local",  label: "Local LLM only" },
] as const;

const PROVIDER_META: Record<string, { label: string; color: string; dot: string }> = {
  claude: { label: "Claude",    color: "border-orange-400/40 bg-orange-400/10 text-orange-400",  dot: "bg-orange-400" },
  gemini: { label: "Gemini",    color: "border-blue-400/40  bg-blue-400/10  text-blue-400",    dot: "bg-blue-400"   },
  local:  { label: "Local LLM", color: "border-purple-400/40 bg-purple-400/10 text-purple-400", dot: "bg-purple-400" },
};

const DEFAULT_ORDER = ["claude", "gemini", "local"];

function AiProviderSection() {
  const [mode, setMode] = useState("auto");
  const [order, setOrder] = useState<string[]>(DEFAULT_ORDER);
  const dragSrc    = useRef<number | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragWidth  = useRef(0);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [insertBefore, setInsertBefore] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    getNonSecretConfig().then(cfg => {
      if (cfg.ai_provider) setMode(cfg.ai_provider);
      if (cfg.ai_provider_order) {
        const parsed = cfg.ai_provider_order.split(",").map((s: string) => s.trim()).filter(Boolean);
        if (parsed.length > 0) setOrder(parsed);
      }
    }).catch(() => {});
  }, []);

  async function handleModeChange(value: string) {
    setMode(value);
    try { await saveCredential("ai_provider", value); } catch { /* non-critical */ }
  }

  async function persistOrder(next: string[]) {
    setOrder(next);
    try { await saveCredential("ai_provider_order", next.join(",")); } catch { /* non-critical */ }
  }

  // Live preview order
  const liveOrder = useMemo(() => {
    if (draggingIdx === null || insertBefore === null) return order;
    const rest = order.filter((_, i) => i !== draggingIdx);
    rest.splice(insertBefore, 0, order[draggingIdx]);
    return rest;
  }, [order, draggingIdx, insertBefore]);

  // Find the insertion index among non-dragged rows by cursor Y position
  function getInsertBefore(clientY: number, fromProvider: string): number {
    const rows = Array.from(document.querySelectorAll("[data-dnd-provider]")) as HTMLElement[];
    const others = rows.filter(r => r.dataset.dndProvider !== fromProvider);
    for (let i = 0; i < others.length; i++) {
      const rect = others[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return others.length;
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>, idx: number) {
    if (e.button !== 0) return;
    e.preventDefault();

    const rect = e.currentTarget.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    dragWidth.current  = rect.width;
    dragSrc.current    = idx;

    const fromProvider = order[idx]; // capture before re-render changes DOM

    setDraggingIdx(idx);
    setInsertBefore(getInsertBefore(e.clientY, fromProvider));
    setDragPos({ x: e.clientX, y: e.clientY });

    // Use global document listeners so events keep firing even after the source
    // element is unmounted when React replaces it with the placeholder.
    function onMove(ev: PointerEvent) {
      setDragPos({ x: ev.clientX, y: ev.clientY });
      setInsertBefore(getInsertBefore(ev.clientY, fromProvider));
    }

    function onUp(ev: PointerEvent) {
      cleanup();
      const from = dragSrc.current;
      dragSrc.current = null;
      // Compute final drop position before clearing state (DOM still correct here)
      const ib = from !== null ? getInsertBefore(ev.clientY, fromProvider) : null;
      setDraggingIdx(null);
      setInsertBefore(null);
      setDragPos(null);
      if (from === null || ib === null) return;
      const rest = order.filter((_, i) => i !== from);
      rest.splice(ib, 0, order[from]);
      if (rest.join(",") !== order.join(",")) persistOrder(rest);
    }

    function onCancel() {
      cleanup();
      dragSrc.current = null;
      setDraggingIdx(null);
      setInsertBefore(null);
      setDragPos(null);
    }

    function cleanup() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup",   onUp);
      document.removeEventListener("pointercancel", onCancel);
    }

    document.addEventListener("pointermove",   onMove);
    document.addEventListener("pointerup",     onUp);
    document.addEventListener("pointercancel", onCancel);
  }

  const modeDesc: Record<string, string> = {
    auto:   "Providers are tried in the order below. If one exceeds its quota, the next is used automatically.",
    claude: "Always use Claude exclusively. No fallback.",
    gemini: "Always use Gemini exclusively. No fallback.",
    local:  "Always use the local model exclusively. Requires a running server.",
  };

  const ghostProvider = draggingIdx !== null ? order[draggingIdx] : null;
  const ghostMeta     = ghostProvider ? PROVIDER_META[ghostProvider] ?? null : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">AI Provider Priority</CardTitle>
        <CardDescription className="text-xs mt-0.5">{modeDesc[mode]}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Mode selector */}
        <div className="flex flex-wrap gap-2">
          {AI_PROVIDER_MODES.map(p => (
            <button
              key={p.value}
              onClick={() => handleModeChange(p.value)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                mode === p.value
                  ? "bg-primary/20 border-primary/40 text-primary font-medium"
                  : "bg-muted/40 border-border text-muted-foreground hover:bg-muted/60"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Live-preview draggable list — only shown in Auto mode */}
        {mode === "auto" && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
              Fallback order — drag to reorder
            </p>
            {liveOrder.map((provider, displayIdx) => {
              const originalIdx = order.indexOf(provider);
              const isDragging  = originalIdx === draggingIdx;
              const meta        = PROVIDER_META[provider] ?? {
                label: provider, color: "border-border bg-muted/40 text-foreground", dot: "bg-muted-foreground",
              };

              if (isDragging) {
                return (
                  <div
                    key={provider}
                    className="h-9 rounded-lg border-2 border-dashed border-primary/40 bg-primary/5 flex items-center justify-center"
                  >
                    <span className="text-[10px] text-primary/50 font-medium tracking-wide pointer-events-none">
                      drop here
                    </span>
                  </div>
                );
              }

              return (
                <div
                  key={provider}
                  data-dnd-provider={provider}
                  onPointerDown={e => handlePointerDown(e, originalIdx)}
                  className={[
                    "flex items-center gap-3 rounded-lg border px-3 py-2 text-xs",
                    "select-none cursor-grab transition-all duration-200",
                    meta.color,
                  ].join(" ")}
                >
                  <span className="opacity-40 shrink-0 text-base leading-none pointer-events-none">⠿</span>
                  <span className="w-4 h-4 rounded-full bg-black/20 flex items-center justify-center text-[10px] font-bold shrink-0 pointer-events-none">
                    {displayIdx + 1}
                  </span>
                  <span className={`w-2 h-2 rounded-full shrink-0 pointer-events-none ${meta.dot}`} />
                  <span className="flex-1 font-medium pointer-events-none">{meta.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {/* Ghost that follows the cursor */}
      {dragPos && ghostMeta && draggingIdx !== null && (
        <div
          style={{
            position:      "fixed",
            left:          dragPos.x - dragOffset.current.x,
            top:           dragPos.y - dragOffset.current.y,
            width:         dragWidth.current,
            pointerEvents: "none",
            zIndex:        9999,
          }}
          className={[
            "flex items-center gap-3 rounded-lg border px-3 py-2 text-xs",
            "shadow-2xl rotate-1 scale-105 opacity-95",
            ghostMeta.color,
          ].join(" ")}
        >
          <span className="opacity-40 shrink-0 text-base leading-none">⠿</span>
          <span className="w-4 h-4 rounded-full bg-black/20 flex items-center justify-center text-[10px] font-bold shrink-0">
            {draggingIdx + 1}
          </span>
          <span className={`w-2 h-2 rounded-full shrink-0 ${ghostMeta.dot}`} />
          <span className="flex-1 font-medium">{ghostMeta.label}</span>
        </div>
      )}
    </Card>
  );
}

// ── Gemini section ─────────────────────────────────────────────────────────────

function GeminiSection({ isConfigured, onSaved }: { isConfigured: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<SectionStatus>({ state: "idle", message: "" });
  const [testResult, setTestResult] = useState<TestResult>("untested");
  const [models, setModels] = useState<[string, string][]>([]);
  const [selectedModel, setSelectedModel] = useState("");

  useEffect(() => {
    getGeminiModels().then(setModels).catch(() => {});
    getNonSecretConfig().then(cfg => {
      if (cfg.gemini_model) setSelectedModel(cfg.gemini_model);
    }).catch(() => {});
  }, []);

  async function handleModelChange(modelId: string) {
    setSelectedModel(modelId);
    try { await saveCredential("gemini_model", modelId); } catch { /* non-critical */ }
  }

  function startEditing() {
    setApiKey(isConfigured ? MASKED_SENTINEL : "");
    setStatus({ state: "idle", message: "" });
    setTestResult("untested");
    setEditing(true);
  }

  async function handleSave() {
    if (!apiKey.trim() || apiKey === MASKED_SENTINEL) return;
    setStatus({ state: "loading", message: "Saving and testing…" });
    try {
      const msg = await validateGemini(apiKey.trim());
      setTestResult("success");
      setStatus({ state: "success", message: msg });
      setEditing(false);
      onSaved();
      // Refresh model list with the new key
      getGeminiModels().then(setModels).catch(() => {});
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTestStored() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = await testGeminiStored();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  function handleCancel() {
    setEditing(false);
    setApiKey("");
    setStatus({ state: "idle", message: "" });
  }

  async function handleReset() {
    try {
      await deleteCredential("gemini_api_key");
      setTestResult("untested");
      onSaved();
    } catch { /* fine */ }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Google Gemini</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <VerifiedBadge result={testResult} />
            <StatusBadge complete={isConfigured} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!editing ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={startEditing}>
              {isConfigured ? "Update key" : "Add key"}
            </Button>
            {isConfigured && (
              <Button variant="outline" size="sm" onClick={handleTestStored} disabled={status.state === "loading"}>
                {status.state === "loading" ? <><Loader2 className="h-3 w-3 animate-spin" /> Testing…</> : "Test connection"}
              </Button>
            )}
            {isConfigured && (
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleReset}>
                Remove
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Gemini API Key</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  type="password"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="AIza…"
                  className="text-xs h-8 font-mono"
                  onFocus={() => { if (apiKey === MASKED_SENTINEL) setApiKey(""); }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Get a free key at{" "}
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer"
                  className="underline hover:text-foreground">
                  aistudio.google.com/apikey
                </a>
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={!apiKey.trim() || apiKey === MASKED_SENTINEL}>
                Save &amp; Test
              </Button>
              <Button variant="outline" size="sm" onClick={handleCancel}>Cancel</Button>
            </div>
          </div>
        )}

        <SectionMessage state={status.state} message={status.message} />

        {isConfigured && models.length > 0 && (
          <div>
            <Label className="text-xs">Model</Label>
            <select
              value={selectedModel}
              onChange={e => handleModelChange(e.target.value)}
              className="mt-1 w-full text-xs rounded-md border border-input bg-background px-2 py-1.5 text-foreground"
            >
              {models.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Local LLM section ──────────────────────────────────────────────────────────

function LocalLlmSection({ isConfigured, onSaved }: { isConfigured: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<SectionStatus>({ state: "idle", message: "" });
  const [testResult, setTestResult] = useState<TestResult>("untested");
  const [models, setModels] = useState<[string, string][]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [customModel, setCustomModel] = useState("");

  useEffect(() => {
    getNonSecretConfig().then(cfg => {
      if (cfg.local_llm_url) {
        setServerUrl(cfg.local_llm_url);
        setLocalLlmUrlCache(cfg.local_llm_url);
      }
      if (cfg.local_llm_model) setSelectedModel(cfg.local_llm_model);
    }).catch(() => {});
    if (isConfigured) {
      getLocalModels().then(setModels).catch(() => {});
    }
  }, [isConfigured]);

  async function handleModelChange(value: string) {
    setSelectedModel(value);
    try { await saveCredential("local_llm_model", value); } catch { /* non-critical */ }
  }

  function startEditing() {
    setApiKey("");
    setStatus({ state: "idle", message: "" });
    setTestResult("untested");
    setEditing(true);
  }

  async function handleSave() {
    if (!serverUrl.trim()) return;
    setStatus({ state: "loading", message: "Connecting…" });
    try {
      const msg = await validateLocalLlm(serverUrl.trim(), apiKey.trim());
      setLocalLlmUrlCache(serverUrl.trim());
      setTestResult("success");
      setStatus({ state: "success", message: msg });
      setEditing(false);
      onSaved();
      const list = await getLocalModels();
      setModels(list);
      if (list.length > 0 && !selectedModel) {
        handleModelChange(list[0][0]);
      }
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTestStored() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = await testLocalLlmStored();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  function handleCancel() {
    setEditing(false);
    setApiKey("");
    setStatus({ state: "idle", message: "" });
  }

  async function handleReset() {
    try {
      await deleteCredential("local_llm_url");
      setTestResult("untested");
      setModels([]);
      onSaved();
    } catch { /* fine */ }
  }

  async function handleRefreshModels() {
    setStatus({ state: "loading", message: "Refreshing model list…" });
    try {
      const list = await getLocalModels();
      setModels(list);
      setStatus({ state: list.length > 0 ? "success" : "idle", message: list.length > 0 ? `${list.length} model${list.length !== 1 ? "s" : ""} found.` : "No models found. Make sure at least one model is pulled in Ollama." });
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }

  const displayModels = models.length > 0 ? models : (selectedModel ? [[selectedModel, selectedModel]] as [string,string][] : []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Local LLM</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Ollama, LM Studio, Jan, or any OpenAI-compatible server
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <VerifiedBadge result={testResult} />
            <StatusBadge complete={isConfigured} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!editing ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={startEditing}>
              {isConfigured ? "Update server" : "Add server"}
            </Button>
            {isConfigured && (
              <Button variant="outline" size="sm" onClick={handleTestStored} disabled={status.state === "loading"}>
                {status.state === "loading" ? <><Loader2 className="h-3 w-3 animate-spin" /> Testing…</> : "Test connection"}
              </Button>
            )}
            {isConfigured && (
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleReset}>
                Remove
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Server URL</Label>
              <Input
                value={serverUrl}
                onChange={e => setServerUrl(e.target.value)}
                placeholder="http://localhost:11434"
                className="text-xs h-8 font-mono mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Ollama default: <code className="bg-muted px-1 rounded">http://localhost:11434</code>
                {" · "}LM Studio: <code className="bg-muted px-1 rounded">http://localhost:1234</code>
              </p>
            </div>
            <div>
              <Label className="text-xs">API Key <span className="text-muted-foreground">(optional)</span></Label>
              <Input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="Leave blank if not required"
                className="text-xs h-8 font-mono mt-1"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={!serverUrl.trim()}>
                Save &amp; Test
              </Button>
              <Button variant="outline" size="sm" onClick={handleCancel}>Cancel</Button>
            </div>
          </div>
        )}

        <SectionMessage state={status.state} message={status.message} />

        {isConfigured && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Model</Label>
              <button
                onClick={handleRefreshModels}
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                Refresh list
              </button>
            </div>
            {displayModels.length > 0 ? (
              <select
                value={selectedModel}
                onChange={e => handleModelChange(e.target.value)}
                className="w-full text-xs rounded-md border border-input bg-background px-2 py-1.5 text-foreground"
              >
                {displayModels.map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            ) : (
              <div className="space-y-1">
                <Input
                  value={customModel}
                  onChange={e => setCustomModel(e.target.value)}
                  onBlur={() => { if (customModel.trim()) handleModelChange(customModel.trim()); }}
                  placeholder="e.g. llama3.2:latest"
                  className="text-xs h-8 font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Type the model name exactly as shown in <code className="bg-muted px-1 rounded">ollama list</code>
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function JiraSection({ isConfigured, onSaved }: { isConfigured: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [status, setStatus] = useState<SectionStatus>({ state: "idle", message: "" });
  const [testResult, setTestResult] = useState<TestResult>("untested");

  async function startEditing() {
    try {
      const config = await getNonSecretConfig();
      setBaseUrl(config["jira_base_url"] ?? "");
      setEmail(config["jira_email"] ?? "");
      const hasStoredCreds = !!(config["jira_base_url"] || config["jira_email"]);
      setApiToken(hasStoredCreds ? MASKED_SENTINEL : "");
    } catch {
      setBaseUrl(""); setEmail(""); setApiToken("");
    }
    setTestResult("untested");
    setStatus({ state: "idle", message: "" });
    setEditing(true);
  }

  async function handleSave() {
    if (!baseUrl.trim() || !email.trim() || !apiToken.trim()) return;
    setStatus({ state: "loading", message: "Saving…" });
    try {
      await saveCredential("jira_base_url", baseUrl.trim());
      await saveCredential("jira_email", email.trim());
      if (apiToken !== MASKED_SENTINEL) {
        // Strip ALL whitespace — API tokens never contain spaces or newlines,
        // and paste events in password fields can introduce them invisibly.
        const cleanToken = apiToken.replace(/\s/g, "");
        if (cleanToken.length !== apiToken.trim().length) {
          console.warn(`JIRA token had embedded whitespace stripped: raw length ${apiToken.length} → clean length ${cleanToken.length}`);
        }
        console.log(`Saving JIRA API token (length: ${cleanToken.length}, prefix: ${cleanToken.slice(0, 8)}, suffix: ${cleanToken.slice(-4)})`);
        await saveCredential("jira_api_token", cleanToken);
      }
      setTestResult("untested");
      setStatus({ state: "success", message: "Credentials saved." });
      onSaved();
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTest() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = apiToken === MASKED_SENTINEL
        ? await testJiraStored()
        : await validateJira(baseUrl.trim(), email.trim(), apiToken.trim());
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTestStored() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = await testJiraStored();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  function handleCancel() {
    setEditing(false);
    setBaseUrl(""); setEmail(""); setApiToken("");
    setStatus({ state: "idle", message: "" });
  }

  async function handleReset() {
    for (const key of ["jira_base_url", "jira_email", "jira_api_token"]) {
      try { await deleteCredential(key); } catch { /* already gone */ }
    }
    setTestResult("untested");
    onSaved();
  }

  const hasInput = baseUrl.trim() && email.trim() && apiToken.trim();
  const canTest = !!(baseUrl.trim() && email.trim() && apiToken.trim());

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">JIRA</CardTitle>
            <CardDescription className="text-xs mt-0.5">Sprint data, tickets, and standup briefings</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <VerifiedBadge result={testResult} />
            <StatusBadge complete={isConfigured} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!editing ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={startEditing}>
              {isConfigured ? "Update credentials" : "Add credentials"}
            </Button>
            {isConfigured && (
              <Button variant="outline" size="sm" onClick={handleTestStored} disabled={status.state === "loading"}>
                {status.state === "loading" ? <><Loader2 className="h-3 w-3 animate-spin" /> Testing…</> : "Test connection"}
              </Button>
            )}
            {isConfigured && (
              <Button variant="ghost" size="sm" className="text-muted-foreground gap-1" onClick={handleReset}>
                <RotateCcw className="h-3 w-3" /> Reset
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <ScopeList {...JIRA_PERMISSIONS} />
            <CredentialField id="s-jira-url" label="Workspace URL" placeholder="https://yourcompany.atlassian.net" value={baseUrl} onChange={(v) => { setBaseUrl(v); setTestResult("untested"); }} disabled={status.state === "loading"} />
            <CredentialField id="s-jira-email" label="Email" placeholder="you@yourcompany.com" value={email} onChange={(v) => { setEmail(v); setTestResult("untested"); }} disabled={status.state === "loading"} />
            <CredentialField id="s-jira-token" label="API Token" placeholder="ATATT3x…" masked value={apiToken} onChange={(v) => { setApiToken(v); setTestResult("untested"); }} disabled={status.state === "loading"} helperText={isConfigured && apiToken === MASKED_SENTINEL ? "Token already saved — clear to replace" : "Classic API token from id.atlassian.com → Security → API tokens. Must be a classic token (starts with ATATT3x, no scope picker) — not an OAuth 2.0 scoped token."} />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={!hasInput || status.state === "loading"}>
                {status.state === "loading" && !status.message.includes("Testing") ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save credentials"}
              </Button>
              <Button size="sm" variant="outline" onClick={handleTest} disabled={!canTest || status.state === "loading"}>
                {status.state === "loading" && status.message.includes("Testing") ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test connection"}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancel}>Cancel</Button>
            </div>
          </div>
        )}
        <SectionMessage {...status} />
      </CardContent>
    </Card>
  );
}

function BitbucketSection({ isConfigured, onSaved }: { isConfigured: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [email, setEmail] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [status, setStatus] = useState<SectionStatus>({ state: "idle", message: "" });
  const [testResult, setTestResult] = useState<TestResult>("untested");

  async function startEditing() {
    try {
      const config = await getNonSecretConfig();
      setWorkspace(config["bitbucket_workspace"] ?? "");
      setEmail(config["bitbucket_email"] ?? "");
      const hasStoredCreds = !!config["bitbucket_workspace"];
      setAccessToken(hasStoredCreds ? MASKED_SENTINEL : "");
    } catch {
      setWorkspace(""); setEmail(""); setAccessToken("");
    }
    setTestResult("untested");
    setStatus({ state: "idle", message: "" });
    setEditing(true);
  }

  async function handleSave() {
    if (!workspace.trim() || !email.trim() || !accessToken.trim()) return;
    setStatus({ state: "loading", message: "Saving…" });
    try {
      await saveCredential("bitbucket_workspace", workspace.trim());
      await saveCredential("bitbucket_email", email.trim());
      if (accessToken !== MASKED_SENTINEL) await saveCredential("bitbucket_access_token", accessToken.trim());
      setTestResult("untested");
      setStatus({ state: "success", message: "Credentials saved." });
      onSaved();
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTest() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = accessToken === MASKED_SENTINEL
        ? await testBitbucketStored()
        : await validateBitbucket(workspace.trim(), email.trim(), accessToken.trim());
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTestStored() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg = await testBitbucketStored();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  function handleCancel() {
    setEditing(false);
    setWorkspace(""); setEmail(""); setAccessToken("");
    setStatus({ state: "idle", message: "" });
  }

  async function handleReset() {
    for (const key of ["bitbucket_workspace", "bitbucket_email", "bitbucket_access_token", "bitbucket_username"]) {
      try { await deleteCredential(key); } catch { /* already gone */ }
    }
    setTestResult("untested");
    onSaved();
  }

  const hasInput = workspace.trim() && email.trim() && accessToken.trim();
  const canTest = !!(workspace.trim() && email.trim() && accessToken.trim());

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Bitbucket</CardTitle>
            <CardDescription className="text-xs mt-0.5">PR reviews, team metrics, and workload analysis</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <VerifiedBadge result={testResult} />
            <StatusBadge complete={isConfigured} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!editing ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={startEditing}>
              {isConfigured ? "Update credentials" : "Add credentials"}
            </Button>
            {isConfigured && (
              <Button variant="outline" size="sm" onClick={handleTestStored} disabled={status.state === "loading"}>
                {status.state === "loading" ? <><Loader2 className="h-3 w-3 animate-spin" /> Testing…</> : "Test connection"}
              </Button>
            )}
            {isConfigured && (
              <Button variant="ghost" size="sm" className="text-muted-foreground gap-1" onClick={handleReset}>
                <RotateCcw className="h-3 w-3" /> Reset
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <ScopeList {...BITBUCKET_SCOPES} />
            <CredentialField id="s-bb-ws" label="Workspace slug" placeholder="your-workspace" value={workspace} onChange={(v) => { setWorkspace(v); setTestResult("untested"); }} disabled={status.state === "loading"} helperText="The slug from your Bitbucket workspace URL" />
            <CredentialField id="s-bb-email" label="Email" placeholder="you@yourcompany.com" value={email} onChange={(v) => { setEmail(v); setTestResult("untested"); }} disabled={status.state === "loading"} helperText="The email address associated with your Bitbucket account (used for authentication)" />
            <CredentialField id="s-bb-token" label="Access Token" placeholder="ATCTT3x…" masked value={accessToken} onChange={(v) => { setAccessToken(v); setTestResult("untested"); }} disabled={status.state === "loading"} helperText={isConfigured && accessToken === MASKED_SENTINEL ? "Token already saved — clear to enter a new one" : "Workspace or repository HTTP access token"} />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={!hasInput || status.state === "loading"}>
                {status.state === "loading" && !status.message.includes("Testing") ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save credentials"}
              </Button>
              <Button size="sm" variant="outline" onClick={handleTest} disabled={!canTest || status.state === "loading"}>
                {status.state === "loading" && status.message.includes("Testing") ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test connection"}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancel}>Cancel</Button>
            </div>
          </div>
        )}
        <SectionMessage {...status} />
      </CardContent>
    </Card>
  );
}

// ── Configuration section (non-secret app settings) ──────────────────────────

function ConfigSection({
  jiraBoardId,
  bitbucketRepoSlug,
  onSaved,
}: {
  jiraBoardId: boolean;
  bitbucketRepoSlug: boolean;
  onSaved: () => void;
}) {
  const [boardId, setBoardId] = useState("");
  const [repoSlug, setRepoSlug] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [baseBranch, setBaseBranch] = useState("develop");
  const [prReviewWorktreePath, setPrReviewWorktreePath] = useState("");
  const [prAddressWorktreePath, setPrAddressWorktreePath] = useState("");
  const [prTerminal, setPrTerminal] = useState("iTerm2");
  const [editing, setEditing] = useState(!jiraBoardId || !bitbucketRepoSlug);
  const [status, setStatus] = useState<SectionStatus>({ state: "idle", message: "" });
  const [worktreeStatus, setWorktreeStatus] = useState<SectionStatus>({ state: "idle", message: "" });
  const [prWorktreeStatus, setPrWorktreeStatus] = useState<SectionStatus>({ state: "idle", message: "" });
  const [prAddressWorktreeStatus, setPrAddressWorktreeStatus] = useState<SectionStatus>({ state: "idle", message: "" });

  async function startEditing() {
    try {
      const prefs = await getPreferences();
      setBoardId(prefs["jira_board_id"] ?? "");
      setRepoSlug(prefs["bitbucket_repo_slug"] ?? "");
      setWorktreePath(prefs["repo_worktree_path"] ?? "");
      setBaseBranch(prefs["repo_base_branch"] || "develop");
      setPrReviewWorktreePath(prefs["pr_review_worktree_path"] ?? "");
      setPrAddressWorktreePath(prefs["pr_address_worktree_path"] ?? "");
      setPrTerminal(prefs["pr_review_terminal"] || "iTerm2");
    } catch {
      setBoardId(""); setRepoSlug("");
    }
    setStatus({ state: "idle", message: "" });
    setEditing(true);
  }

  // Auto-load on first mount if already in editing state (incomplete config)
  useEffect(() => {
    if (editing) {
      getPreferences().then(prefs => {
          setBoardId(prev => prev || (prefs["jira_board_id"] ?? ""));
          setRepoSlug(prev => prev || (prefs["bitbucket_repo_slug"] ?? ""));
          setWorktreePath(prev => prev || (prefs["repo_worktree_path"] ?? ""));
          setBaseBranch(prev => prev || (prefs["repo_base_branch"] || "develop"));
          setPrReviewWorktreePath(prev => prev || (prefs["pr_review_worktree_path"] ?? ""));
          setPrAddressWorktreePath(prev => prev || (prefs["pr_address_worktree_path"] ?? ""));
          setPrTerminal(prev => prev !== "iTerm2" ? prev : (prefs["pr_review_terminal"] || "iTerm2"));
      }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    if (!boardId.trim() && !repoSlug.trim() && !worktreePath.trim() && !prReviewWorktreePath.trim() && !prAddressWorktreePath.trim()) return;
    setStatus({ state: "loading", message: "Saving…" });
    try {
      if (boardId.trim()) await setPreference("jira_board_id", boardId.trim());
      if (repoSlug.trim()) await setPreference("bitbucket_repo_slug", repoSlug.trim());
      if (worktreePath.trim()) await setPreference("repo_worktree_path", worktreePath.trim());
      await setPreference("repo_base_branch", baseBranch.trim() || "develop");
      if (prReviewWorktreePath.trim()) {
        await setPreference("pr_review_worktree_path", prReviewWorktreePath.trim());
      } else {
        await setPreference("pr_review_worktree_path", "");
      }
      if (prAddressWorktreePath.trim()) {
        await setPreference("pr_address_worktree_path", prAddressWorktreePath.trim());
      } else {
        await setPreference("pr_address_worktree_path", "");
      }
      await setPreference("pr_review_terminal", prTerminal.trim() || "iTerm2");
      setStatus({ state: "success", message: "Configuration saved." });
      setEditing(false);
      onSaved();
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleValidateWorktree() {
    setWorktreeStatus({ state: "loading", message: "Validating…" });
    try {
      if (worktreePath.trim()) await setPreference("repo_worktree_path", worktreePath.trim());
      const { validateWorktree } = await import("@/lib/tauri");
      const info = await validateWorktree();
      setWorktreeStatus({
        state: "success",
        message: `✓ Valid git repo — branch: ${info.branch}, HEAD: ${info.headCommit}`,
      });
    } catch (err) {
      setWorktreeStatus({ state: "error", message: String(err) });
    }
  }

  async function handleValidatePrWorktree() {
    setPrWorktreeStatus({ state: "loading", message: "Validating…" });
    try {
      if (prReviewWorktreePath.trim()) await setPreference("pr_review_worktree_path", prReviewWorktreePath.trim());
      const { validatePrReviewWorktree } = await import("@/lib/tauri");
      const info = await validatePrReviewWorktree();
      setPrWorktreeStatus({
        state: "success",
        message: `✓ Valid git repo — branch: ${info.branch}, HEAD: ${info.headCommit}`,
      });
    } catch (err) {
      setPrWorktreeStatus({ state: "error", message: String(err) });
    }
  }

  async function handleValidatePrAddressWorktree() {
    setPrAddressWorktreeStatus({ state: "loading", message: "Validating…" });
    try {
      if (prAddressWorktreePath.trim()) await setPreference("pr_address_worktree_path", prAddressWorktreePath.trim());
      const { validatePrAddressWorktree } = await import("@/lib/tauri");
      const info = await validatePrAddressWorktree();
      setPrAddressWorktreeStatus({
        state: "success",
        message: `✓ Valid git repo — branch: ${info.branch}, HEAD: ${info.headCommit}`,
      });
    } catch (err) {
      setPrAddressWorktreeStatus({ state: "error", message: String(err) });
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
        {!editing ? (
          <Button variant="outline" size="sm" onClick={startEditing}>
            Update configuration
          </Button>
        ) : (
          <div className="space-y-3">
            <CredentialField
              id="cfg-board-id"
              label="JIRA Board ID"
              placeholder="15"
              value={boardId}
              onChange={setBoardId}
              disabled={status.state === "loading"}
              helperText="Found in your JIRA board URL: /jira/software/projects/…/boards/15"
            />
            <CredentialField
              id="cfg-repo-slug"
              label="Bitbucket Repository Slug"
              placeholder="my-repo"
              value={repoSlug}
              onChange={setRepoSlug}
              disabled={status.state === "loading"}
              helperText="The repo slug from your Bitbucket URL: /repositories/workspace/my-repo"
            />
            <div className="border-t pt-3 mt-1 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Implementation Worktree</p>
              <CredentialField
                id="cfg-worktree-path"
                label="Worktree Path"
                placeholder="/Users/you/REPOS/MyRepo-meridian"
                value={worktreePath}
                onChange={setWorktreePath}
                disabled={status.state === "loading"}
                helperText="Absolute path to a git worktree for the implementation pipeline (Grooming, Impact Analysis, Triage agents). Set up with: git worktree add ../MyRepo-meridian develop"
              />
              <CredentialField
                id="cfg-base-branch"
                label="Base Branch"
                placeholder="develop"
                value={baseBranch}
                onChange={setBaseBranch}
                disabled={status.state === "loading"}
                helperText="The branch the implementation worktree tracks (default: develop)."
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
                    <span className={`text-xs ${worktreeStatus.state === "success" ? "text-green-600" : "text-destructive"}`}>
                      {worktreeStatus.message}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="border-t pt-3 mt-1 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">PR Review Worktree</p>
              <CredentialField
                id="cfg-pr-review-worktree-path"
                label="PR Review Worktree Path"
                placeholder="/Users/you/REPOS/MyRepo-pr-review"
                value={prReviewWorktreePath}
                onChange={setPrReviewWorktreePath}
                disabled={status.state === "loading"}
                helperText="Optional dedicated worktree for PR reviews. Branches are checked out here when you open a PR for review, keeping it isolated from your implementation worktree. Leave blank to share the implementation worktree. Set up with: git worktree add ../MyRepo-pr-review develop"
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
                    <span className={`text-xs ${prWorktreeStatus.state === "success" ? "text-green-600" : "text-destructive"}`}>
                      {prWorktreeStatus.message}
                    </span>
                  )}
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="cfg-pr-terminal" className="text-xs">Terminal Application</Label>
                <select
                  id="cfg-pr-terminal"
                  value={prTerminal}
                  onChange={(e) => setPrTerminal(e.target.value)}
                  disabled={status.state === "loading"}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
                >
                  <option value="iTerm2">iTerm2</option>
                  <option value="Terminal">Terminal</option>
                  <option value="Warp">Warp</option>
                  <option value="Kitty">Kitty</option>
                  <option value="Alacritty">Alacritty</option>
                </select>
                <p className="text-[11px] text-muted-foreground">
                  The terminal app that opens when you press the play button in PR Review.
                </p>
              </div>
            </div>
            <div className="border-t pt-3 mt-1 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Address PR Comments Worktree</p>
              <CredentialField
                id="cfg-pr-address-worktree-path"
                label="PR Address Worktree Path"
                placeholder="/Users/you/REPOS/MyRepo-pr-address"
                value={prAddressWorktreePath}
                onChange={setPrAddressWorktreePath}
                disabled={status.state === "loading"}
                helperText="Optional dedicated worktree for addressing PR comments. Branches are checked out here when you work through reviewer comments, keeping it isolated from the implementation and review worktrees. Falls back to PR Review worktree, then Implementation worktree. Set up with: git worktree add ../MyRepo-pr-address develop"
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
                    <span className={`text-xs ${prAddressWorktreeStatus.state === "success" ? "text-green-600" : "text-destructive"}`}>
                      {prAddressWorktreeStatus.message}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={
                  (!boardId.trim() && !repoSlug.trim() && !worktreePath.trim() && !prReviewWorktreePath.trim() && !prAddressWorktreePath.trim()) || status.state === "loading"
                }
              >
                {status.state === "loading" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Save"
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setStatus({ state: "idle", message: "" });
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        <SectionMessage {...status} />
      </CardContent>
    </Card>
  );
}

// ── Data test section ─────────────────────────────────────────────────────────

// ── Cache management section ──────────────────────────────────────────────────

const CACHE_KEY_LABELS: Record<string, string> = {
  [IMPLEMENT_STORE_KEY]: "Implement a Ticket pipeline sessions",
  [PR_REVIEW_STORE_KEY]: "PR Review sessions",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function CacheSection() {
  const [info, setInfo] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [done, setDone] = useState(false);

  const resetImplementSession = useImplementTicketStore((s) => s.resetSession);

  async function loadInfo() {
    setLoading(true);
    try {
      const result = await getStoreCacheInfo();
      setInfo(result);
    } catch { /* non-critical */ }
    finally { setLoading(false); }
  }

  useEffect(() => { loadInfo(); }, []);

  const totalBytes = info ? Object.values(info).reduce((a, b) => a + b, 0) : 0;
  const hasCache = totalBytes > 0;

  async function handleClear() {
    if (!confirmed) {
      setConfirmed(true);
      return;
    }
    setClearing(true);
    try {
      await clearAllStoreCaches();
      // Reset in-memory store state too
      resetImplementSession();
      useImplementTicketStore.setState({ ...IMPLEMENT_INITIAL, sessions: new Map() });
      usePrReviewStore.setState({
        sessions: new Map(),
        prsForReview: [],
        allOpenPrs: [],
        selectedPr: null,
        isSessionActive: false,
        prListLoaded: false,
      });
      setInfo({});
      setDone(true);
      setConfirmed(false);
    } catch { /* non-critical */ }
    finally { setClearing(false); }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Session Cache</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Pipeline and PR review sessions are saved to disk so they survive app restarts
            </CardDescription>
          </div>
          {hasCache && (
            <Badge variant="outline" className="gap-1 text-muted-foreground shrink-0">
              {formatBytes(totalBytes)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading cache info…
          </div>
        ) : info && Object.keys(info).length > 0 ? (
          <div className="space-y-1.5">
            {Object.entries(info).map(([key, size]) => (
              <div key={key} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {CACHE_KEY_LABELS[key] ?? key}
                </span>
                <span className="font-mono text-muted-foreground">{formatBytes(size)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No session cache on disk.</p>
        )}

        {done && (
          <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
            <CheckCircle className="h-3 w-3" /> Cache cleared. All session data has been removed.
          </p>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          {hasCache && (
            <Button
              variant={confirmed ? "destructive" : "outline"}
              size="sm"
              onClick={handleClear}
              disabled={clearing}
              className="gap-1.5"
            >
              {clearing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
              {confirmed ? "Click again to confirm" : "Clear cache"}
            </Button>
          )}
          {confirmed && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmed(false)}
            >
              Cancel
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setDone(false); loadInfo(); }}
            disabled={loading}
            className="text-muted-foreground"
          >
            Refresh
          </Button>
        </div>

        {confirmed && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            This will permanently delete all saved pipeline sessions and PR review data.
            In-progress work will be lost.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Mock mode section ─────────────────────────────────────────────────────────

function MockModeSection({ onToggle }: { onToggle: () => void }) {
  const [enabled, setEnabled] = useState(isMockMode());

  function toggle() {
    const next = !enabled;
    setMockMode(next);
    setEnabled(next);
    onToggle();
  }

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-start gap-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 shrink-0">
            <FlaskRound className="h-4 w-4 text-amber-500" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <p className="text-sm font-medium">Mock Data Mode</p>
              {enabled && (
                <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 text-xs">
                  Active
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Replace JIRA and Bitbucket API calls with realistic local mock data. Useful for
              testing without API access. Claude still calls the API unless{" "}
              <span className="font-medium text-foreground">Mock AI responses</span> is enabled
              below.
            </p>
          </div>
          <Button
            variant={enabled ? "default" : "outline"}
            size="sm"
            onClick={toggle}
            className={enabled ? "bg-amber-500 hover:bg-amber-600 text-white shrink-0" : "shrink-0"}
          >
            {enabled ? "Disable" : "Enable"}
          </Button>
        </div>
        {enabled && (
          <p className="text-xs text-amber-600 mt-3 pl-13 ml-13">
            Restart or navigate back to landing to reload data with mock mode active.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function MockClaudeModeSection({ onToggle }: { onToggle: () => void }) {
  const [enabled, setEnabled] = useState(isMockClaudeMode());

  function toggle() {
    const next = !enabled;
    setMockClaudeMode(next);
    setEnabled(next);
    onToggle();
  }

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-start gap-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 shrink-0">
            <FlaskConical className="h-4 w-4 text-violet-500" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <p className="text-sm font-medium">Mock AI responses</p>
              {enabled && (
                <Badge className="bg-violet-500/15 text-violet-600 border-violet-500/30 text-xs">
                  Active
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Return canned Claude / agent output for pipelines, standup, retros, workload, ticket
              quality, and PR review — no Anthropic API calls. JIRA and Bitbucket are unaffected
              (use Mock Data Mode for those).
            </p>
          </div>
          <Button
            variant={enabled ? "default" : "outline"}
            size="sm"
            onClick={toggle}
            className={
              enabled
                ? "bg-violet-600 hover:bg-violet-700 text-white shrink-0"
                : "shrink-0"
            }
          >
            {enabled ? "Disable" : "Enable"}
          </Button>
        </div>
        {enabled && (
          <p className="text-xs text-violet-600 dark:text-violet-400 mt-3 pl-13 ml-13">
            Credential status treats Anthropic as configured while this is on. Re-run workflows to
            see mock output.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

type DataTestState = "idle" | "loading" | "success" | "error";

function DataTestSection({ fullyConfigured }: { fullyConfigured: boolean }) {
  const [state, setState] = useState<DataTestState>("idle");
  const [result, setResult] = useState("");
  const [diagState, setDiagState] = useState<DataTestState>("idle");
  const [diagResult, setDiagResult] = useState("");

  async function runTest() {
    setState("loading");
    setResult("");
    try {
      const sprint = await getActiveSprint();
      const prs = await getOpenPrs();
      const lines: string[] = [];
      if (sprint) {
        lines.push(`Active sprint: "${sprint.name}" (${sprint.state})`);
        if (sprint.endDate) {
          const days = Math.ceil(
            (new Date(sprint.endDate).getTime() - Date.now()) / 86_400_000
          );
          lines.push(`  ${days > 0 ? `${days} days remaining` : "Sprint ended"}`);
        }
      } else {
        lines.push("No active sprint found.");
      }
      lines.push(`Open PRs in repo: ${prs.length}`);
      if (prs.length > 0) {
        lines.push(`  e.g. "#${prs[0].id} — ${prs[0].title.slice(0, 60)}"`);
      }
      setResult(lines.join("\n"));
      setState("success");
    } catch (err) {
      setResult(String(err));
      setState("error");
    }
  }

  async function runDiag() {
    setDiagState("loading");
    setDiagResult("");
    try {
      const report = await debugJiraEndpoints();
      setDiagResult(report);
      setDiagState("success");
    } catch (err) {
      setDiagResult(String(err));
      setDiagState("error");
    }
  }

  const loading = state === "loading" || diagState === "loading";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div>
          <CardTitle className="text-base">Data connection test</CardTitle>
          <CardDescription className="text-xs mt-0.5">
            Verify JIRA and Bitbucket are returning live data
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={runTest}
            disabled={!fullyConfigured || loading}
            className="gap-1.5"
          >
            {state === "loading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FlaskConical className="h-3.5 w-3.5" />
            )}
            {state === "loading" ? "Fetching…" : "Run test"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={runDiag}
            disabled={loading}
            className="gap-1.5"
          >
            {diagState === "loading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FlaskConical className="h-3.5 w-3.5" />
            )}
            {diagState === "loading" ? "Running…" : "JIRA endpoint diagnostics"}
          </Button>
        </div>
        {!fullyConfigured && (
          <p className="text-xs text-muted-foreground">
            Complete credentials and configuration above first.
          </p>
        )}
        {result && (
          <div
            className={`rounded-md px-3 py-2 text-xs font-mono whitespace-pre-wrap ${
              state === "success"
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "bg-destructive/10 text-destructive"
            }`}
          >
            {result}
          </div>
        )}
        {diagResult && (
          <div className="rounded-md px-3 py-2 text-xs font-mono whitespace-pre-wrap max-h-96 overflow-y-auto bg-muted text-muted-foreground border">
            {diagResult}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main Settings screen ──────────────────────────────────────────────────────

export function SettingsScreen({ onClose, onNavigate }: SettingsScreenProps) {
  const [credStatus, setCredStatus] = useState<CredentialStatus | null>(null);

  async function refresh() {
    const s = await getCredentialStatus();
    setCredStatus(s);
  }

  // Re-evaluate credential status after mock mode toggle so the UI reflects
  // the (now overridden) status immediately.
  function handleMockToggle() {
    refresh();
  }

  useEffect(() => {
    refresh();
  }, []);

  const fullyConfigured = credStatus
    ? anthropicComplete(credStatus) &&
      jiraComplete(credStatus) &&
      bitbucketComplete(credStatus)
    : false;

  return (
    <div className="min-h-screen">
      <header className={APP_HEADER_BAR}>
        <div className={APP_HEADER_ROW_PANEL}>
          <h1 className={cn(APP_HEADER_TITLE, "shrink-0")}>Settings</h1>
          <div className="min-w-0 flex-1" aria-hidden />
          <div className="flex shrink-0 items-center gap-1">
            <HeaderSettingsButton />
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close settings">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8 space-y-8 bg-background/60 rounded-xl">
        {credStatus ? (
          <>
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Credentials
              </h2>
              <AnthropicSection
                isConfigured={anthropicComplete(credStatus)}
                onSaved={refresh}
              />
              <GeminiSection
                isConfigured={credStatus.geminiApiKey}
                onSaved={refresh}
              />
              <LocalLlmSection
                isConfigured={credStatus.localLlmUrl}
                onSaved={refresh}
              />
              <AiProviderSection />
              <JiraSection isConfigured={jiraCredentialsSet(credStatus)} onSaved={refresh} />
              <BitbucketSection
                isConfigured={bitbucketCredentialsSet(credStatus)}
                onSaved={refresh}
              />
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Configuration
              </h2>
              <ConfigSection
                jiraBoardId={credStatus.jiraBoardId}
                bitbucketRepoSlug={credStatus.bitbucketRepoSlug}
                onSaved={refresh}
              />
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Session Cache
              </h2>
              <CacheSection />
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Appearance
              </h2>
              <ThemeSection />
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Development
              </h2>
              <MockModeSection onToggle={handleMockToggle} />
              <MockClaudeModeSection onToggle={handleMockToggle} />
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Verify
              </h2>
              <DataTestSection fullyConfigured={fullyConfigured} />
            </section>

            {onNavigate && (
              <section className="space-y-3">
                <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  AI Agents
                </h2>
                <Card
                  className="cursor-pointer hover:bg-muted/40 transition-colors"
                  onClick={() => onNavigate("agent-skills")}
                >
                  <CardContent className="flex items-center gap-4 py-4">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                      <Sparkles className="h-4 w-4 text-primary" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium">Agent Skills</p>
                      <p className="text-xs text-muted-foreground">
                        Configure domain knowledge injected into AI agents — grooming
                        conventions, codebase patterns, implementation standards, review
                        criteria
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </CardContent>
                </Card>
              </section>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        <div className="text-xs text-muted-foreground space-y-1 border-t pt-6">
          <p>All credentials are stored in your macOS Keychain and never leave your machine.</p>
          <p>
            They are used exclusively in the Tauri backend layer and never exposed to the UI.
          </p>
        </div>
      </main>
    </div>
  );
}
