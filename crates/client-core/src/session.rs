use rand::RngCore;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub const SESSION_COOKIE_NAME: &str = "ashfall_session";

pub struct SessionState {
    bootstrap_token: String,
    bootstrap_consumed: AtomicBool,
    session_cookie: String,
}

impl std::fmt::Debug for SessionState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionState")
            .field("bootstrap_token", &"[REDACTED]")
            .field("bootstrap_consumed", &self.bootstrap_consumed)
            .field("session_cookie", &"[REDACTED]")
            .finish()
    }
}

impl SessionState {
    pub fn new() -> Arc<Self> {
        let mut rng = rand::thread_rng();
        let mut b_bytes = [0u8; 32];
        let mut c_bytes = [0u8; 32];
        rng.fill_bytes(&mut b_bytes);
        rng.fill_bytes(&mut c_bytes);

        let bootstrap_token = hex_encode(&b_bytes);
        let session_cookie = hex_encode(&c_bytes);

        Arc::new(Self {
            bootstrap_token,
            bootstrap_consumed: AtomicBool::new(false),
            session_cookie,
        })
    }

    pub fn bootstrap_token(&self) -> &str {
        &self.bootstrap_token
    }

    pub fn session_cookie(&self) -> &str {
        &self.session_cookie
    }

    /// Consumes the bootstrap token once. Returns true if valid and consumed, false otherwise.
    pub fn consume_bootstrap(&self, candidate: &str) -> bool {
        if candidate.is_empty() || candidate.len() != self.bootstrap_token.len() {
            return false;
        }
        if subtle_eq(candidate.as_bytes(), self.bootstrap_token.as_bytes()) {
            // Swap true if was false
            !self.bootstrap_consumed.swap(true, Ordering::SeqCst)
        } else {
            false
        }
    }

    /// Verifies if a Cookie header contains the exact session cookie.
    /// Strictly parses `Cookie: <name>=<value>; ...` and avoids substring matching.
    pub fn validate_cookie(&self, cookie_header: &str) -> bool {
        for pair in cookie_header.split(';') {
            let trimmed = pair.trim();
            if let Some((name, val)) = trimmed.split_once('=')
                && name.trim() == SESSION_COOKIE_NAME
                && subtle_eq(val.trim().as_bytes(), self.session_cookie.as_bytes())
            {
                return true;
            }
        }
        false
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

/// Constant-time slice equality comparison
fn subtle_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
