use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::path_policy::{PathError, resolve_file};

const MAX_MANIFEST_SIZE: u64 = 16 * 1024 * 1024; // 16 MiB
const STREAM_BUFFER_SIZE: usize = 64 * 1024; // 64 KiB

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetEntry {
    pub source_url: String,
    pub path: String,
    pub content_type: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json deserialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid manifest: {0}")]
    InvalidManifest(String),
    #[error("invalid asset path '{path}': {reason}")]
    InvalidPath { path: String, reason: String },
    #[error("asset not found: {0}")]
    AssetNotFound(String),
    #[error("asset size mismatch for '{path}': expected {expected}, actual {actual}")]
    SizeMismatch {
        path: String,
        expected: u64,
        actual: u64,
    },
    #[error("asset sha256 mismatch for '{path}': expected {expected}, actual {actual}")]
    Sha256Mismatch {
        path: String,
        expected: String,
        actual: String,
    },
}

fn is_windows_reserved_device_name(stem: &str) -> bool {
    let upper = stem.to_ascii_uppercase();
    match upper.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        s if s.len() == 4 => {
            (s.starts_with("COM") || s.starts_with("LPT"))
                && s.chars()
                    .nth(3)
                    .is_some_and(|c| c.is_ascii_digit() && c != '0')
        }
        _ => false,
    }
}

/// Verifies game assets against a manifest file.
///
/// Security constraints:
/// - Manifest must be located strictly inside canonical `root` and be a regular file.
/// - Manifest file bounded to 16 MiB max with `Read::take(MAX + 1)` protection.
/// - Manifest array must be non-empty and contain `index.html`.
/// - Case-insensitive duplicate path collision rejected (Windows safety).
/// - Content types must be non-empty and contain no control characters.
/// - Hashes must be valid 64-character lowercase hex strings.
/// - Asset paths must be clean relative paths without traversal, escape, forbidden characters, or DOS device names.
/// - Streams assets in 64 KiB chunks to verify both stream total bytes and SHA-256 integrity against metadata.
pub fn verify_manifest(
    root: &Path,
    manifest_path: &Path,
) -> Result<Vec<AssetEntry>, ManifestError> {
    let canonical_root = root.canonicalize().map_err(ManifestError::Io)?;
    let canonical_manifest = manifest_path.canonicalize().map_err(ManifestError::Io)?;

    if !canonical_manifest.starts_with(&canonical_root) {
        return Err(ManifestError::InvalidManifest(
            "manifest path escapes root directory".into(),
        ));
    }

    let manifest_meta = canonical_manifest.metadata().map_err(ManifestError::Io)?;
    if !manifest_meta.is_file() {
        return Err(ManifestError::InvalidManifest(
            "manifest path is not a regular file".into(),
        ));
    }

    if manifest_meta.len() > MAX_MANIFEST_SIZE {
        return Err(ManifestError::InvalidManifest(
            "manifest exceeds 16MiB size limit".into(),
        ));
    }

    let manifest_file = File::open(&canonical_manifest).map_err(ManifestError::Io)?;
    let mut manifest_bytes = Vec::new();
    let bytes_read = manifest_file
        .take(MAX_MANIFEST_SIZE + 1)
        .read_to_end(&mut manifest_bytes)
        .map_err(ManifestError::Io)?;

    if bytes_read as u64 > MAX_MANIFEST_SIZE {
        return Err(ManifestError::InvalidManifest(
            "manifest file stream exceeds 16MiB".into(),
        ));
    }

    let entries: Vec<AssetEntry> = serde_json::from_slice(&manifest_bytes)?;

    if entries.is_empty() {
        return Err(ManifestError::InvalidManifest(
            "manifest array must not be empty".into(),
        ));
    }

    if !entries.iter().any(|e| e.path == "index.html") {
        return Err(ManifestError::InvalidManifest(
            "manifest must contain index.html".into(),
        ));
    }

    let mut seen_paths = HashSet::new();

    for entry in &entries {
        // Case-insensitive collision check
        let lower_path = entry.path.to_ascii_lowercase();
        if !seen_paths.insert(lower_path) {
            return Err(ManifestError::InvalidManifest(format!(
                "duplicate path (case-insensitive): {}",
                entry.path
            )));
        }

        // Content type check
        if entry.content_type.is_empty() {
            return Err(ManifestError::InvalidManifest(format!(
                "contentType cannot be empty for path: {}",
                entry.path
            )));
        }
        if entry.content_type.chars().any(|c| c.is_control()) {
            return Err(ManifestError::InvalidManifest(format!(
                "contentType contains control characters for path: {}",
                entry.path
            )));
        }

        // SHA-256 format check (must be 64-character lowercase hex)
        if entry.sha256.len() != 64
            || !entry
                .sha256
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(ManifestError::InvalidManifest(format!(
                "invalid sha256 format for path '{}': must be 64 lowercase hex characters",
                entry.path
            )));
        }

        // Relative path validation
        if entry.path.starts_with('/') {
            return Err(ManifestError::InvalidPath {
                path: entry.path.clone(),
                reason: "path must not start with a leading slash".into(),
            });
        }
        if entry.path.ends_with('/') {
            return Err(ManifestError::InvalidPath {
                path: entry.path.clone(),
                reason: "path must not end with a trailing slash".into(),
            });
        }

        if entry.path.contains('\\')
            || entry.path.contains(':')
            || entry.path.contains('\0')
            || entry.path.contains('%')
            || entry.path.contains('?')
            || entry.path.contains('#')
        {
            return Err(ManifestError::InvalidPath {
                path: entry.path.clone(),
                reason: "path contains forbidden characters (\\, :, NUL, %, ?, #)".into(),
            });
        }

        for seg in entry.path.split('/') {
            if seg.is_empty() {
                return Err(ManifestError::InvalidPath {
                    path: entry.path.clone(),
                    reason: "empty segment (consecutive slashes)".into(),
                });
            }
            if seg == "." || seg == ".." {
                return Err(ManifestError::InvalidPath {
                    path: entry.path.clone(),
                    reason: "relative traversal segment (. or ..)".into(),
                });
            }
            let stem = seg.split('.').next().unwrap_or(seg);
            if is_windows_reserved_device_name(stem) {
                return Err(ManifestError::InvalidPath {
                    path: entry.path.clone(),
                    reason: format!("windows reserved device name: {}", seg),
                });
            }
        }

        // Reuse resolve_file for canonical containment and regular file verification
        let uri = format!("/{}", entry.path);
        let resolved_file_path = match resolve_file(&canonical_root, &uri) {
            Ok(p) => p,
            Err(PathError::NotFound(_)) => {
                return Err(ManifestError::AssetNotFound(entry.path.clone()));
            }
            Err(e) => {
                return Err(ManifestError::InvalidPath {
                    path: entry.path.clone(),
                    reason: format!("{}", e),
                });
            }
        };

        // Open asset and verify opened metadata size
        let mut file = File::open(&resolved_file_path).map_err(ManifestError::Io)?;
        let file_meta = file.metadata().map_err(ManifestError::Io)?;
        if file_meta.len() != entry.size {
            return Err(ManifestError::SizeMismatch {
                path: entry.path.clone(),
                expected: entry.size,
                actual: file_meta.len(),
            });
        }

        // Stream asset in 64 KiB chunks
        let mut buffer = [0u8; STREAM_BUFFER_SIZE];
        let mut hasher = Sha256::new();
        let mut stream_total: u64 = 0;

        loop {
            let bytes_read = file.read(&mut buffer).map_err(ManifestError::Io)?;
            if bytes_read == 0 {
                break;
            }
            hasher.update(&buffer[..bytes_read]);
            stream_total = stream_total.checked_add(bytes_read as u64).ok_or_else(|| {
                ManifestError::InvalidManifest("file stream size overflow".into())
            })?;
        }

        if stream_total != entry.size {
            return Err(ManifestError::SizeMismatch {
                path: entry.path.clone(),
                expected: entry.size,
                actual: stream_total,
            });
        }

        let computed_sha256 = format!("{:x}", hasher.finalize());
        if computed_sha256 != entry.sha256 {
            return Err(ManifestError::Sha256Mismatch {
                path: entry.path.clone(),
                expected: entry.sha256.clone(),
                actual: computed_sha256,
            });
        }
    }

    Ok(entries)
}
