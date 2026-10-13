use std::path::{Component, Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("invalid path: {0}")]
    Invalid(String),
    #[error("forbidden access: {0}")]
    Forbidden(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl PathError {
    pub fn status_code(&self) -> u16 {
        match self {
            PathError::Invalid(_) => 400,
            PathError::Forbidden(_) => 403,
            PathError::NotFound(_) => 404,
            PathError::Io(_) => 500,
        }
    }
}

/// Resolves and validates a request URI path against a canonical root directory.
///
/// Security constraints:
/// - Single URL decode; rejects residual percent (`%`) signs to prevent double-encoding ambiguities.
/// - Rejects backslashes (`\`), null bytes (`\0`), colons (`:`, drive letters / ADS).
/// - Rejects non-Normal path components (`.`, `..`, prefixes, root dirs).
/// - Rejects UNC paths and extended-length path prefixes (e.g. `\\?\`); permits valid deep directories.
/// - Limits individual path components to 255 UTF-16 code units (Windows filesystem limit).
/// - Maps `/` or empty path to `index.html`.
/// - Must resolve within `canonical_root` and point to a regular file.
/// - Missing file returns `PathError::NotFound` (404); directory access returns `PathError::Forbidden` (403).
/// - Security note on TOCTOU: Path validation reflects filesystem state at the specific point of resolution and cannot guard against concurrent resource modification by local processes running with identical privileges.
pub fn resolve_file(root: &Path, uri_path: &str) -> Result<PathBuf, PathError> {
    // Defense-in-depth: disallow query strings and fragments
    if uri_path.contains('?') || uri_path.contains('#') {
        return Err(PathError::Invalid(
            "query strings and fragments are not allowed in path resolution".into(),
        ));
    }

    // 1. Single percent-decode
    let decoded = percent_encoding::percent_decode_str(uri_path)
        .decode_utf8()
        .map_err(|_| PathError::Invalid("invalid utf-8 byte sequence".into()))?;

    // 2. Reject ambiguous remaining '%'
    if decoded.contains('%') {
        return Err(PathError::Invalid(
            "ambiguous percent encoding or double encoding detected".into(),
        ));
    }

    // 3. Reject forbidden characters
    if decoded.contains('\\') {
        return Err(PathError::Invalid("backslash is not permitted".into()));
    }
    if decoded.contains('\0') {
        return Err(PathError::Invalid("null byte is not permitted".into()));
    }
    if decoded.contains(':') {
        return Err(PathError::Invalid(
            "colon is not permitted (drive specifier or Alternate Data Stream)".into(),
        ));
    }

    // 4. Reject UNC syntax
    if decoded.starts_with("//") {
        return Err(PathError::Invalid("UNC paths are not permitted".into()));
    }

    // 5. Component parsing and normalization
    let trimmed = decoded.trim_start_matches('/');
    let clean_path = if trimmed.ends_with('/') {
        trimmed.trim_end_matches('/')
    } else {
        trimmed
    };

    let target_rel_str = if clean_path.is_empty() {
        "index.html"
    } else {
        clean_path
    };

    // Canonicalize root first
    let canonical_root = root.canonicalize().map_err(PathError::Io)?;
    let mut candidate = canonical_root.clone();

    // Validate every component and build path incrementally
    for segment in target_rel_str.split('/') {
        if segment.is_empty() {
            return Err(PathError::Invalid(
                "empty path component (consecutive slashes)".into(),
            ));
        }
        if segment == "." || segment == ".." {
            return Err(PathError::Invalid(
                "relative traversal component (. or ..) is not permitted".into(),
            ));
        }
        if segment.encode_utf16().count() > 255 {
            return Err(PathError::Invalid(
                "path component exceeds maximum segment length (255 UTF-16 code units)".into(),
            ));
        }

        // Verify component has only Normal elements
        let seg_path = Path::new(segment);
        for comp in seg_path.components() {
            match comp {
                Component::Normal(_) => {}
                _ => {
                    return Err(PathError::Invalid("non-normal component detected".into()));
                }
            }
        }

        candidate.push(segment);
    }

    // 7. Canonicalize target
    let canonical_target = match candidate.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            return if e.kind() == std::io::ErrorKind::NotFound {
                Err(PathError::NotFound(target_rel_str.to_string()))
            } else {
                Err(PathError::Io(e))
            };
        }
    };

    // 8. Prevent UNC canonical targets
    if canonical_target.to_string_lossy().starts_with(r"\\?\UNC\") {
        return Err(PathError::Forbidden("UNC target forbidden".into()));
    }

    // 9. Ensure target is strictly inside canonical root (prevents symlink escapes)
    if !canonical_target.starts_with(&canonical_root) {
        return Err(PathError::Forbidden(
            "target escapes canonical root directory".into(),
        ));
    }

    // 10. Check file metadata (directory -> Forbidden, non-regular file -> Forbidden)
    let meta = std::fs::metadata(&canonical_target).map_err(PathError::Io)?;
    if meta.is_dir() {
        return Err(PathError::Forbidden("directory access is forbidden".into()));
    }
    if !meta.is_file() {
        return Err(PathError::Forbidden("target is not a regular file".into()));
    }

    Ok(canonical_target)
}
