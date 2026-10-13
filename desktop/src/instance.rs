use fs2::FileExt;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum InstanceError {
    AlreadyRunning,
    Io(std::io::Error),
}

impl std::fmt::Display for InstanceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstanceError::AlreadyRunning => write!(f, "已有另一个游戏客户端实例在运行。"),
            InstanceError::Io(e) => write!(f, "访问单实例锁文件失败: {}", e),
        }
    }
}

impl std::error::Error for InstanceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            InstanceError::AlreadyRunning => None,
            InstanceError::Io(e) => Some(e),
        }
    }
}

impl From<std::io::Error> for InstanceError {
    fn from(err: std::io::Error) -> Self {
        InstanceError::Io(err)
    }
}

/// 跨进程单实例文件排他锁
/// 保持锁文件 `instance.lock` 句柄直至实例退出，不删除文件以避免并发创建/删除竞态。
pub struct InstanceLock {
    _file: File,
    path: PathBuf,
}

impl InstanceLock {
    pub fn acquire(data_dir: &Path) -> Result<Self, InstanceError> {
        fs::create_dir_all(data_dir)?;
        let path = data_dir.join("instance.lock");

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;

        match file.try_lock_exclusive() {
            Ok(()) => Ok(Self { _file: file, path }),
            Err(e) => {
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.raw_os_error() == Some(33) // Windows ERROR_LOCK_VIOLATION
                    || e.raw_os_error() == fs2::lock_contended_error().raw_os_error()
                {
                    Err(InstanceError::AlreadyRunning)
                } else {
                    Err(InstanceError::Io(e))
                }
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}
