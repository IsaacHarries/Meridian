// IPC bridge to the TypeScript sidecar.
//
// The sidecar runs LangGraph workflows. Rust sends `workflow.start` requests
// over the sidecar's stdin and receives a stream of newline-delimited JSON
// events back over stdout. This module manages the sidecar process lifecycle,
// correlates concurrent workflow runs by id, and exposes a high-level
// `run_workflow` that drives a single run to its terminal `result`/`error`
// event while emitting intermediate progress to the Tauri frontend.
//
// Workflows can also request tool callbacks (filesystem reads/writes against
// the configured worktree). The sidecar emits `tool.callback.request`; this
// module dispatches to the existing repo Tauri commands and writes
// `tool.callback.response` back over stdin.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, Mutex};

use crate::commands::repo::{
    get_repo_diff, glob_repo_files, grep_repo_files, read_repo_file, write_repo_file,
};
use crate::storage::preferences::{ai_debug_enabled, append_ai_debug_log_line};

const DEV_BUNDLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../src-sidecar/dist/bundle.cjs"
);

// ── Script & node resolution ──────────────────────────────────────────────────

fn sidecar_node_modules_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    // Production: Tauri ships the sidecar's node_modules alongside bundle.cjs
    // in the app's resource dir.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let prod = resource_dir.join("node_modules");
        if prod.exists() {
            return Some(prod);
        }
    }
    // Development: the sidecar's node_modules sits next to its source.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src-sidecar/node_modules");
    if dev.exists() {
        return Some(dev);
    }
    None
}

fn checkpoint_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create app data dir {}: {e}", dir.display()))?;
    Ok(dir.join("meridian-checkpoints.db"))
}

fn find_sidecar_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;

    if let Ok(resource_dir) = app.path().resource_dir() {
        let prod = resource_dir.join("bundle.cjs");
        if prod.exists() {
            return Ok(prod);
        }
    }

    let dev = PathBuf::from(DEV_BUNDLE);
    if dev.exists() {
        return Ok(dev);
    }

    Err(format!(
        "Sidecar bundle not found. Run `pnpm bundle` inside src-sidecar/. \
         (checked resource dir and {DEV_BUNDLE})"
    ))
}

fn find_node_binary() -> Result<String, String> {
    let via_which = std::process::Command::new("which")
        .arg("node")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        });
    if let Some(path) = via_which {
        return Ok(path);
    }

    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/usr/local/opt/node/bin/node",
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return Ok((*c).to_string());
        }
    }

    if let Some(home) = dirs::home_dir() {
        let nvm_base = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_base) {
            let mut versions: Vec<_> = entries.flatten().filter(|e| e.path().is_dir()).collect();
            versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
            for entry in versions {
                let node = entry.path().join("bin/node");
                if node.exists() {
                    return Ok(node.to_string_lossy().into_owned());
                }
            }
        }
    }

    Err("Cannot find a Node.js binary. \
         Install Node.js via Homebrew (`brew install node`) or nvm."
        .to_string())
}

// ── Protocol types (mirror src-sidecar/src/protocol.ts) ───────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "provider")]
#[serde(rename_all = "lowercase")]
pub enum ProviderCredentials {
    Anthropic(AnthropicCreds),
    Google(GoogleCreds),
    Copilot(CopilotCreds),
    Ollama(OllamaCreds),
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "mode")]
pub enum AnthropicCreds {
    #[serde(rename = "api_key")]
    ApiKey {
        #[serde(rename = "apiKey")]
        api_key: String,
    },
    #[serde(rename = "oauth")]
    OAuth {
        #[serde(rename = "accessToken")]
        access_token: String,
    },
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "mode")]
pub enum GoogleCreds {
    #[serde(rename = "api_key")]
    ApiKey {
        #[serde(rename = "apiKey")]
        api_key: String,
    },
    #[serde(rename = "oauth")]
    OAuth {
        #[serde(rename = "accessToken")]
        access_token: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        project: Option<String>,
    },
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "mode")]
pub enum CopilotCreds {
    #[serde(rename = "oauth")]
    OAuth {
        #[serde(rename = "accessToken")]
        access_token: String,
    },
}

#[derive(Serialize, Clone, Debug)]
pub struct OllamaCreds {
    #[serde(rename = "baseUrl")]
    pub base_url: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ModelSelection {
    pub provider: String,
    pub model: String,
    pub credentials: ProviderCredentials,
    /// Per-provider response-token ceiling. Resolved from the user's
    /// preferences (Settings → Models → "Max output tokens"). Skipped
    /// from JSON serialisation when None so the sidecar's adapter
    /// defaults stay in charge for unset values.
    #[serde(rename = "maxTokens", skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Serialize)]
struct WorkflowStartRequest<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    msg_type: &'static str,
    workflow: &'a str,
    input: serde_json::Value,
    model: &'a ModelSelection,
    #[serde(rename = "worktreePath", skip_serializing_if = "Option::is_none")]
    worktree_path: Option<String>,
    /// Asks the sidecar to attach its AI-traffic capture handler so each
    /// model round-trip emits an `ai_traffic` event back to the frontend's
    /// debug panel. Skipped on the wire when false to keep ordinary runs
    /// uncluttered.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    debug: bool,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarOutboundEvent {
    Progress {
        id: String,
        node: String,
        status: String,
        #[serde(default)]
        data: Option<serde_json::Value>,
    },
    Stream {
        id: String,
        node: String,
        delta: String,
    },
    Interrupt {
        id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        reason: String,
        #[serde(default)]
        payload: serde_json::Value,
    },
    Result {
        id: String,
        output: serde_json::Value,
        usage: SidecarUsage,
    },
    Error {
        id: String,
        message: String,
        #[serde(default)]
        cause: Option<serde_json::Value>,
    },
    #[serde(rename = "tool.callback.request")]
    ToolCallbackRequest {
        id: String,
        #[serde(rename = "callbackId")]
        callback_id: String,
        tool: String,
        input: serde_json::Value,
    },
    AiTraffic {
        id: String,
        #[serde(flatten)]
        payload: serde_json::Value,
    },
}

#[derive(Deserialize, Debug, Clone, Serialize, Default)]
pub struct SidecarUsage {
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    /// Anthropic prompt-cache breakdown (subset of `input_tokens`).
    /// Tokens billed at 1.25x because they wrote the cache. Optional —
    /// present only on workflows that opt into prompt caching (the
    /// implementation pipeline's orchestrator at time of writing); zero
    /// for the rest and for non-Anthropic providers.
    #[serde(
        rename = "cacheCreationInputTokens",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub cache_creation_input_tokens: Option<u64>,
    /// Anthropic prompt-cache breakdown (subset of `input_tokens`).
    /// Tokens billed at 0.1x because they came from a cache hit.
    #[serde(
        rename = "cacheReadInputTokens",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub cache_read_input_tokens: Option<u64>,
}

impl SidecarOutboundEvent {
    fn id(&self) -> &str {
        match self {
            Self::Progress { id, .. }
            | Self::Stream { id, .. }
            | Self::Interrupt { id, .. }
            | Self::Result { id, .. }
            | Self::Error { id, .. }
            | Self::ToolCallbackRequest { id, .. }
            | Self::AiTraffic { id, .. } => id,
        }
    }

    fn is_terminal(&self) -> bool {
        matches!(self, Self::Result { .. } | Self::Error { .. })
    }
}

// ── Process lifecycle ─────────────────────────────────────────────────────────

type PendingMap = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<SidecarOutboundEvent>>>>;

struct SidecarProcess {
    stdin: Arc<Mutex<BufWriter<ChildStdin>>>,
    pending: PendingMap,
}

pub struct SidecarState(Arc<Mutex<Option<SidecarProcess>>>);

impl SidecarState {
    pub fn new() -> Self {
        SidecarState(Arc::new(Mutex::new(None)))
    }
}

fn new_request_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64;
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{ts:016x}{seq:016x}")
}

async fn ensure_sidecar(
    app: &tauri::AppHandle,
    state: &SidecarState,
) -> Result<(Arc<Mutex<BufWriter<ChildStdin>>>, PendingMap), String> {
    let mut guard = state.0.lock().await;
    if let Some(proc) = guard.as_ref() {
        return Ok((proc.stdin.clone(), proc.pending.clone()));
    }

    let node = find_node_binary()?;
    let script = find_sidecar_script(app)?;

    // Persistent checkpointer for interruptible workflows (the implementation
    // pipeline). Place the DB inside Tauri's app data dir so it survives
    // restarts but stays out of the user's homedir.
    let checkpoint_db = checkpoint_db_path(app)?;

    // The sidecar bundle externalises native modules (better-sqlite3 etc.) so
    // they aren't bundled into the .cjs blob. Node must be able to resolve
    // them from the sidecar's node_modules, which lives alongside the bundle
    // source in dev (src-sidecar/) but is mirrored into the Tauri resource
    // dir in production. Set NODE_PATH so the runtime require() succeeds
    // regardless of where the script actually lives.
    let node_path = sidecar_node_modules_path(app);

    eprintln!(
        "[sidecar] spawning: {node} {} (checkpoint db: {}, NODE_PATH: {})",
        script.display(),
        checkpoint_db.display(),
        node_path.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "<unset>".to_string()),
    );

    let mut command = tokio::process::Command::new(&node);
    command
        .arg(&script)
        .env("MERIDIAN_CHECKPOINT_DB", &checkpoint_db)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit());
    if let Some(p) = &node_path {
        command.env("NODE_PATH", p);
    }
    let mut child: Child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar ({node}): {e}"))?;

    let stdin: ChildStdin = child.stdin.take().ok_or("No stdin on sidecar process")?;
    let stdout: ChildStdout = child.stdout.take().ok_or("No stdout on sidecar process")?;

    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let pending_reader = pending.clone();
    let pending_cleanup = pending.clone();
    let stdin_arc = Arc::new(Mutex::new(BufWriter::new(stdin)));

    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) if !line.is_empty() => {
                    match serde_json::from_str::<SidecarOutboundEvent>(&line) {
                        Ok(event) => {
                            let id = event.id().to_owned();
                            let is_terminal = event.is_terminal();
                            {
                                let map = pending_reader.lock().await;
                                if let Some(tx) = map.get(&id) {
                                    let _ = tx.send(event);
                                }
                            }
                            if is_terminal {
                                pending_reader.lock().await.remove(&id);
                            }
                        }
                        Err(e) => {
                            eprintln!("[sidecar] parse error: {e} — {line}");
                        }
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        eprintln!("[sidecar] stdout EOF — notifying pending requests");
        let mut map = pending_cleanup.lock().await;
        for (id, tx) in map.drain() {
            let _ = tx.send(SidecarOutboundEvent::Error {
                id,
                message: "Sidecar process exited unexpectedly".to_string(),
                cause: None,
            });
        }
    });

    let state_arc = state.0.clone();
    tokio::spawn(async move {
        let _ = child.wait().await;
        eprintln!("[sidecar] child process exited");
        *state_arc.lock().await = None;
    });

    let proc = SidecarProcess {
        stdin: stdin_arc.clone(),
        pending: pending.clone(),
    };
    *guard = Some(proc);

    Ok((stdin_arc, pending))
}

// ── Public API ────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct WorkflowInterrupt {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub reason: String,
    pub payload: serde_json::Value,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct WorkflowResult {
    /// Final output when the workflow completed. None when paused at an
    /// interrupt (workflows without interrupts always populate this).
    pub output: Option<serde_json::Value>,
    /// Set when the workflow paused at a human checkpoint. The frontend
    /// uses `thread_id` + the resume command to continue the run.
    pub interrupt: Option<WorkflowInterrupt>,
    pub usage: SidecarUsage,
}

impl WorkflowResult {
    fn from_output(output: serde_json::Value, usage: SidecarUsage) -> Self {
        Self {
            output: Some(output),
            interrupt: None,
            usage,
        }
    }

    fn from_interrupt(interrupt: WorkflowInterrupt, usage: SidecarUsage) -> Self {
        Self {
            output: None,
            interrupt: Some(interrupt),
            usage,
        }
    }
}

// ── Tool callback dispatch ────────────────────────────────────────────────────

async fn execute_tool_callback(
    tool: &str,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let take_str = |obj: &serde_json::Value, key: &str| -> Result<String, String> {
        obj.get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("Tool '{tool}' missing required '{key}' (string)"))
    };

    match tool {
        "glob_repo_files" => {
            let pattern = take_str(&input, "pattern")?;
            let files = glob_repo_files(pattern).await?;
            Ok(serde_json::json!({ "files": files }))
        }
        "grep_repo_files" => {
            let pattern = take_str(&input, "pattern")?;
            let path = input
                .get("path")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let matches = grep_repo_files(pattern, path).await?;
            Ok(serde_json::json!({ "matches": matches }))
        }
        "read_repo_file" => {
            let path = take_str(&input, "path")?;
            let contents = read_repo_file(path).await?;
            Ok(serde_json::json!({ "contents": contents }))
        }
        "stat_repo_file" => {
            let path = take_str(&input, "path")?;
            let stat = crate::commands::repo::stat_repo_file_internal(&path)?;
            Ok(serde_json::json!({
                "exists": stat.exists,
                "sizeBytes": stat.size_bytes,
            }))
        }
        "write_repo_file" => {
            let path = take_str(&input, "path")?;
            let content = take_str(&input, "content")?;
            write_repo_file(path, content).await?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "get_repo_diff" => {
            let diff = get_repo_diff().await?;
            Ok(serde_json::json!({ "diff": diff }))
        }
        "exec_in_worktree" => {
            let command = take_str(&input, "command")?;
            let timeout_secs = input
                .get("timeoutSecs")
                .and_then(|v| v.as_u64())
                .unwrap_or(180);
            let (exit_code, output) =
                crate::commands::repo::exec_in_worktree_internal(&command, timeout_secs)
                    .await?;
            Ok(serde_json::json!({
                "exitCode": exit_code,
                "output": output,
            }))
        }
        // Pseudo-tool: re-resolve provider credentials from the keychain,
        // refreshing OAuth tokens as needed. Long-running tool loops (e.g.
        // implementation iterating per file) call this between iterations
        // so the access token doesn't expire mid-stage.
        "refresh_credentials" => {
            let provider = take_str(&input, "provider")?;
            let creds = crate::commands::workflows::resolve_credentials(&provider).await?;
            serde_json::to_value(&creds)
                .map_err(|e| format!("Failed to serialise refreshed credentials: {e}"))
        }
        // Pseudo-tool: re-resolve the *entire* ModelSelection (provider +
        // model name + fresh credentials) for a given panel/stage context.
        // Used so long-running stages pick up provider/model changes the user
        // makes via the header dropdown without restarting the workflow.
        "refresh_model" => {
            use crate::agents::dispatch::AiContext;
            let panel = take_str(&input, "panel")?;
            let stage = input
                .get("stage")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let ctx = match stage {
                Some(s) => AiContext::stage(&panel, &s),
                None => AiContext::panel(&panel),
            };
            let model = crate::commands::workflows::resolve_model_for_context(&ctx).await?;
            serde_json::to_value(&model)
                .map_err(|e| format!("Failed to serialise refreshed model: {e}"))
        }
        other => Err(format!("Unknown tool: {other}")),
    }
}

async fn write_callback_response(
    stdin: &Arc<Mutex<BufWriter<ChildStdin>>>,
    workflow_id: &str,
    callback_id: &str,
    result: Result<serde_json::Value, String>,
) {
    let payload = match result {
        Ok(v) => serde_json::json!({
            "id": workflow_id,
            "type": "tool.callback.response",
            "callbackId": callback_id,
            "result": v,
        }),
        Err(err) => serde_json::json!({
            "id": workflow_id,
            "type": "tool.callback.response",
            "callbackId": callback_id,
            "error": err,
        }),
    };
    let mut line = serde_json::to_string(&payload).unwrap_or_default();
    line.push('\n');
    let mut w = stdin.lock().await;
    if let Err(e) = w.write_all(line.as_bytes()).await {
        eprintln!("[sidecar] failed to write tool.callback.response: {e}");
        return;
    }
    if let Err(e) = w.flush().await {
        eprintln!("[sidecar] failed to flush tool.callback.response: {e}");
    }
}

#[derive(Serialize)]
struct WorkflowResumeRequest<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    msg_type: &'static str,
    #[serde(rename = "threadId")]
    thread_id: &'a str,
    #[serde(rename = "resumeValue")]
    resume_value: &'a serde_json::Value,
    /// When present, the sidecar overwrites `state.model` with this before
    /// invoking the graph. Used to refresh OAuth credentials on long runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<&'a ModelSelection>,
    /// Mirrors WorkflowStartRequest.debug — capture is per-invocation
    /// because each resume creates a fresh AsyncLocalStorage scope.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    debug: bool,
}

#[derive(Serialize)]
struct WorkflowRewindRequest<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    msg_type: &'static str,
    #[serde(rename = "threadId")]
    thread_id: &'a str,
    #[serde(rename = "toNode")]
    to_node: &'a str,
    /// When present, the sidecar overwrites `state.model` with this before
    /// invoking the graph. Used to refresh OAuth credentials on long runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<&'a ModelSelection>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    debug: bool,
}

#[derive(Serialize)]
struct WorkflowCancelRequest<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    msg_type: &'static str,
}

/// Cancel an in-flight workflow run. Aborts the AbortController in the
/// sidecar's `activeRuns` registry and removes the pending channel on the
/// Rust side so any further events from the (potentially still-running)
/// model call are discarded. The model call itself isn't guaranteed to
/// halt — LangChain providers don't all honour AbortSignal — but the
/// sidecar stops emitting events for the run once aborted, so the
/// frontend won't see any more output from this `run_id`. No-op if the
/// run already finished.
pub async fn cancel_workflow(
    state: &SidecarState,
    run_id: String,
) -> Result<(), String> {
    let stdin_arc = {
        let guard = state.0.lock().await;
        match guard.as_ref() {
            Some(p) => p.stdin.clone(),
            // Sidecar isn't running — nothing to cancel.
            None => return Ok(()),
        }
    };

    let req = WorkflowCancelRequest {
        id: &run_id,
        msg_type: "workflow.cancel",
    };
    let mut line = serde_json::to_string(&req).map_err(|e| format!("Serialize error: {e}"))?;
    line.push('\n');

    let mut w = stdin_arc.lock().await;
    w.write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Stdin write error: {e}"))?;
    w.flush()
        .await
        .map_err(|e| format!("Stdin flush error: {e}"))?;
    Ok(())
}

/// Rewind a paused workflow to the checkpoint just before `to_node` ran,
/// then resume forward. Same return shape as `run_workflow`. `model` (when
/// supplied) refreshes the workflow's model selection — used to keep OAuth
/// tokens fresh on long runs.
pub async fn rewind_workflow(
    app: &tauri::AppHandle,
    state: &SidecarState,
    event_name: &str,
    thread_id: String,
    to_node: String,
    model: Option<ModelSelection>,
    run_id: Option<String>,
) -> Result<WorkflowResult, String> {
    let (stdin, pending) = ensure_sidecar(app, state).await?;

    let id = run_id.unwrap_or_else(new_request_id);
    let (tx, mut rx) = mpsc::unbounded_channel::<SidecarOutboundEvent>();
    pending.lock().await.insert(id.clone(), tx);

    let req = WorkflowRewindRequest {
        id: &id,
        msg_type: "workflow.rewind",
        thread_id: &thread_id,
        to_node: &to_node,
        model: model.as_ref(),
        debug: ai_debug_enabled(),
    };
    let mut line = serde_json::to_string(&req).map_err(|e| format!("Serialize error: {e}"))?;
    line.push('\n');

    {
        let mut w = stdin.lock().await;
        w.write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Stdin write error: {e}"))?;
        w.flush()
            .await
            .map_err(|e| format!("Stdin flush error: {e}"))?;
    }

    drive_workflow_loop(app, &stdin, &pending, &id, event_name, &mut rx).await
}

/// Resume a paused workflow. Same return shape as `run_workflow`; emits
/// either the next `interrupt` (if the resume hits another checkpoint) or
/// the final `result`. `model` (when supplied) refreshes the workflow's
/// model selection — used to keep OAuth tokens fresh on long runs.
pub async fn resume_workflow(
    app: &tauri::AppHandle,
    state: &SidecarState,
    event_name: &str,
    thread_id: String,
    resume_value: serde_json::Value,
    model: Option<ModelSelection>,
    run_id: Option<String>,
) -> Result<WorkflowResult, String> {
    let (stdin, pending) = ensure_sidecar(app, state).await?;

    let id = run_id.unwrap_or_else(new_request_id);
    let (tx, mut rx) = mpsc::unbounded_channel::<SidecarOutboundEvent>();
    pending.lock().await.insert(id.clone(), tx);

    let req = WorkflowResumeRequest {
        id: &id,
        msg_type: "workflow.resume",
        thread_id: &thread_id,
        resume_value: &resume_value,
        model: model.as_ref(),
        debug: ai_debug_enabled(),
    };
    let mut line = serde_json::to_string(&req).map_err(|e| format!("Serialize error: {e}"))?;
    line.push('\n');

    {
        let mut w = stdin.lock().await;
        w.write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Stdin write error: {e}"))?;
        w.flush()
            .await
            .map_err(|e| format!("Stdin flush error: {e}"))?;
    }

    drive_workflow_loop(app, &stdin, &pending, &id, event_name, &mut rx).await
}

/// Run a workflow to completion. Streams progress / stream-delta events to
/// `event_name` on the Tauri frontend; returns the final `result` payload or
/// the first `error`. Tool callback requests from the sidecar are dispatched
/// to the existing repo commands and answered over stdin.
pub async fn run_workflow(
    app: &tauri::AppHandle,
    state: &SidecarState,
    event_name: &str,
    workflow: &str,
    input: serde_json::Value,
    model: ModelSelection,
    worktree_path: Option<String>,
    run_id: Option<String>,
) -> Result<WorkflowResult, String> {
    let (stdin, pending) = ensure_sidecar(app, state).await?;

    // Caller-supplied runId lets the frontend track which run a stream of
    // Tauri events came from, so it can drop stale events from a prior
    // run that the user cancelled / rewound past.
    let id = run_id.unwrap_or_else(new_request_id);
    let (tx, mut rx) = mpsc::unbounded_channel::<SidecarOutboundEvent>();
    pending.lock().await.insert(id.clone(), tx);

    let req = WorkflowStartRequest {
        id: &id,
        msg_type: "workflow.start",
        workflow,
        input,
        model: &model,
        worktree_path,
        debug: ai_debug_enabled(),
    };
    let mut line = serde_json::to_string(&req).map_err(|e| format!("Serialize error: {e}"))?;
    line.push('\n');

    {
        let mut w = stdin.lock().await;
        w.write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Stdin write error: {e}"))?;
        w.flush()
            .await
            .map_err(|e| format!("Stdin flush error: {e}"))?;
    }

    drive_workflow_loop(app, &stdin, &pending, &id, event_name, &mut rx).await
}

async fn drive_workflow_loop(
    app: &tauri::AppHandle,
    stdin: &Arc<Mutex<BufWriter<ChildStdin>>>,
    pending: &PendingMap,
    id: &str,
    event_name: &str,
    rx: &mut mpsc::UnboundedReceiver<SidecarOutboundEvent>,
) -> Result<WorkflowResult, String> {
    while let Some(event) = rx.recv().await {
        match event {
            SidecarOutboundEvent::Progress {
                node,
                status,
                data,
                ..
            } => {
                // Rate-limit snapshots ride on the workflow's progress
                // channel (sidecar emits them as a side-effect of any
                // Anthropic OAuth response), but the consumer is a
                // global UI element (HeaderModelPicker bars). Mirror
                // them onto a dedicated channel so a single boot-time
                // listener catches updates regardless of which workflow
                // is in flight — without this, only stores that listen
                // on the originating workflow's channel see them, and
                // the orchestrator chat path leaves the bars empty.
                if let Some(rate_limits) =
                    data.as_ref().and_then(|d| d.get("rateLimits"))
                {
                    let _ = app.emit("ai-rate-limit-event", rate_limits.clone());
                }
                let _ = app.emit(
                    event_name,
                    serde_json::json!({
                        "kind": "progress",
                        "runId": id,
                        "node": node,
                        "status": status,
                        "data": data,
                    }),
                );
            }
            SidecarOutboundEvent::Stream { node, delta, .. } => {
                let _ = app.emit(
                    event_name,
                    serde_json::json!({
                        "kind": "stream",
                        "runId": id,
                        "node": node,
                        "delta": delta,
                    }),
                );
            }
            SidecarOutboundEvent::Interrupt {
                thread_id,
                reason,
                payload,
                ..
            } => {
                let _ = app.emit(
                    event_name,
                    serde_json::json!({
                        "kind": "interrupt",
                        "runId": id,
                        "threadId": thread_id,
                        "reason": reason,
                        "payload": payload,
                    }),
                );
                pending.lock().await.remove(id);
                return Ok(WorkflowResult::from_interrupt(
                    WorkflowInterrupt {
                        thread_id,
                        reason,
                        payload,
                    },
                    SidecarUsage::default(),
                ));
            }
            SidecarOutboundEvent::ToolCallbackRequest {
                id: req_id,
                callback_id,
                tool,
                input,
            } => {
                let stdin_clone = stdin.clone();
                tokio::spawn(async move {
                    let result = execute_tool_callback(&tool, input).await;
                    write_callback_response(&stdin_clone, &req_id, &callback_id, result).await;
                });
            }
            SidecarOutboundEvent::Result { output, usage, .. } => {
                return Ok(WorkflowResult::from_output(output, usage));
            }
            SidecarOutboundEvent::Error { message, .. } => {
                pending.lock().await.remove(id);
                return Err(message);
            }
            SidecarOutboundEvent::AiTraffic { payload, .. } => {
                // Broadcast on a single shared event channel rather than the
                // per-workflow one — the debug panel listens once and sees
                // every workflow's traffic without subscribing to each
                // event_name separately. The runId is already inside the
                // payload so the panel can attribute each row to its run.
                let mut envelope = payload;
                if let Some(obj) = envelope.as_object_mut() {
                    obj.insert(
                        "runId".to_string(),
                        serde_json::Value::String(id.to_string()),
                    );
                }
                // Mirror to the on-disk JSONL log when capture is on, so
                // Claude Code (or any external tailer / grep) can read it
                // out-of-band. The renderer's debug panel still works the
                // same; the file is purely a passive sink.
                if let Ok(line) = serde_json::to_string(&envelope) {
                    append_ai_debug_log_line(&line);
                }
                let _ = app.emit("ai-traffic-event", envelope);
            }
        }
    }

    Err("Sidecar channel closed without a terminal event".to_string())
}
