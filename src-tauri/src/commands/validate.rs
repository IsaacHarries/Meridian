use reqwest::{Client, StatusCode};
use std::time::Duration;

use super::credentials::{get_credential, store_credential};
use crate::http::make_corporate_client;

fn make_client() -> Result<Client, String> {
    make_corporate_client(Duration::from_secs(10))
}

/// Validate an Anthropic API key. Saves the key immediately, then tests
/// connectivity. If api.anthropic.com is blocked by a corporate firewall,
/// returns a warning (not an error) so the user can still proceed.
#[tauri::command]
pub async fn validate_anthropic(api_key: String) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("API key cannot be empty.".to_string());
    }
    store_credential("anthropic_api_key", api_key.trim())?;
    store_credential("claude_auth_method", "api_key")?;
    test_anthropic_connectivity(api_key.trim(), true).await
}

/// Test the already-stored Anthropic key without accepting it from the frontend.
/// Unlike validate_anthropic, this returns an error if the network is unreachable —
/// the user explicitly asked to test the connection.
#[tauri::command]
pub async fn test_anthropic_stored() -> Result<String, String> {
    let auth_method = get_credential("claude_auth_method")
        .unwrap_or_else(|| "api_key".to_string());

    if auth_method == "oauth" {
        // Sidecar path — verify the claude CLI is still present and logged in.
        let user = std::env::var("USER").unwrap_or_else(|_| "claude".to_string());
        let output = std::process::Command::new("security")
            .args(["find-generic-password", "-a", &user, "-s", "Claude Code", "-w"])
            .output()
            .map_err(|e| format!("Keychain lookup failed: {e}"))?;

        let found = output.status.success()
            && !String::from_utf8_lossy(&output.stdout).trim().is_empty();

        return if found {
            Ok("Claude Code login confirmed. Meridian is using your Claude Pro / Max \
                subscription via the claude CLI sidecar."
                .to_string())
        } else {
            Err("Claude Code login not found. Run `claude` in a terminal and log in \
                 again, then re-import."
                .to_string())
        };
    }

    let key = get_credential("anthropic_api_key")
        .ok_or("No Anthropic API key is stored. Save a key first.")?;
    test_anthropic_connectivity(&key, false).await
}

/// Verify that the Claude Code CLI is logged in and enable the sidecar auth path.
///
/// The sidecar spawns the system `claude` binary which authenticates via its own
/// session in `~/.claude/` — Meridian never holds or transmits the credential.
/// This command just confirms login is present, then sets `claude_auth_method = "oauth"`
/// so all AI calls are routed through the sidecar instead of the API key path.
#[tauri::command]
pub async fn import_claude_pro_token() -> Result<String, String> {
    let user = std::env::var("USER").unwrap_or_else(|_| "claude".to_string());

    // Claude Code stores a managed API key in the macOS keychain under service
    // "Claude Code", account = current macOS username, after the user logs in.
    // We check for its presence to confirm the user is authenticated — we never
    // read or store the actual value.
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-a", &user,
            "-s", "Claude Code",
            "-w",
        ])
        .output()
        .map_err(|e| format!("Failed to run keychain lookup: {e}"))?;

    let found = output.status.success()
        && !String::from_utf8_lossy(&output.stdout).trim().is_empty();

    if !found {
        return Err(
            "Claude Code login not found. Open a terminal and run:\n\n  claude\n\n\
             Choose \"Log in with Claude.ai\" to authenticate your Claude Pro / Max \
             subscription. Once logged in, click this button again."
                .to_string(),
        );
    }

    // Login confirmed — enable the sidecar path. The sidecar authenticates via
    // the `claude` CLI automatically; no token is extracted or stored here.
    store_credential("claude_auth_method", "oauth")?;

    Ok(
        "Claude Code login verified. Meridian will use your Claude Pro / Max \
         subscription via the claude CLI sidecar for all AI features."
            .to_string(),
    )
}

/// `tolerant`: if true, network failures return Ok with a warning (used on save).
///             if false, network failures return Err (used by Test Connection button).
async fn test_anthropic_connectivity(api_key: &str, tolerant: bool) -> Result<String, String> {
    let client = make_client()?;
    // API keys (sk-ant-api03-…) use x-api-key.
    // OAuth tokens (sk-ant-oat01-…) use Authorization: Bearer plus the
    // oauth-2025-04-20 beta header required by the Anthropic API.
    let base_req = client
        .get("https://api.anthropic.com/v1/models")
        .header("anthropic-version", "2023-06-01");
    let authed_req = if api_key.starts_with("sk-ant-api") {
        base_req.header("x-api-key", api_key)
    } else {
        base_req
            .header("Authorization", format!("Bearer {api_key}"))
            .header("anthropic-beta", "oauth-2025-04-20")
    };
    let resp = match authed_req.send().await
    {
        Ok(r) => r,
        Err(e) if e.is_connect() || e.is_timeout() => {
            return if tolerant {
                Ok("API key saved. Note: api.anthropic.com could not be reached from this network — Claude workflows will be attempted at runtime.".to_string())
            } else {
                Err("Could not reach api.anthropic.com. Check your internet connection — your corporate network may be blocking this endpoint.".to_string())
            };
        }
        Err(e) => return Err(format!("Request failed: {e}")),
    };

    match resp.status() {
        StatusCode::OK => Ok("Connected to Anthropic API successfully.".to_string()),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(
            "Anthropic rejected the API key as invalid. Check the key at platform.claude.com → API Keys.".to_string(),
        ),
        s => Err(format!("Unexpected response from Anthropic (HTTP {s}).")),
    }
}

/// Test JIRA connectivity using the provided credentials.
/// Credentials are saved separately via save_credential.
#[tauri::command]
pub async fn validate_jira(
    base_url: String,
    email: String,
    api_token: String,
) -> Result<String, String> {
    if base_url.trim().is_empty() || email.trim().is_empty() || api_token.trim().is_empty() {
        return Err("All JIRA fields are required.".to_string());
    }
    test_jira_connection(&base_url, &email, &api_token).await
}

/// Test the already-stored JIRA credentials without accepting secrets from the frontend.
#[tauri::command]
pub async fn test_jira_stored() -> Result<String, String> {
    let base_url = get_credential("jira_base_url")
        .ok_or("No JIRA URL is stored. Save credentials first.")?;
    let email = get_credential("jira_email")
        .ok_or("No JIRA email is stored. Save credentials first.")?;
    let api_token = get_credential("jira_api_token")
        .ok_or("No JIRA API token is stored. Save credentials first.")?;
    test_jira_connection(&base_url, &email, &api_token).await
}

async fn test_jira_connection(base_url: &str, email: &str, api_token: &str) -> Result<String, String> {
    let base_url_trimmed = base_url.trim().trim_end_matches('/');
    let email_trimmed = email.trim();
    let token_trimmed = api_token.trim();

    // Use a client that does NOT follow redirects — a redirect to an OAuth/SAML login page
    // would otherwise be silently followed and produce a confusing error from the login page.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .use_native_tls()
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // /rest/api/3/myself always requires authentication and returns the user's profile.
    let url = format!("{base_url_trimmed}/rest/api/3/myself");

    let resp = client
        .get(&url)
        .basic_auth(email_trimmed, Some(token_trimmed))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                format!(
                    "Could not reach {base_url_trimmed}. \
                     Check your workspace URL and internet connection."
                )
            } else {
                format!("Request failed: {e}")
            }
        })?;

    let status = resp.status();
    let www_auth = resp
        .headers()
        .get("www-authenticate")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let location = resp
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp.text().await.unwrap_or_default();
    // Trim body to first 400 chars so error messages are readable.
    let body_excerpt = if body.len() > 400 { &body[..400] } else { &body };

    match status {
        StatusCode::OK => {
            let parsed = serde_json::from_str::<serde_json::Value>(&body).ok();
            let display_name = parsed
                .as_ref()
                .and_then(|v| v["displayName"].as_str().map(str::to_string))
                .unwrap_or_else(|| email_trimmed.to_string());
            // Store the accountId so other parts of the app can use it
            // (e.g. filtering Bitbucket reviewer lists by account identity).
            if let Some(account_id) = parsed.as_ref().and_then(|v| v["accountId"].as_str()) {
                let _ = store_credential("jira_account_id", account_id);
            }
            Ok(format!("Connected to JIRA as {display_name}."))
        }
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            // Surface every diagnostic detail so the user (and developer) can see
            // exactly what Atlassian returned, rather than guessing.
            let detail = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| {
                    v["message"].as_str()
                        .or_else(|| v["errorMessages"].get(0).and_then(|m| m.as_str()))
                        .map(str::to_string)
                });

            let mut parts: Vec<String> = vec![
                format!("JIRA returned HTTP {status} for {url}."),
            ];
            if !www_auth.is_empty() {
                parts.push(format!("WWW-Authenticate: {www_auth}"));
            }
            if let Some(d) = detail {
                parts.push(format!("JIRA message: \"{d}\""));
            } else if !body_excerpt.is_empty() {
                parts.push(format!("Response body: {body_excerpt}"));
            }
            parts.push(
                "Check your email and API token at id.atlassian.com → Security → API tokens."
                    .to_string(),
            );
            Err(parts.join("\n"))
        }
        s if s.is_redirection() => {
            Err(format!(
                "JIRA redirected the request (HTTP {s}) — this usually means your workspace URL \
                 is incorrect, or your organisation requires a different login flow.\n\
                 Redirect location: {location}\n\
                 Check your workspace URL in Settings (e.g. https://yourcompany.atlassian.net)."
            ))
        }
        StatusCode::NOT_FOUND => Err(format!(
            "JIRA workspace not found at {base_url_trimmed} (404). \
             Check your workspace URL in Settings."
        )),
        s => Err(format!(
            "Unexpected response from JIRA (HTTP {s}).\nBody: {body_excerpt}"
        )),
    }
}

/// Test Bitbucket connectivity using the provided credentials.
/// Credentials are saved separately via save_credential.
#[tauri::command]
pub async fn validate_bitbucket(
    workspace: String,
    email: String,
    access_token: String,
) -> Result<String, String> {
    if workspace.trim().is_empty() || email.trim().is_empty() || access_token.trim().is_empty() {
        return Err("Workspace, email, and access token are required.".to_string());
    }
    test_bitbucket_connection(&workspace, &email, &access_token).await
}

/// Test the already-stored Bitbucket credentials without accepting secrets from the frontend.
#[tauri::command]
pub async fn test_bitbucket_stored() -> Result<String, String> {
    let workspace = get_credential("bitbucket_workspace")
        .ok_or("No Bitbucket workspace is stored. Save credentials first.")?;
    let email = get_credential("bitbucket_email")
        .ok_or("No Bitbucket email is stored. Save credentials first.")?;
    let access_token = get_credential("bitbucket_access_token")
        .ok_or("No Bitbucket access token is stored. Save credentials first.")?;
    test_bitbucket_connection(&workspace, &email, &access_token).await
}

/// Full diagnostic sweep of every JIRA endpoint Meridian uses.
/// Returns a plain-text report regardless of success/failure so the frontend
/// can display it verbatim. Never returns Err — errors are embedded in the report.
#[tauri::command]
pub async fn debug_jira_endpoints() -> Result<String, String> {
    let base_url = get_credential("jira_base_url")
        .ok_or("No JIRA URL stored. Save credentials first.")?;
    let email = get_credential("jira_email")
        .ok_or("No JIRA email stored. Save credentials first.")?;
    let token = get_credential("jira_api_token")
        .ok_or("No JIRA API token stored. Save credentials first.")?;
    let board_id = get_credential("jira_board_id").unwrap_or_else(|| "(not set)".into());

    let base = base_url.trim().trim_end_matches('/');
    let email = email.trim();
    let token = token.trim();

    // Build clients: one following redirects (default), one not.
    let client_follow = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .use_native_tls()
        .build()
        .map_err(|e| format!("client error: {e}"))?;
    let client_nofollow = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .use_native_tls()
        .build()
        .map_err(|e| format!("client error: {e}"))?;

    let mut report = format!(
        "JIRA Endpoint Diagnostic\n\
         ========================\n\
         Base URL : {base}\n\
         Email    : {email}\n\
         Token    : {}...{} (len {})\n\
         Board ID : {board_id}\n\n",
        &token[..8.min(token.len())],
        &token[token.len().saturating_sub(4)..],
        token.len(),
    );

    // List of (label, url, use_nofollow_client, send_accept_json, send_basic_auth)
    let endpoints: &[(&str, String, bool, bool, bool)] = &[
        ("GET /rest/api/3/myself [no-redirect, Accept:json, Basic auth]",
            format!("{base}/rest/api/3/myself"), true, true, true),
        ("GET /rest/api/3/myself [follow-redirect, Accept:json, Basic auth]",
            format!("{base}/rest/api/3/myself"), false, true, true),
        ("GET /rest/api/3/myself [no-redirect, NO Accept header, Basic auth]",
            format!("{base}/rest/api/3/myself"), true, false, true),
        ("GET /rest/api/3/myself [no-redirect, Accept:json, NO auth]",
            format!("{base}/rest/api/3/myself"), true, true, false),
        ("GET /rest/api/3/serverInfo [no-redirect, Accept:json, Basic auth]",
            format!("{base}/rest/api/3/serverInfo"), true, true, true),
        ("GET /rest/agile/1.0/board [no-redirect, Accept:json, Basic auth]",
            format!("{base}/rest/agile/1.0/board"), true, true, true),
        ("GET /rest/agile/1.0/board/{board_id}/sprint?state=active [no-redirect]",
            format!("{base}/rest/agile/1.0/board/{board_id}/sprint?state=active"), true, true, true),
    ];

    for (label, url, nofollow, accept_json, with_auth) in endpoints {
        let client = if *nofollow { &client_nofollow } else { &client_follow };
        let mut req = client.get(url.as_str());
        if *with_auth {
            req = req.basic_auth(email, Some(token));
        }
        if *accept_json {
            req = req.header("Accept", "application/json");
        }

        report.push_str(&format!("\n── {label}\n   URL: {url}\n"));

        match req.send().await {
            Err(e) => {
                report.push_str(&format!("   ERROR: {e}\n"));
            }
            Ok(resp) => {
                let status = resp.status();
                let headers_of_interest: Vec<String> = ["www-authenticate", "location", "content-type", "x-seraph-loginreason"]
                    .iter()
                    .filter_map(|h| {
                        resp.headers().get(*h)
                            .and_then(|v| v.to_str().ok())
                            .map(|v| format!("   {h}: {v}"))
                    })
                    .collect();
                let body = resp.text().await.unwrap_or_default();
                let body_preview = body.chars().take(300).collect::<String>()
                    .replace('\n', " ").replace('\r', "");

                report.push_str(&format!("   Status : {status}\n"));
                for h in &headers_of_interest {
                    report.push_str(&format!("{h}\n"));
                }
                report.push_str(&format!("   Body   : {body_preview}\n"));
            }
        }
    }

    Ok(report)
}

async fn test_bitbucket_connection(workspace: &str, email: &str, access_token: &str) -> Result<String, String> {
    let workspace_trimmed = workspace.trim();
    let email_trimmed = email.trim();
    let token_trimmed = access_token.trim();

    let client = make_client()?;

    let url = format!("https://api.bitbucket.org/2.0/repositories/{workspace_trimmed}?pagelen=1");

    let resp = client
        .get(&url)
        .basic_auth(email_trimmed, Some(token_trimmed))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "Could not reach api.bitbucket.org. Check your internet connection.".to_string()
            } else {
                format!("Request failed: {e}")
            }
        })?;

    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();

    match status {
        StatusCode::OK => {
            let count = serde_json::from_str::<serde_json::Value>(&body_text)
                .ok()
                .and_then(|v| v["size"].as_u64())
                .map(|n| format!(" ({n} repositories found)"))
                .unwrap_or_default();
            Ok(format!("Connected to Bitbucket workspace '{workspace_trimmed}'{count}."))
        }
        StatusCode::UNAUTHORIZED => Err(
            "Bitbucket rejected the credentials. Check your email and that the token has read:repository:bitbucket scope.".to_string()
        ),
        StatusCode::FORBIDDEN => Err(format!(
            "Bitbucket access denied — your token may not have access to workspace '{workspace_trimmed}'. Ensure the token was created in the correct workspace."
        )),
        StatusCode::NOT_FOUND => Err(format!(
            "Bitbucket workspace '{workspace_trimmed}' not found. Check the workspace slug in your Bitbucket URL."
        )),
        s => Err(format!("Unexpected response from Bitbucket (HTTP {s}).")),
    }
}
