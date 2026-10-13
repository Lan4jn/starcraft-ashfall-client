use std::collections::BTreeMap;
use std::fs;
use std::sync::Arc;
use tempfile::tempdir;

use ashfall_client_core::data_dir::default_data_dir;
use ashfall_client_core::save::{
    SaveError, SaveLoad, SaveSnapshot, SaveStore, MAX_SAFE_INTEGER, MAX_SAVE_BYTES,
};

#[test]
fn test_full_map_capsule_uuid_and_pointer() {
    let dir = tempdir().unwrap();
    let store = SaveStore::open(dir.path().to_path_buf()).unwrap();

    let mut values = BTreeMap::new();
    values.insert(
        "capsule-uuid-550e8400-e29b-41d4-a716-446655440000".into(),
        r#"{"inventory":["marine_armor","stimpack"],"hp":100}"#.into(),
    );
    values.insert(
        "capsule-pointer-active".into(),
        "550e8400-e29b-41d4-a716-446655440000".into(),
    );
    values.insert("sc-shooter-local-board".into(), r#"[{"score":9999}]"#.into());

    let snapshot = SaveSnapshot {
        schema_version: 1,
        revision: 1,
        saved_at: "2026-10-12T00:00:00Z".into(),
        values: values.clone(),
    };

    assert_eq!(store.commit(snapshot.clone()).unwrap(), 1);

    let loaded = store.load().unwrap();
    match loaded {
        SaveLoad::Valid(loaded_snap) => {
            assert_eq!(loaded_snap, snapshot);
            assert_eq!(loaded_snap.values, values);
        }
        other => panic!("expected SaveLoad::Valid, got {:?}", other),
    }
}

#[test]
fn test_delete_and_clear_empty_map() {
    let dir = tempdir().unwrap();
    let store = SaveStore::open(dir.path().to_path_buf()).unwrap();

    let mut initial_values = BTreeMap::new();
    initial_values.insert("key1".into(), "val1".into());
    initial_values.insert("key2".into(), "val2".into());

    let snap1 = SaveSnapshot {
        schema_version: 1,
        revision: 1,
        saved_at: "2026-10-12T00:00:00Z".into(),
        values: initial_values,
    };
    assert_eq!(store.commit(snap1).unwrap(), 1);

    // Now clear: commit an empty Map
    let snap2 = SaveSnapshot {
        schema_version: 1,
        revision: 2,
        saved_at: "2026-10-12T00:01:00Z".into(),
        values: BTreeMap::new(),
    };
    assert_eq!(store.commit(snap2.clone()).unwrap(), 2);

    match store.load().unwrap() {
        SaveLoad::Valid(loaded) => {
            assert_eq!(loaded.revision, 2);
            assert!(loaded.values.is_empty(), "cleared map must be empty");
        }
        other => panic!("expected Valid, got {:?}", other),
    }
}

#[test]
fn test_size_limit() {
    let dir = tempdir().unwrap();
    let store = SaveStore::open(dir.path().to_path_buf()).unwrap();

    // Create a payload exceeding MAX_SAVE_BYTES (16 MiB)
    let mut values = BTreeMap::new();
    let big_string = "a".repeat(MAX_SAVE_BYTES + 1024);
    values.insert("big_key".into(), big_string);

    let snapshot = SaveSnapshot {
        schema_version: 1,
        revision: 1,
        saved_at: "2026-10-12T00:00:00Z".into(),
        values,
    };

    let err = store.commit(snapshot).unwrap_err();
    match err {
        SaveError::TooLarge(size, max) => {
            assert!(size > MAX_SAVE_BYTES);
            assert_eq!(max, MAX_SAVE_BYTES);
        }
        other => panic!("expected TooLarge, got {:?}", other),
    }
}

#[test]
fn test_schema_and_revision_and_date_constraints() {
    let dir = tempdir().unwrap();
    let store = SaveStore::open(dir.path().to_path_buf()).unwrap();

    // 1. Invalid schema version
    let bad_schema = SaveSnapshot {
        schema_version: 2,
        revision: 1,
        saved_at: "2026-10-12T00:00:00Z".into(),
        values: BTreeMap::new(),
    };
    match store.commit(bad_schema).unwrap_err() {
        SaveError::InvalidSchema(2) => {}
        other => panic!("expected InvalidSchema(2), got {:?}", other),
    }

    // 2. Revision exceeding JS MAX_SAFE_INTEGER
    let bad_revision = SaveSnapshot {
        schema_version: 1,
        revision: MAX_SAFE_INTEGER + 1,
        saved_at: "2026-10-12T00:00:00Z".into(),
        values: BTreeMap::new(),
    };
    match store.commit(bad_revision).unwrap_err() {
        SaveError::InvalidRevision(r) => assert_eq!(r, MAX_SAFE_INTEGER + 1),
        other => panic!("expected InvalidRevision, got {:?}", other),
    }

    // 3. Non-UTC saved_at date (+08:00)
    let non_utc_date = SaveSnapshot {
        schema_version: 1,
        revision: 1,
        saved_at: "2026-10-12T08:00:00+08:00".into(),
        values: BTreeMap::new(),
    };
    match store.commit(non_utc_date).unwrap_err() {
        SaveError::InvalidDate(_) => {}
        other => panic!("expected InvalidDate, got {:?}", other),
    }

    // 4. Malformed date
    let malformed_date = SaveSnapshot {
        schema_version: 1,
        revision: 1,
        saved_at: "not-a-rfc3339-timestamp".into(),
        values: BTreeMap::new(),
    };
    match store.commit(malformed_date).unwrap_err() {
        SaveError::InvalidDate(_) => {}
        other => panic!("expected InvalidDate, got {:?}", other),
    }

    // 5. Valid UTC RFC3339 with milliseconds and Z
    let valid_snapshot = SaveSnapshot {
        schema_version: 1,
        revision: 1,
        saved_at: "2026-10-12T00:00:00.123Z".into(),
        values: BTreeMap::new(),
    };
    assert_eq!(store.commit(valid_snapshot).unwrap(), 1);
}

#[test]
fn test_deny_unknown_fields() {
    let json_with_unknown = r#"{
        "schemaVersion": 1,
        "revision": 1,
        "savedAt": "2026-10-12T00:00:00Z",
        "values": {},
        "extraField": "forbidden"
    }"#;
    let res: Result<SaveSnapshot, _> = serde_json::from_str(json_with_unknown);
    assert!(res.is_err(), "serde deny_unknown_fields must reject extra fields");
}

#[test]
fn test_revision_out_of_order_and_reload_increment() {
    let dir = tempdir().unwrap();
    let store = SaveStore::open(dir.path().to_path_buf()).unwrap();

    let snap5 = SaveSnapshot {
        schema_version: 1,
        revision: 5,
        saved_at: "2026-10-12T00:00:00Z".into(),
        values: BTreeMap::new(),
    };
    assert_eq!(store.commit(snap5.clone()).unwrap(), 5);

    // Commit same revision 5 -> StaleRevision
    match store.commit(snap5).unwrap_err() {
        SaveError::StaleRevision { current, attempted } => {
            assert_eq!(current, 5);
            assert_eq!(attempted, 5);
        }
        other => panic!("expected StaleRevision, got {:?}", other),
    }

    // Commit lower revision 3 -> StaleRevision
    let snap3 = SaveSnapshot {
        schema_version: 1,
        revision: 3,
        saved_at: "2026-10-12T00:00:01Z".into(),
        values: BTreeMap::new(),
    };
    match store.commit(snap3).unwrap_err() {
        SaveError::StaleRevision { current, attempted } => {
            assert_eq!(current, 5);
            assert_eq!(attempted, 3);
        }
        other => panic!("expected StaleRevision, got {:?}", other),
    }

    // Commit higher revision 6 -> Success
    let snap6 = SaveSnapshot {
        schema_version: 1,
        revision: 6,
        saved_at: "2026-10-12T00:00:02Z".into(),
        values: BTreeMap::new(),
    };
    assert_eq!(store.commit(snap6).unwrap(), 6);

    // Reopen store on the same directory
    drop(store);
    let reopened = SaveStore::open(dir.path().to_path_buf()).unwrap();
    match reopened.load().unwrap() {
        SaveLoad::Valid(snap) => assert_eq!(snap.revision, 6),
        other => panic!("expected Valid, got {:?}", other),
    }

    // Attempting stale revision 6 after reload must fail
    let stale_after_reload = SaveSnapshot {
        schema_version: 1,
        revision: 6,
        saved_at: "2026-10-12T00:00:03Z".into(),
        values: BTreeMap::new(),
    };
    match reopened.commit(stale_after_reload).unwrap_err() {
        SaveError::StaleRevision { current, attempted } => {
            assert_eq!(current, 6);
            assert_eq!(attempted, 6);
        }
        other => panic!("expected StaleRevision after reload, got {:?}", other),
    }

    // Commit higher revision 7 -> Success
    let snap7 = SaveSnapshot {
        schema_version: 1,
        revision: 7,
        saved_at: "2026-10-12T00:00:04Z".into(),
        values: BTreeMap::new(),
    };
    assert_eq!(reopened.commit(snap7).unwrap(), 7);
}

#[test]
fn test_two_saves_backup_and_corrupt_primary_recovery() {
    let dir = tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let store = SaveStore::open(root.clone()).unwrap();

    let mut val1 = BTreeMap::new();
    val1.insert("state".into(), "first".into());
    let snap1 = SaveSnapshot {
        schema_version: 1,
        revision: 1,
        saved_at: "2026-10-12T00:00:00Z".into(),
        values: val1,
    };

    let mut val2 = BTreeMap::new();
    val2.insert("state".into(), "second".into());
    let snap2 = SaveSnapshot {
        schema_version: 1,
        revision: 2,
        saved_at: "2026-10-12T00:01:00Z".into(),
        values: val2,
    };

    // First commit
    assert_eq!(store.commit(snap1.clone()).unwrap(), 1);
    // Second commit: backup should now hold snap1, primary holds snap2
    assert_eq!(store.commit(snap2.clone()).unwrap(), 2);

    let save_path = root.join("save.json");
    let prev_path = root.join("save.previous.json");
    assert!(save_path.exists());
    assert!(prev_path.exists());

    // Corrupt save.json
    fs::write(&save_path, b"corrupted garbage content").unwrap();

    // Load must recover from backup
    let load_res = store.load().unwrap();
    match load_res {
        SaveLoad::Recovered(recovered) => {
            assert_eq!(recovered, snap1, "recovered data must match snapshot 1");
        }
        other => panic!("expected Recovered, got {:?}", other),
    }

    // Check isolation: an isolated file matching save.json.corrupt.* must exist
    let entries: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    let corrupt_isolated = entries.iter().any(|name| name.starts_with("save.json.corrupt."));
    assert!(corrupt_isolated, "corrupt save.json must be isolated with timestamp/random suffix: found {:?}", entries);

    // save.json must have been rebuilt as a valid baseline (containing snap1)
    let primary_after_recovery: SaveSnapshot = serde_json::from_slice(&fs::read(&save_path).unwrap()).unwrap();
    assert_eq!(primary_after_recovery, snap1);
}

#[test]
fn test_save_after_recovery_does_not_pollute_backup() {
    let dir = tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let store = SaveStore::open(root.clone()).unwrap();

    let snap1 = SaveSnapshot {
        schema_version: 1,
        revision: 1,
        saved_at: "2026-10-12T00:00:00Z".into(),
        values: [("k".into(), "v1".into())].into(),
    };
    let snap2 = SaveSnapshot {
        schema_version: 1,
        revision: 2,
        saved_at: "2026-10-12T00:01:00Z".into(),
        values: [("k".into(), "v2".into())].into(),
    };

    store.commit(snap1.clone()).unwrap();
    store.commit(snap2).unwrap();

    // Corrupt primary
    let save_path = root.join("save.json");
    fs::write(&save_path, b"corrupted garbage").unwrap();

    // Recover
    match store.load().unwrap() {
        SaveLoad::Recovered(rec) => assert_eq!(rec, snap1),
        other => panic!("expected Recovered, got {:?}", other),
    }

    // Now commit snap3 (revision 3)
    let snap3 = SaveSnapshot {
        schema_version: 1,
        revision: 3,
        saved_at: "2026-10-12T00:02:00Z".into(),
        values: [("k".into(), "v3".into())].into(),
    };
    assert_eq!(store.commit(snap3.clone()).unwrap(), 3);

    // Verify backup contains the valid baseline snap1, NOT corrupt data
    let prev_path = root.join("save.previous.json");
    let prev_content: SaveSnapshot = serde_json::from_slice(&fs::read(&prev_path).unwrap()).unwrap();
    assert_eq!(prev_content, snap1, "backup must contain the valid baseline, not corrupted data");

    // Primary contains snap3
    let current_content: SaveSnapshot = serde_json::from_slice(&fs::read(&save_path).unwrap()).unwrap();
    assert_eq!(current_content, snap3);
}

#[test]
fn test_both_files_corrupt_returns_error_and_does_not_clear() {
    let dir = tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let store = SaveStore::open(root.clone()).unwrap();

    let save_path = root.join("save.json");
    let prev_path = root.join("save.previous.json");

    fs::write(&save_path, b"corrupted primary data").unwrap();
    fs::write(&prev_path, b"corrupted backup data").unwrap();

    let res = store.load();
    match res {
        Err(SaveError::Corrupt(_)) => {}
        other => panic!("expected Corrupt error when both are invalid, got {:?}", other),
    }

    // Crucial: files must NOT be silently cleared or deleted
    assert!(save_path.exists(), "corrupted primary must NOT be deleted");
    assert!(prev_path.exists(), "corrupted backup must NOT be deleted");
    assert_eq!(fs::read(&save_path).unwrap(), b"corrupted primary data");
    assert_eq!(fs::read(&prev_path).unwrap(), b"corrupted backup data");
}

#[test]
fn test_concurrent_commits() {
    let dir = tempdir().unwrap();
    let store = Arc::new(SaveStore::open(dir.path().to_path_buf()).unwrap());

    // Commit initial snapshot
    let initial = SaveSnapshot {
        schema_version: 1,
        revision: 1,
        saved_at: "2026-10-12T00:00:00Z".into(),
        values: BTreeMap::new(),
    };
    store.commit(initial).unwrap();

    let mut handles = Vec::new();
    for thread_idx in 2..=10 {
        let store_clone = Arc::clone(&store);
        let handle = std::thread::spawn(move || {
            let snap = SaveSnapshot {
                schema_version: 1,
                revision: thread_idx,
                saved_at: format!("2026-10-12T00:00:{:02}Z", thread_idx),
                values: [(format!("thread_{}", thread_idx), "done".into())].into(),
            };
            store_clone.commit(snap)
        });
        handles.push(handle);
    }

    for handle in handles {
        let _ = handle.join().unwrap();
    }

    // Verify store is valid and readable
    match store.load().unwrap() {
        SaveLoad::Valid(loaded) => {
            assert!(loaded.revision >= 2);
        }
        other => panic!("expected Valid after concurrency, got {:?}", other),
    }
}

#[test]
fn test_default_data_dir() {
    let dir = default_data_dir().expect("default_data_dir should resolve");
    let s = dir.to_string_lossy();
    assert!(
        s.ends_with("StarCraftAshfallClient"),
        "expected directory to end with StarCraftAshfallClient, got: {}",
        s
    );
}

#[test]
fn test_commit_on_unloaded_corrupt_primary_fails_closed_and_does_not_reset_to_zero() {
    let dir = tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let save_path = root.join("save.json");

    // Pre-existing corrupted save file on disk
    fs::write(&save_path, b"corrupted legacy save data").unwrap();

    let store = SaveStore::open(root).unwrap();

    let snapshot = SaveSnapshot {
        schema_version: 1,
        revision: 1,
        saved_at: "2026-10-12T00:00:00Z".into(),
        values: BTreeMap::new(),
    };

    // Calling commit without load must NOT unwrap_or(0) and must NOT overwrite the corrupted file
    let commit_res = store.commit(snapshot);
    match commit_res {
        Err(SaveError::Corrupt(_)) => {}
        other => panic!("expected Err(SaveError::Corrupt), got {:?}", other),
    }

    // Corrupted file must still exist and must not be overwritten
    assert_eq!(
        fs::read(&save_path).unwrap(),
        b"corrupted legacy save data",
        "unloaded corrupt save must not be overwritten"
    );
}

#[test]
fn test_commit_with_runtime_corrupted_primary_isolates_and_does_not_lose_evidence() {
    let dir = tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let store = SaveStore::open(root.clone()).unwrap();

    let snap1 = SaveSnapshot {
        schema_version: 1,
        revision: 1,
        saved_at: "2026-10-12T00:00:00Z".into(),
        values: [("k".into(), "v1".into())].into(),
    };
    assert_eq!(store.commit(snap1).unwrap(), 1);

    let save_path = root.join("save.json");
    // Simulate runtime external corruption of save.json
    fs::write(&save_path, b"runtime corrupted garbage content").unwrap();

    let snap2 = SaveSnapshot {
        schema_version: 1,
        revision: 2,
        saved_at: "2026-10-12T00:01:00Z".into(),
        values: [("k".into(), "v2".into())].into(),
    };

    // Commit must not silently overwrite without isolating the corrupt file
    assert_eq!(store.commit(snap2.clone()).unwrap(), 2);

    // Verify isolation file exists and contains the corrupted garbage
    let entries: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .filter_map(|e| e.ok())
        .collect();
    let corrupt_isolated = entries
        .iter()
        .find(|e| e.file_name().to_string_lossy().starts_with("save.json.corrupt."));
    assert!(
        corrupt_isolated.is_some(),
        "runtime corrupted save must be isolated before committing new save"
    );
    let corrupt_file_bytes = fs::read(corrupt_isolated.unwrap().path()).unwrap();
    assert_eq!(corrupt_file_bytes, b"runtime corrupted garbage content");

    // The new save.json must contain snap2
    let current: SaveSnapshot = serde_json::from_slice(&fs::read(&save_path).unwrap()).unwrap();
    assert_eq!(current, snap2);
}

