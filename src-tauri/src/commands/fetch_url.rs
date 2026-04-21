use crate::http::make_corporate_client;
use std::time::Duration;

/// Fetch the text content of a URL and return it as plain text.
///
/// - Follows redirects (up to 10)
/// - Strips HTML tags to plain text so the LLM can read it without token waste
/// - Caps the returned content at MAX_BYTES to avoid blowing the context window
/// - Returns an error string (not a panic) on any failure so the frontend can
///   display it gracefully
#[tauri::command]
pub async fn fetch_url_content(url: String) -> Result<String, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("URL cannot be empty.".to_string());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("URL must start with http:// or https://".to_string());
    }

    let client = make_corporate_client(Duration::from_secs(20), false)
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (compatible; Meridian/1.0)")
        .header("Accept", "text/html,text/plain,application/xhtml+xml,*/*")
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                format!("Could not reach {url}. Check your internet connection.")
            } else {
                format!("Request failed: {e}")
            }
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!("HTTP {status} from {url}"));
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    let raw = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {e}"))?;

    // Strip HTML tags if it looks like an HTML document
    let plain = if content_type.contains("html") || raw.trim_start().starts_with('<') {
        strip_html(&raw)
    } else {
        raw
    };

    // Cap at ~100 KB of plain text — enough to cover most doc pages without
    // blowing up the context window
    const MAX_BYTES: usize = 100 * 1024;
    let trimmed = if plain.len() > MAX_BYTES {
        let cut = &plain[..MAX_BYTES];
        // Back up to the last newline so we don't cut mid-word
        let end = cut.rfind('\n').unwrap_or(MAX_BYTES);
        format!(
            "{}\n\n[Content truncated at 100 KB — {} total bytes fetched]",
            &plain[..end],
            plain.len()
        )
    } else {
        plain
    };

    Ok(trimmed)
}

/// Very lightweight HTML-to-text stripper.
/// Removes tags, decodes common HTML entities, collapses whitespace.
/// Not a full parser — good enough for documentation pages.
fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    let mut in_script_or_style = false;
    let mut tag_buf = String::new();

    let chars: Vec<char> = html.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let ch = chars[i];

        if in_tag {
            if ch == '>' {
                in_tag = false;
                let tag_lower = tag_buf.to_lowercase();
                let tag_name: &str = tag_lower
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .trim_start_matches('/');

                if tag_name == "script" || tag_name == "style" {
                    // Check whether this is an opening or closing tag
                    if tag_lower.starts_with('/') || tag_lower.starts_with("script") || tag_lower.starts_with("style") {
                        // Opening script/style — mark as in-block
                        if !tag_lower.starts_with('/') {
                            in_script_or_style = true;
                        } else {
                            in_script_or_style = false;
                        }
                    }
                }

                // Add newlines after block-level elements for readability
                match tag_name {
                    "br" | "p" | "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                    | "li" | "tr" | "section" | "article" | "header" | "footer" | "pre" => {
                        if !in_script_or_style {
                            out.push('\n');
                        }
                    }
                    _ => {}
                }

                tag_buf.clear();
            } else {
                tag_buf.push(ch);
            }
        } else if ch == '<' {
            in_tag = true;
            tag_buf.clear();
        } else if !in_script_or_style {
            // Decode common HTML entities inline
            if ch == '&' {
                // Collect up to the next ';' (max 8 chars ahead)
                let rest: String = chars[i..std::cmp::min(i + 10, len)].iter().collect();
                if let Some(end) = rest.find(';') {
                    let entity = &rest[..end + 1];
                    let decoded = match entity {
                        "&amp;"  => Some('&'),
                        "&lt;"   => Some('<'),
                        "&gt;"   => Some('>'),
                        "&quot;" => Some('"'),
                        "&#39;"  => Some('\''),
                        "&nbsp;" => Some(' '),
                        "&mdash;"=> Some('—'),
                        "&ndash;"=> Some('–'),
                        "&laquo;"=> Some('«'),
                        "&raquo;"=> Some('»'),
                        _ => None,
                    };
                    if let Some(c) = decoded {
                        out.push(c);
                        i += entity.len();
                        continue;
                    }
                }
            }
            out.push(ch);
        }

        i += 1;
    }

    // Collapse runs of 3+ newlines into 2, and trim each line
    let mut result = String::with_capacity(out.len());
    let mut blank_count = 0u32;
    for line in out.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            blank_count += 1;
            if blank_count <= 2 {
                result.push('\n');
            }
        } else {
            blank_count = 0;
            result.push_str(trimmed);
            result.push('\n');
        }
    }

    result.trim().to_string()
}
