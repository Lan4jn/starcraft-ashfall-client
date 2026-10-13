use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_LOG_SIZE: u64 = 2 * 1024 * 1024; // 2 MiB per log file
const MAX_LOG_FILES: usize = 3; // client.log, client.log.1, client.log.2

static LOG_MUTEX: Mutex<()> = Mutex::new(());
static LOG_ERR_SHOWN: AtomicBool = AtomicBool::new(false);

// ============================================================================
// 原生对话框 (Native Windows Message Boxes)
// ============================================================================

/// 原生 Win32 消息提示安全说明：
/// 1. 传入的 UTF-16 字符串均通过 encode_utf16 加上末尾 NUL 终结符构建为连续的内存切片，
///    指针在 MessageBoxW 调用期间始终合法有效。
/// 2. HWND 传入空指针（null），表示无父窗口的桌面级系统/应用模态对话框，由 user32 内部托管。
/// 3. 使用的样式标志（MB_OK, MB_ICONERROR, MB_RETRYCANCEL 等）均为 Windows 标准样式，
///    阻塞当前线程并等待用户交互返回标准响应码（IDRETRY, IDYES 等）。
pub fn show_error(title: &str, message: &str) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
        let title_w: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let msg_w: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                msg_w.as_ptr(),
                title_w.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("[原生错误] {}: {}", title, message);
    }
}

/// 询问是否重试保存退出（Retry: 重试, Cancel: 取消并进一步询问；默认聚焦 Cancel，避免误触）
pub fn ask_retry_or_cancel(title: &str, message: &str) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            IDRETRY, MB_DEFBUTTON2, MB_ICONWARNING, MB_RETRYCANCEL, MessageBoxW,
        };
        let title_w: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let msg_w: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
        let ret = unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                msg_w.as_ptr(),
                title_w.as_ptr(),
                MB_RETRYCANCEL | MB_ICONWARNING | MB_DEFBUTTON2,
            )
        };
        ret == IDRETRY
    }
    #[cfg(not(windows))]
    {
        eprintln!("[原生重试提示] {}: {}", title, message);
        false
    }
}

/// 明确确认是否丢弃未保存进度并退出（Yes: 明确放弃并退出, No: 取消并返回游戏；默认聚焦 No）
pub fn ask_discard(title: &str, message: &str) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            IDYES, MB_DEFBUTTON2, MB_ICONQUESTION, MB_YESNO, MessageBoxW,
        };
        let title_w: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let msg_w: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
        let ret = unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                msg_w.as_ptr(),
                title_w.as_ptr(),
                MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2,
            )
        };
        ret == IDYES
    }
    #[cfg(not(windows))]
    {
        eprintln!("[原生放弃进度提示] {}: {}", title, message);
        false
    }
}

// ============================================================================
// 日志与轮转 (Logging with Rotation)
// ============================================================================

/// 将错误阶段与信息写入日志（最多保留 3 个文件，每个不超过 2MiB，循环轮转）。
/// 严格过滤敏感信息（禁止记录引导令牌、会话秘钥或完整快照正文）。
/// 全局加锁以消除并发写入与文件轮转竞态。
pub fn append_log(data_dir: &Path, stage: &str, raw_message: &str) {
    let _guard = LOG_MUTEX.lock().unwrap_or_else(|p| p.into_inner());

    let logs_dir = data_dir.join("logs");
    if let Err(e) = fs::create_dir_all(&logs_dir) {
        if !LOG_ERR_SHOWN.swap(true, Ordering::SeqCst) {
            show_error(
                "日志目录无法创建",
                &format!(
                    "无法在数据目录中创建日志文件夹:\n{:?}\n错误: {}",
                    logs_dir, e
                ),
            );
        }
        return;
    }

    let safe_stage = truncate_utf8(stage, 64);
    let sanitized = sanitize_message(raw_message);
    let timestamp = current_timestamp_utc();
    let line = format!("[{timestamp}] [{safe_stage}] {sanitized}\n");
    let line_bytes = line.as_bytes();

    let primary_log = logs_dir.join("client.log");

    // 检查是否需要触发日志轮转
    if let Ok(meta) = fs::metadata(&primary_log)
        && meta.len() + (line_bytes.len() as u64) > MAX_LOG_SIZE
    {
        rotate_logs(&logs_dir);
    }

    let mut file = match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&primary_log)
    {
        Ok(f) => f,
        Err(e) => {
            if !LOG_ERR_SHOWN.swap(true, Ordering::SeqCst) {
                show_error(
                    "日志文件打开失败",
                    &format!(
                        "无法打开日志文件:\n{:?}\n错误: {}\n\n待记录信息: {}",
                        primary_log, e, line
                    ),
                );
            }
            return;
        }
    };

    if let Err(e) = file.write_all(line_bytes)
        && !LOG_ERR_SHOWN.swap(true, Ordering::SeqCst)
    {
        show_error(
            "日志写入失败",
            &format!("无法向日志文件写入数据:\n{:?}\n错误: {}", primary_log, e),
        );
    }
}

/// 执行日志文件轮转：保留至多 3 个文件 (client.log, client.log.1, client.log.2)
fn rotate_logs(logs_dir: &Path) {
    let oldest = logs_dir.join(format!("client.log.{}", MAX_LOG_FILES - 1));
    if oldest.exists() {
        let _ = fs::remove_file(&oldest);
    }

    for i in (1..MAX_LOG_FILES - 1).rev() {
        let from = logs_dir.join(format!("client.log.{i}"));
        let to = logs_dir.join(format!("client.log.{}", i + 1));
        if from.exists() {
            let _ = fs::rename(&from, &to);
        }
    }

    let primary = logs_dir.join("client.log");
    let first_backup = logs_dir.join("client.log.1");
    if primary.exists() {
        let _ = fs::rename(&primary, &first_backup);
    }
}

/// 在 UTF-8 字符边界安全截断字符串，防止因切分多字节字符而 panic
fn truncate_utf8(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let boundary = s
        .char_indices()
        .map(|(idx, _)| idx)
        .take_while(|&idx| idx <= max_bytes)
        .last()
        .unwrap_or(0);
    &s[..boundary]
}

/// 抹除日志中可能携带的一次性引导令牌或完整 URL
pub fn sanitize_message(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut remaining = message;

    while let Some(idx) = remaining.find("/__bootstrap/") {
        out.push_str(&remaining[..idx]);
        out.push_str("/__bootstrap/[REDACTED]");
        let after = &remaining[idx + "/__bootstrap/".len()..];
        // 跳过令牌字符（字母数字等直到分隔符或空格）
        let token_len = after
            .find(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
            .unwrap_or(after.len());
        remaining = &after[token_len..];
    }
    out.push_str(remaining);

    // 截断超长快照正文，防止单行日志过大或泄露完整存档数据
    if out.len() > 2048 {
        let truncated = truncate_utf8(&out, 2048);
        format!("{}... [日志内容过长已截断]", truncated)
    } else {
        out
    }
}

/// 获取 UTC 时间戳字符串 (YYYY-MM-DD HH:MM:SS UTC)
fn current_timestamp_utc() -> String {
    let now = std::time::SystemTime::now();
    let dur = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = dur.as_secs();

    let sec = total_secs % 60;
    let total_mins = total_secs / 60;
    let min = total_mins % 60;
    let total_hours = total_mins / 60;
    let hour = total_hours % 24;
    let days = total_hours / 24;

    // Gregorian calendar calculation
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02} {hour:02}:{min:02}:{sec:02} UTC")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn sanitize_redacts_bootstrap_tokens() {
        let input =
            "Server bootstrap url: http://127.0.0.1:12345/__bootstrap/abcdef0123456789 and more";
        let cleaned = sanitize_message(input);
        assert!(!cleaned.contains("abcdef0123456789"));
        assert!(cleaned.contains("/__bootstrap/[REDACTED]"));
        assert!(cleaned.contains("and more"));
    }

    #[test]
    fn sanitize_handles_chinese_utf8_truncation_without_panic() {
        let input = "中".repeat(1000); // 3000 bytes
        let cleaned = sanitize_message(&input);
        assert!(cleaned.contains("[日志内容过长已截断]"));
        assert!(cleaned.starts_with("中"));
    }

    #[test]
    fn log_rotation_limits_files_and_size() {
        let dir = tempdir().unwrap();
        let logs_dir = dir.path().join("logs");
        fs::create_dir_all(&logs_dir).unwrap();

        let primary_log = logs_dir.join("client.log");

        // 1. 预置接近 2MiB 的日志文件
        let prefill = vec![b'A'; (MAX_LOG_SIZE - 50) as usize];
        fs::write(&primary_log, &prefill).unwrap();

        // 2. 追加一条日志触发第一次轮转 (client.log -> client.log.1)
        append_log(dir.path(), "stage_1", "trigger rotate 1");
        assert!(logs_dir.join("client.log").exists());
        assert!(logs_dir.join("client.log.1").exists());

        // 3. 再次填充 client.log 并追加，触发第二次轮转 (client.log.1 -> client.log.2)
        fs::write(&primary_log, &prefill).unwrap();
        append_log(dir.path(), "stage_2", "trigger rotate 2");
        assert!(logs_dir.join("client.log").exists());
        assert!(logs_dir.join("client.log.1").exists());
        assert!(logs_dir.join("client.log.2").exists());

        // 4. 第三次轮转，client.log.2 应当被覆盖，绝不生成 client.log.3
        fs::write(&primary_log, &prefill).unwrap();
        append_log(dir.path(), "stage_3", "trigger rotate 3");
        assert!(logs_dir.join("client.log").exists());
        assert!(logs_dir.join("client.log.1").exists());
        assert!(logs_dir.join("client.log.2").exists());
        assert!(!logs_dir.join("client.log.3").exists());

        // 5. 校验每个文件大小均 <= MAX_LOG_SIZE (2MiB)
        for i in 0..MAX_LOG_FILES {
            let name = if i == 0 {
                "client.log".to_string()
            } else {
                format!("client.log.{i}")
            };
            let path = logs_dir.join(name);
            if path.exists() {
                let size = fs::metadata(&path).unwrap().len();
                assert!(
                    size <= MAX_LOG_SIZE,
                    "文件 {:?} 大小 {} 超过了上限 {}",
                    path,
                    size,
                    MAX_LOG_SIZE
                );
            }
        }
    }
}
