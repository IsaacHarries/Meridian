import { useState, useEffect, useRef, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  open as openDialog,
  ask as askDialog,
} from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
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
import {
  type PrTaskFilter,
  type PrTaskFilterMode,
  getPrTaskFilters,
  setPrTaskFilters,
  newFilterId,
} from "@/lib/prTaskFilters";
import { usePrTasksStore } from "@/stores/prTasksStore";
import {
  type AppPreferences,
  APP_PREFERENCE_DEFAULTS,
  getAppPreferences,
  setPrReviewDefaultChunkChars,
  setPrTasksPollIntervalMinutes,
  setBuildCheckTimeoutSecs,
  setBuildCheckMaxAttempts,
  setStreamingPartialsEnabled,
  setWorkloadOverloadThresholdPct,
  setDailyTokenBudget,
  setNotifyPrTaskAdded,
  setNotifyAgentStageComplete,
} from "@/lib/appPreferences";
import { setStreamingPartialsEnabledRuntime } from "@/stores/implementTicketStore";
import { setRuntimeOverloadPct } from "@/lib/workloadClassifier";
import {
  BACKGROUNDS,
  CATEGORY_LABELS,
  BackgroundRenderer,
  type BgCategory,
  getBackgroundId,
  setBackgroundId,
} from "@/lib/backgrounds";
import {
  LANDING_LAYOUTS,
  getLandingLayoutId,
  setLandingLayoutId,
  type LandingLayoutId,
} from "@/lib/landingLayouts";
import {
  CheckCircle,
  AlertCircle,
  Loader2,
  X,
  RotateCcw,
  FlaskConical,
  Sparkles,
  ChevronRight,
  FlaskRound,
  Trash2,
  Link2,
  Palette,
  HardDrive,
  Bot,
  FolderOpen,
  FileText,
  Mic,
  NotebookPen,
  Download,
  Clock,
  Plus,
  Filter,
  ListTodo,
  Activity,
  Bell,
  Gauge,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeaderSettingsButton } from "@/components/HeaderSettingsButton";
import { HeaderRecordButton } from "@/components/HeaderRecordButton";
import { HeaderTimeTracker } from "@/components/HeaderTimeTracker";
import {
  APP_HEADER_BAR,
  APP_HEADER_ROW_PANEL,
  APP_HEADER_TITLE,
} from "@/components/appHeaderLayout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RichNotesEditor } from "@/components/RichNotesEditor";
import { extractTiptapPlainText } from "@/lib/tiptapText";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CredentialField } from "@/components/CredentialField";
import {
  ScopeList,
  JIRA_PERMISSIONS,
  BITBUCKET_SCOPES,
} from "@/components/ScopeList";
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
  validateCopilot,
  validateJira,
  validateBitbucket,
  testAnthropicStored,
  pingAnthropic,
  pingGemini,
  pingCopilot,
  testJiraStored,
  testBitbucketStored,
  testGeminiStored,
  testCopilotStored,
  testLocalLlmStored,
  debugJiraEndpoints,
  deleteCredential,
  saveCredential,
  getGeminiModels,
  getCustomGeminiModels,
  addCustomGeminiModel,
  removeCustomGeminiModel,
  getCopilotModels,
  getCustomCopilotModels,
  addCustomCopilotModel,
  removeCustomCopilotModel,
  getLocalModels,
  getActiveSprint,
  getOpenPrs,
  startClaudeOauth,
  startGeminiOauth,
  startCopilotOauth,
  getClaudeModels,
  setLocalLlmUrlCache,
  getStoreCacheInfo,
  clearAllStoreCaches,
  deleteStoreCache,
  validateWorktree,
  validatePrReviewWorktree,
  validatePrAddressWorktree,
  validateGroomingWorktree,
} from "@/lib/tauri";
import {
  useImplementTicketStore,
  IMPLEMENT_STORE_KEY,
  INITIAL as IMPLEMENT_INITIAL,
} from "@/stores/implementTicketStore";
import { usePrReviewStore, PR_REVIEW_STORE_KEY } from "@/stores/prReviewStore";
import { Switch } from "@/components/ui/switch";
import { useTimeTrackingStore } from "@/stores/timeTrackingStore";
import {
  MIN_IDLE_THRESHOLD_MIN,
  MAX_IDLE_THRESHOLD_MIN,
} from "@/lib/timeTracking";
import {
  getDataDir,
  dataDirectoryHasContent,
  moveDataDirectory,
  relaunchApp,
  loadPrTemplate,
  savePrTemplate,
  getPrTemplatePath,
  revealPrTemplateDir,
  type PrTemplateMode,
  loadGroomingTemplate,
  saveGroomingTemplate,
  getGroomingTemplatePath,
  revealGroomingTemplatesDir,
  type GroomingTemplateKind,
  listMicrophones,
  type MicrophoneInfo,
} from "@/lib/tauri";
import { useMeetingsStore } from "@/stores/meetingsStore";
import {
  useAiSelectionStore,
  PANEL_LABELS,
  STAGE_LABELS,
  PROVIDER_LABELS,
} from "@/stores/aiSelectionStore";
import type {
  PanelId as AiPanelId,
  StageId as AiStageId,
  AiProvider,
} from "@/stores/aiSelectionStore";

// ── Theme section ─────────────────────────────────────────────────────────────

const ACCENTS: AccentColor[] = [
  "slate",
  "blue",
  "violet",
  "green",
  "orange",
  "rose",
];

const BG_CATEGORIES: BgCategory[] = [
  "meridian",
  "space",
  "jwst",
  "abstract",
  "patterns",
  "minimal",
];

function ThemeSection() {
  const { config, setAccent } = useTheme();
  const [selectedBg, setSelectedBg] = useState(() => getBackgroundId());
  const [selectedLayout, setSelectedLayout] = useState<LandingLayoutId>(() =>
    getLandingLayoutId(),
  );

  function pickBackground(id: string) {
    setSelectedBg(id);
    setBackgroundId(id);
  }

  function pickLayout(id: LandingLayoutId) {
    setSelectedLayout(id);
    setLandingLayoutId(id);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Appearance</CardTitle>
        <CardDescription>
          Choose your accent colour, background, and landing-page layout.
        </CardDescription>
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
                <p className="text-xs text-muted-foreground mb-2">
                  {CATEGORY_LABELS[cat]}
                </p>
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
                        <p className="text-[10px] text-center font-medium leading-tight truncate">
                          {bg.name}
                        </p>
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

        {/* Landing layout */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Landing layout</p>
          <p className="text-xs text-muted-foreground">
            How the home screen arranges your workflows.
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 pt-1">
            {LANDING_LAYOUTS.map((layout) => {
              const isSelected = selectedLayout === layout.id;
              return (
                <button
                  key={layout.id}
                  onClick={() => pickLayout(layout.id)}
                  title={layout.description}
                  className={`group relative flex flex-col gap-2 rounded-md border p-2 text-left transition-all ${
                    isSelected
                      ? "border-primary ring-2 ring-primary ring-offset-2"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  <div className="aspect-[5/3] w-full rounded-sm bg-muted/40 overflow-hidden flex items-center justify-center text-muted-foreground group-hover:text-foreground transition-colors">
                    <layout.Wireframe />
                  </div>
                  <div>
                    <p className="text-xs font-medium leading-tight">
                      {layout.name}
                    </p>
                    <p className="text-[10px] text-muted-foreground leading-snug mt-0.5 line-clamp-2">
                      {layout.description}
                    </p>
                  </div>
                  {isSelected && (
                    <div className="absolute top-1 right-1 w-3 h-3 rounded-full bg-primary" />
                  )}
                </button>
              );
            })}
          </div>
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

function SectionMessage({
  state,
  message,
}: {
  state: SectionState;
  message: string;
}) {
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
      {state === "loading" && (
        <Loader2 className="h-4 w-4 animate-spin shrink-0 mt-0.5" />
      )}
      {state === "success" && (
        <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
      )}
      {state === "error" && <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />}
      <span>{message}</span>
    </div>
  );
}

function AnthropicSection({
  isConfigured,
  onSaved,
}: {
  isConfigured: boolean;
  onSaved: () => void;
}) {
  const [authMethod, setAuthMethod] = useState<"api_key" | "oauth">("api_key");
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [testResult, setTestResult] = useState<TestResult>("untested");
  const [importing, setImporting] = useState(false);
  const [models, setModels] = useState<[string, string][]>([]);
  const [selectedModel, setSelectedModel] = useState("");

  useEffect(() => {
    getClaudeModels()
      .then(setModels)
      .catch(() => {});
    getNonSecretConfig()
      .then((cfg) => {
        if (cfg.claude_model) setSelectedModel(cfg.claude_model);
        if (cfg.claude_auth_method === "oauth") setAuthMethod("oauth");
      })
      .catch(() => {});
  }, []);

  async function handleModelChange(modelId: string) {
    setSelectedModel(modelId);
    try {
      await setPreference("claude_model", modelId);
      void useAiSelectionStore.getState().refreshFromPrefs();
    } catch {
      /* non-critical */
    }
  }

  async function handleAuthMethodChange(method: "api_key" | "oauth") {
    setAuthMethod(method);
    setEditing(false);
    setStatus({ state: "idle", message: "" });
    setTestResult("untested");
    try {
      await saveCredential("claude_auth_method", method);
    } catch {
      /* non-critical */
    }
  }

  function startEditing() {
    setApiKey(isConfigured ? MASKED_SENTINEL : "");
    setStatus({ state: "idle", message: "" });
    setTestResult("untested");
    setEditing(true);
  }

  async function handleImportClaudePro() {
    setImporting(true);
    setStatus({
      state: "loading",
      message: "Opening browser for Claude authorization…",
    });
    try {
      const msg = await startClaudeOauth();
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
      const msg =
        apiKey === MASKED_SENTINEL
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

  async function handlePing() {
    setStatus({ state: "loading", message: "Sending test message…" });
    setTestResult("untested");
    try {
      const msg = await pingAnthropic();
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
    } catch {
      /* fine if not present */
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Anthropic</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Claude authentication for all AI workflows
            </CardDescription>
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
                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted",
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
                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            Claude.ai
          </button>
        </div>

        {/* API Key flow */}
        {authMethod === "api_key" &&
          (!editing ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={startEditing}>
                {isConfigured ? "Update key" : "Add key"}
              </Button>
              {isConfigured && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestStored}
                  disabled={status.state === "loading"}
                >
                  {status.state === "loading" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Testing…
                    </>
                  ) : (
                    "Test connection"
                  )}
                </Button>
              )}
              {isConfigured && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePing}
                  disabled={status.state === "loading"}
                >
                  {status.state === "loading" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Sending…
                    </>
                  ) : (
                    "Send test message"
                  )}
                </Button>
              )}
              {isConfigured && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground gap-1"
                  onClick={handleReset}
                >
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
                onChange={(v) => {
                  setApiKey(v);
                  setTestResult("untested");
                }}
                disabled={status.state === "loading"}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={
                    !apiKey.trim() ||
                    apiKey === MASKED_SENTINEL ||
                    status.state === "loading"
                  }
                >
                  {status.state === "loading" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Save key"
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleTest}
                  disabled={!apiKey.trim() || status.state === "loading"}
                >
                  Test connection
                </Button>
                <Button variant="ghost" size="sm" onClick={handleCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          ))}

        {/* OAuth flow */}
        {authMethod === "oauth" && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Authorize Meridian to use your Claude.ai account. A browser window
              will open to complete sign-in — no API key or CLI required.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleImportClaudePro}
                disabled={importing || status.state === "loading"}
                className="gap-1.5"
              >
                {importing ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" /> Connecting…
                  </>
                ) : isConfigured ? (
                  "Re-authorize"
                ) : (
                  "Connect with Claude"
                )}
              </Button>
              {isConfigured && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestStored}
                  disabled={status.state === "loading"}
                >
                  {status.state === "loading" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Testing…
                    </>
                  ) : (
                    "Test connection"
                  )}
                </Button>
              )}
              {isConfigured && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePing}
                  disabled={status.state === "loading"}
                >
                  {status.state === "loading" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Sending…
                    </>
                  ) : (
                    "Send test message"
                  )}
                </Button>
              )}
            </div>
          </div>
        )}

        <SectionMessage {...status} />

        {/* Model picker — visible when Anthropic is configured */}
        {isConfigured && models.length > 0 && (
          <div className="space-y-1.5 pt-2 border-t">
            <label className="text-xs font-medium text-muted-foreground">
              Default Claude Model
            </label>
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {!selectedModel && <option value="">— select a model —</option>}
              {models.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              Used for all AI features. Sonnet is recommended for quality; Haiku
              is faster and lower cost.
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
  { value: "auto", label: "Auto (ordered fallback)" },
  { value: "claude", label: "Claude only" },
  { value: "gemini", label: "Gemini only" },
  { value: "copilot", label: "Copilot only" },
  { value: "local", label: "Local LLM only" },
] as const;

const PROVIDER_META: Record<
  string,
  { label: string; color: string; dot: string }
> = {
  claude: {
    label: "Claude",
    color: "border-orange-400/40 bg-orange-400/10 text-orange-400",
    dot: "bg-orange-400",
  },
  gemini: {
    label: "Gemini",
    color: "border-blue-400/40  bg-blue-400/10  text-blue-400",
    dot: "bg-blue-400",
  },
  copilot: {
    label: "Copilot",
    color: "border-emerald-400/40 bg-emerald-400/10 text-emerald-400",
    dot: "bg-emerald-400",
  },
  local: {
    label: "Local LLM",
    color: "border-purple-400/40 bg-purple-400/10 text-purple-400",
    dot: "bg-purple-400",
  },
};

const DEFAULT_ORDER = ["claude", "gemini", "copilot", "local"];

function AiProviderSection() {
  const [mode, setMode] = useState("auto");
  const [order, setOrder] = useState<string[]>(DEFAULT_ORDER);
  const dragSrc = useRef<number | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragWidth = useRef(0);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [insertBefore, setInsertBefore] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    getNonSecretConfig()
      .then((cfg) => {
        if (cfg.ai_provider) setMode(cfg.ai_provider);
        if (cfg.ai_provider_order) {
          const parsed = cfg.ai_provider_order
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean);
          if (parsed.length > 0) {
            const missing = DEFAULT_ORDER.filter((p) => !parsed.includes(p));
            const merged = [...parsed, ...missing];

            // Ensure "local" is always the last option if present
            const localIdx = merged.indexOf("local");
            if (localIdx !== -1 && localIdx !== merged.length - 1) {
              merged.splice(localIdx, 1);
              merged.push("local");
            }

            setOrder(merged);
          }
        }
      })
      .catch(() => {});
  }, []);

  async function handleModeChange(value: string) {
    setMode(value);
    try {
      await setPreference("ai_provider", value);
      // Keep PerPanelAiSection's lock state in sync.
      void useAiSelectionStore.getState().refreshFromPrefs();
    } catch {
      /* non-critical */
    }
  }

  async function persistOrder(next: string[]) {
    setOrder(next);
    try {
      await setPreference("ai_provider_order", next.join(","));
    } catch {
      /* non-critical */
    }
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
    const rows = Array.from(
      document.querySelectorAll("[data-dnd-provider]"),
    ) as HTMLElement[];
    const others = rows.filter((r) => r.dataset.dndProvider !== fromProvider);
    for (let i = 0; i < others.length; i++) {
      const rect = others[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return others.length;
  }

  function handlePointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    idx: number,
  ) {
    if (e.button !== 0) return;
    e.preventDefault();

    const rect = e.currentTarget.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    dragWidth.current = rect.width;
    dragSrc.current = idx;

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
      const ib =
        from !== null ? getInsertBefore(ev.clientY, fromProvider) : null;
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
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
  }

  const modeDesc: Record<string, string> = {
    auto: "Providers are tried in the order below. If one exceeds its quota, the next is used automatically.",
    claude: "Always use Claude exclusively. No fallback.",
    gemini: "Always use Gemini exclusively. No fallback.",
    copilot: "Always use GitHub Copilot exclusively. No fallback.",
    local: "Always use the local model exclusively. Requires a running server.",
  };

  const ghostProvider = draggingIdx !== null ? order[draggingIdx] : null;
  const ghostMeta = ghostProvider
    ? (PROVIDER_META[ghostProvider] ?? null)
    : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">AI Provider Priority</CardTitle>
        <CardDescription className="text-xs mt-0.5">
          {modeDesc[mode]}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Mode selector */}
        <div className="flex flex-wrap gap-2">
          {AI_PROVIDER_MODES.map((p) => (
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
              const isDragging = originalIdx === draggingIdx;
              const meta = PROVIDER_META[provider] ?? {
                label: provider,
                color: "border-border bg-muted/40 text-foreground",
                dot: "bg-muted-foreground",
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
                  onPointerDown={(e) => handlePointerDown(e, originalIdx)}
                  className={[
                    "flex items-center gap-3 rounded-lg border px-3 py-2 text-xs",
                    "select-none cursor-grab transition-all duration-200",
                    meta.color,
                  ].join(" ")}
                >
                  <span className="opacity-40 shrink-0 text-base leading-none pointer-events-none">
                    ⠿
                  </span>
                  <span className="w-4 h-4 rounded-full bg-black/20 flex items-center justify-center text-[10px] font-bold shrink-0 pointer-events-none">
                    {displayIdx + 1}
                  </span>
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 pointer-events-none ${meta.dot}`}
                  />
                  <span className="flex-1 font-medium pointer-events-none">
                    {meta.label}
                  </span>
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
            position: "fixed",
            left: dragPos.x - dragOffset.current.x,
            top: dragPos.y - dragOffset.current.y,
            width: dragWidth.current,
            pointerEvents: "none",
            zIndex: 9999,
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

// ── Per-panel AI section ───────────────────────────────────────────────────────

function PerPanelAiSection() {
  type PanelId = AiPanelId;
  type StageId = AiStageId;

  const hydrated = useAiSelectionStore((s) => s.hydrated);
  const hydrate = useAiSelectionStore((s) => s.hydrate);
  const refresh = useAiSelectionStore((s) => s.refreshFromPrefs);
  const loadModels = useAiSelectionStore((s) => s.loadModels);
  const priority = useAiSelectionStore((s) => s.priority);
  const order = useAiSelectionStore((s) => s.order);
  const panelOverrides = useAiSelectionStore((s) => s.panelOverrides);
  const stageOverrides = useAiSelectionStore((s) => s.stageOverrides);
  const modelsByProvider = useAiSelectionStore((s) => s.modelsByProvider);
  const providerDefaultModel = useAiSelectionStore(
    (s) => s.providerDefaultModel,
  );
  const setPanelOverride = useAiSelectionStore((s) => s.setPanelOverride);
  const setStageOverride = useAiSelectionStore((s) => s.setStageOverride);

  const PANELS: PanelId[] = [
    "implement_ticket",
    "pr_review",
    "ticket_quality",
    "address_pr_comments",
    "sprint_dashboard",
    "retrospectives",
    "meetings",
  ];
  const IMPL_STAGES: StageId[] = [
    "grooming",
    "impact",
    "triage",
    "plan",
    "implementation",
    "tests",
    "review",
    "pr",
    "retro",
  ];
  const PROVIDERS: AiProvider[] = ["claude", "gemini", "copilot", "local"];

  useEffect(() => {
    if (!hydrated) void hydrate();
    else void refresh();
    for (const p of PROVIDERS) void loadModels(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const locked = priority !== "auto";
  const lockedProvider = locked ? (priority as AiProvider) : null;
  // First provider in the fallback order — shown as the "Default" label when in Auto mode.
  const defaultProvider: AiProvider = (order[0] ?? "claude") as AiProvider;

  function getModels(provider: AiProvider): [string, string][] {
    return modelsByProvider[provider] ?? [];
  }

  // Build a model list that always includes the currently stored value even if
  // it hasn't yet appeared in the fetched list (e.g. a custom model ID).
  function modelsWithCurrent(
    provider: AiProvider,
    currentModel: string,
  ): [string, string][] {
    const list = getModels(provider);
    if (!currentModel || list.some(([id]) => id === currentModel)) return list;
    return [[currentModel, currentModel], ...list];
  }

  function modelLabel(provider: AiProvider, modelId: string): string {
    if (!modelId) return "";
    const found = getModels(provider).find(([id]) => id === modelId);
    return found ? found[1] : modelId;
  }

  function defaultModelOptionLabel(provider: AiProvider): string {
    const def = providerDefaultModel[provider];
    return def ? `Default: (${modelLabel(provider, def)})` : "— Default —";
  }

  function savePanel(panel: PanelId, prov: AiProvider, model: string) {
    const m =
      model || getModels(prov)[0]?.[0] || providerDefaultModel[prov] || "";
    void setPanelOverride(panel, { provider: prov, model: m });
  }
  function clearPanel(panel: PanelId) {
    void setPanelOverride(panel, null);
  }

  function saveStage(stage: StageId, prov: AiProvider, model: string) {
    const m =
      model || getModels(prov)[0]?.[0] || providerDefaultModel[prov] || "";
    void setStageOverride(stage, { provider: prov, model: m });
  }
  function clearStage(stage: StageId) {
    void setStageOverride(stage, null);
  }

  // Unified row renderer used for both panels and stages.
  function OverrideRow({
    label,
    indent,
    hint,
    overrideProvider,
    overrideModel,
    onSet,
    onClear,
  }: {
    label: string;
    indent?: boolean;
    hint?: string | null;
    overrideProvider: AiProvider | "";
    overrideModel: string;
    onSet: (provider: AiProvider, model: string) => void;
    onClear: () => void;
  }) {
    const rowClass = indent
      ? "flex items-center gap-2 py-1 pl-6 border-l-2 border-muted ml-2"
      : "flex items-center gap-2 py-1.5";
    const labelClass = indent
      ? "flex-1 text-xs text-muted-foreground"
      : "flex-1 text-sm";

    if (locked && lockedProvider) {
      // Provider is forced; show a label + model picker. "— Default —" clears the
      // model override so the global default for that provider is used.
      const models = modelsWithCurrent(lockedProvider, overrideModel);
      return (
        <div className={rowClass}>
          <div className={labelClass}>
            {label}
            {hint && (
              <span className="ml-1.5 text-[10px] uppercase tracking-wide opacity-60">
                {hint}
              </span>
            )}
          </div>
          <span className="text-xs border rounded px-2 py-1 bg-muted/40 text-muted-foreground shrink-0">
            {PROVIDER_LABELS[lockedProvider]}
          </span>
          <select
            className={`text-xs border rounded px-2 py-1 bg-background min-w-[180px] ${
              overrideModel === "" ? "text-muted-foreground" : ""
            }`}
            value={overrideModel}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "") onClear();
              else onSet(lockedProvider, v);
            }}
          >
            <option value="">
              {defaultModelOptionLabel(lockedProvider)}
            </option>
            {models.length === 0 ? (
              <option value="" disabled>
                Loading…
              </option>
            ) : (
              models.map(([id, lbl]) => (
                <option key={id} value={id}>
                  {lbl}
                </option>
              ))
            )}
          </select>
        </div>
      );
    }

    // Unlocked: provider dropdown + model dropdown (when a provider is chosen).
    const models = overrideProvider
      ? modelsWithCurrent(overrideProvider as AiProvider, overrideModel)
      : [];
    return (
      <div className={rowClass}>
        <div className={labelClass}>
          {label}
          {hint && (
            <span className="ml-1.5 text-[10px] uppercase tracking-wide opacity-60">
              {hint}
            </span>
          )}
        </div>
        <select
          className={`text-xs border rounded px-2 py-1 bg-background ${
            overrideProvider === "" ? "text-muted-foreground" : ""
          }`}
          value={overrideProvider}
          onChange={(e) => {
            const v = e.target.value as AiProvider | "";
            if (v === "") onClear();
            else onSet(v, "");
          }}
        >
          <option value="">
            — Default ({PROVIDER_LABELS[defaultProvider]}) —
          </option>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
        {overrideProvider && (
          <select
            className="text-xs border rounded px-2 py-1 bg-background min-w-[180px]"
            value={overrideModel}
            onChange={(e) =>
              onSet(overrideProvider as AiProvider, e.target.value)
            }
          >
            {models.length === 0 ? (
              <option value="">Loading…</option>
            ) : (
              models.map(([id, lbl]) => (
                <option key={id} value={id}>
                  {lbl}
                </option>
              ))
            )}
          </select>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Per-panel AI</CardTitle>
        <CardDescription className="text-xs mt-0.5">
          {locked ? (
            <>
              Provider is locked to{" "}
              <strong>{PROVIDER_LABELS[lockedProvider!]}</strong> by the
              priority setting above. Optionally choose a different model per
              panel or stage.
            </>
          ) : (
            <>
              Override the AI provider and model for any panel. Stage overrides
              under <strong>Implement a Ticket</strong> win over the panel
              setting.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {PANELS.map((p) => {
          const panelOv = panelOverrides[p];
          return (
            <div key={p}>
              <OverrideRow
                label={PANEL_LABELS[p]}
                overrideProvider={panelOv?.provider ?? ""}
                overrideModel={panelOv?.model ?? ""}
                onSet={(prov, model) => savePanel(p, prov, model)}
                onClear={() => clearPanel(p)}
              />
              {p === "implement_ticket" && (
                <div className="mt-1">
                  {IMPL_STAGES.map((s) => {
                    const stageOv = stageOverrides[s];
                    const hint = !stageOv
                      ? panelOv
                        ? "(panel)"
                        : "(default)"
                      : null;
                    return (
                      <OverrideRow
                        key={s}
                        label={STAGE_LABELS[s]}
                        indent
                        hint={hint}
                        overrideProvider={stageOv?.provider ?? ""}
                        overrideModel={stageOv?.model ?? ""}
                        onSet={(prov, model) => saveStage(s, prov, model)}
                        onClear={() => clearStage(s)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ── Gemini section ─────────────────────────────────────────────────────────────

function GeminiSection({
  isConfigured,
  onSaved,
}: {
  isConfigured: boolean;
  onSaved: () => void;
}) {
  const [authMethod, setAuthMethod] = useState<"api_key" | "oauth">("api_key");
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [testResult, setTestResult] = useState<TestResult>("untested");
  const [connecting, setConnecting] = useState(false);
  const [models, setModels] = useState<[string, string][]>([]);
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [customModelDraft, setCustomModelDraft] = useState("");
  const [customModelErr, setCustomModelErr] = useState("");
  const [savingCustom, setSavingCustom] = useState(false);

  async function refreshModelLists() {
    const [list, custom] = await Promise.all([
      getGeminiModels(),
      getCustomGeminiModels(),
    ]);
    setModels(list);
    setCustomModels(custom);
  }

  useEffect(() => {
    refreshModelLists().catch((err) => {
      if (isConfigured) {
        setStatus({
          state: "error",
          message: `Failed to load models: ${err}`,
        });
      }
    });
    getNonSecretConfig()
      .then((cfg) => {
        if (cfg.gemini_model) setSelectedModel(cfg.gemini_model);
        if (cfg.gemini_auth_method === "oauth") setAuthMethod("oauth");
      })
      .catch(() => {});
  }, [isConfigured]);

  async function handleAddCustomModel() {
    const id = customModelDraft.trim();
    if (!id) return;
    setSavingCustom(true);
    setCustomModelErr("");
    try {
      const updated = await addCustomGeminiModel(id);
      setCustomModels(updated);
      setModels(await getGeminiModels());
      useAiSelectionStore.getState().invalidateModels("gemini");
      setCustomModelDraft("");
      if (!selectedModel) handleModelChange(id);
    } catch (err) {
      setCustomModelErr(String(err));
    } finally {
      setSavingCustom(false);
    }
  }

  async function handleRemoveCustomModel(id: string) {
    try {
      const updated = await removeCustomGeminiModel(id);
      setCustomModels(updated);
      setModels(await getGeminiModels());
      useAiSelectionStore.getState().invalidateModels("gemini");
      if (selectedModel === id) handleModelChange("");
    } catch (err) {
      setCustomModelErr(String(err));
    }
  }

  async function handleModelChange(modelId: string) {
    setSelectedModel(modelId);
    try {
      await setPreference("gemini_model", modelId);
      void useAiSelectionStore.getState().refreshFromPrefs();
    } catch {
      /* non-critical */
    }
  }

  async function handleAuthMethodChange(method: "api_key" | "oauth") {
    setAuthMethod(method);
    setEditing(false);
    setStatus({ state: "idle", message: "" });
    setTestResult("untested");
    try {
      await saveCredential("gemini_auth_method", method);
    } catch {
      /* non-critical */
    }
  }

  function startEditing() {
    setApiKey(isConfigured ? MASKED_SENTINEL : "");
    setStatus({ state: "idle", message: "" });
    setTestResult("untested");
    setEditing(true);
  }

  async function handleConnectGoogle() {
    setConnecting(true);
    setStatus({
      state: "loading",
      message: "Opening browser for Google authorization…",
    });
    try {
      await saveCredential("gemini_auth_method", "oauth");
      const msg = await startGeminiOauth();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
      setEditing(false);
      onSaved();
      refreshModelLists().catch((err) => {
        setStatus({
          state: "error",
          message: `${msg} (but failed to load models: ${err})`,
        });
      });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    } finally {
      setConnecting(false);
    }
  }

  async function handleSave() {
    if (!apiKey.trim() || apiKey === MASKED_SENTINEL) return;
    setStatus({ state: "loading", message: "Saving and testing…" });
    try {
      await saveCredential("gemini_auth_method", "api_key");
      const msg = await validateGemini(apiKey.trim());
      const verified = msg.toLowerCase().includes("successfully");
      setTestResult(verified ? "success" : "untested");
      setStatus({ state: "success", message: msg });
      setEditing(false);
      onSaved();
      refreshModelLists().catch((err) => {
        setStatus({
          state: "error",
          message: `${msg} (but failed to load models: ${err})`,
        });
      });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTest() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg =
        apiKey === MASKED_SENTINEL
          ? await testGeminiStored()
          : await validateGemini(apiKey.trim());
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
      const msg = await testGeminiStored();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handlePing() {
    setStatus({ state: "loading", message: "Sending test message…" });
    setTestResult("untested");
    try {
      const msg = await pingGemini();
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
      await saveCredential("gemini_auth_method", "api_key");
      setTestResult("untested");
      onSaved();
    } catch {
      /* fine if not present */
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Google Gemini</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Alternative AI provider for fallback or cost optimisation
            </CardDescription>
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
                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted",
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
                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            Google Account
          </button>
        </div>

        {/* API Key flow */}
        {authMethod === "api_key" &&
          (!editing ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={startEditing}>
                {isConfigured ? "Update key" : "Add key"}
              </Button>
              {isConfigured && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestStored}
                  disabled={status.state === "loading"}
                >
                  {status.state === "loading" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Testing…
                    </>
                  ) : (
                    "Test connection"
                  )}
                </Button>
              )}
              {isConfigured && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePing}
                  disabled={status.state === "loading"}
                >
                  {status.state === "loading" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Sending…
                    </>
                  ) : (
                    "Send test message"
                  )}
                </Button>
              )}
              {isConfigured && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground gap-1"
                  onClick={handleReset}
                >
                  <RotateCcw className="h-3 w-3" /> Reset
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <CredentialField
                id="settings-gemini-key"
                label="API Key"
                placeholder="AIza…"
                masked
                value={apiKey}
                onChange={(v) => {
                  setApiKey(v);
                  setTestResult("untested");
                }}
                disabled={status.state === "loading"}
              />
              <p className="text-[11px] text-muted-foreground -mt-1">
                Get a free key (or enable pay-as-you-go) at{" "}
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground"
                >
                  aistudio.google.com/apikey
                </a>
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={
                    !apiKey.trim() ||
                    apiKey === MASKED_SENTINEL ||
                    status.state === "loading"
                  }
                >
                  {status.state === "loading" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Save key"
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleTest}
                  disabled={!apiKey.trim() || status.state === "loading"}
                >
                  Test connection
                </Button>
                <Button variant="ghost" size="sm" onClick={handleCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          ))}

        {/* OAuth flow */}
        {authMethod === "oauth" && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Sign in with your Google account to use your Gemini subscription
              limits. A browser window will open to complete sign-in.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleConnectGoogle}
                disabled={connecting || status.state === "loading"}
                className="gap-1.5"
              >
                {connecting ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" /> Connecting…
                  </>
                ) : isConfigured ? (
                  "Re-authorize"
                ) : (
                  "Connect with Google"
                )}
              </Button>
              {isConfigured && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestStored}
                  disabled={status.state === "loading"}
                >
                  {status.state === "loading" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Testing…
                    </>
                  ) : (
                    "Test connection"
                  )}
                </Button>
              )}
              {isConfigured && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePing}
                  disabled={status.state === "loading"}
                >
                  {status.state === "loading" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Sending…
                    </>
                  ) : (
                    "Send test message"
                  )}
                </Button>
              )}
            </div>
          </div>
        )}

        <SectionMessage {...status} />

        {/* Model picker — visible when Gemini is configured */}
        {isConfigured && (
          <div className="space-y-1.5 pt-2 border-t">
            <label className="text-xs font-medium text-muted-foreground">
              Default Gemini Model
            </label>
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {!selectedModel && <option value="">— select a model —</option>}
              {models.length === 0 && !selectedModel && (
                <option value="" disabled>
                  Loading models...
                </option>
              )}
              {models.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              Used when Gemini is the active provider. Flash is recommended for
              speed and cost; Pro for the highest quality.
            </p>

            <div className="pt-2 space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Custom models
              </label>
              <p className="text-[11px] text-muted-foreground -mt-0.5">
                Add any Gemini model ID Google has published (e.g.{" "}
                <code>gemini-3.1-pro-preview</code>). Useful when a new model
                ships before Meridian's built-in list is updated.
              </p>
              <div className="flex gap-2">
                <Input
                  value={customModelDraft}
                  onChange={(e) => {
                    setCustomModelDraft(e.target.value);
                    if (customModelErr) setCustomModelErr("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddCustomModel();
                    }
                  }}
                  placeholder="gemini-…"
                  disabled={savingCustom}
                  className="h-8 text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAddCustomModel}
                  disabled={!customModelDraft.trim() || savingCustom}
                >
                  {savingCustom ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Add"
                  )}
                </Button>
              </div>
              {customModelErr && (
                <p className="text-[11px] text-destructive">{customModelErr}</p>
              )}
              {customModels.length > 0 && (
                <ul className="space-y-1 pt-1">
                  {customModels.map((id) => (
                    <li
                      key={id}
                      className="flex items-center justify-between rounded-md border px-2 py-1 text-xs"
                    >
                      <code className="font-mono">{id}</code>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemoveCustomModel(id)}
                        aria-label={`Remove ${id}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Copilot section ────────────────────────────────────────────────────────────

function CopilotSection({
  isConfigured,
  onSaved,
}: {
  isConfigured: boolean;
  onSaved: () => void;
}) {
  const [authMethod, setAuthMethod] = useState<"api_key" | "oauth">("api_key");
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [testResult, setTestResult] = useState<TestResult>("untested");
  const [connecting, setConnecting] = useState(false);
  const [models, setModels] = useState<[string, string][]>([]);
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [customModelDraft, setCustomModelDraft] = useState("");
  const [customModelErr, setCustomModelErr] = useState("");
  const [savingCustom, setSavingCustom] = useState(false);

  async function refreshModelLists() {
    const [list, custom] = await Promise.all([
      getCopilotModels(),
      getCustomCopilotModels(),
    ]);
    setModels(list);
    setCustomModels(custom);
  }

  useEffect(() => {
    refreshModelLists().catch((err) => {
      if (isConfigured) {
        setStatus({
          state: "error",
          message: `Failed to load models: ${err}`,
        });
      }
    });
    getNonSecretConfig()
      .then((cfg) => {
        if (cfg.copilot_model) setSelectedModel(cfg.copilot_model);
        if (cfg.copilot_auth_method === "oauth") setAuthMethod("oauth");
      })
      .catch(() => {});
  }, [isConfigured]);

  async function handleAddCustomModel() {
    const id = customModelDraft.trim();
    if (!id) return;
    setSavingCustom(true);
    setCustomModelErr("");
    try {
      const updated = await addCustomCopilotModel(id);
      setCustomModels(updated);
      setModels(await getCopilotModels());
      useAiSelectionStore.getState().invalidateModels("copilot");
      setCustomModelDraft("");
      if (!selectedModel) handleModelChange(id);
    } catch (err) {
      setCustomModelErr(String(err));
    } finally {
      setSavingCustom(false);
    }
  }

  async function handleRemoveCustomModel(id: string) {
    try {
      const updated = await removeCustomCopilotModel(id);
      setCustomModels(updated);
      setModels(await getCopilotModels());
      useAiSelectionStore.getState().invalidateModels("copilot");
      if (selectedModel === id) handleModelChange("");
    } catch (err) {
      setCustomModelErr(String(err));
    }
  }

  async function handleModelChange(modelId: string) {
    setSelectedModel(modelId);
    try {
      await setPreference("copilot_model", modelId);
      void useAiSelectionStore.getState().refreshFromPrefs();
    } catch {
      /* non-critical */
    }
  }

  async function handleAuthMethodChange(method: "api_key" | "oauth") {
    setAuthMethod(method);
    setEditing(false);
    setStatus({ state: "idle", message: "" });
    setTestResult("untested");
    try {
      await saveCredential("copilot_auth_method", method);
    } catch {
      /* non-critical */
    }
  }

  function startEditing() {
    setApiKey(isConfigured ? MASKED_SENTINEL : "");
    setStatus({ state: "idle", message: "" });
    setTestResult("untested");
    setEditing(true);
  }

  async function handleConnectGithub() {
    setConnecting(true);
    setStatus({
      state: "loading",
      message: "Opening browser for GitHub authorization…",
    });
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen("copilot-oauth-code", (event) => {
        const payload = event.payload as {
          userCode: string;
          verificationUri: string;
        };
        setStatus({
          state: "loading",
          message: `Please open ${payload.verificationUri} and enter code: ${payload.userCode}`,
        });
      });
      await saveCredential("copilot_auth_method", "oauth");
      const msg = await startCopilotOauth();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
      setEditing(false);
      onSaved();
      refreshModelLists().catch((err) => {
        setStatus({
          state: "error",
          message: `${msg} (but failed to load models: ${err})`,
        });
      });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    } finally {
      if (unlisten) unlisten();
      setConnecting(false);
    }
  }

  async function handleSave() {
    if (!apiKey.trim() || apiKey === MASKED_SENTINEL) return;
    setStatus({ state: "loading", message: "Saving and testing…" });
    try {
      await saveCredential("copilot_auth_method", "api_key");
      const msg = await validateCopilot(apiKey.trim());
      const verified = msg.toLowerCase().includes("successfully");
      setTestResult(verified ? "success" : "untested");
      setStatus({ state: "success", message: msg });
      setEditing(false);
      onSaved();
      refreshModelLists().catch((err) => {
        setStatus({
          state: "error",
          message: `${msg} (but failed to load models: ${err})`,
        });
      });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handleTest() {
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg =
        apiKey === MASKED_SENTINEL
          ? await testCopilotStored()
          : await validateCopilot(apiKey.trim());
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
      const msg = await testCopilotStored();
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    }
  }

  async function handlePing() {
    setStatus({ state: "loading", message: "Sending test message…" });
    setTestResult("untested");
    try {
      const msg = await pingCopilot();
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
      await deleteCredential("copilot_api_key");
      await saveCredential("copilot_auth_method", "api_key");
      setTestResult("untested");
      onSaved();
    } catch {
      /* fine if not present */
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">GitHub Copilot</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Use your GitHub Copilot subscription for AI features
            </CardDescription>
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
                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted",
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
                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            GitHub Account
          </button>
        </div>

        {/* API Key flow */}
        {authMethod === "api_key" &&
          (!editing ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={startEditing}>
                {isConfigured ? "Update key" : "Add key"}
              </Button>
              {isConfigured && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestStored}
                  disabled={status.state === "loading"}
                >
                  {status.state === "loading" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Testing…
                    </>
                  ) : (
                    "Test connection"
                  )}
                </Button>
              )}
              {isConfigured && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePing}
                  disabled={status.state === "loading"}
                >
                  {status.state === "loading" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Sending…
                    </>
                  ) : (
                    "Send test message"
                  )}
                </Button>
              )}
              {isConfigured && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground gap-1"
                  onClick={handleReset}
                >
                  <RotateCcw className="h-3 w-3" /> Reset
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <CredentialField
                id="settings-copilot-token"
                label="GitHub Token"
                placeholder="AIza…"
                masked
                value={apiKey}
                onChange={(v) => {
                  setApiKey(v);
                  setTestResult("untested");
                }}
                disabled={status.state === "loading"}
              />
              <p className="text-[11px] text-muted-foreground -mt-1">
                Get a free key (or enable pay-as-you-go) at{" "}
                <a
                  href="https://github.com/settings/tokens"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground"
                >
                  github.com/settings/tokens
                </a>
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={
                    !apiKey.trim() ||
                    apiKey === MASKED_SENTINEL ||
                    status.state === "loading"
                  }
                >
                  {status.state === "loading" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Save key"
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleTest}
                  disabled={!apiKey.trim() || status.state === "loading"}
                >
                  Test connection
                </Button>
                <Button variant="ghost" size="sm" onClick={handleCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          ))}

        {/* OAuth flow */}
        {authMethod === "oauth" && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Sign in with your GitHub account to use your Copilot subscription.
              A browser window will open on github.com/login/device. The
              one-time code has been copied to your clipboard — paste it and
              approve to finish sign-in.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleConnectGithub}
                disabled={connecting || status.state === "loading"}
                className="gap-1.5"
              >
                {connecting ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" /> Connecting…
                  </>
                ) : isConfigured ? (
                  "Re-authorize"
                ) : (
                  "Connect with GitHub"
                )}
              </Button>
              {isConfigured && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestStored}
                  disabled={status.state === "loading"}
                >
                  {status.state === "loading" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Testing…
                    </>
                  ) : (
                    "Test connection"
                  )}
                </Button>
              )}
              {isConfigured && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePing}
                  disabled={status.state === "loading"}
                >
                  {status.state === "loading" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Sending…
                    </>
                  ) : (
                    "Send test message"
                  )}
                </Button>
              )}
              {isConfigured && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground gap-1"
                  onClick={handleReset}
                >
                  <RotateCcw className="h-3 w-3" /> Reset
                </Button>
              )}
            </div>
          </div>
        )}

        <SectionMessage {...status} />

        {/* Model picker — visible when Copilot is configured */}
        {isConfigured && models.length > 0 && (
          <div className="space-y-1.5 pt-2 border-t">
            <label className="text-xs font-medium text-muted-foreground">
              Default Copilot Model
            </label>
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {!selectedModel && <option value="">— select a model —</option>}
              {models.length === 0 && !selectedModel && (
                <option value="" disabled>
                  Loading models...
                </option>
              )}
              {models.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              Used when GitHub Copilot is the active provider. Includes GPT-4o,
              o3-mini, and Claude 3.5 Sonnet.
            </p>

            <div className="pt-2 space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Custom models
              </label>
              <p className="text-[11px] text-muted-foreground -mt-0.5">
                Add any model ID supported by GitHub Copilot (e.g.{" "}
                <code>o1-preview</code>). Useful when a new model ships before
                Meridian's built-in list is updated.
              </p>
              <div className="flex gap-2">
                <Input
                  value={customModelDraft}
                  onChange={(e) => {
                    setCustomModelDraft(e.target.value);
                    if (customModelErr) setCustomModelErr("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddCustomModel();
                    }
                  }}
                  placeholder="o3-mini…"
                  disabled={savingCustom}
                  className="h-8 text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAddCustomModel}
                  disabled={!customModelDraft.trim() || savingCustom}
                >
                  {savingCustom ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Add"
                  )}
                </Button>
              </div>
              {customModelErr && (
                <p className="text-[11px] text-destructive">{customModelErr}</p>
              )}
              {customModels.length > 0 && (
                <ul className="space-y-1 pt-1">
                  {customModels.map((id) => (
                    <li
                      key={id}
                      className="flex items-center justify-between rounded-md border px-2 py-1 text-xs"
                    >
                      <code className="font-mono">{id}</code>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemoveCustomModel(id)}
                        aria-label={`Remove ${id}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Local LLM section ──────────────────────────────────────────────────────────

function LocalLlmSection({
  isConfigured,
  onSaved,
}: {
  isConfigured: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [testResult, setTestResult] = useState<TestResult>("untested");
  const [models, setModels] = useState<[string, string][]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [customModel, setCustomModel] = useState("");

  useEffect(() => {
    getNonSecretConfig()
      .then((cfg) => {
        if (cfg.local_llm_url) {
          setServerUrl(cfg.local_llm_url);
          setLocalLlmUrlCache(cfg.local_llm_url);
        }
        if (cfg.local_llm_model) setSelectedModel(cfg.local_llm_model);
      })
      .catch(() => {});
    if (isConfigured) {
      getLocalModels()
        .then(setModels)
        .catch(() => {});
    }
  }, [isConfigured]);

  async function handleModelChange(value: string) {
    setSelectedModel(value);
    try {
      await saveCredential("local_llm_model", value);
      void useAiSelectionStore.getState().refreshFromPrefs();
    } catch {
      /* non-critical */
    }
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
      // Drop any cached "local" model list in the AI selection store so the
      // per-panel model picker fetches a fresh list against the new URL.
      useAiSelectionStore.getState().invalidateModels("local");
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
      useAiSelectionStore.getState().invalidateModels("local");
      onSaved();
    } catch {
      /* fine */
    }
  }

  async function handleRefreshModels() {
    setStatus({ state: "loading", message: "Refreshing model list…" });
    try {
      const list = await getLocalModels();
      setModels(list);
      setStatus({
        state: list.length > 0 ? "success" : "idle",
        message:
          list.length > 0
            ? `${list.length} model${list.length !== 1 ? "s" : ""} found.`
            : "No models found. Make sure at least one model is pulled in Ollama.",
      });
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    }
  }

  const displayModels =
    models.length > 0
      ? models
      : selectedModel
        ? ([[selectedModel, selectedModel]] as [string, string][])
        : [];

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
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestStored}
                disabled={status.state === "loading"}
              >
                {status.state === "loading" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" /> Testing…
                  </>
                ) : (
                  "Test connection"
                )}
              </Button>
            )}
            {isConfigured && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={handleReset}
              >
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
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="http://localhost:11434"
                className="text-xs h-8 font-mono mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Ollama default:{" "}
                <code className="bg-muted px-1 rounded">
                  http://localhost:11434
                </code>
                {" · "}LM Studio:{" "}
                <code className="bg-muted px-1 rounded">
                  http://localhost:1234
                </code>
              </p>
            </div>
            <div>
              <Label className="text-xs">
                API Key{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Leave blank if not required"
                className="text-xs h-8 font-mono mt-1"
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!serverUrl.trim() || status.state === "loading"}
              >
                {status.state === "loading" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Save & Test"
                )}
              </Button>
              <Button variant="outline" size="sm" onClick={handleCancel}>
                Cancel
              </Button>
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
                onChange={(e) => handleModelChange(e.target.value)}
                className="w-full text-xs rounded-md border border-input bg-background px-2 py-1.5 text-foreground"
              >
                {displayModels.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                onBlur={() => {
                  if (customModel.trim()) handleModelChange(customModel.trim());
                }}
                placeholder="e.g. llama3.2:latest"
                className="text-xs h-8 font-mono"
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function JiraSection({
  isConfigured,
  onSaved,
}: {
  isConfigured: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [testResult, setTestResult] = useState<TestResult>("untested");

  async function startEditing() {
    try {
      const config = await getNonSecretConfig();
      setBaseUrl(config["jira_base_url"] ?? "");
      setEmail(config["jira_email"] ?? "");
      const hasStoredCreds = !!(
        config["jira_base_url"] || config["jira_email"]
      );
      setApiToken(hasStoredCreds ? MASKED_SENTINEL : "");
    } catch {
      setBaseUrl("");
      setEmail("");
      setApiToken("");
    }
    setTestResult("untested");
    setStatus({ state: "idle", message: "" });
    setEditing(true);
  }

  async function handleSave() {
    if (!baseUrl.trim() || !email.trim() || !apiToken.trim()) return;
    setSavingJira(true);
    setStatus({ state: "loading", message: "Saving…" });
    try {
      await saveCredential("jira_base_url", baseUrl.trim());
      await saveCredential("jira_email", email.trim());
      if (apiToken !== MASKED_SENTINEL) {
        // Strip ALL whitespace — API tokens never contain spaces or newlines,
        // and paste events in password fields can introduce them invisibly.
        const cleanToken = apiToken.replace(/\s/g, "");
        await saveCredential("jira_api_token", cleanToken);
      }
      setTestResult("untested");
      setStatus({ state: "success", message: "Credentials saved." });
      onSaved();
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    } finally {
      setSavingJira(false);
    }
  }

  async function handleTest() {
    setTestingJira(true);
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg =
        apiToken === MASKED_SENTINEL
          ? await testJiraStored()
          : await validateJira(baseUrl.trim(), email.trim(), apiToken.trim());
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    } finally {
      setTestingJira(false);
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
    setBaseUrl("");
    setEmail("");
    setApiToken("");
    setStatus({ state: "idle", message: "" });
  }

  async function handleReset() {
    for (const key of ["jira_base_url", "jira_email", "jira_api_token"]) {
      try {
        await deleteCredential(key);
      } catch {
        /* already gone */
      }
    }
    setTestResult("untested");
    onSaved();
  }

  const canSave = !!(baseUrl.trim() && email.trim() && apiToken.trim());
  const [savingJira, setSavingJira] = useState(false);
  const [testingJira, setTestingJira] = useState(false);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">JIRA</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Sprint data and ticket details
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
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={startEditing}>
              {isConfigured ? "Update credentials" : "Add credentials"}
            </Button>
            {isConfigured && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestStored}
                disabled={status.state === "loading"}
              >
                {status.state === "loading" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" /> Testing…
                  </>
                ) : (
                  "Test connection"
                )}
              </Button>
            )}
            {isConfigured && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground gap-1"
                onClick={handleReset}
              >
                <RotateCcw className="h-3 w-3" /> Reset
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <ScopeList {...JIRA_PERMISSIONS} />
            <CredentialField
              id="s-jira-url"
              label="Workspace URL"
              placeholder="https://yourcompany.atlassian.net"
              value={baseUrl}
              onChange={(v) => {
                setBaseUrl(v);
                setTestResult("untested");
              }}
              disabled={savingJira || testingJira}
            />
            <CredentialField
              id="s-jira-email"
              label="Email"
              placeholder="you@yourcompany.com"
              value={email}
              onChange={(v) => {
                setEmail(v);
                setTestResult("untested");
              }}
              disabled={savingJira || testingJira}
            />
            <CredentialField
              id="s-jira-token"
              label="API Token"
              placeholder="ATATT3x…"
              masked
              value={apiToken}
              onChange={(v) => {
                setApiToken(v);
                setTestResult("untested");
              }}
              disabled={savingJira || testingJira}
              helperText={
                isConfigured && apiToken === MASKED_SENTINEL
                  ? "Token already saved — clear to replace"
                  : "Go to id.atlassian.com → Security → API tokens and create a classic token (starts with ATATT3x)."
              }
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!canSave || savingJira || testingJira}
              >
                {savingJira ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Save credentials"
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleTest}
                disabled={!canSave || savingJira || testingJira}
              >
                {testingJira ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Test connection"
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancel}>
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

function BitbucketSection({
  isConfigured,
  onSaved,
}: {
  isConfigured: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [email, setEmail] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [testResult, setTestResult] = useState<TestResult>("untested");
  const [disableSslVerify, setDisableSslVerify] = useState(false);

  async function startEditing() {
    try {
      const config = await getNonSecretConfig();
      setWorkspace(config["bitbucket_workspace"] ?? "");
      setEmail(config["bitbucket_email"] ?? "");
      const hasStoredCreds = !!config["bitbucket_workspace"];
      setAccessToken(hasStoredCreds ? MASKED_SENTINEL : "");
    } catch {
      setWorkspace("");
      setEmail("");
      setAccessToken("");
    }
    setTestResult("untested");
    setStatus({ state: "idle", message: "" });
    setEditing(true);
  }

  // Load preference on mount
  useEffect(() => {
    getPreferences().then((prefs) => {
      setDisableSslVerify(prefs["bitbucket_disable_ssl_verify"] === "true");
    });
  }, []);

  async function handleSave() {
    if (!workspace.trim() || !email.trim() || !accessToken.trim()) return;
    setSavingBb(true);
    setStatus({ state: "loading", message: "Saving…" });
    try {
      await saveCredential("bitbucket_workspace", workspace.trim());
      await saveCredential("bitbucket_email", email.trim());
      if (accessToken !== MASKED_SENTINEL)
        await saveCredential("bitbucket_access_token", accessToken.trim());
      setTestResult("untested");
      setStatus({ state: "success", message: "Credentials saved." });
      onSaved();
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
    } finally {
      setSavingBb(false);
    }
  }

  async function handleTest() {
    setTestingBb(true);
    setStatus({ state: "loading", message: "Testing connection…" });
    setTestResult("untested");
    try {
      const msg =
        accessToken === MASKED_SENTINEL
          ? await testBitbucketStored()
          : await validateBitbucket(
              workspace.trim(),
              email.trim(),
              accessToken.trim(),
            );
      setTestResult("success");
      setStatus({ state: "success", message: msg });
    } catch (err) {
      setTestResult("error");
      setStatus({ state: "error", message: String(err) });
    } finally {
      setTestingBb(false);
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
    setWorkspace("");
    setEmail("");
    setAccessToken("");
    setStatus({ state: "idle", message: "" });
  }

  async function handleReset() {
    for (const key of [
      "bitbucket_workspace",
      "bitbucket_email",
      "bitbucket_access_token",
      "bitbucket_username",
    ]) {
      try {
        await deleteCredential(key);
      } catch {
        /* already gone */
      }
    }
    setTestResult("untested");
    onSaved();
  }

  const canSaveBb = !!(workspace.trim() && email.trim() && accessToken.trim());
  const [savingBb, setSavingBb] = useState(false);
  const [testingBb, setTestingBb] = useState(false);

  // Save preference when toggled
  async function handleSslVerifyToggle(checked: boolean) {
    setDisableSslVerify(checked);
    await setPreference(
      "bitbucket_disable_ssl_verify",
      checked ? "true" : "false",
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Bitbucket</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              PR reviews, team metrics, and workload analysis
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <VerifiedBadge result={testResult} />
            <StatusBadge complete={isConfigured} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Credentials/test/reset buttons */}
        {!editing ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={startEditing}>
              {isConfigured ? "Update credentials" : "Add credentials"}
            </Button>
            {isConfigured && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestStored}
                disabled={status.state === "loading"}
              >
                {status.state === "loading" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" /> Testing…
                  </>
                ) : (
                  "Test connection"
                )}
              </Button>
            )}
            {isConfigured && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground gap-1"
                onClick={handleReset}
              >
                <RotateCcw className="h-3 w-3" /> Reset
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <ScopeList {...BITBUCKET_SCOPES} />
            <CredentialField
              id="s-bb-ws"
              label="Workspace slug"
              placeholder="your-workspace"
              value={workspace}
              onChange={(v) => {
                setWorkspace(v);
                setTestResult("untested");
              }}
              disabled={savingBb || testingBb}
              helperText="The short name in your Bitbucket workspace URL: bitbucket.org/your-workspace"
            />
            <CredentialField
              id="s-bb-email"
              label="Email"
              placeholder="you@yourcompany.com"
              value={email}
              onChange={(v) => {
                setEmail(v);
                setTestResult("untested");
              }}
              disabled={savingBb || testingBb}
              helperText="The email address you use to sign in to Bitbucket"
            />
            <CredentialField
              id="s-bb-token"
              label="Access Token"
              placeholder="ATCTT3x…"
              masked
              value={accessToken}
              onChange={(v) => {
                setAccessToken(v);
                setTestResult("untested");
              }}
              disabled={savingBb || testingBb}
              helperText={
                isConfigured && accessToken === MASKED_SENTINEL
                  ? "Token already saved — clear to enter a new one"
                  : "HTTP access token from Bitbucket workspace or repository settings → Access tokens."
              }
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!canSaveBb || savingBb || testingBb}
              >
                {savingBb ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Save credentials"
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleTest}
                disabled={!canSaveBb || savingBb || testingBb}
              >
                {testingBb ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Test connection"
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* SSL Verification toggle is always visible */}
        <div className="flex items-center gap-2 pt-2">
          <Switch
            id="s-bb-disable-ssl-verify"
            checked={disableSslVerify}
            onCheckedChange={handleSslVerifyToggle}
          />
          <label
            htmlFor="s-bb-disable-ssl-verify"
            className="text-xs select-none"
          >
            Disable SSL Verification (insecure)
          </label>
        </div>

        <SectionMessage {...status} />
      </CardContent>
    </Card>
  );
}

// ── PR task filters section ──────────────────────────────────────────────────
//
// Lets the user hide PR-tasks from the right-hand Tasks panel based on
// pattern rules. Common case: a Bitbucket project ships every PR with a
// boilerplate task ("verify deploy", "QA sign-off") that someone other
// than the author resolves — they shouldn't clutter the author's task
// list. Saved to the `pr_task_filters` preference key as a JSON array;
// usePrTasksStore reads them on hydrate, listens for setFilters, and
// re-applies the rules to the cached fetch without re-hitting Bitbucket.

const FILTER_MODE_LABELS: Record<PrTaskFilterMode, string> = {
  substring: "Contains",
  starts_with: "Starts with",
  ends_with: "Ends with",
  regex: "Regex",
};

function PrTaskFiltersSection() {
  const filters = usePrTasksStore((s) => s.filters);
  const setStoreFilters = usePrTasksStore((s) => s.setFilters);
  const [loaded, setLoaded] = useState(false);
  const [savingErr, setSavingErr] = useState<string | null>(null);

  // Pull persisted filters once; the store's hydrateFilters runs at app
  // startup but mounting Settings before that finishes is possible
  // (e.g. when navigating from a deep link). Re-hydrate here so the
  // section reflects on-disk truth even if the store is empty.
  useEffect(() => {
    let alive = true;
    void getPrTaskFilters().then((f) => {
      if (!alive) return;
      // Only seed the store if it's empty — otherwise the store may
      // already hold a more recent in-memory edit.
      if (usePrTasksStore.getState().filters.length === 0 && f.length > 0) {
        setStoreFilters(f);
      }
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [setStoreFilters]);

  async function commit(next: PrTaskFilter[]) {
    setStoreFilters(next);
    try {
      await setPrTaskFilters(next);
      setSavingErr(null);
    } catch (e) {
      setSavingErr(e instanceof Error ? e.message : String(e));
    }
  }

  function addRule() {
    void commit([
      ...filters,
      {
        id: newFilterId(),
        pattern: "",
        mode: "substring",
        caseInsensitive: true,
        enabled: true,
      },
    ]);
  }

  function updateRule(id: string, patch: Partial<PrTaskFilter>) {
    const next = filters.map((f) => (f.id === id ? { ...f, ...patch } : f));
    void commit(next);
  }

  function removeRule(id: string) {
    void commit(filters.filter((f) => f.id !== id));
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              PR Task Filters
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Hide PR-tasks from the Tasks panel whose text matches any of
              these rules. A task is hidden if any enabled rule matches.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!loaded ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : filters.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No filters yet — every unresolved PR-task on your authored PRs
            shows up in the Tasks panel.
          </p>
        ) : (
          <div className="space-y-2">
            {filters.map((f) => (
              <PrTaskFilterRow
                key={f.id}
                filter={f}
                onChange={(patch) => updateRule(f.id, patch)}
                onRemove={() => removeRule(f.id)}
              />
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={addRule}
          >
            <Plus className="h-3.5 w-3.5" />
            Add rule
          </Button>
          {savingErr && (
            <span className="text-xs text-destructive">{savingErr}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PrTaskFilterRow({
  filter,
  onChange,
  onRemove,
}: {
  filter: PrTaskFilter;
  onChange: (patch: Partial<PrTaskFilter>) => void;
  onRemove: () => void;
}) {
  // For regex rules, surface a parse error inline so a typo is obvious
  // before the user wonders why nothing's being filtered.
  let regexError: string | null = null;
  if (filter.mode === "regex" && filter.pattern) {
    try {
      new RegExp(filter.pattern);
    } catch (e) {
      regexError = e instanceof Error ? e.message : String(e);
    }
  }
  return (
    <div
      className={cn(
        "rounded-md border bg-muted/20 p-2 space-y-2",
        !filter.enabled && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        <select
          value={filter.mode}
          onChange={(e) =>
            onChange({ mode: e.target.value as PrTaskFilterMode })
          }
          className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-none"
          aria-label="Match mode"
        >
          {(Object.keys(FILTER_MODE_LABELS) as PrTaskFilterMode[]).map((m) => (
            <option key={m} value={m}>
              {FILTER_MODE_LABELS[m]}
            </option>
          ))}
        </select>
        <Input
          value={filter.pattern}
          onChange={(e) => onChange({ pattern: e.target.value })}
          placeholder={
            filter.mode === "regex"
              ? "^Verify .* deployed$"
              : "Verify deploy"
          }
          className="h-8 text-sm flex-1"
          spellCheck={false}
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label="Remove rule"
          title="Remove rule"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-4 px-1 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer select-none text-muted-foreground">
          <input
            type="checkbox"
            checked={filter.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
            className="h-3 w-3 cursor-pointer"
          />
          Enabled
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer select-none text-muted-foreground">
          <input
            type="checkbox"
            checked={filter.caseInsensitive}
            onChange={(e) => onChange({ caseInsensitive: e.target.checked })}
            className="h-3 w-3 cursor-pointer"
          />
          Case-insensitive
        </label>
      </div>
      {regexError && (
        <p className="text-xs text-destructive px-1">
          Invalid regex: {regexError}
        </p>
      )}
    </div>
  );
}

// ── App preferences hook ──────────────────────────────────────────────────────
//
// Load + write the typed app preferences that the per-feature setting
// cards below all share. Each card calls `update(key, value)` to commit
// a single field; the hook persists via the matching setter and reflects
// the new value back through component state immediately so the UI feels
// responsive without re-fetching.

function useAppPreferencesEditor() {
  const [prefs, setPrefs] = useState<AppPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getAppPreferences().then((p) => {
      if (alive) setPrefs(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function update<K extends keyof AppPreferences>(
    key: K,
    value: AppPreferences[K],
  ): Promise<void> {
    setPrefs((prior) => (prior ? { ...prior, [key]: value } : prior));
    try {
      switch (key) {
        case "prReviewDefaultChunkChars":
          await setPrReviewDefaultChunkChars(value as number);
          break;
        case "prTasksPollIntervalMinutes":
          await setPrTasksPollIntervalMinutes(value as number);
          break;
        case "buildCheckTimeoutSecs":
          await setBuildCheckTimeoutSecs(value as number);
          break;
        case "buildCheckMaxAttempts":
          await setBuildCheckMaxAttempts(value as number);
          break;
        case "streamingPartialsEnabled":
          await setStreamingPartialsEnabled(value as boolean);
          // Update the runtime gate immediately so the next pipeline
          // event respects the new setting without an app restart.
          setStreamingPartialsEnabledRuntime(value as boolean);
          break;
        case "workloadOverloadThresholdPct":
          await setWorkloadOverloadThresholdPct(value as number);
          setRuntimeOverloadPct(value as number);
          break;
        case "dailyTokenBudget":
          await setDailyTokenBudget(value as number | null);
          break;
        case "notifyPrTaskAdded":
          await setNotifyPrTaskAdded(value as boolean);
          break;
        case "notifyAgentStageComplete":
          await setNotifyAgentStageComplete(value as boolean);
          break;
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return { prefs, error, update };
}

// Tiny helper that renders a labelled number input with a "default: N"
// hint and a reset-to-default button. Used by every numeric pref card
// below so the UX stays consistent.
function NumberPreferenceField({
  label,
  helper,
  value,
  defaultValue,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  helper?: string;
  value: number;
  defaultValue: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-sm font-medium">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          value={Number.isFinite(value) ? value : ""}
          min={min}
          max={max}
          step={step ?? 1}
          onChange={(e) => {
            const n = Number.parseFloat(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          className="h-8 w-32 text-sm"
        />
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
        {value !== defaultValue && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => onChange(defaultValue)}
            title={`Reset to default (${defaultValue})`}
          >
            Reset
          </Button>
        )}
      </div>
      {helper && (
        <p className="text-xs text-muted-foreground">
          {helper} {`Default: ${defaultValue}.`}
        </p>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  helper,
  checked,
  onChange,
}: {
  label: string;
  helper?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 cursor-pointer"
      />
      <div className="space-y-0.5">
        <span className="text-sm font-medium">{label}</span>
        {helper && (
          <p className="text-xs text-muted-foreground leading-snug">{helper}</p>
        )}
      </div>
    </label>
  );
}

// ── Implementation pipeline tunables ──────────────────────────────────────────

function PipelineSettingsSection() {
  const { prefs, error, update } = useAppPreferencesEditor();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Implement Ticket Pipeline
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          Tunables for the per-stage agents and the build-verify sub-loop.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!prefs ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <NumberPreferenceField
              label="Build-check timeout"
              helper="Per-attempt wall-clock cap on the build command."
              value={prefs.buildCheckTimeoutSecs}
              defaultValue={APP_PREFERENCE_DEFAULTS.buildCheckTimeoutSecs}
              min={10}
              max={1800}
              step={30}
              unit="seconds"
              onChange={(n) => void update("buildCheckTimeoutSecs", n)}
            />
            <NumberPreferenceField
              label="Build-check max attempts"
              helper="Combined build + fix iterations before the pipeline gives up."
              value={prefs.buildCheckMaxAttempts}
              defaultValue={APP_PREFERENCE_DEFAULTS.buildCheckMaxAttempts}
              min={1}
              max={10}
              onChange={(n) => void update("buildCheckMaxAttempts", n)}
            />
            <ToggleRow
              label="Stream partial output into stage panels"
              helper="When on, each stage's structured panel fills in field-by-field as the agent emits JSON. Off renders the whole panel at once when the stage finishes (less busy, slightly later)."
              checked={prefs.streamingPartialsEnabled}
              onChange={(b) => void update("streamingPartialsEnabled", b)}
            />
          </>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

// ── PR Review tunables ────────────────────────────────────────────────────────

function PrReviewSettingsSection() {
  const { prefs, error, update } = useAppPreferencesEditor();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Gauge className="h-4 w-4 text-muted-foreground" />
          PR Review
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          Limits applied when sending PR diffs to the reviewer agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!prefs ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <NumberPreferenceField
            label="Default chunk size (cloud models)"
            helper="Maximum characters per chunk before the workflow splits a large diff into a multi-pass review. Local models stay pinned to 12,000 — the constraint there is the model's context window."
            value={prefs.prReviewDefaultChunkChars}
            defaultValue={APP_PREFERENCE_DEFAULTS.prReviewDefaultChunkChars}
            min={4_000}
            max={200_000}
            step={4_000}
            unit="characters"
            onChange={(n) => void update("prReviewDefaultChunkChars", n)}
          />
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

// ── Sprint Dashboard tunables ────────────────────────────────────────────────

function SprintDashboardSettingsSection() {
  const { prefs, error, update } = useAppPreferencesEditor();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Sprint Dashboard
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          Workload classification thresholds for the per-developer load
          status (Overloaded / Balanced / Underutilised).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!prefs ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <NumberPreferenceField
            label="Overload threshold"
            helper="A developer is flagged Overloaded when their remaining ticket count exceeds this percentage of the team average. The Underutilised threshold is mirrored around 100% (e.g. 140 → > 140% overloaded, < 60% underutilised)."
            value={prefs.workloadOverloadThresholdPct}
            defaultValue={APP_PREFERENCE_DEFAULTS.workloadOverloadThresholdPct}
            min={101}
            max={199}
            step={5}
            unit="% of team avg"
            onChange={(n) => void update("workloadOverloadThresholdPct", n)}
          />
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

// ── Notifications + token budget ─────────────────────────────────────────────

function NotificationsSettingsSection() {
  const { prefs, error, update } = useAppPreferencesEditor();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          Notifications & Token Budget
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          Optional in-app alerts and a soft daily cap on cumulative LLM
          token usage. The token budget only surfaces a toast — it does
          not block agent runs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!prefs ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <ToggleRow
              label="Toast when a new PR-task is detected"
              helper="Triggered by the Tasks-panel poller when a teammate adds a task to one of your authored PRs."
              checked={prefs.notifyPrTaskAdded}
              onChange={(b) => void update("notifyPrTaskAdded", b)}
            />
            <ToggleRow
              label="Toast when an agent finishes a stage"
              helper="Fires on every interrupt the implement-ticket pipeline emits — useful when you've stepped away mid-run."
              checked={prefs.notifyAgentStageComplete}
              onChange={(b) => void update("notifyAgentStageComplete", b)}
            />
            <div className="space-y-1">
              <Label className="text-sm font-medium">Daily token budget</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="numeric"
                  value={prefs.dailyTokenBudget ?? ""}
                  placeholder="Off"
                  min={1}
                  step={10_000}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    if (raw === "") {
                      void update("dailyTokenBudget", null);
                      return;
                    }
                    const n = Number.parseInt(raw, 10);
                    if (Number.isFinite(n) && n > 0) {
                      void update("dailyTokenBudget", n);
                    }
                  }}
                  className="h-8 w-40 text-sm"
                />
                <span className="text-xs text-muted-foreground">tokens / day</span>
                {prefs.dailyTokenBudget !== null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => void update("dailyTokenBudget", null)}
                    title="Disable budget"
                  >
                    Off
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Surfaces a one-time toast when cumulative tokens for the
                local day exceed this value. Leave empty to disable.
              </p>
            </div>
          </>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

// ── Tasks panel poll interval (extends the existing Tasks section) ───────────

function PrTasksPollIntervalSection() {
  const { prefs, error, update } = useAppPreferencesEditor();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ListTodo className="h-4 w-4 text-muted-foreground" />
          Tasks panel sync
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          How often the Tasks panel polls Bitbucket for new PR-tasks.
          The panel also refreshes on window focus and when you open it,
          so a longer interval is safe.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!prefs ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <NumberPreferenceField
            label="Poll interval"
            value={prefs.prTasksPollIntervalMinutes}
            defaultValue={APP_PREFERENCE_DEFAULTS.prTasksPollIntervalMinutes}
            min={5}
            max={1440}
            step={15}
            unit="minutes"
            onChange={(n) => void update("prTasksPollIntervalMinutes", n)}
          />
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
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
  const [groomingWorktreePath, setGroomingWorktreePath] = useState("");
  const [prTerminal, setPrTerminal] = useState("iTerm2");
  const [buildVerifyEnabled, setBuildVerifyEnabled] = useState(false);
  const [buildCheckCommand, setBuildCheckCommand] = useState("");
  const [editing, setEditing] = useState(!jiraBoardId || !bitbucketRepoSlug);
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
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

  async function startEditing() {
    try {
      const prefs = await getPreferences();
      setBoardId(prefs["jira_board_id"] ?? "");
      setRepoSlug(prefs["bitbucket_repo_slug"] ?? "");
      setWorktreePath(prefs["repo_worktree_path"] ?? "");
      setBaseBranch(prefs["repo_base_branch"] || "develop");
      setPrReviewWorktreePath(prefs["pr_review_worktree_path"] ?? "");
      setPrAddressWorktreePath(prefs["pr_address_worktree_path"] ?? "");
      setGroomingWorktreePath(prefs["grooming_worktree_path"] ?? "");
      setPrTerminal(prefs["pr_review_terminal"] || "iTerm2");
      setBuildVerifyEnabled(prefs["build_verify_enabled"] === "true");
      setBuildCheckCommand(prefs["build_check_command"] ?? "");
    } catch {
      setBoardId("");
      setRepoSlug("");
    }
    setStatus({ state: "idle", message: "" });
    setEditing(true);
  }

  // Auto-load on first mount if already in editing state (incomplete config)
  useEffect(() => {
    if (editing) {
      getPreferences()
        .then((prefs) => {
          setBoardId((prev) => prev || (prefs["jira_board_id"] ?? ""));
          setRepoSlug((prev) => prev || (prefs["bitbucket_repo_slug"] ?? ""));
          setWorktreePath(
            (prev) => prev || (prefs["repo_worktree_path"] ?? ""),
          );
          setBaseBranch(
            (prev) => prev || prefs["repo_base_branch"] || "develop",
          );
          setPrReviewWorktreePath(
            (prev) => prev || (prefs["pr_review_worktree_path"] ?? ""),
          );
          setPrAddressWorktreePath(
            (prev) => prev || (prefs["pr_address_worktree_path"] ?? ""),
          );
          setGroomingWorktreePath(
            (prev) => prev || (prefs["grooming_worktree_path"] ?? ""),
          );
          setPrTerminal((prev) =>
            prev !== "iTerm2" ? prev : prefs["pr_review_terminal"] || "iTerm2",
          );
          setBuildVerifyEnabled(
            (prev) => prev || prefs["build_verify_enabled"] === "true",
          );
          setBuildCheckCommand(
            (prev) => prev || (prefs["build_check_command"] ?? ""),
          );
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    if (
      !boardId.trim() &&
      !repoSlug.trim() &&
      !worktreePath.trim() &&
      !prReviewWorktreePath.trim() &&
      !prAddressWorktreePath.trim()
    )
      return;
    setStatus({ state: "loading", message: "Saving…" });
    try {
      if (boardId.trim()) await setPreference("jira_board_id", boardId.trim());
      if (repoSlug.trim())
        await setPreference("bitbucket_repo_slug", repoSlug.trim());
      if (worktreePath.trim())
        await setPreference("repo_worktree_path", worktreePath.trim());
      await setPreference("repo_base_branch", baseBranch.trim() || "develop");
      if (prReviewWorktreePath.trim()) {
        await setPreference(
          "pr_review_worktree_path",
          prReviewWorktreePath.trim(),
        );
      } else {
        await setPreference("pr_review_worktree_path", "");
      }
      if (prAddressWorktreePath.trim()) {
        await setPreference(
          "pr_address_worktree_path",
          prAddressWorktreePath.trim(),
        );
      } else {
        await setPreference("pr_address_worktree_path", "");
      }
      if (groomingWorktreePath.trim()) {
        await setPreference(
          "grooming_worktree_path",
          groomingWorktreePath.trim(),
        );
      } else {
        await setPreference("grooming_worktree_path", "");
      }
      await setPreference("pr_review_terminal", prTerminal.trim() || "iTerm2");
      await setPreference(
        "build_verify_enabled",
        buildVerifyEnabled ? "true" : "false",
      );
      await setPreference("build_check_command", buildCheckCommand.trim());
      setStatus({ state: "success", message: "Configuration saved." });
      setEditing(false);
      onSaved();
    } catch (err) {
      setStatus({ state: "error", message: String(err) });
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
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Implementation Worktree
              </p>
              <CredentialField
                id="cfg-worktree-path"
                label="Worktree Path"
                placeholder="/Users/you/REPOS/MyRepo-meridian"
                value={worktreePath}
                onChange={setWorktreePath}
                disabled={status.state === "loading"}
                helperText={`Absolute path to a git worktree for the implementation pipeline (Grooming, Impact Analysis, Triage agents). Set up with: git worktree add ../MyRepo-meridian ${baseBranch || "develop"}`}
              />
              <CredentialField
                id="cfg-base-branch"
                label="Base Branch"
                placeholder="develop"
                value={baseBranch}
                onChange={setBaseBranch}
                disabled={status.state === "loading"}
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
                disabled={status.state === "loading"}
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
                disabled={status.state === "loading"}
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
                disabled={status.state === "loading"}
                helperText={`Optional dedicated worktree that stays on ${baseBranch || "develop"} and is used for reading codebase context during Grooming and Ticket Quality checks. Meridian runs "git pull" here before each analysis to ensure it reads up-to-date code. If not set, falls back to the Implementation worktree. Set up with: git worktree add ../MyRepo-grooming ${baseBranch || "develop"}`}
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
            <div className="flex items-start justify-between gap-4 py-1">
              <div>
                <p className="text-sm font-medium">Build Verification</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  After the implementation agent writes code, run the
                  configured build command. If it fails, an AI fix loop reads
                  the error, edits the offending files, and retries (up to 3
                  times) before handing control back to you.
                </p>
              </div>
              <Button
                size="sm"
                variant={buildVerifyEnabled ? "default" : "outline"}
                onClick={() => setBuildVerifyEnabled((v) => !v)}
                disabled={status.state === "loading"}
                className="shrink-0"
              >
                {buildVerifyEnabled ? "Enabled" : "Disabled"}
              </Button>
            </div>
            {buildVerifyEnabled && (
              <div className="space-y-1.5 pl-1">
                <label
                  htmlFor="build-check-command"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Build command
                </label>
                <input
                  id="build-check-command"
                  type="text"
                  value={buildCheckCommand}
                  onChange={(e) => setBuildCheckCommand(e.target.value)}
                  placeholder="e.g. pnpm build, cargo check, make test"
                  spellCheck={false}
                  className="w-full rounded-md border bg-background px-3 py-1.5 text-sm font-mono"
                  disabled={status.state === "loading"}
                />
                <p className="text-xs text-muted-foreground">
                  Runs in the configured worktree. Leave empty to skip the
                  build sub-loop even when the toggle is on.
                </p>
              </div>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={
                  (!boardId.trim() &&
                    !repoSlug.trim() &&
                    !worktreePath.trim() &&
                    !prReviewWorktreePath.trim() &&
                    !prAddressWorktreePath.trim()) ||
                  status.state === "loading"
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

const ALL_KEY = "__all__";

function resetInMemoryStoreFor(key: string) {
  if (key === IMPLEMENT_STORE_KEY) {
    useImplementTicketStore.setState({
      ...IMPLEMENT_INITIAL,
      sessions: new Map(),
    });
  } else if (key === PR_REVIEW_STORE_KEY) {
    usePrReviewStore.setState({
      sessions: new Map(),
      prsForReview: [],
      allOpenPrs: [],
      selectedPr: null,
      isSessionActive: false,
      prListLoaded: false,
    });
  }
}

function CacheSection() {
  const [info, setInfo] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearingKey, setClearingKey] = useState<string | null>(null);
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  async function loadInfo() {
    setLoading(true);
    try {
      const result = await getStoreCacheInfo();
      setInfo(result);
    } catch {
      /* non-critical */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadInfo();
  }, []);

  const totalBytes = info ? Object.values(info).reduce((a, b) => a + b, 0) : 0;
  const hasCache = totalBytes > 0;

  async function handleClear(key: string) {
    if (confirmingKey !== key) {
      setConfirmingKey(key);
      return;
    }
    setClearingKey(key);
    try {
      if (key === ALL_KEY) {
        await clearAllStoreCaches();
        Object.keys(info ?? {}).forEach(resetInMemoryStoreFor);
        setInfo({});
        setDoneMessage("All session caches cleared.");
      } else {
        await deleteStoreCache(key);
        resetInMemoryStoreFor(key);
        setInfo((prev) => {
          if (!prev) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
        const label = CACHE_KEY_LABELS[key] ?? key;
        setDoneMessage(`Cleared ${label}.`);
      }
      setConfirmingKey(null);
    } catch {
      /* non-critical */
    } finally {
      setClearingKey(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Session Cache</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Pipeline and PR review sessions are saved to disk so they survive
              app restarts
            </CardDescription>
          </div>
          {hasCache && (
            <Badge
              variant="outline"
              className="gap-1 text-muted-foreground shrink-0"
            >
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
          <div className="space-y-1">
            {Object.entries(info).map(([key, size]) => {
              const isConfirming = confirmingKey === key;
              const isClearing = clearingKey === key;
              return (
                <div
                  key={key}
                  className="flex items-center justify-between gap-2 text-xs py-0.5"
                >
                  <span className="text-muted-foreground truncate">
                    {CACHE_KEY_LABELS[key] ?? key}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-muted-foreground">
                      {formatBytes(size)}
                    </span>
                    <Button
                      variant={isConfirming ? "destructive" : "ghost"}
                      size="sm"
                      onClick={() => handleClear(key)}
                      disabled={
                        isClearing || (clearingKey !== null && !isClearing)
                      }
                      className="h-7 gap-1.5 px-2"
                    >
                      {isClearing ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                      {isConfirming ? "Confirm" : "Clear"}
                    </Button>
                    {isConfirming && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmingKey(null)}
                        className="h-7 px-2"
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No session cache on disk.
          </p>
        )}

        {doneMessage && (
          <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
            <CheckCircle className="h-3 w-3" /> {doneMessage}
          </p>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          {hasCache && (
            <Button
              variant={confirmingKey === ALL_KEY ? "destructive" : "outline"}
              size="sm"
              onClick={() => handleClear(ALL_KEY)}
              disabled={clearingKey !== null}
              className="gap-1.5"
            >
              {clearingKey === ALL_KEY ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
              {confirmingKey === ALL_KEY
                ? "Click again to confirm"
                : "Clear all"}
            </Button>
          )}
          {confirmingKey === ALL_KEY && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmingKey(null)}
            >
              Cancel
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDoneMessage(null);
              loadInfo();
            }}
            disabled={loading}
            className="text-muted-foreground"
          >
            Refresh
          </Button>
        </div>

        {confirmingKey && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {confirmingKey === ALL_KEY
              ? "This will permanently delete all saved pipeline sessions and PR review data. In-progress work will be lost."
              : `This will permanently delete the "${
                  CACHE_KEY_LABELS[confirmingKey] ?? confirmingKey
                }" cache. In-progress work in this section will be lost.`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Data directory section ────────────────────────────────────────────────────

function DataDirectorySection() {
  const [dir, setDir] = useState("");
  const [resolvedDir, setResolvedDir] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });

  useEffect(() => {
    getPreferences().then((prefs) => setDir(prefs["data_dir"] ?? ""));
    getDataDir()
      .then(setResolvedDir)
      .catch(() => {});
  }, []);

  async function persist(next: string): Promise<string> {
    setStatus({ state: "loading", message: "" });
    try {
      await setPreference("data_dir", next);
      setDir(next);
      const resolved = await getDataDir();
      setResolvedDir(resolved);
      setStatus({
        state: "success",
        message: next ? "Saved" : "Reset to default",
      });
      return resolved;
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
      throw e;
    }
  }

  async function applyDirectoryChange(targetPref: string) {
    const oldResolved = resolvedDir;
    let newResolved: string;
    try {
      newResolved = await persist(targetPref);
    } catch {
      return;
    }
    if (!oldResolved || newResolved === oldResolved) return;

    try {
      const hasContent = await dataDirectoryHasContent(oldResolved);
      if (hasContent) {
        const move = await askDialog(
          `Move your existing data from\n\n${oldResolved}\n\nto\n\n${newResolved}\n\n` +
            `Click "Yes" to move it across, or "No" to leave it behind and start fresh in the new location.`,
          { title: "Move existing data?", kind: "info" },
        );
        if (move) {
          setStatus({ state: "loading", message: "" });
          await moveDataDirectory(oldResolved, newResolved);
          setStatus({ state: "success", message: "Moved" });
        }
      }
    } catch (e) {
      setStatus({ state: "error", message: `Could not move data: ${e}` });
      return;
    }

    const restart = await askDialog(
      "Restart Meridian now so the new data directory takes effect?",
      { title: "Restart required", kind: "info" },
    );
    if (restart) {
      try {
        await relaunchApp();
      } catch (e) {
        setStatus({ state: "error", message: `Could not relaunch: ${e}` });
      }
    }
  }

  async function browse() {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose data directory",
        defaultPath: dir || resolvedDir || undefined,
      });
      if (typeof picked === "string" && picked.trim()) {
        await applyDirectoryChange(picked.trim());
      }
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
    }
  }

  async function reveal() {
    if (!resolvedDir) return;
    try {
      await revealItemInDir(resolvedDir);
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
    }
  }

  const usingDefault = !dir;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Data Directory</CardTitle>
        <CardDescription>
          Root folder for all files generated by Meridian — sprint reports,
          templates, skills, and meetings. Defaults to the app data location if
          unset.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label>Directory path</Label>
          <div className="flex gap-2 items-center">
            <div
              className={cn(
                "flex-1 rounded-md border border-input bg-muted/40 px-3 py-1.5 text-sm font-mono break-all min-h-9 flex items-center",
                usingDefault && "italic text-muted-foreground",
              )}
            >
              {dir || "Using default app data location"}
            </div>
            <Button
              onClick={browse}
              disabled={status.state === "loading"}
              size="sm"
              variant="outline"
            >
              {status.state === "loading" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <FolderOpen className="h-4 w-4 mr-1.5" />
                  Browse…
                </>
              )}
            </Button>
            {!usingDefault && (
              <Button
                onClick={() => applyDirectoryChange("")}
                disabled={status.state === "loading"}
                size="sm"
                variant="ghost"
              >
                Use default
              </Button>
            )}
          </div>
        </div>
        {resolvedDir && (
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground font-mono break-all flex-1">
              Active: {resolvedDir}
            </p>
            <Button
              onClick={reveal}
              size="sm"
              variant="ghost"
              className="shrink-0"
            >
              <FolderOpen className="h-4 w-4 mr-1.5" />
              Open in Finder
            </Button>
          </div>
        )}
        {status.state === "success" && (
          <p className="text-xs text-emerald-600 flex items-center gap-1">
            <CheckCircle className="h-3 w-3" /> {status.message}
          </p>
        )}
        {status.state === "error" && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="h-3 w-3" /> {status.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Meetings section ─────────────────────────────────────────────────────────

const WHISPER_MODEL_META: Record<
  string,
  { label: string; sizeHuman: string; note: string }
> = {
  "tiny.en": {
    label: "tiny.en",
    sizeHuman: "~75 MB",
    note: "Fastest, lowest accuracy",
  },
  "base.en": {
    label: "base.en",
    sizeHuman: "~140 MB",
    note: "Recommended default",
  },
  "small.en": {
    label: "small.en",
    sizeHuman: "~470 MB",
    note: "Better accuracy",
  },
  "medium.en": {
    label: "medium.en",
    sizeHuman: "~1.5 GB",
    note: "Highest accuracy, slow on CPU",
  },
};

function humanBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function TimeTrackingSection() {
  const settings = useTimeTrackingStore((s) => s.settings);
  const setIdleFallbackEnabled = useTimeTrackingStore(
    (s) => s.setIdleFallbackEnabled,
  );
  const setIdleThresholdMin = useTimeTrackingStore(
    (s) => s.setIdleThresholdMin,
  );
  const setDailyTargetHours = useTimeTrackingStore(
    (s) => s.setDailyTargetHours,
  );
  const setChipHiddenInHeader = useTimeTrackingStore(
    (s) => s.setChipHiddenInHeader,
  );
  const setTrackingEnabled = useTimeTrackingStore((s) => s.setTrackingEnabled);

  // Local mirror of the threshold so users can type freely without each
  // keystroke clamping mid-edit. The actual store value is updated on blur.
  const [thresholdDraft, setThresholdDraft] = useState(
    String(settings.idleThresholdMin),
  );
  const [targetDraft, setTargetDraft] = useState(
    String(settings.dailyTargetHours),
  );

  // Resync drafts if the store changes via another path (e.g. a future
  // import/export). Comparing to the source of truth avoids stuck stale
  // drafts after store-side normalisation.
  useEffect(() => {
    setThresholdDraft(String(settings.idleThresholdMin));
  }, [settings.idleThresholdMin]);
  useEffect(() => {
    setTargetDraft(String(settings.dailyTargetHours));
  }, [settings.dailyTargetHours]);

  function commitThreshold() {
    const parsed = Number.parseInt(thresholdDraft, 10);
    if (Number.isFinite(parsed)) setIdleThresholdMin(parsed);
    else setThresholdDraft(String(settings.idleThresholdMin));
  }
  function commitTarget() {
    const parsed = Number.parseFloat(targetDraft);
    if (Number.isFinite(parsed) && parsed > 0) setDailyTargetHours(parsed);
    else setTargetDraft(String(settings.dailyTargetHours));
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Work Hours Tracking</CardTitle>
        <CardDescription>
          Tracks how long you've worked today by listening for screen lock,
          sleep, and idle. Anything beyond your daily target is banked toward a
          running overtime balance you can cash in later in the week.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor="time-tracking-enabled" className="font-normal">
              Enable time tracking
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Master switch. When off, no new segments are recorded and the
              header chip disappears. Existing history is preserved.
            </p>
          </div>
          <Switch
            id="time-tracking-enabled"
            checked={settings.trackingEnabled}
            onCheckedChange={setTrackingEnabled}
          />
        </div>
        {/* The remaining controls are only meaningful while tracking is on,
            so dim them visually when it's off — but keep them mounted so
            the user can pre-configure before flipping the master back on. */}
        <div
          className={`space-y-5 border-t pt-4 ${
            settings.trackingEnabled ? "" : "opacity-50 pointer-events-none"
          }`}
          aria-disabled={!settings.trackingEnabled}
        >
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <Label htmlFor="time-tracking-target" className="font-normal">
                Daily target (hours)
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                How long counts as a full day's work.
              </p>
            </div>
            <Input
              id="time-tracking-target"
              type="number"
              min={0.5}
              max={24}
              step={0.5}
              value={targetDraft}
              onChange={(e) => setTargetDraft(e.target.value)}
              onBlur={commitTarget}
              className="w-24 text-right"
            />
          </div>
          <div className="flex items-center justify-between gap-4 border-t pt-4">
            <div className="min-w-0">
              <Label
                htmlFor="time-tracking-chip-visible"
                className="font-normal"
              >
                Show stopwatch in header
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                The compact "today / target" chip in the top bar. Hide it from
                its own popover; flip back on here or in the Time Tracking
                workflow.
              </p>
            </div>
            <Switch
              id="time-tracking-chip-visible"
              checked={!settings.chipHiddenInHeader}
              onCheckedChange={(checked) => setChipHiddenInHeader(!checked)}
            />
          </div>
          <div className="flex items-center justify-between gap-4 border-t pt-4">
            <div className="min-w-0">
              <Label
                htmlFor="time-tracking-idle-enabled"
                className="font-normal"
              >
                Pause on idle
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Stop tracking when there's been no keyboard or mouse activity
                for the threshold below. Disable if long builds frequently keep
                you at your desk without input.
              </p>
            </div>
            <Switch
              id="time-tracking-idle-enabled"
              checked={settings.idleFallbackEnabled}
              onCheckedChange={setIdleFallbackEnabled}
            />
          </div>
          {settings.idleFallbackEnabled && (
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <Label
                  htmlFor="time-tracking-idle-threshold"
                  className="font-normal"
                >
                  Idle threshold (minutes)
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Between {MIN_IDLE_THRESHOLD_MIN} and {MAX_IDLE_THRESHOLD_MIN}.
                </p>
              </div>
              <Input
                id="time-tracking-idle-threshold"
                type="number"
                min={MIN_IDLE_THRESHOLD_MIN}
                max={MAX_IDLE_THRESHOLD_MIN}
                step={1}
                value={thresholdDraft}
                onChange={(e) => setThresholdDraft(e.target.value)}
                onBlur={commitThreshold}
                className="w-24 text-right"
              />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function MeetingsSection() {
  const [mics, setMics] = useState<MicrophoneInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("base.en");
  const [micStatus, setMicStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });
  const [modelStatus, setModelStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });

  const whisperModels = useMeetingsStore((s) => s.whisperModels);
  const modelProgress = useMeetingsStore((s) => s.modelProgress);
  const refreshWhisperModels = useMeetingsStore((s) => s.refreshWhisperModels);
  const startModelDownload = useMeetingsStore((s) => s.startModelDownload);
  const transcriptionDisabled = useMeetingsStore(
    (s) => s.transcriptionDisabled,
  );
  const setTranscriptionDisabled = useMeetingsStore(
    (s) => s.setTranscriptionDisabled,
  );

  useEffect(() => {
    // Skip mic enumeration entirely while transcription is disabled — even
    // listing devices can prompt for the macOS mic permission on some setups,
    // and the user has explicitly opted out of that flow.
    if (transcriptionDisabled) return;
    getPreferences().then((prefs) => {
      if (prefs["meeting_mic"]) setSelectedMic(prefs["meeting_mic"]);
      if (prefs["meeting_whisper_model"])
        setSelectedModel(prefs["meeting_whisper_model"]);
    });
    listMicrophones()
      .then((list) => setMics(list))
      .catch((e) => setMicStatus({ state: "error", message: String(e) }));
    refreshWhisperModels();
  }, [refreshWhisperModels, transcriptionDisabled]);

  async function saveMic(next: string) {
    setSelectedMic(next);
    setMicStatus({ state: "loading", message: "" });
    try {
      await setPreference("meeting_mic", next);
      setMicStatus({ state: "success", message: "Saved" });
    } catch (e) {
      setMicStatus({ state: "error", message: String(e) });
    }
  }

  async function saveModel(next: string) {
    setSelectedModel(next);
    setModelStatus({ state: "loading", message: "" });
    try {
      await setPreference("meeting_whisper_model", next);
      setModelStatus({ state: "success", message: "Saved" });
    } catch (e) {
      setModelStatus({ state: "error", message: String(e) });
    }
  }

  async function handleDownload(modelId: string) {
    setModelStatus({ state: "loading", message: `Downloading ${modelId}...` });
    try {
      await startModelDownload(modelId);
      setModelStatus({ state: "success", message: `Downloaded ${modelId}` });
    } catch (e) {
      setModelStatus({ state: "error", message: String(e) });
    }
  }

  async function refreshMics() {
    setMicStatus({ state: "loading", message: "" });
    try {
      const list = await listMicrophones();
      setMics(list);
      setMicStatus({ state: "idle", message: "" });
    } catch (e) {
      setMicStatus({ state: "error", message: String(e) });
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Transcription</CardTitle>
          <CardDescription>
            Disable to hide all audio-recording entry points across the app —
            useful when company policy forbids recording meetings. You can still
            create freeform notes meetings from the Meetings panel and run AI
            summaries on them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <Label
              htmlFor="meeting-transcription-disabled"
              className="font-normal"
            >
              Disable meeting transcription
            </Label>
            <Switch
              id="meeting-transcription-disabled"
              checked={transcriptionDisabled}
              onCheckedChange={setTranscriptionDisabled}
            />
          </div>
        </CardContent>
      </Card>

      {transcriptionDisabled ? null : (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Mic className="h-4 w-4" /> Microphone
              </CardTitle>
              <CardDescription>
                Default input device for live meeting transcription. You can
                override this per meeting from the Meetings screen.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="meeting-mic">Input device</Label>
                <div className="flex gap-2">
                  <select
                    id="meeting-mic"
                    value={selectedMic}
                    onChange={(e) => saveMic(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="">— System default —</option>
                    {mics.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                        {m.is_default ? " (default)" : ""} — {m.sampleRate}Hz
                        {m.channels > 1 ? ` / ${m.channels}ch` : ""}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={refreshMics}
                    title="Re-enumerate devices"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {mics.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No input devices found. If this is your first use, macOS will
                  prompt for microphone permission when you start a meeting.
                </p>
              )}
              {micStatus.state === "success" && (
                <p className="text-xs text-emerald-600 flex items-center gap-1">
                  <CheckCircle className="h-3 w-3" /> {micStatus.message}
                </p>
              )}
              {micStatus.state === "error" && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> {micStatus.message}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Whisper Model</CardTitle>
              <CardDescription>
                Local speech-to-text model. Downloaded from HuggingFace and
                stored under <span className="font-mono">models/whisper/</span>{" "}
                in your data directory. Audio is never written to disk — only
                the transcription is saved.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="whisper-model">Active model</Label>
                <select
                  id="whisper-model"
                  value={selectedModel}
                  onChange={(e) => saveModel(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {Object.entries(WHISPER_MODEL_META).map(([id, meta]) => (
                    <option key={id} value={id}>
                      {meta.label} — {meta.sizeHuman} — {meta.note}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                {whisperModels.map((m) => {
                  const meta = WHISPER_MODEL_META[m.id];
                  const progress = modelProgress[m.id];
                  const downloading = !!progress && !progress.done;
                  const pct =
                    progress && progress.total > 0
                      ? Math.min(
                          100,
                          Math.floor(
                            (progress.downloaded / progress.total) * 100,
                          ),
                        )
                      : 0;
                  return (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {meta?.label ?? m.id}
                          </span>
                          {m.downloaded && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] py-0 px-1.5"
                            >
                              Downloaded
                            </Badge>
                          )}
                        </div>
                        <p className="text-muted-foreground">
                          {m.downloaded
                            ? humanBytes(m.sizeBytes)
                            : downloading
                              ? `${pct}% — ${humanBytes(progress.downloaded)} / ${humanBytes(progress.total)}`
                              : (meta?.sizeHuman ?? "")}
                        </p>
                      </div>
                      {!m.downloaded && !downloading && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDownload(m.id)}
                        >
                          <Download className="h-3.5 w-3.5 mr-1.5" />
                          Download
                        </Button>
                      )}
                      {downloading && (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      )}
                    </div>
                  );
                })}
              </div>
              {modelStatus.state === "success" && (
                <p className="text-xs text-emerald-600 flex items-center gap-1">
                  <CheckCircle className="h-3 w-3" /> {modelStatus.message}
                </p>
              )}
              {modelStatus.state === "error" && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> {modelStatus.message}
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}

// ── Per-tag note template section ────────────────────────────────────────────
//
// Templates are TipTap JSON strings keyed by tag name. The store applies the
// first selected tag's template to a notes-mode meeting whose body is empty
// (see meetingsStore.setMeetingTags). The editor here is the same one users
// type meeting notes with, so the formatting they author is exactly what gets
// pasted in.

function NoteTemplatesSection() {
  const tagVocab = useMeetingsStore((s) => s.tagVocab);
  const tagTemplates = useMeetingsStore((s) => s.tagTemplates);
  const setTagTemplate = useMeetingsStore((s) => s.setTagTemplate);

  const [selectedTag, setSelectedTag] = useState<string>(
    () => tagVocab[0] ?? "",
  );

  // Keep the selected tag valid as the vocabulary changes (tag deleted from
  // the Meetings panel, or the first tag added on a fresh setup).
  useEffect(() => {
    if (selectedTag && !tagVocab.includes(selectedTag)) {
      setSelectedTag(tagVocab[0] ?? "");
    } else if (!selectedTag && tagVocab.length > 0) {
      setSelectedTag(tagVocab[0]);
    }
  }, [selectedTag, tagVocab]);

  const hasTemplate = (t: string) =>
    extractTiptapPlainText(tagTemplates[t] ?? "").length > 0;

  if (tagVocab.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <NotebookPen className="h-4 w-4 text-muted-foreground" />
            Tag note templates
          </CardTitle>
          <CardDescription>
            Pre-fills a notes-mode meeting's body when its first tag is
            selected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No tags yet. Add tags from the Meetings panel to associate templates
            here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <NotebookPen className="h-4 w-4 text-muted-foreground" />
          Tag note templates
        </CardTitle>
        <CardDescription>
          When you select a tag for a notes-mode meeting and its body is empty,
          that tag's template is dropped in automatically. Only the first tag
          selected applies a template — adding more tags later won't replace
          existing notes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="note-template-tag">Tag</Label>
          <select
            id="note-template-tag"
            value={selectedTag}
            onChange={(e) => setSelectedTag(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {tagVocab.map((t) => (
              <option key={t} value={t}>
                {t}
                {hasTemplate(t) ? " · template set" : ""}
              </option>
            ))}
          </select>
        </div>
        {selectedTag && (
          <TagTemplateEditor
            key={selectedTag}
            tag={selectedTag}
            initialTemplate={tagTemplates[selectedTag] ?? ""}
            onSave={(content) => setTagTemplate(selectedTag, content)}
          />
        )}
        <p className="text-xs text-muted-foreground">
          Saves automatically when you click outside the editor or switch tags.
          Leave empty to skip the template for this tag.
        </p>
      </CardContent>
    </Card>
  );
}

// Why a separate component keyed on `tag`? The RichNotesEditor is uncontrolled
// after mount, so swapping its `value` mid-life only sometimes propagates (the
// editor bails when the new value is null/empty). Remounting on tag change is
// the simplest way to guarantee each tag's template loads cleanly.
function TagTemplateEditor({
  tag,
  initialTemplate,
  onSave,
}: {
  tag: string;
  initialTemplate: string;
  onSave: (content: string) => void;
}) {
  const notesLineHeight = useMeetingsStore((s) => s.notesLineHeight);
  const [draft, setDraft] = useState(initialTemplate);

  // Refs so the unmount cleanup sees the latest values without rerunning the
  // effect on every keystroke (which would also rerun the cleanup, causing
  // every keystroke to write to disk).
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const lastSavedRef = useRef(initialTemplate);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  function flush() {
    if (draftRef.current === lastSavedRef.current) return;
    lastSavedRef.current = draftRef.current;
    onSaveRef.current(draftRef.current);
  }

  // Save on unmount — covers the user switching tags (this component remounts
  // on key change), navigating away from Settings, or closing the panel.
  useEffect(() => {
    return () => {
      if (draftRef.current !== lastSavedRef.current) {
        onSaveRef.current(draftRef.current);
      }
    };
  }, []);

  return (
    <div className="rounded-md border h-[280px] flex flex-col overflow-hidden">
      <RichNotesEditor
        value={initialTemplate || null}
        onChange={setDraft}
        onBlur={flush}
        lineHeight={notesLineHeight}
        placeholder={`Template for "${tag}" notes. Use the toolbar for headings, lists, and checkboxes.`}
      />
    </div>
  );
}

// ── PR Description template section ──────────────────────────────────────────

const PR_TEMPLATE_PLACEHOLDER = `## Summary
<1–2 sentence summary of what changed and why>

## Changes
- <bullet points of the key changes>

## Testing
<how this was tested — unit tests, manual steps, etc.>

## Linked ticket
<JIRA key and URL>
`;

function PrTemplateSection() {
  const [content, setContent] = useState("");
  const [baseline, setBaseline] = useState("");
  const [mode, setMode] = useState<PrTemplateMode>("guide");
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });

  useEffect(() => {
    loadPrTemplate()
      .then((c) => {
        setContent(c);
        setBaseline(c);
      })
      .catch(() => {});
    getPreferences().then((prefs) => {
      const m = prefs["pr_template_mode"];
      setMode(m === "strict" ? "strict" : "guide");
    });
    getPrTemplatePath()
      .then(setPath)
      .catch(() => {});
  }, []);

  const dirty = content !== baseline;

  async function save() {
    setStatus({ state: "loading", message: "" });
    try {
      await savePrTemplate(content);
      setBaseline(content);
      setStatus({ state: "success", message: "Saved" });
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
    }
  }

  async function toggleMode(next: boolean) {
    const value: PrTemplateMode = next ? "strict" : "guide";
    setMode(value);
    try {
      await setPreference("pr_template_mode", value);
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
    }
  }

  async function openFolder() {
    try {
      await revealPrTemplateDir();
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          PR Description Template
        </CardTitle>
        <CardDescription>
          Markdown template the PR Description agent uses when drafting the PR
          body in the Implement a Ticket workflow. Leave blank to let the agent
          choose its own structure.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="pr-template-mode" className="text-sm font-medium">
              Strictly enforce template
            </Label>
            <p className="text-xs text-muted-foreground max-w-md">
              {mode === "strict"
                ? "Agent must follow the template exactly — same headings, same order. Sections with no content get 'N/A'."
                : "Template is a guide — the agent follows it where it fits but may adapt or omit sections for simple PRs."}
            </p>
          </div>
          <Switch
            id="pr-template-mode"
            checked={mode === "strict"}
            onCheckedChange={toggleMode}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pr-template-content">Template</Label>
          <Textarea
            id="pr-template-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={PR_TEMPLATE_PLACEHOLDER}
            className="min-h-[320px] font-mono text-sm resize-y leading-relaxed"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={openFolder}
            className="gap-2"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Open folder
          </Button>
          <Button
            onClick={save}
            disabled={!dirty || status.state === "loading"}
            size="sm"
            className="gap-2"
          >
            {status.state === "loading" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Save
          </Button>
        </div>

        {path && (
          <p className="text-xs text-muted-foreground font-mono break-all">
            File: {path}
          </p>
        )}
        {status.state === "success" && (
          <p className="text-xs text-emerald-600 flex items-center gap-1">
            <CheckCircle className="h-3 w-3" /> {status.message}
          </p>
        )}
        {status.state === "error" && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="h-3 w-3" /> {status.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Grooming format templates section ────────────────────────────────────────

const AC_PLACEHOLDER = `- <first acceptance criterion, written as a bullet>
- <second acceptance criterion>
- <third acceptance criterion>
`;

const STR_PLACEHOLDER = `1. <first step to reproduce, on its own line>
2. <second step>
3. <third step>
`;

function GroomingTemplateEditor({
  kind,
  label,
  description,
  placeholder,
}: {
  kind: GroomingTemplateKind;
  label: string;
  description: string;
  placeholder: string;
}) {
  const [content, setContent] = useState("");
  const [baseline, setBaseline] = useState("");
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<SectionStatus>({
    state: "idle",
    message: "",
  });

  useEffect(() => {
    loadGroomingTemplate(kind)
      .then((c) => {
        setContent(c);
        setBaseline(c);
      })
      .catch(() => {});
    getGroomingTemplatePath(kind)
      .then(setPath)
      .catch(() => {});
  }, [kind]);

  const dirty = content !== baseline;

  async function save() {
    setStatus({ state: "loading", message: "" });
    try {
      await saveGroomingTemplate(kind, content);
      setBaseline(content);
      setStatus({ state: "success", message: "Saved" });
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <Label
          htmlFor={`grooming-template-${kind}`}
          className="text-sm font-medium"
        >
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Textarea
        id={`grooming-template-${kind}`}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={placeholder}
        className="min-h-[160px] font-mono text-sm resize-y leading-relaxed"
      />
      <div className="flex items-center justify-between gap-3">
        {path && (
          <p className="text-xs text-muted-foreground font-mono break-all">
            File: {path}
          </p>
        )}
        <Button
          onClick={save}
          disabled={!dirty || status.state === "loading"}
          size="sm"
          className="gap-2 ml-auto"
        >
          {status.state === "loading" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : null}
          Save
        </Button>
      </div>
      {status.state === "success" && (
        <p className="text-xs text-emerald-600 flex items-center gap-1">
          <CheckCircle className="h-3 w-3" /> {status.message}
        </p>
      )}
      {status.state === "error" && (
        <p className="text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" /> {status.message}
        </p>
      )}
    </div>
  );
}

function GroomingTemplatesSection() {
  async function openFolder() {
    try {
      await revealGroomingTemplatesDir();
    } catch {
      /* silent — same folder as PR template, surfaced there too */
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          Grooming Format Templates
        </CardTitle>
        <CardDescription>
          Formatting rules the Grooming agent follows when drafting ticket
          fields. Leave a template blank to let the agent choose its own format
          for that field.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <GroomingTemplateEditor
          kind="acceptance_criteria"
          label="Acceptance Criteria"
          description="Applied when the agent drafts or rewrites the acceptance_criteria field on Story/Task tickets."
          placeholder={AC_PLACEHOLDER}
        />
        <GroomingTemplateEditor
          kind="steps_to_reproduce"
          label="Steps to Reproduce"
          description="Applied when the agent drafts or rewrites the steps_to_reproduce field on Bug tickets."
          placeholder={STR_PLACEHOLDER}
        />
        <div className="pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={openFolder}
            className="gap-2"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Open folder
          </Button>
        </div>
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
              Replace JIRA and Bitbucket API calls with realistic local mock
              data. Useful for testing without API access. Claude still calls
              the API unless{" "}
              <span className="font-medium text-foreground">
                Mock AI responses
              </span>{" "}
              is enabled below.
            </p>
          </div>
          <Button
            variant={enabled ? "default" : "outline"}
            size="sm"
            onClick={toggle}
            className={
              enabled
                ? "bg-amber-500 hover:bg-amber-600 text-white shrink-0"
                : "shrink-0"
            }
          >
            {enabled ? "Disable" : "Enable"}
          </Button>
        </div>
        {enabled && (
          <div className="mt-3 ml-13 flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2">
            <AlertCircle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Navigate back to the landing screen to reload data sources with
              mock mode active.
            </p>
          </div>
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
              Return pre-recorded agent responses for pipelines, retros,
              workload, ticket quality, and PR review — no Anthropic API calls
              made. JIRA and Bitbucket are unaffected (enable Mock Data Mode for
              those).
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
          <div className="mt-3 ml-13 flex items-start gap-2 rounded-md bg-violet-500/10 border border-violet-500/20 px-3 py-2">
            <AlertCircle className="h-3.5 w-3.5 text-violet-600 shrink-0 mt-0.5" />
            <p className="text-xs text-violet-700 dark:text-violet-400">
              Anthropic is treated as configured while this is on. Re-run any
              workflow to see pre-recorded output.
            </p>
          </div>
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
            (new Date(sprint.endDate).getTime() - Date.now()) / 86_400_000,
          );
          lines.push(
            `  ${days > 0 ? `${days} days remaining` : "Sprint ended"}`,
          );
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
  const [activeCategory, setActiveCategory] = useState("ai");
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  // Suppress scroll-spy briefly after a click-to-scroll so the click target wins
  const suppressSpyUntil = useRef(0);

  async function refresh() {
    const s = await getCredentialStatus();
    setCredStatus(s);
  }

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

  type NavItem = { id: string; label: string; icon: React.ElementType };
  const navItems: NavItem[] = [
    { id: "ai", label: "AI", icon: Sparkles },
    ...(onNavigate
      ? [{ id: "agents", label: "Agents", icon: Bot } as NavItem]
      : []),
    { id: "integrations", label: "Integrations", icon: Link2 },
    { id: "tasks", label: "Tasks", icon: ListTodo },
    { id: "pipeline", label: "Workflows", icon: Activity },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "storage", label: "Storage", icon: HardDrive },
    { id: "time-tracking", label: "Time", icon: Clock },
    { id: "meetings", label: "Meetings", icon: NotebookPen },
    { id: "templates", label: "Templates", icon: FileText },
    { id: "development", label: "Development", icon: FlaskConical },
  ];

  // Scroll-spy: update active nav item as user scrolls
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    function onScroll() {
      if (Date.now() < suppressSpyUntil.current) return;
      const containerRect = container!.getBoundingClientRect();
      const threshold = containerRect.top + 80; // 80px from top of scroll area
      let current = navItems[0].id;
      for (const { id } of navItems) {
        const el = sectionRefs.current[id];
        if (!el) continue;
        if (el.getBoundingClientRect().top <= threshold) current = id;
      }
      setActiveCategory(current);
    }

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
    // navItems is derived from props/state that don't change after mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function scrollToSection(id: string) {
    const el = sectionRefs.current[id];
    if (!el || !scrollRef.current) return;
    setActiveCategory(id);
    suppressSpyUntil.current = Date.now() + 800;
    el.scrollIntoView({ behavior: "smooth" });
  }

  function sectionRef(id: string) {
    return (el: HTMLElement | null) => {
      sectionRefs.current[id] = el;
    };
  }

  return (
    <div className="h-screen flex flex-col">
      <header className={APP_HEADER_BAR}>
        <div className={APP_HEADER_ROW_PANEL}>
          <h1 className={cn(APP_HEADER_TITLE, "shrink-0")}>Settings</h1>
          <div className="min-w-0 flex-1" aria-hidden />
          <div className="flex shrink-0 items-center gap-1">
            <HeaderTimeTracker />
            <HeaderRecordButton />
            <HeaderSettingsButton />
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close settings"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <nav className="w-44 shrink-0 border-r flex flex-col gap-0.5 p-3 overflow-y-auto">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => scrollToSection(id)}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors text-left w-full",
                activeCategory === id
                  ? "bg-background text-foreground shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-background/60",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>

        {/* Scrollable content */}
        <main ref={scrollRef} className="flex-1 overflow-y-auto">
          {!credStatus ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-10 py-8 space-y-8">
              <section ref={sectionRef("ai")} className="space-y-4 pt-2">
                <h2 className="text-xl font-semibold text-foreground">AI</h2>
                <AnthropicSection
                  isConfigured={anthropicComplete(credStatus)}
                  onSaved={refresh}
                />
                <GeminiSection
                  isConfigured={credStatus.geminiApiKey}
                  onSaved={refresh}
                />
                <CopilotSection
                  isConfigured={credStatus.copilotApiKey}
                  onSaved={refresh}
                />
                <LocalLlmSection
                  isConfigured={credStatus.localLlmUrl}
                  onSaved={refresh}
                />
                <AiProviderSection />
                <PerPanelAiSection />
                <p className="text-xs text-muted-foreground pt-1">
                  All credentials are stored in your macOS Keychain and never
                  leave your machine. They are used exclusively in the Tauri
                  backend layer and never exposed to the UI.
                </p>
              </section>

              {onNavigate && (
                <section
                  ref={sectionRef("agents")}
                  className="space-y-4 border-t pt-8"
                >
                  <h2 className="text-xl font-semibold text-foreground">
                    Agents
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
                          Configure domain knowledge injected into AI agents —
                          grooming conventions, codebase patterns,
                          implementation standards, review criteria
                        </p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </CardContent>
                  </Card>
                </section>
              )}

              <section
                ref={sectionRef("integrations")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Integrations
                </h2>
                <JiraSection
                  isConfigured={jiraCredentialsSet(credStatus)}
                  onSaved={refresh}
                />
                <BitbucketSection
                  isConfigured={bitbucketCredentialsSet(credStatus)}
                  onSaved={refresh}
                />
                <ConfigSection
                  jiraBoardId={credStatus.jiraBoardId}
                  bitbucketRepoSlug={credStatus.bitbucketRepoSlug}
                  onSaved={refresh}
                />
                <DataTestSection fullyConfigured={fullyConfigured} />
              </section>

              <section
                ref={sectionRef("tasks")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">Tasks</h2>
                <PrTasksPollIntervalSection />
                <PrTaskFiltersSection />
              </section>

              <section
                ref={sectionRef("pipeline")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Workflows
                </h2>
                <PipelineSettingsSection />
                <PrReviewSettingsSection />
                <SprintDashboardSettingsSection />
              </section>

              <section
                ref={sectionRef("notifications")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Notifications
                </h2>
                <NotificationsSettingsSection />
              </section>

              <section
                ref={sectionRef("appearance")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Appearance
                </h2>
                <ThemeSection />
              </section>

              <section
                ref={sectionRef("storage")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Storage
                </h2>
                <DataDirectorySection />
                <CacheSection />
              </section>

              <section
                ref={sectionRef("time-tracking")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Time Tracking
                </h2>
                <TimeTrackingSection />
              </section>

              <section
                ref={sectionRef("meetings")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Meetings
                </h2>
                <MeetingsSection />
                <NoteTemplatesSection />
              </section>

              <section
                ref={sectionRef("templates")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Templates
                </h2>
                <PrTemplateSection />
                <GroomingTemplatesSection />
              </section>

              <section
                ref={sectionRef("development")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Development
                </h2>
                <MockModeSection onToggle={handleMockToggle} />
                <MockClaudeModeSection onToggle={handleMockToggle} />
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
