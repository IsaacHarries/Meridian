// Ollama embeddings client used by the cross-meeting search index.
//
// Goes through Ollama's native /api/embeddings (or the newer
// /api/embed batch endpoint) rather than the OpenAI-compat shim
// because Ollama's compat layer doesn't expose embeddings on every
// build, while the native endpoint is stable across versions.
//
// All callers in this app are background tasks (the backfill loop or
// search-time query-vector computation) so failures are non-fatal —
// callers retry on the next tick.

use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::integrations::ai_traffic::{
    emit_event, new_run_id, now_ms, AiTrafficEvent, AiTrafficMessage, AiTrafficUsage,
};
use crate::llms::local_llm::{local_llm_base_url, make_local_client};

/// Coarse status used by the backfill loop and the Settings UI to
/// decide whether to attempt embeddings on this tick / show the user
/// a warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OllamaStatus {
    /// Server reachable AND the requested model is loaded / pullable.
    Available,
    /// Server unreachable — either Ollama isn't running, the URL is
    /// wrong, or the user hasn't configured one yet.
    Unreachable,
    /// Server reachable but the requested model isn't installed. The
    /// backfill loop sleeps; the user gets a "run `ollama pull X`"
    /// hint in Settings.
    ModelMissing,
    /// User hasn't configured a local LLM URL at all.
    NotConfigured,
}

#[derive(Serialize, Clone, Debug)]
pub struct OllamaProbe {
    pub status: OllamaStatus,
    /// Whichever model the user picked in preferences (or the default).
    pub model: String,
    /// Embedding dimensionality discovered during the probe — `None`
    /// if the probe didn't reach a successful embedding call.
    pub dimensions: Option<usize>,
    /// Human-readable message for the Settings UI when status is not
    /// Available — e.g. the underlying error or "model not found".
    pub message: Option<String>,
}

/// Default model — chosen for English-language meeting transcripts at
/// reasonable size (768 dims). Users can override via Settings.
pub const DEFAULT_EMBEDDING_MODEL: &str = "nomic-embed-text";

fn embedding_client() -> Result<Client, String> {
    Client::builder()
        // Embedding calls should be fast (<1s typical) but on a cold
        // model load Ollama might take several seconds to warm up.
        // Generous read timeout, modest connect timeout.
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

/// Single-embedding request body. Both /api/embeddings (singular) and
/// /api/embed (batch) accept this shape; we use the batch endpoint for
/// the backfill loop and the singular for one-off query embeddings.
#[derive(Serialize)]
struct OllamaEmbedRequest<'a> {
    model: &'a str,
    /// Singular endpoint expects `prompt`; batch endpoint expects `input`.
    /// We send both — Ollama ignores unknown fields, so this works for
    /// either endpoint without branching on Ollama version.
    prompt: &'a str,
    input: &'a [&'a str],
}

#[derive(Deserialize)]
struct OllamaSingleEmbedResponse {
    /// /api/embeddings (legacy): returns one vector under `embedding`.
    embedding: Option<Vec<f32>>,
    /// /api/embed (new): returns a batch under `embeddings`.
    embeddings: Option<Vec<Vec<f32>>>,
}

/// Embed one string with debug traffic capture. Use this from caller
/// sites that you want surfaced in the AI debug panel (the embedding
/// backfill loop, the search-time query embed). The probe path uses
/// the un-traced `embed_text` so probe noise doesn't drown out the
/// actual workload in the debug feed.
pub async fn embed_text_traced(
    text: &str,
    model: &str,
    workflow: &str,
    node: &str,
) -> Result<Vec<f32>, String> {
    let started_at = now_ms();
    let result = embed_text(text, model).await;
    let latency_ms = now_ms() - started_at;
    // Render a brief shape descriptor as the "response" so the panel
    // shows something meaningful — full vectors are useless to skim.
    let (response, error) = match &result {
        Ok(v) => (
            format!(
                "<vector: {} dims, norm={:.3}>",
                v.len(),
                v.iter().map(|x| x * x).sum::<f32>().sqrt()
            ),
            None,
        ),
        Err(e) => (String::new(), Some(e.clone())),
    };
    emit_event(AiTrafficEvent {
        event_type: "ai_traffic",
        id: new_run_id(),
        run_id: format!("embed-{started_at}"),
        started_at,
        latency_ms,
        provider: "ollama".to_string(),
        model: model.to_string(),
        workflow: workflow.to_string(),
        node: Some(node.to_string()),
        messages: vec![AiTrafficMessage {
            role: "user".to_string(),
            content: text.to_string(),
        }],
        response,
        // Ollama's embed endpoint doesn't return token counts, but we
        // can give a rough character-count proxy so the badge has
        // something useful to display.
        usage: AiTrafficUsage {
            input_tokens: text.chars().count() as i64 / 4,
            output_tokens: 0,
        },
        error,
    });
    result
}

/// Embed one string. Returns the vector + the model that produced it
/// so the caller can persist both — embeddings from different models
/// are not comparable.
pub async fn embed_text(text: &str, model: &str) -> Result<Vec<f32>, String> {
    let base = local_llm_base_url().ok_or_else(|| "Ollama URL not configured".to_string())?;
    let client = make_local_client().or_else(|_| embedding_client())?;
    // Strip any /v1 the user may have added — embeddings sit at the
    // root of Ollama's API surface, not behind the OpenAI-compat shim.
    let root = base.trim_end_matches("/v1").trim_end_matches('/').to_string();
    let body = OllamaEmbedRequest {
        model,
        prompt: text,
        input: &[text],
    };
    // Try the new batch endpoint first (Ollama ≥ 0.1.32). On 404 the
    // server is older and we fall through to /api/embeddings.
    let new_url = format!("{root}/api/embed");
    let resp = client.post(&new_url).json(&body).send().await.map_err(|e| {
        format!("Ollama embed request failed: {e}")
    })?;
    let parsed: OllamaSingleEmbedResponse = if resp.status().is_success() {
        resp.json().await.map_err(|e| e.to_string())?
    } else if resp.status() == reqwest::StatusCode::NOT_FOUND {
        let legacy_url = format!("{root}/api/embeddings");
        let resp2 = client
            .post(&legacy_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Ollama embed request failed: {e}"))?;
        if !resp2.status().is_success() {
            return Err(format!(
                "Ollama embed returned {}: {}",
                resp2.status(),
                resp2.text().await.unwrap_or_default()
            ));
        }
        resp2.json().await.map_err(|e| e.to_string())?
    } else {
        return Err(format!(
            "Ollama embed returned {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    };

    // Pull the vector out of whichever shape the server returned.
    if let Some(mut batch) = parsed.embeddings {
        if let Some(v) = batch.pop() {
            return Ok(v);
        }
    }
    if let Some(v) = parsed.embedding {
        return Ok(v);
    }
    Err("Ollama returned no embedding".to_string())
}

/// Probe Ollama for liveness + model availability. Used by the
/// backfill loop (gates whether we attempt embeddings on this tick)
/// and Settings (renders the indicator).
pub async fn probe_ollama(model: &str) -> OllamaProbe {
    let configured_url = local_llm_base_url();
    let url = match configured_url {
        Some(u) => u,
        None => {
            return OllamaProbe {
                status: OllamaStatus::NotConfigured,
                model: model.to_string(),
                dimensions: None,
                message: Some("Local LLM URL not set in Settings".to_string()),
            };
        }
    };

    // Step 1: can we reach the server at all?
    let client = match embedding_client() {
        Ok(c) => c,
        Err(_) => {
            return OllamaProbe {
                status: OllamaStatus::Unreachable,
                model: model.to_string(),
                dimensions: None,
                message: Some("Could not build HTTP client".to_string()),
            };
        }
    };
    let root = url.trim_end_matches("/v1").trim_end_matches('/').to_string();
    let tags_url = format!("{root}/api/tags");
    let resp = match client.get(&tags_url).send().await {
        Ok(r) => r,
        Err(e) => {
            return OllamaProbe {
                status: OllamaStatus::Unreachable,
                model: model.to_string(),
                dimensions: None,
                message: Some(format!("Cannot reach Ollama at {root}: {e}")),
            };
        }
    };

    if !resp.status().is_success() {
        return OllamaProbe {
            status: OllamaStatus::Unreachable,
            model: model.to_string(),
            dimensions: None,
            message: Some(format!("Ollama tags endpoint returned {}", resp.status())),
        };
    }

    // Step 2: does it have the model?
    #[derive(Deserialize)]
    struct TagsResp {
        models: Vec<TagModel>,
    }
    #[derive(Deserialize)]
    struct TagModel {
        name: String,
    }
    let tags: TagsResp = match resp.json().await {
        Ok(t) => t,
        Err(_) => {
            return OllamaProbe {
                status: OllamaStatus::Unreachable,
                model: model.to_string(),
                dimensions: None,
                message: Some("Could not parse Ollama tags response".to_string()),
            };
        }
    };
    let has_model = tags
        .models
        .iter()
        .any(|m| m.name == model || m.name.starts_with(&format!("{model}:")));
    if !has_model {
        return OllamaProbe {
            status: OllamaStatus::ModelMissing,
            model: model.to_string(),
            dimensions: None,
            message: Some(format!(
                "Model '{model}' not installed. Run: ollama pull {model}"
            )),
        };
    }

    // Step 3: actually embed a tiny string to verify the model
    // produces vectors and capture dimensionality. A failure here
    // typically means the model isn't an embedding model (e.g. user
    // picked llama3 by mistake).
    match embed_text("ok", model).await {
        Ok(v) => OllamaProbe {
            status: OllamaStatus::Available,
            model: model.to_string(),
            dimensions: Some(v.len()),
            message: None,
        },
        Err(e) => OllamaProbe {
            status: OllamaStatus::ModelMissing,
            model: model.to_string(),
            dimensions: None,
            message: Some(format!("Model present but embed failed: {e}")),
        },
    }
}

/// Tauri command — read by Settings to render the status indicator
/// and by the search command to decide whether to attempt the
/// semantic-search half of hybrid retrieval.
#[tauri::command]
pub async fn probe_ollama_cmd(model: Option<String>) -> OllamaProbe {
    let m = model
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_EMBEDDING_MODEL.to_string());
    probe_ollama(&m).await
}
