use reqwest::Client;
use std::time::Duration;

/// Build an HTTP client that loads the corporate CA bundle from the environment
/// or common fixed paths, in addition to the system native TLS roots.
/// `timeout` is configurable so different callers can set appropriate timeouts.
/// If danger_accept_invalid_certs is true, disables SSL verification (insecure).
pub fn make_corporate_client(timeout: Duration, danger_accept_invalid_certs: bool) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(timeout)
        .use_native_tls();
    if danger_accept_invalid_certs {
        builder = builder.danger_accept_invalid_certs(true);
    }

    let ca_paths: Vec<std::path::PathBuf> = std::iter::once(std::env::var("REQUESTS_CA_BUNDLE").ok())
        .chain(std::iter::once(std::env::var("SSL_CERT_FILE").ok()))
        .flatten()
        .map(std::path::PathBuf::from)
        .chain(
            [
                dirs::home_dir().map(|h| h.join(".certs/all.pem")),
                dirs::home_dir().map(|h| h.join(".certs/ca-bundle.pem")),
            ]
            .into_iter()
            .flatten(),
        )
        .collect();

    for path in &ca_paths {
        if path.exists() {
            match std::fs::read(path) {
                Ok(pem_bytes) => match reqwest::Certificate::from_pem_bundle(&pem_bytes) {
                    Ok(certs) => {
                        for cert in certs {
                            builder = builder.add_root_certificate(cert);
                        }
                        break;
                    }
                    Err(_) => {}
                },
                Err(_) => {}
            }
        }
    }

    builder.build().map_err(|e| format!("HTTP client error: {e}"))
}

