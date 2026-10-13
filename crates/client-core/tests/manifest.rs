use std::fs::{self, File};
use tempfile::tempdir;

use ashfall_client_core::manifest::{AssetEntry, ManifestError, verify_manifest};
use sha2::{Digest, Sha256};

fn compute_sha256(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

#[test]
fn test_valid_manifest_multiple_files() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // 1. Create index.html
    let index_data = b"<!DOCTYPE html><html><body>Game</body></html>";
    let index_path = root.join("index.html");
    fs::write(&index_path, index_data).unwrap();

    // 2. Create assets/app.js
    let assets_dir = root.join("assets");
    fs::create_dir_all(&assets_dir).unwrap();
    let js_data = b"console.log('loaded');";
    let js_path = assets_dir.join("app.js");
    fs::write(&js_path, js_data).unwrap();

    // 3. Create styles/main.css
    let styles_dir = root.join("styles");
    fs::create_dir_all(&styles_dir).unwrap();
    let css_data = b"body { margin: 0; }";
    let css_path = styles_dir.join("main.css");
    fs::write(&css_path, css_data).unwrap();

    let manifest_entries = vec![
        AssetEntry {
            source_url: "https://example.com/index.html".into(),
            path: "index.html".into(),
            content_type: "text/html".into(),
            size: index_data.len() as u64,
            sha256: compute_sha256(index_data),
        },
        AssetEntry {
            source_url: "https://example.com/assets/app.js".into(),
            path: "assets/app.js".into(),
            content_type: "application/javascript".into(),
            size: js_data.len() as u64,
            sha256: compute_sha256(js_data),
        },
        AssetEntry {
            source_url: "https://example.com/styles/main.css".into(),
            path: "styles/main.css".into(),
            content_type: "text/css".into(),
            size: css_data.len() as u64,
            sha256: compute_sha256(css_data),
        },
    ];

    let manifest_path = root.join("assets.json");
    let json_bytes = serde_json::to_vec(&manifest_entries).unwrap();
    fs::write(&manifest_path, json_bytes).unwrap();

    let verified = verify_manifest(root, &manifest_path).expect("valid manifest should verify");
    assert_eq!(verified, manifest_entries);
}

#[test]
fn test_missing_asset_fails() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let manifest_entries = vec![AssetEntry {
        source_url: "https://example.com/index.html".into(),
        path: "index.html".into(),
        content_type: "text/html".into(),
        size: 10,
        sha256: "0".repeat(64),
    }];

    let manifest_path = root.join("assets.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest_entries).unwrap(),
    )
    .unwrap();

    let err = verify_manifest(root, &manifest_path).unwrap_err();
    match err {
        ManifestError::AssetNotFound(p) => assert_eq!(p, "index.html"),
        other => panic!("expected AssetNotFound, got {:?}", other),
    }
}

#[test]
fn test_size_mismatch_fails() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let index_data = b"short content";
    fs::write(root.join("index.html"), index_data).unwrap();

    let manifest_entries = vec![AssetEntry {
        source_url: "https://example.com/index.html".into(),
        path: "index.html".into(),
        content_type: "text/html".into(),
        size: index_data.len() as u64 + 10, // Incorrect size
        sha256: compute_sha256(index_data),
    }];

    let manifest_path = root.join("assets.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest_entries).unwrap(),
    )
    .unwrap();

    let err = verify_manifest(root, &manifest_path).unwrap_err();
    match err {
        ManifestError::SizeMismatch {
            path,
            expected,
            actual,
        } => {
            assert_eq!(path, "index.html");
            assert_eq!(expected, index_data.len() as u64 + 10);
            assert_eq!(actual, index_data.len() as u64);
        }
        other => panic!("expected SizeMismatch, got {:?}", other),
    }
}

#[test]
fn test_sha256_mismatch_fails() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let index_data = b"correct content";
    fs::write(root.join("index.html"), index_data).unwrap();

    let manifest_entries = vec![AssetEntry {
        source_url: "https://example.com/index.html".into(),
        path: "index.html".into(),
        content_type: "text/html".into(),
        size: index_data.len() as u64,
        sha256: "a".repeat(64), // Incorrect hash
    }];

    let manifest_path = root.join("assets.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest_entries).unwrap(),
    )
    .unwrap();

    let err = verify_manifest(root, &manifest_path).unwrap_err();
    match err {
        ManifestError::Sha256Mismatch {
            path,
            expected,
            actual,
        } => {
            assert_eq!(path, "index.html");
            assert_eq!(expected, "a".repeat(64));
            assert_eq!(actual, compute_sha256(index_data));
        }
        other => panic!("expected Sha256Mismatch, got {:?}", other),
    }
}

#[test]
fn test_path_escape_fails() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    fs::write(root.join("index.html"), b"index").unwrap();

    let manifest_entries = vec![
        AssetEntry {
            source_url: "https://example.com/index.html".into(),
            path: "index.html".into(),
            content_type: "text/html".into(),
            size: 5,
            sha256: compute_sha256(b"index"),
        },
        AssetEntry {
            source_url: "https://example.com/escape".into(),
            path: "../secret.txt".into(),
            content_type: "text/plain".into(),
            size: 5,
            sha256: "0".repeat(64),
        },
    ];

    let manifest_path = root.join("assets.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest_entries).unwrap(),
    )
    .unwrap();

    let err = verify_manifest(root, &manifest_path).unwrap_err();
    match err {
        ManifestError::InvalidPath { path, .. } => assert_eq!(path, "../secret.txt"),
        other => panic!("expected InvalidPath, got {:?}", other),
    }
}

#[test]
fn test_case_insensitive_duplicate_fails() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    fs::write(root.join("index.html"), b"index").unwrap();
    fs::write(root.join("app.js"), b"app").unwrap();

    let manifest_entries = vec![
        AssetEntry {
            source_url: "https://example.com/index.html".into(),
            path: "index.html".into(),
            content_type: "text/html".into(),
            size: 5,
            sha256: compute_sha256(b"index"),
        },
        AssetEntry {
            source_url: "https://example.com/app.js".into(),
            path: "app.js".into(),
            content_type: "application/javascript".into(),
            size: 3,
            sha256: compute_sha256(b"app"),
        },
        AssetEntry {
            source_url: "https://example.com/APP.JS".into(),
            path: "APP.JS".into(),
            content_type: "application/javascript".into(),
            size: 3,
            sha256: compute_sha256(b"app"),
        },
    ];

    let manifest_path = root.join("assets.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest_entries).unwrap(),
    )
    .unwrap();

    let err = verify_manifest(root, &manifest_path).unwrap_err();
    match err {
        ManifestError::InvalidManifest(msg) => assert!(msg.contains("duplicate")),
        other => panic!("expected InvalidManifest duplicate, got {:?}", other),
    }
}

#[test]
fn test_empty_json_array_fails() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let manifest_path = root.join("assets.json");
    fs::write(&manifest_path, b"[]").unwrap();

    let err = verify_manifest(root, &manifest_path).unwrap_err();
    match err {
        ManifestError::InvalidManifest(msg) => assert!(msg.contains("empty")),
        other => panic!("expected InvalidManifest empty array, got {:?}", other),
    }
}

#[test]
fn test_missing_index_html_fails() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    fs::write(root.join("app.js"), b"app").unwrap();

    let manifest_entries = vec![AssetEntry {
        source_url: "https://example.com/app.js".into(),
        path: "app.js".into(),
        content_type: "application/javascript".into(),
        size: 3,
        sha256: compute_sha256(b"app"),
    }];

    let manifest_path = root.join("assets.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest_entries).unwrap(),
    )
    .unwrap();

    let err = verify_manifest(root, &manifest_path).unwrap_err();
    match err {
        ManifestError::InvalidManifest(msg) => assert!(msg.contains("index.html")),
        other => panic!(
            "expected InvalidManifest index.html required, got {:?}",
            other
        ),
    }
}

#[test]
fn test_oversized_manifest_fails() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let manifest_path = root.join("assets.json");
    // Write 16MiB + 1 byte
    let file = File::create(&manifest_path).unwrap();
    file.set_len(16 * 1024 * 1024 + 1).unwrap();

    let err = verify_manifest(root, &manifest_path).unwrap_err();
    match err {
        ManifestError::InvalidManifest(msg) => assert!(msg.contains("16MiB")),
        other => panic!("expected InvalidManifest for >16MiB file, got {:?}", other),
    }
}

#[test]
fn test_manifest_outside_root_fails() {
    let root_dir = tempdir().unwrap();
    let outside_dir = tempdir().unwrap();

    let outside_manifest = outside_dir.path().join("assets.json");
    fs::write(&outside_manifest, b"[]").unwrap();

    let err = verify_manifest(root_dir.path(), &outside_manifest).unwrap_err();
    match err {
        ManifestError::InvalidManifest(msg) => assert!(msg.contains("escapes root")),
        other => panic!("expected InvalidManifest for outside root, got {:?}", other),
    }
}

#[test]
fn test_invalid_sha256_format_fails() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("index.html"), b"index").unwrap();

    // Uppercase hex must fail
    let manifest_entries = vec![AssetEntry {
        source_url: "https://example.com/index.html".into(),
        path: "index.html".into(),
        content_type: "text/html".into(),
        size: 5,
        sha256: compute_sha256(b"index").to_ascii_uppercase(),
    }];

    let manifest_path = root.join("assets.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest_entries).unwrap(),
    )
    .unwrap();

    let err = verify_manifest(root, &manifest_path).unwrap_err();
    match err {
        ManifestError::InvalidManifest(msg) => assert!(msg.contains("sha256")),
        other => panic!(
            "expected InvalidManifest for uppercase sha256, got {:?}",
            other
        ),
    }
}

#[test]
fn test_content_type_control_char_fails() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("index.html"), b"index").unwrap();

    let manifest_entries = vec![AssetEntry {
        source_url: "https://example.com/index.html".into(),
        path: "index.html".into(),
        content_type: "text/html\r\n".into(),
        size: 5,
        sha256: compute_sha256(b"index"),
    }];

    let manifest_path = root.join("assets.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest_entries).unwrap(),
    )
    .unwrap();

    let err = verify_manifest(root, &manifest_path).unwrap_err();
    match err {
        ManifestError::InvalidManifest(msg) => assert!(msg.contains("contentType")),
        other => panic!(
            "expected InvalidManifest for control characters, got {:?}",
            other
        ),
    }
}

#[test]
fn test_windows_reserved_device_name_fails() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("index.html"), b"index").unwrap();

    let manifest_entries = vec![
        AssetEntry {
            source_url: "https://example.com/index.html".into(),
            path: "index.html".into(),
            content_type: "text/html".into(),
            size: 5,
            sha256: compute_sha256(b"index"),
        },
        AssetEntry {
            source_url: "https://example.com/aux.js".into(),
            path: "aux.js".into(),
            content_type: "application/javascript".into(),
            size: 5,
            sha256: "0".repeat(64),
        },
    ];

    let manifest_path = root.join("assets.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest_entries).unwrap(),
    )
    .unwrap();

    let err = verify_manifest(root, &manifest_path).unwrap_err();
    match err {
        ManifestError::InvalidPath { path, reason } => {
            assert_eq!(path, "aux.js");
            assert!(reason.contains("reserved"));
        }
        other => panic!(
            "expected InvalidPath for windows reserved name, got {:?}",
            other
        ),
    }
}
