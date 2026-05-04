use base64::Engine as _;
use reqwest::Client;
use std::time::Duration;

use crate::http::make_corporate_client;

pub(super) fn make_client() -> Result<Client, String> {
    make_corporate_client(Duration::from_secs(10), false)
}

// ── OAuth PKCE helpers ────────────────────────────────────────────────────────

pub(super) fn generate_random_base64url(byte_len: usize) -> Result<String, String> {
    use std::io::Read;
    let mut bytes = vec![0u8; byte_len];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("Failed to generate random bytes: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes))
}

pub(super) fn sha256_base64url(input: &str) -> String {
    use sha2::{Digest, Sha256};
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(input.as_bytes()))
}

pub(super) fn percent_encode(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => {
                vec![c as u8]
            }
            c => format!("%{:02X}", c as u32).bytes().collect(),
        })
        .map(|b| b as char)
        .collect()
}

pub(super) fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte as char);
                    i += 3;
                    continue;
                }
            }
        } else if bytes[i] == b'+' {
            out.push(' ');
            i += 1;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

pub(super) async fn wait_for_oauth_callback(
    listener: tokio::net::TcpListener,
    expected_state: &str,
    provider_label: &str,
) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("Local server accept error: {e}"))?;

        let mut buf = [0u8; 8192];
        let n = stream
            .read(&mut buf)
            .await
            .map_err(|e| format!("Read error: {e}"))?;

        let request = String::from_utf8_lossy(&buf[..n]);
        let first_line = request.lines().next().unwrap_or("").to_string();

        match parse_callback(&request, expected_state) {
            CallbackResult::Code(code) => {
                let html = format!(
                    "<html><head><meta charset=utf-8><title>Meridian — Connected</title>\
                    <style>body{{font-family:system-ui;display:flex;align-items:center;\
                    justify-content:center;min-height:100vh;margin:0;background:#0f0f0f;color:#fff}}\
                    .card{{background:#1a1a1a;padding:2rem;border-radius:12px;text-align:center;max-width:380px}}\
                    h2{{margin:0 0 .5rem}}p{{color:#aaa;margin:.5rem 0 0;font-size:.9rem}}</style>\
                    </head><body><div class=card><h2>✓ Connected to {provider_label}</h2>\
                    <p>You can close this window and return to Meridian.</p></div></body></html>"
                );
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html.len(),
                    html
                );
                let _ = stream.write_all(response.as_bytes()).await;
                return Ok(code);
            }
            CallbackResult::OAuthError(msg) => {
                let _ = stream
                    .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
                    .await;
                return Err(format!("Authorization server returned an error: {msg}"));
            }
            CallbackResult::NotCallback => {
                // Not our redirect — send a minimal response and keep waiting.
                eprintln!("[meridian oauth] ignored request: {first_line}");
                let _ = stream
                    .write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
                    .await;
            }
        }
    }
}

enum CallbackResult {
    Code(String),
    OAuthError(String),
    NotCallback,
}

fn parse_callback(request: &str, expected_state: &str) -> CallbackResult {
    let line = match request.lines().next() {
        Some(l) => l,
        None => return CallbackResult::NotCallback,
    };
    let after_get = match line.strip_prefix("GET ") {
        Some(s) => s,
        None => return CallbackResult::NotCallback,
    };
    let path = match after_get.split_whitespace().next() {
        Some(s) => s,
        None => return CallbackResult::NotCallback,
    };
    let query = match path.strip_prefix("/callback?") {
        Some(q) => q,
        None => return CallbackResult::NotCallback,
    };

    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut error: Option<String> = None;
    let mut error_description: Option<String> = None;

    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            let decoded = percent_decode(v);
            match k {
                "code" => code = Some(decoded),
                "state" => state = Some(decoded),
                "error" => error = Some(decoded),
                "error_description" => error_description = Some(decoded),
                _ => {}
            }
        }
    }

    // If the server redirected with an error, surface it immediately.
    if let Some(err) = error {
        let desc = error_description.unwrap_or_default();
        return CallbackResult::OAuthError(format!("{err}: {desc}"));
    }

    // Verify CSRF state.
    if state.as_deref() != Some(expected_state) {
        eprintln!(
            "[meridian oauth] state mismatch: got {:?}, expected {expected_state}",
            state
        );
        return CallbackResult::NotCallback;
    }

    match code {
        Some(c) => CallbackResult::Code(c),
        None => CallbackResult::NotCallback,
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── generate_random_base64url ─────────────────────────────────────────────

    #[test]
    fn random_base64url_32_bytes_gives_43_chars() {
        let s = generate_random_base64url(32).unwrap();
        assert_eq!(s.len(), 43, "32 bytes → 43 base64url chars (no padding)");
    }

    #[test]
    fn random_base64url_16_bytes_gives_22_chars() {
        let s = generate_random_base64url(16).unwrap();
        assert_eq!(s.len(), 22, "16 bytes → 22 base64url chars (no padding)");
    }

    #[test]
    fn random_base64url_contains_only_url_safe_chars() {
        let s = generate_random_base64url(32).unwrap();
        assert!(
            s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "Output should only contain A-Z a-z 0-9 - _; got: {s}"
        );
    }

    #[test]
    fn random_base64url_two_calls_differ() {
        let a = generate_random_base64url(32).unwrap();
        let b = generate_random_base64url(32).unwrap();
        assert_ne!(a, b, "Two calls should produce different values");
    }

    // ── sha256_base64url ──────────────────────────────────────────────────────

    #[test]
    fn sha256_base64url_known_input() {
        // SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
        // base64url (no pad) = LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ
        let result = sha256_base64url("hello");
        assert_eq!(result, "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ");
    }

    #[test]
    fn sha256_base64url_output_is_43_chars() {
        let result = sha256_base64url("any input");
        assert_eq!(result.len(), 43, "SHA-256 → 32 bytes → 43 base64url chars");
    }

    // ── percent_encode ────────────────────────────────────────────────────────

    #[test]
    fn percent_encode_space() {
        assert_eq!(percent_encode("hello world"), "hello%20world");
    }

    #[test]
    fn percent_encode_slash() {
        assert_eq!(percent_encode("a/b"), "a%2Fb");
    }

    #[test]
    fn percent_encode_colon() {
        assert_eq!(percent_encode("a:b"), "a%3Ab");
    }

    #[test]
    fn percent_encode_leaves_unreserved_chars() {
        let unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~";
        assert_eq!(percent_encode(unreserved), unreserved);
    }

    #[test]
    fn percent_encode_scope_string() {
        let scope = "user:profile user:inference";
        let encoded = percent_encode(scope);
        assert!(encoded.contains("%3A"), "colons encoded");
        assert!(encoded.contains("%20"), "spaces encoded");
    }

    // ── percent_decode ────────────────────────────────────────────────────────

    #[test]
    fn percent_decode_space() {
        assert_eq!(percent_decode("%20"), " ");
    }

    #[test]
    fn percent_decode_colon() {
        assert_eq!(percent_decode("%3A"), ":");
    }

    #[test]
    fn percent_decode_plus_as_space() {
        assert_eq!(percent_decode("hello+world"), "hello world");
    }

    #[test]
    fn percent_decode_unchanged_for_plain_text() {
        assert_eq!(percent_decode("hello"), "hello");
    }

    #[test]
    fn percent_encode_decode_round_trip() {
        let original = "user:profile user:inference org:create_api_key";
        let encoded = percent_encode(original);
        let decoded = percent_decode(&encoded);
        assert_eq!(decoded, original);
    }
}
