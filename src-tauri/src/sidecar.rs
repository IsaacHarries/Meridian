use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, Mutex};

// Dev-time path baked in at compile time — used when the resource dir is absent.
const DEV_BUNDLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../src-sidecar/dist/bundle.cjs"
);

// ── Script & node resolution ──────────────────────────────────────────────────

fn find_sidecar_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;

    // Production: Tauri copies the resource to the app's resource directory.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let prod = resource_dir.join("bundle.cjs");
        if prod.exists() {
            return Ok(prod);
        }
    }

    // Development: use the compile-time path.
    let dev = PathBuf::from(DEV_BUNDLE);
    if dev.exists() {
        return Ok(dev);
    }

    Err(format!(
        "Sidecar bundle not found. Run `npm run bundle` inside src-sidecar/. \
         (checked resource dir and {DEV_BUNDLE})"
    ))
}

fn find_node_binary() -> Result<String, String> {
    // 1. Resolve via PATH (works in dev and when PATH is set properly).
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

    // 2. Common fixed locations (Homebrew, system, Volta).
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

    // 3. NVM — pick the lexicographically latest version directory.
    if let Some(home) = dirs::home_dir() {
        let nvm_base = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_base) {
            let mut versions: Vec<_> = entries.flatten().filter(|e| e.path().is_dir()).collect();
            // Sort descending so the newest version is first.
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

// ── Protocol types ────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
struct SidecarRequest {
    id: String,
    #[serde(rename = "type")]
    req_type: &'static str,
    system: String,
    messages: Vec<Message>,
    model: String,
    cwd: String,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum SidecarOutputEvent {
    Text {
        id: String,
        delta: String,
    },
    Result {
        id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "costUsd")]
        cost_usd: f64,
        #[serde(rename = "inputTokens")]
        input_tokens: u64,
        #[serde(rename = "outputTokens")]
        output_tokens: u64,
    },
    Error {
        id: String,
        message: String,
    },
}

impl SidecarOutputEvent {
    fn id(&self) -> &str {
        match self {
            SidecarOutputEvent::Text { id, .. } => id,
            SidecarOutputEvent::Result { id, .. } => id,
            SidecarOutputEvent::Error { id, .. } => id,
        }
    }

    fn is_final(&self) -> bool {
        matches!(
            self,
            SidecarOutputEvent::Result { .. } | SidecarOutputEvent::Error { .. }
        )
    }
}

// ── State ─────────────────────────────────────────────────────────────────────

type PendingMap = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<SidecarOutputEvent>>>>;

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

// ── ID generation ─────────────────────────────────────────────────────────────

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

// ── Sidecar lifecycle ─────────────────────────────────────────────────────────

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

    eprintln!("[sidecar] spawning: {node} {}", script.display());

    let mut child: Child = tokio::process::Command::new(&node)
        .arg(&script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar ({node}): {e}"))?;

    let stdin: ChildStdin = child.stdin.take().ok_or("No stdin on sidecar process")?;
    let stdout: ChildStdout = child.stdout.take().ok_or("No stdout on sidecar process")?;

    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let pending_reader = pending.clone();
    let pending_cleanup = pending.clone();
    let stdin_arc = Arc::new(Mutex::new(BufWriter::new(stdin)));

    // Read stdout lines and route each event to its waiting channel.
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) if !line.is_empty() => {
                    match serde_json::from_str::<SidecarOutputEvent>(&line) {
                        Ok(event) => {
                            let id = event.id().to_owned();
                            let is_final = event.is_final();
                            {
                                let map = pending_reader.lock().await;
                                if let Some(tx) = map.get(&id) {
                                    let _ = tx.send(event);
                                }
                            }
                            if is_final {
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
        // Process exited — surface an error to all waiting callers.
        eprintln!("[sidecar] stdout EOF — notifying pending requests");
        let mut map = pending_cleanup.lock().await;
        for (id, tx) in map.drain() {
            let _ = tx.send(SidecarOutputEvent::Error {
                id,
                message: "Sidecar process exited unexpectedly".to_string(),
            });
        }
    });

    // Wait for child so it doesn't become a zombie, then clear state.
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
pub struct SidecarResult {
    pub text: String,
    pub session_id: String,
    pub cost_usd: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

pub async fn dispatch_sidecar(
    app: &tauri::AppHandle,
    state: &SidecarState,
    event_name: &str,
    system: String,
    messages: Vec<Message>,
    model: String,
    cwd: String,
    session_id: Option<String>,
) -> Result<SidecarResult, String> {
    use tauri::Emitter;

    let (stdin, pending) = ensure_sidecar(app, state).await?;

    let id = new_request_id();
    let (tx, mut rx) = mpsc::unbounded_channel::<SidecarOutputEvent>();
    pending.lock().await.insert(id.clone(), tx);

    let req = SidecarRequest {
        id: id.clone(),
        req_type: "query",
        system,
        messages,
        model,
        cwd,
        session_id,
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

    let mut full_text = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            SidecarOutputEvent::Text { delta, .. } => {
                full_text.push_str(&delta);
                let _ = app.emit(event_name, serde_json::json!({ "delta": delta }));
            }
            SidecarOutputEvent::Result {
                session_id,
                cost_usd,
                input_tokens,
                output_tokens,
                ..
            } => {
                return Ok(SidecarResult {
                    text: full_text,
                    session_id,
                    cost_usd,
                    input_tokens,
                    output_tokens,
                });
            }
            SidecarOutputEvent::Error { message, .. } => {
                pending.lock().await.remove(&id);
                return Err(message);
            }
        }
    }

    Err("Sidecar channel closed without a result".to_string())
}
