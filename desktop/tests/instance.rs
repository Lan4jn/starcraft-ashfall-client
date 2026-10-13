use ashfall_desktop::instance::{InstanceError, InstanceLock};
use tempfile::tempdir;

#[test]
fn single_instance_lock_acquires_and_blocks_second_instance() {
    let dir = tempdir().unwrap();
    let lock_dir = dir.path().to_path_buf();

    // 1. First instance acquires lock successfully
    let first = InstanceLock::acquire(&lock_dir);
    assert!(first.is_ok(), "首次获取单实例锁必须成功");
    let first_lock = first.unwrap();

    let lock_file = lock_dir.join("instance.lock");
    assert!(lock_file.is_file(), "实例锁文件 instance.lock 必须已创建");
    assert_eq!(first_lock.path(), lock_file.as_path());

    // 2. Second instance attempting to acquire in the same dir must fail with AlreadyRunning
    let second = InstanceLock::acquire(&lock_dir);
    assert!(
        matches!(second, Err(InstanceError::AlreadyRunning)),
        "同一目录的第二个实例尝试获取锁必须返回 AlreadyRunning，实际为: {:?}",
        second.err()
    );

    // 3. Drop first lock, then third instance can acquire
    drop(first_lock);
    assert!(
        lock_file.exists(),
        "释放锁后 instance.lock 文件必须保留在磁盘，不得删除文件"
    );

    let third = InstanceLock::acquire(&lock_dir);
    assert!(third.is_ok(), "释放前一个锁后后续实例必须能成功获取锁");
}

#[test]
fn instance_lock_creates_missing_parent_directories() {
    let dir = tempdir().unwrap();
    let nested_dir = dir.path().join("nested").join("deep").join("data");
    assert!(!nested_dir.exists());

    let lock = InstanceLock::acquire(&nested_dir);
    assert!(lock.is_ok(), "即使目标目录不存在也应自动创建并成功获取锁");
    assert!(nested_dir.is_dir(), "目标目录必须已被创建");
    assert!(nested_dir.join("instance.lock").is_file());
}
