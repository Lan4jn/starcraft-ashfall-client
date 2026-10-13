use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::replace_windows::safe_replace;

pub const MAX_SAVE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_SAFE_INTEGER: u64 = 9007199254740991;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveSnapshot {
    pub schema_version: u32,
    pub revision: u64,
    pub saved_at: String,
    pub values: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveLoad {
    Fresh,
    Valid(SaveSnapshot),
    Recovered(SaveSnapshot),
}

#[derive(Debug, thiserror::Error)]
pub enum SaveError {
    #[error("invalid schema version: expected 1, got {0}")]
    InvalidSchema(u32),
    #[error("save size exceeds maximum allowed size ({0} > {1})")]
    TooLarge(usize, usize),
    #[error("stale revision: current {current}, attempted {attempted}")]
    StaleRevision { current: u64, attempted: u64 },
    #[error("invalid revision {0}: exceeds JavaScript safe integer limit")]
    InvalidRevision(u64),
    #[error("invalid saved_at date: {0}")]
    InvalidDate(String),
    #[error("corrupt save data: {0}")]
    Corrupt(String),
    #[error("failed to isolate corrupted save file: {0}")]
    IsolationFailed(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

fn validate_saved_at(s: &str) -> Result<(), SaveError> {
    let parsed = time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
        .map_err(|e| SaveError::InvalidDate(format!("{}: {}", s, e)))?;
    if parsed.offset() != time::UtcOffset::UTC {
        return Err(SaveError::InvalidDate(format!(
            "saved_at must be in UTC, got offset {:?}",
            parsed.offset()
        )));
    }
    Ok(())
}

fn validate_snapshot(snapshot: &SaveSnapshot) -> Result<(), SaveError> {
    if snapshot.schema_version != crate::SAVE_SCHEMA_VERSION {
        return Err(SaveError::InvalidSchema(snapshot.schema_version));
    }
    if snapshot.revision > MAX_SAFE_INTEGER {
        return Err(SaveError::InvalidRevision(snapshot.revision));
    }
    validate_saved_at(&snapshot.saved_at)?;
    Ok(())
}

fn read_snapshot_file(path: &Path) -> Result<SaveSnapshot, SaveError> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > MAX_SAVE_BYTES as u64 {
        return Err(SaveError::TooLarge(metadata.len() as usize, MAX_SAVE_BYTES));
    }
    let bytes = fs::read(path)?;
    if bytes.len() > MAX_SAVE_BYTES {
        return Err(SaveError::TooLarge(bytes.len(), MAX_SAVE_BYTES));
    }
    let snapshot: SaveSnapshot = serde_json::from_slice(&bytes)
        .map_err(|e| SaveError::Corrupt(format!("json parse error: {}", e)))?;

    if snapshot.schema_version != crate::SAVE_SCHEMA_VERSION {
        return Err(SaveError::InvalidSchema(snapshot.schema_version));
    }
    if snapshot.revision > MAX_SAFE_INTEGER {
        return Err(SaveError::InvalidRevision(snapshot.revision));
    }
    if let Err(e) = validate_saved_at(&snapshot.saved_at) {
        return Err(SaveError::Corrupt(format!("invalid saved_at date: {}", e)));
    }
    Ok(snapshot)
}

fn isolate_corrupt_file(root: &Path, file_path: &Path) -> Result<PathBuf, SaveError> {
    let timestamp = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown_time".into())
        .replace(':', "-");
    let rand_suffix: u32 = rand::random();
    let target_name = format!("save.json.corrupt.{timestamp}.{rand_suffix:08x}");
    let target_path = root.join(&target_name);
    fs::rename(file_path, &target_path).map_err(|e| {
        SaveError::IsolationFailed(format!(
            "failed to isolate corrupt file to {:?}: {}",
            target_path, e
        ))
    })?;
    Ok(target_path)
}

fn write_file_safely(root: &Path, dest: &Path, bytes: &[u8]) -> Result<(), SaveError> {
    let rand_id: u32 = rand::random();
    let temp_name = format!(
        "{}.tmp.{}",
        dest.file_name().unwrap_or_default().to_string_lossy(),
        rand_id
    );
    let temp_path = root.join(&temp_name);

    let write_res = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_res {
        let _ = fs::remove_file(&temp_path);
        return Err(SaveError::Io(e));
    }

    if let Err(e) = safe_replace(&temp_path, dest) {
        let _ = fs::remove_file(&temp_path);
        return Err(SaveError::Io(e));
    }

    Ok(())
}

struct SaveStoreInner {
    confirmed_revision: Option<u64>,
}

pub struct SaveStore {
    root: PathBuf,
    inner: Mutex<SaveStoreInner>,
}

impl SaveStore {
    pub fn open(root: PathBuf) -> Result<Self, SaveError> {
        fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            inner: Mutex::new(SaveStoreInner {
                confirmed_revision: None,
            }),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn load(&self) -> Result<SaveLoad, SaveError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| SaveError::Corrupt("mutex poisoned".into()))?;

        let primary_path = self.root.join("save.json");
        let backup_path = self.root.join("save.previous.json");

        if primary_path.exists() {
            match read_snapshot_file(&primary_path) {
                Ok(snapshot) => {
                    inner.confirmed_revision = Some(snapshot.revision);
                    Ok(SaveLoad::Valid(snapshot))
                }
                Err(primary_err) => {
                    // Primary is corrupt! Check backup.
                    if backup_path.exists() {
                        match read_snapshot_file(&backup_path) {
                            Ok(backup_snapshot) => {
                                // Backup is valid! Isolate the corrupt primary file first.
                                isolate_corrupt_file(&self.root, &primary_path)?;

                                // Rebuild valid primary baseline from backup
                                let backup_bytes = fs::read(&backup_path)?;
                                write_file_safely(&self.root, &primary_path, &backup_bytes)?;

                                inner.confirmed_revision = Some(backup_snapshot.revision);
                                Ok(SaveLoad::Recovered(backup_snapshot))
                            }
                            Err(_) => {
                                // Both files exist and are corrupt!
                                // Do NOT isolate, delete, or clear anything.
                                Err(SaveError::Corrupt(format!(
                                    "both primary and backup save files are corrupt (primary error: {})",
                                    primary_err
                                )))
                            }
                        }
                    } else {
                        // Primary is corrupt and no backup exists. Do not clear.
                        Err(SaveError::Corrupt(format!(
                            "primary save file is corrupt and no backup exists: {}",
                            primary_err
                        )))
                    }
                }
            }
        } else if backup_path.exists() {
            // Primary does not exist, but backup exists
            match read_snapshot_file(&backup_path) {
                Ok(backup_snapshot) => {
                    let backup_bytes = fs::read(&backup_path)?;
                    write_file_safely(&self.root, &primary_path, &backup_bytes)?;
                    inner.confirmed_revision = Some(backup_snapshot.revision);
                    Ok(SaveLoad::Recovered(backup_snapshot))
                }
                Err(_) => Err(SaveError::Corrupt("backup save file is corrupt".into())),
            }
        } else {
            // Neither file exists: fresh store
            inner.confirmed_revision = Some(0);
            Ok(SaveLoad::Fresh)
        }
    }

    pub fn commit(&self, snapshot: SaveSnapshot) -> Result<u64, SaveError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| SaveError::Corrupt("mutex poisoned".into()))?;

        // 1. Validate snapshot schema, safe integer limit, date format
        validate_snapshot(&snapshot)?;

        // 2. Check monotonic revision
        let current_revision = match inner.confirmed_revision {
            Some(rev) => rev,
            None => {
                // If load was not called, inspect primary file if it exists
                let primary_path = self.root.join("save.json");
                if primary_path.exists() {
                    match read_snapshot_file(&primary_path) {
                        Ok(existing) => {
                            inner.confirmed_revision = Some(existing.revision);
                            existing.revision
                        }
                        Err(e) => {
                            return Err(SaveError::Corrupt(format!(
                                "existing primary save file is corrupt: {}",
                                e
                            )));
                        }
                    }
                } else {
                    inner.confirmed_revision = Some(0);
                    0
                }
            }
        };

        if snapshot.revision <= current_revision {
            return Err(SaveError::StaleRevision {
                current: current_revision,
                attempted: snapshot.revision,
            });
        }

        // 3. Serialize and verify size
        let bytes = serde_json::to_vec(&snapshot)?;
        if bytes.len() > MAX_SAVE_BYTES {
            return Err(SaveError::TooLarge(bytes.len(), MAX_SAVE_BYTES));
        }

        let primary_path = self.root.join("save.json");
        let backup_path = self.root.join("save.previous.json");

        // 4. Backup existing valid primary snapshot before replacing, or isolate if corrupt
        if primary_path.exists() {
            match read_snapshot_file(&primary_path) {
                Ok(old_primary_snapshot) => {
                    let old_bytes = serde_json::to_vec(&old_primary_snapshot)?;
                    write_file_safely(&self.root, &backup_path, &old_bytes)?;
                }
                Err(_) => {
                    // Runtime corruption detected on primary_path: isolate evidence before overwriting
                    isolate_corrupt_file(&self.root, &primary_path)?;
                }
            }
        }

        // 5. Safely replace primary file
        write_file_safely(&self.root, &primary_path, &bytes)?;

        // 6. Update confirmed revision
        inner.confirmed_revision = Some(snapshot.revision);
        Ok(snapshot.revision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_replace_fault_injection_preserves_old_primary() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let store = SaveStore::open(root.clone()).unwrap();

        let snap1 = SaveSnapshot {
            schema_version: 1,
            revision: 1,
            saved_at: "2026-10-12T00:00:00Z".into(),
            values: [("state".into(), "good".into())].into(),
        };
        assert_eq!(store.commit(snap1.clone()).unwrap(), 1);

        // Inject replace failure
        crate::replace_windows::set_inject_replace_failure(true);

        let snap2 = SaveSnapshot {
            schema_version: 1,
            revision: 2,
            saved_at: "2026-10-12T00:01:00Z".into(),
            values: [("state".into(), "uncommitted".into())].into(),
        };
        let commit_res = store.commit(snap2);
        assert!(
            commit_res.is_err(),
            "commit must fail under injected replace failure"
        );

        // Disable fault injection
        crate::replace_windows::set_inject_replace_failure(false);

        // Old primary file must remain intact
        match store.load().unwrap() {
            SaveLoad::Valid(snap) => {
                assert_eq!(
                    snap, snap1,
                    "primary file must remain unchanged when replace fails"
                );
            }
            other => panic!("expected Valid(snap1), got {:?}", other),
        }
    }
}
