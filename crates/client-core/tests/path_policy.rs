use std::fs;
use tempfile::tempdir;

use ashfall_client_core::path_policy::{resolve_file, PathError};

#[test]
fn test_status_codes() {
    assert_eq!(PathError::Invalid("bad".into()).status_code(), 400);
    assert_eq!(PathError::Forbidden("no".into()).status_code(), 403);
    assert_eq!(PathError::NotFound("missing".into()).status_code(), 404);
    let io_err = std::io::Error::new(std::io::ErrorKind::Other, "disk error");
    assert_eq!(PathError::Io(io_err).status_code(), 500);
}

#[test]
fn test_resolve_root_to_index_html() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let index_file = root.join("index.html");
    fs::write(&index_file, "hello world").unwrap();

    let resolved = resolve_file(root, "/").expect("should resolve / to index.html");
    assert_eq!(resolved, index_file.canonicalize().unwrap());

    let resolved_empty = resolve_file(root, "").expect("should resolve empty string to index.html");
    assert_eq!(resolved_empty, index_file.canonicalize().unwrap());
}

#[test]
fn test_resolve_root_index_html_not_found() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let err = resolve_file(root, "/").unwrap_err();
    match err {
        PathError::NotFound(_) => {}
        other => panic!("expected NotFound, got {:?}", other),
    }
}

#[test]
fn test_resolve_normal_file() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let sub = root.join("assets");
    fs::create_dir_all(&sub).unwrap();
    let file = sub.join("app.js");
    fs::write(&file, "console.log('hi');").unwrap();

    let resolved = resolve_file(root, "/assets/app.js").expect("valid file should resolve");
    assert_eq!(resolved, file.canonicalize().unwrap());
}

#[test]
fn test_resolve_chinese_and_spaces() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let sub = root.join("测试 目录");
    fs::create_dir_all(&sub).unwrap();
    let file = sub.join("测试 文件.txt");
    fs::write(&file, "chinese content").unwrap();

    // Raw utf-8 with spaces
    let resolved = resolve_file(root, "/测试 目录/测试 文件.txt").expect("raw utf8 with space");
    assert_eq!(resolved, file.canonicalize().unwrap());

    // URL encoded
    let resolved_encoded = resolve_file(
        root,
        "/%E6%B5%8B%E8%AF%95%20%E7%9B%AE%E5%BD%95/%E6%B5%8B%E8%AF%95%20%E6%96%87%E4%BB%B6.txt",
    )
    .expect("url-encoded utf8 with %20");
    assert_eq!(resolved_encoded, file.canonicalize().unwrap());
}

#[test]
fn test_directory_access_forbidden() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let sub = root.join("folder");
    fs::create_dir_all(&sub).unwrap();

    let err = resolve_file(root, "/folder").unwrap_err();
    match err {
        PathError::Forbidden(_) => {}
        other => panic!("expected Forbidden for directory, got {:?}", other),
    }

    let err_slash = resolve_file(root, "/folder/").unwrap_err();
    match err_slash {
        PathError::Forbidden(_) => {}
        other => panic!("expected Forbidden for directory with trailing slash, got {:?}", other),
    }
}

#[test]
fn test_missing_file_not_found() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let err = resolve_file(root, "/nonexistent.txt").unwrap_err();
    match err {
        PathError::NotFound(_) => {}
        other => panic!("expected NotFound, got {:?}", other),
    }
}

#[test]
fn test_reject_percent_traversal() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // %2e%2e is ..
    let err = resolve_file(root, "/%2e%2e/secret.txt").unwrap_err();
    match err {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for %2e%2e, got {:?}", other),
    }

    let err2 = resolve_file(root, "/dir/%2e%2e/secret.txt").unwrap_err();
    match err2 {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for relative %2e%2e, got {:?}", other),
    }
}

#[test]
fn test_reject_backslash() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let err = resolve_file(root, "/assets\\app.js").unwrap_err();
    match err {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for backslash, got {:?}", other),
    }

    // %5c is backslash
    let err2 = resolve_file(root, "/assets%5capp.js").unwrap_err();
    match err2 {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for %5c, got {:?}", other),
    }
}

#[test]
fn test_reject_ads_colon() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let err = resolve_file(root, "/file.txt:stream").unwrap_err();
    match err {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for colon (ADS), got {:?}", other),
    }

    // %3a is colon
    let err2 = resolve_file(root, "/file.txt%3astream").unwrap_err();
    match err2 {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for %3a, got {:?}", other),
    }
}

#[test]
fn test_reject_nul_byte() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let err = resolve_file(root, "/file.txt\0.js").unwrap_err();
    match err {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for NUL byte, got {:?}", other),
    }

    // %00 is NUL
    let err2 = resolve_file(root, "/file.txt%00.js").unwrap_err();
    match err2 {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for %00, got {:?}", other),
    }
}

#[test]
fn test_reject_double_encoding() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // %252e%252e decodes to %2e%2e, containing '%'
    let err = resolve_file(root, "/%252e%252e/passwords.txt").unwrap_err();
    match err {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for double encoding, got {:?}", other),
    }

    // %2520 decodes to %20
    let err2 = resolve_file(root, "/hello%2520world.txt").unwrap_err();
    match err2 {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for double encoding %2520, got {:?}", other),
    }
}

#[test]
fn test_reject_non_normal_components() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let err = resolve_file(root, "/./test.txt").unwrap_err();
    match err {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for curdir '.', got {:?}", other),
    }

    let err2 = resolve_file(root, "/a/../b.txt").unwrap_err();
    match err2 {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for parent '..', got {:?}", other),
    }
}

#[test]
fn test_reject_unc_path() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    let err = resolve_file(root, "//server/share/file.txt").unwrap_err();
    match err {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for UNC path, got {:?}", other),
    }
}

#[test]
fn test_support_long_path_multisegment() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // Create 4 nested directories, each of length 70 (< 100), total path > 260
    let seg1 = "a".repeat(70);
    let seg2 = "b".repeat(70);
    let seg3 = "c".repeat(70);
    let seg4 = "d".repeat(70);

    let deep_dir = root.join(&seg1).join(&seg2).join(&seg3).join(&seg4);
    fs::create_dir_all(&deep_dir).expect("should create nested directory");
    let target_file = deep_dir.join("test.txt");
    fs::write(&target_file, "nested content").expect("should create nested file");

    let uri = format!("/{}/{}/{}/{}/test.txt", seg1, seg2, seg3, seg4);
    assert!(uri.len() > 260, "uri length should exceed 260");

    let resolved = resolve_file(root, &uri).expect("multisegment path exceeding 260 chars should resolve");
    assert_eq!(resolved, target_file.canonicalize().unwrap());
}

#[test]
fn test_long_chinese_filename_utf16_limit() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // 90 Chinese characters: UTF-8 length is 270 bytes (> 255), but UTF-16 code units is 90 (<= 255)
    let long_chinese_name = "中".repeat(90) + ".txt";
    let file = root.join(&long_chinese_name);
    fs::write(&file, "chinese long").unwrap();

    let uri = format!("/{}", long_chinese_name);
    let resolved = resolve_file(root, &uri).expect("long chinese filename under 255 UTF-16 units should resolve");
    assert_eq!(resolved, file.canonicalize().unwrap());
}

#[test]
fn test_reject_extended_path_prefix() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // Reject \\?\ or //?/ prefix
    let err = resolve_file(root, r"/\?\test.txt").unwrap_err();
    match err {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for extended prefix, got {:?}", other),
    }

    let err2 = resolve_file(root, "//?/C:/test.txt").unwrap_err();
    match err2 {
        PathError::Invalid(_) => {}
        other => panic!("expected Invalid for //?/ prefix, got {:?}", other),
    }
}

#[test]
fn test_external_symlink_forbidden() {
    let root_dir = tempdir().unwrap();
    let outside_dir = tempdir().unwrap();

    let outside_file = outside_dir.path().join("secret.txt");
    fs::write(&outside_file, "classified").unwrap();

    let link_path = root_dir.path().join("link_to_outside.txt");

    #[cfg(windows)]
    let symlink_res = std::os::windows::fs::symlink_file(&outside_file, &link_path);
    #[cfg(unix)]
    let symlink_res = std::os::unix::fs::symlink(&outside_file, &link_path);

    match symlink_res {
        Ok(_) => {
            let err = resolve_file(root_dir.path(), "/link_to_outside.txt").unwrap_err();
            match err {
                PathError::Forbidden(_) => {}
                other => panic!("expected Forbidden for symlink escaping root, got {:?}", other),
            }
        }
        Err(e) => {
            println!(
                "Symlink creation skipped due to environment permissions: {e} (Windows non-developer mode / unprivileged)"
            );
        }
    }
}
