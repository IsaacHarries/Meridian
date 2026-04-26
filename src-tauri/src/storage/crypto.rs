// Symmetric encryption helpers shared by on-disk stores (credentials,
// meeting records, etc.). AES-256-GCM with a 32-byte key derived from
// SHA256(domain || machine_uuid). The `domain` argument keeps each
// caller's key cryptographically isolated — a leak of one store cannot
// be replayed against another.

use std::sync::OnceLock;

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};

pub fn derive_key(domain: &str) -> [u8; 32] {
    let uuid = machine_uuid();
    let mut h = Sha256::new();
    h.update(domain.as_bytes());
    h.update(uuid.as_bytes());
    h.finalize().into()
}

pub fn encrypt(domain: &str, plaintext: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new_from_slice(&derive_key(domain)).expect("key is 32 bytes");
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let mut ct = cipher.encrypt(nonce, plaintext).expect("encryption failed");
    let mut out = nonce_bytes.to_vec();
    out.append(&mut ct);
    out
}

pub fn decrypt(domain: &str, data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 12 {
        return None;
    }
    let (nonce_bytes, ct) = data.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(&derive_key(domain)).ok()?;
    cipher.decrypt(Nonce::from_slice(nonce_bytes), ct).ok()
}

fn machine_uuid() -> String {
    static UUID: OnceLock<String> = OnceLock::new();
    UUID.get_or_init(|| {
        #[cfg(target_os = "macos")]
        {
            use std::process::Command;
            if let Ok(out) = Command::new("ioreg")
                .args(["-rd1", "-c", "IOPlatformExpertDevice"])
                .output()
            {
                let text = String::from_utf8_lossy(&out.stdout);
                for line in text.lines() {
                    if line.contains("IOPlatformUUID") {
                        let parts: Vec<&str> = line.splitn(2, '=').collect();
                        if let Some(rhs) = parts.get(1) {
                            let uuid = rhs.trim().trim_matches('"').trim().to_string();
                            if !uuid.is_empty() {
                                return uuid;
                            }
                        }
                    }
                }
            }
        }
        std::process::Command::new("hostname")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "meridian-default-host".to_string())
    })
    .clone()
}
