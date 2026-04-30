use crate::storage::credentials::get_credential;
use reqwest::Client;
use std::time::Duration;

pub fn get_local_llm_model() -> Option<String> {
    get_credential("local_llm_model").filter(|m| !m.trim().is_empty())
}

pub fn local_llm_base_url() -> Option<String> {
    get_credential("local_llm_url")
        .map(|u| u.trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty())
}

/// Build an HTTP client that does NOT enforce HTTPS — local servers run on plain HTTP.
pub fn make_local_client() -> Result<Client, String> {
    Client::builder()
        // Only time out on the initial connection, not on the response body.
        // Ollama can take many minutes to generate a long review; a total-request
        // timeout would fire mid-stream and produce "error decoding response body".
        .connect_timeout(Duration::from_secs(15))
        .danger_accept_invalid_certs(true) // self-signed certs are common
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

/// Fetch the model list from the local server via the OpenAI-compatible `/v1/models`
/// endpoint, with an Ollama-native `/api/tags` fallback.
#[tauri::command]
pub async fn get_local_models() -> Vec<(String, String)> {
    let base_url = match local_llm_base_url() {
        Some(u) => u,
        None => return vec![],
    };

    let api_key = get_credential("local_llm_api_key");
    let client = match make_local_client() {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    // ── Try OpenAI-compatible /models ─────────────────────────────────────────
    let mut req = client.get(format!("{base_url}/models"));
    if let Some(ref key) = api_key {
        if !key.is_empty() {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
    }

    if let Ok(resp) = req.send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(arr) = json["data"].as_array() {
                    let models: Vec<(String, String)> = arr
                        .iter()
                        .filter_map(|m| {
                            let id = m["id"].as_str()?;
                            Some((id.to_string(), id.to_string()))
                        })
                        .collect();
                    if !models.is_empty() {
                        return models;
                    }
                }
            }
        }
    }

    // ── Ollama fallback: try stripping /v1 suffix and hitting /api/tags ───────
    let ollama_base = base_url.trim_end_matches("/v1");
    if let Ok(resp) = client.get(format!("{ollama_base}/api/tags")).send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(arr) = json["models"].as_array() {
                    let models: Vec<(String, String)> = arr
                        .iter()
                        .filter_map(|m| {
                            let name = m["name"].as_str()?;
                            Some((name.to_string(), name.to_string()))
                        })
                        .collect();
                    if !models.is_empty() {
                        return models;
                    }
                }
            }
        }
    }

    vec![]
}

/// Test connectivity to a local LLM server and save the URL + optional key on success.
#[tauri::command]
pub async fn validate_local_llm(url: String, api_key: String) -> Result<String, String> {
    use crate::storage::credentials::store_credential;

    let base = url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Server URL cannot be empty.".to_string());
    }
    // Normalise: ensure it ends with /v1
    let base = if base.ends_with("/v1") {
        base.to_string()
    } else {
        format!("{base}/v1")
    };

    let client = make_local_client()?;
    let key_opt = if api_key.trim().is_empty() {
        None
    } else {
        Some(api_key.trim())
    };

    // Try /models first (OpenAI-compatible)
    let mut req = client.get(format!("{base}/models"));
    if let Some(k) = key_opt {
        req = req.header("Authorization", format!("Bearer {k}"));
    }

    let ok = match req.send().await {
        Ok(r) => r.status().is_success() || r.status().as_u16() == 404,
        Err(_) => {
            // Fallback: try Ollama's root endpoint
            let ollama_root = base.trim_end_matches("/v1");
            match client.get(format!("{ollama_root}/api/tags")).send().await {
                Ok(r) => r.status().is_success(),
                Err(e) => {
                    return Err(format!(
                        "Could not connect to {base}. \
                         Is the server running?\n\nError: {e}"
                    ))
                }
            }
        }
    };

    if !ok {
        return Err(format!(
            "Server at {base} responded with an unexpected error."
        ));
    }

    store_credential("local_llm_url", &base)?;
    if let Some(k) = key_opt {
        store_credential("local_llm_api_key", k)?;
    }

    Ok(format!("Connected to local LLM server at {base}."))
}

/// Test the already-stored Local LLM server URL without re-saving it.
#[tauri::command]
pub async fn test_local_llm_stored() -> Result<String, String> {
    let base = local_llm_base_url().ok_or("Local LLM server URL is not configured.")?;
    let key_opt = get_credential("local_llm_api_key").filter(|k| !k.trim().is_empty());

    let client = make_local_client()?;

    let mut req = client.get(format!("{base}/models"));
    if let Some(ref k) = key_opt {
        req = req.header("Authorization", format!("Bearer {k}"));
    }

    let ok = match req.send().await {
        Ok(r) => r.status().is_success() || r.status().as_u16() == 404,
        Err(_) => {
            // Fallback: Ollama /api/tags
            let ollama_root = base.trim_end_matches("/v1");
            match client.get(format!("{ollama_root}/api/tags")).send().await {
                Ok(r) => r.status().is_success(),
                Err(e) => {
                    return Err(format!(
                        "Could not connect to {base}. \
                     Is the server running?\n\nError: {e}"
                    ))
                }
            }
        }
    };

    if ok {
        Ok(format!("Connected to local LLM server at {base}."))
    } else {
        Err(format!(
            "Server at {base} responded with an unexpected error."
        ))
    }
}
