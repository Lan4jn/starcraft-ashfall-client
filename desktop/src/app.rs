use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub struct AppState {
    pub store: Arc<ashfall_client_core::save::SaveStore>,
    pub origin: String,
    pub data_dir: PathBuf,
    pub last_revision: AtomicU64,
    pub close_state: Mutex<CloseState>,
}

pub struct CloseState {
    pub current_attempt: u64,
    pub machine: crate::lifecycle::CloseMachine,
    pub is_pending: bool,
    pub prompt_active: bool,
}

// ============================================================================
// IPC 命令实现 (Commands)
// ============================================================================

#[tauri::command]
async fn save_snapshot(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
    snapshot: ashfall_client_core::save::SaveSnapshot,
) -> Result<u64, String> {
    let current_url = window.url().map_err(|e| e.to_string())?.to_string();
    if !crate::commands::authorized_source(window.label(), &current_url, &state.origin) {
        return Err("未授权的调用来源或窗口".into());
    }

    let store = state.store.clone();
    let rev = tauri::async_runtime::spawn_blocking(move || store.commit(snapshot))
        .await
        .map_err(|e| format!("存档任务调度失败: {e}"))?
        .map_err(|e| format!("存档提交失败: {e}"))?;

    state.last_revision.fetch_max(rev, Ordering::SeqCst);
    Ok(rev)
}

#[tauri::command]
async fn flush_failed(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
    message: String,
) -> Result<(), String> {
    let current_url = window.url().map_err(|e| e.to_string())?.to_string();
    if !crate::commands::authorized_source(window.label(), &current_url, &state.origin) {
        return Err("未授权的调用来源或窗口".into());
    }

    // 记录日志，但不弹出重复的模态窗口以免打扰游戏或在 100ms 防抖中反复阻塞
    crate::native::append_log(&state.data_dir, "flush_failed", &message);
    Ok(())
}

#[tauri::command]
async fn toggle_fullscreen(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let current_url = window.url().map_err(|e| e.to_string())?.to_string();
    if !crate::commands::authorized_source(window.label(), &current_url, &state.origin) {
        return Err("未授权的调用来源或窗口".into());
    }

    let is_fullscreen = window
        .is_fullscreen()
        .map_err(|e| format!("获取全屏状态失败: {e}"))?;
    window
        .set_fullscreen(!is_fullscreen)
        .map_err(|e| format!("设置全屏状态失败: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn close_ready(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
    attempt: u64,
    revision: u64,
) -> Result<(), String> {
    let current_url = window.url().map_err(|e| e.to_string())?.to_string();
    if !crate::commands::authorized_source(window.label(), &current_url, &state.origin) {
        return Err("未授权的调用来源或窗口".into());
    }

    let (should_destroy, mismatch_reason) = {
        let mut cs = state.close_state.lock().unwrap();
        if cs.current_attempt == attempt && cs.is_pending && !cs.prompt_active {
            let expected_rev = state.last_revision.load(Ordering::SeqCst);
            if revision != expected_rev {
                // 版本不匹配：不在此处重置 is_pending，保留状态交由 handle_close_timeout_or_failure 统一转换并弹窗
                (
                    false,
                    Some(format!(
                        "存档版本校验不一致: 前端提供 {revision}, 后端确认 {expected_rev}"
                    )),
                )
            } else {
                cs.machine.confirm_saved();
                cs.is_pending = false;
                (true, None)
            }
        } else {
            return Ok(()); // 过期或已处理的 attempt，忽略
        }
    };

    if should_destroy {
        if let Err(e) = window.destroy() {
            crate::native::append_log(
                &state.data_dir,
                "destroy_failed",
                &format!("关闭确认后销毁窗口失败: {e}"),
            );
            {
                let mut cs = state.close_state.lock().unwrap();
                cs.is_pending = false;
                cs.prompt_active = false;
            }
            handle_close_timeout_or_failure(
                state.inner().clone(),
                window,
                attempt,
                format!("销毁窗口失败: {e}"),
            );
            return Err(format!("销毁窗口失败: {e}"));
        }
    } else if let Some(reason) = mismatch_reason {
        handle_close_timeout_or_failure(state.inner().clone(), window, attempt, reason);
    }
    Ok(())
}

#[tauri::command]
async fn close_failed(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
    attempt: u64,
    message: String,
) -> Result<(), String> {
    let current_url = window.url().map_err(|e| e.to_string())?.to_string();
    if !crate::commands::authorized_source(window.label(), &current_url, &state.origin) {
        return Err("未授权的调用来源或窗口".into());
    }

    handle_close_timeout_or_failure(state.inner().clone(), window, attempt, message);
    Ok(())
}

// ============================================================================
// 关闭握手与超时处理
// ============================================================================

fn start_close_attempt(state: Arc<AppState>, window: tauri::WebviewWindow) {
    let attempt = {
        let mut cs = state.close_state.lock().unwrap();
        if cs.is_pending || cs.prompt_active {
            return; // 正在等待当前 attempt 或正在显示原生对话框，不重复触发
        }
        cs.current_attempt += 1;
        cs.is_pending = true;
        cs.machine.request();
        cs.current_attempt
    };

    // 必须使用 tauri::async_runtime::spawn，因为 WindowEvent 运行在主 UI 线程，无 Tokio ambient 上下文
    let state_timer = state.clone();
    let window_timer = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        handle_close_timeout_or_failure(
            state_timer,
            window_timer,
            attempt,
            "保存进度超时（超过 5 秒未响应）".to_string(),
        );
    });

    // 调用前端退出脚本：设置标志、阻拦输入、冻结并 flush
    let js = format!(
        r#"(() => {{
  window.__ASHFALL_CLOSING__ = true;
  let overlay = document.getElementById('__ashfall_close_overlay__');
  if (!overlay) {{
    overlay = document.createElement('div');
    overlay.id = '__ashfall_close_overlay__';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999999;background:rgba(0,0,0,0.1);cursor:wait;pointer-events:all;';
    document.documentElement.appendChild(overlay);
  }}
  const rawInvoke = window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke;
  const bridge = window.__ASHFALL_BRIDGE__;
  const attempt = {attempt};
  (async () => {{
    try {{
      if (!bridge) {{
        throw new Error('桌面存档桥接未安装，无法安全验证存档');
      }}
      await bridge.freeze();
      while (bridge.isDirty()) {{
        await bridge.flush();
      }}
      const revision = bridge.getRevision();
      if (rawInvoke) {{
        await rawInvoke('close_ready', {{ attempt, revision }});
      }}
    }} catch (err) {{
      const message = (err && err.message) ? err.message : String(err);
      if (rawInvoke) {{
        await rawInvoke('close_failed', {{ attempt, message }});
      }}
    }}
  }})();
}})();"#
    );

    let _ = window.eval(&js);
}

fn handle_close_timeout_or_failure(
    state: Arc<AppState>,
    window: tauri::WebviewWindow,
    attempt: u64,
    reason: String,
) {
    // 弹窗包含阻塞式 MessageBoxW，必须在 spawn_blocking 中执行，避免阻塞 Tokio 异步工作线程
    tauri::async_runtime::spawn_blocking(move || {
        handle_close_timeout_or_failure_sync(state, window, attempt, &reason);
    });
}

fn handle_close_timeout_or_failure_sync(
    state: Arc<AppState>,
    window: tauri::WebviewWindow,
    attempt: u64,
    reason: &str,
) {
    let should_prompt = {
        let mut cs = state.close_state.lock().unwrap();
        if cs.current_attempt == attempt && cs.is_pending && !cs.prompt_active {
            cs.machine.failed();
            cs.is_pending = false;
            cs.prompt_active = true;
            true
        } else {
            false
        }
    };

    if !should_prompt {
        return;
    }

    crate::native::append_log(&state.data_dir, "close_failed", reason);

    // 第一层弹窗：询问重试还是取消
    let retry = crate::native::ask_retry_or_cancel(
        "星际争霸：余烬 - 退出提示",
        &format!(
            "保存游戏进度失败或超时（原因: {reason}）。\n\n点击【重试】将重新尝试保存进度并退出；\n点击【取消】将进一步询问是否放弃进度直接退出。"
        ),
    );

    // 弹窗返回后再次检查 attempt 是否与当前一致
    {
        let cs = state.close_state.lock().unwrap();
        if cs.current_attempt != attempt {
            return;
        }
    }

    if retry {
        {
            let mut cs = state.close_state.lock().unwrap();
            cs.prompt_active = false;
        }
        start_close_attempt(state, window);
    } else {
        // 第二层弹窗：明确询问是否放弃未保存进度退出
        let discard = crate::native::ask_discard(
            "星际争霸：余烬 - 确认放弃进度",
            "是否放弃未保存的游戏进度并强制退出？\n\n【是】：放弃未保存进度并直接退出游戏。\n【否】：取消退出，返回游戏继续游玩。",
        );

        {
            let mut cs = state.close_state.lock().unwrap();
            if cs.current_attempt != attempt {
                return;
            }
            cs.prompt_active = false;

            if discard {
                cs.machine.discard();
            } else {
                cs.machine.cancel();
            }
        }

        if discard {
            if let Err(e) = window.destroy() {
                crate::native::append_log(
                    &state.data_dir,
                    "destroy_failed",
                    &format!("明确放弃后销毁窗口失败: {e}"),
                );
                {
                    let mut cs = state.close_state.lock().unwrap();
                    cs.is_pending = false;
                    cs.prompt_active = false;
                }
                crate::native::show_error(
                    "星际争霸：余烬 - 退出失败",
                    &format!("强制销毁窗口失败: {e}，请尝试使用任务管理器结束进程。"),
                );
            }
        } else {
            // 恢复前端运行状态并移除遮罩
            let _ = window.eval(
                "if (typeof window.__ASHFALL_RESUME__ === 'function') { window.__ASHFALL_RESUME__(); } const o = document.getElementById('__ashfall_close_overlay__'); if (o) o.remove();",
            );
        }
    }
}

// ============================================================================
// 主应用入口 (App Run)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClientRunMode {
    Normal,
    Fixture,
    ValidateGame,
}

fn resolve_local_app_data(subfolder: &str) -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE").map(|u| PathBuf::from(u).join("AppData").join("Local"))
        })
        .unwrap_or_else(|| PathBuf::from("."))
        .join(subfolder)
}

pub fn run() -> Result<(), String> {
    // 1. 命令行参数解析：--fixture 与 --validate-game 仅在调试构建 (debug_assertions) 下接受且互斥
    let args: Vec<String> = std::env::args().collect();
    let run_mode = if cfg!(debug_assertions) {
        let mut selected_mode = ClientRunMode::Normal;
        for arg in args.iter().skip(1) {
            match arg.as_str() {
                "--fixture" => {
                    if selected_mode != ClientRunMode::Normal {
                        return Err(
                            "命令行参数冲突或重复: --fixture 与 --validate-game 互斥且不可重复指定。"
                                .into(),
                        );
                    }
                    selected_mode = ClientRunMode::Fixture;
                }
                "--validate-game" => {
                    if selected_mode != ClientRunMode::Normal {
                        return Err(
                            "命令行参数冲突或重复: --fixture 与 --validate-game 互斥且不可重复指定。"
                                .into(),
                        );
                    }
                    selected_mode = ClientRunMode::ValidateGame;
                }
                _ => {
                    return Err(format!(
                        "未知命令行参数: {arg}。仅在调试模式下接受 --fixture 或 --validate-game 参数。"
                    ));
                }
            }
        }
        selected_mode
    } else {
        if args.len() > 1 {
            return Err("正式发布版本不接受命令行参数。".into());
        }
        ClientRunMode::Normal
    };

    let is_test = matches!(
        run_mode,
        ClientRunMode::Fixture | ClientRunMode::ValidateGame
    );

    // 2. 确定游戏资源根目录、数据目录与调试参数
    let (game_root, data_dir) = match run_mode {
        ClientRunMode::Fixture => {
            // 使用编译期常量 CARGO_MANIFEST_DIR，避免跨工作目录启动进程时路径解析失效
            let manifest_game =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/game");
            let probe_data = resolve_local_app_data("StarCraftAshfallClientProbe");
            (manifest_game, probe_data)
        }
        ClientRunMode::ValidateGame => {
            // 读取可执行文件同级目录下的 game 目录，用于在隔离工作区中执行端到端真实资源验证
            let current_exe =
                std::env::current_exe().map_err(|e| format!("获取程序路径失败: {e}"))?;
            let real_game = current_exe
                .parent()
                .ok_or_else(|| "无法获取当前程序所在目录".to_string())?
                .join("game");
            let val_data = resolve_local_app_data("StarCraftAshfallClientValidation");
            (real_game, val_data)
        }
        ClientRunMode::Normal => {
            let current_exe =
                std::env::current_exe().map_err(|e| format!("获取程序路径失败: {e}"))?;
            let real_game = current_exe
                .parent()
                .ok_or_else(|| "无法获取当前程序所在目录".to_string())?
                .join("game");
            let normal_data = ashfall_client_core::data_dir::default_data_dir()
                .map_err(|e| format!("获取数据目录失败: {e}"))?;
            (real_game, normal_data)
        }
    };

    let cdp_args = if cfg!(debug_assertions) && is_test {
        if let Ok(port_str) = std::env::var("ASHFALL_FIXTURE_DEBUG_PORT") {
            if let Ok(port) = port_str.trim().parse::<u16>() {
                if (1..=65535).contains(&port) {
                    Some(format!(
                        "--remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
                    ))
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    // 3. 校验游戏资源目录与 index.html 是否就绪
    let canonical_game_root = match game_root.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            return Err(format!(
                "未找到游戏资源目录:\n{:?}\n错误: {}\n\n请确认游戏文件完整放置在客户端 game 目录下。",
                game_root, e
            ));
        }
    };

    if !canonical_game_root.is_dir() || !canonical_game_root.join("index.html").is_file() {
        return Err(format!(
            "游戏资源目录缺失或缺少 index.html:\n{:?}\n\n请确认资源完整后再启动客户端。",
            canonical_game_root
        ));
    }

    // 完整资产清单校验（非 Fixture 模式下强制执行，在独立工作线程中运行流式哈希校验）
    if run_mode != ClientRunMode::Fixture {
        let root_for_verify = canonical_game_root.clone();
        let manifest_path = canonical_game_root.join("assets.json");

        let verify_result = std::thread::spawn(move || {
            ashfall_client_core::manifest::verify_manifest(&root_for_verify, &manifest_path)
        })
        .join()
        .map_err(|_| "资产完整性校验线程执行异常".to_string())?;

        if let Err(e) = verify_result {
            let msg = format!(
                "游戏资源完整性校验失败: {e}。\n请确认 assets.json 资源清单与游戏素材完整无损坏。"
            );
            crate::native::append_log(&data_dir, "manifest_verify_error", &msg);
            return Err(msg);
        }
    }

    // 4. 获取单实例排他文件锁
    let lock = match crate::instance::InstanceLock::acquire(&data_dir) {
        Ok(l) => l,
        Err(crate::instance::InstanceError::AlreadyRunning) => {
            return Err("已有另一个游戏客户端实例在运行中，请勿重复打开。".into());
        }
        Err(crate::instance::InstanceError::Io(e)) => {
            return Err(format!("锁定单实例文件失败: {e}"));
        }
    };

    // 5. 创建独立浏览器 Profile 子目录
    let profile_dir = data_dir.join("profile");
    if let Err(e) = std::fs::create_dir_all(&profile_dir) {
        return Err(format!(
            "无法创建浏览器配置文件目录:\n{:?}\n错误: {}",
            profile_dir, e
        ));
    }

    // 6. 创建 Tokio 运行时并注入 Tauri
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("启动 Tokio 运行时失败: {e}"))?;
    tauri::async_runtime::set(rt.handle().clone());

    // 7. 打开存档存储并加载基线
    let store = match ashfall_client_core::save::SaveStore::open(data_dir.clone()) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            return Err(format!("打开存档存储失败:\n{:?}\n错误: {}", data_dir, e));
        }
    };

    let (seed, initial_revision) = match store.load() {
        Ok(ashfall_client_core::save::SaveLoad::Valid(snap)) => (Some(snap.clone()), snap.revision),
        Ok(ashfall_client_core::save::SaveLoad::Recovered(snap)) => {
            crate::native::append_log(&data_dir, "save_load", "主存档损坏，已从备份恢复");
            (Some(snap.clone()), snap.revision)
        }
        Ok(ashfall_client_core::save::SaveLoad::Fresh) => (None, 0),
        Err(e) => {
            let msg = format!("加载游戏存档失败（主存档与备份均损坏）:\n{}", e);
            crate::native::append_log(&data_dir, "save_load_error", &msg);
            return Err(msg);
        }
    };

    // 8. 启动回环 HTTP 服务
    let server = match rt.block_on(ashfall_client_core::http_server::start(canonical_game_root)) {
        Ok(s) => s,
        Err(e) => {
            let msg = format!("启动本地资源服务失败: {e}");
            crate::native::append_log(&data_dir, "http_server_error", &msg);
            return Err(msg);
        }
    };
    let origin = server.origin.clone();
    let bootstrap_url = server.bootstrap_url.clone();

    // 9. 生成唯一无秘密会话标记
    let session_id = format!(
        "{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        std::process::id()
    );

    // 10. 构建初始化注入脚本
    let init_script = match crate::initialization::build_script(&origin, seed.as_ref(), &session_id)
    {
        Ok(s) => s,
        Err(e) => {
            return Err(format!("构建初始化脚本失败: {e}"));
        }
    };

    // 11. 初始化应用状态
    let app_state = Arc::new(AppState {
        store: store.clone(),
        origin: origin.clone(),
        data_dir: data_dir.clone(),
        last_revision: AtomicU64::new(initial_revision),
        close_state: Mutex::new(CloseState {
            current_attempt: 0,
            machine: crate::lifecycle::CloseMachine::default(),
            is_pending: false,
            prompt_active: false,
        }),
    });

    let state_manage = app_state.clone();
    let origin_for_setup = origin.clone();
    let bootstrap_for_setup = bootstrap_url.clone();

    // 12. 构建 Tauri 应用与窗口
    let builder = tauri::Builder::default()
        .manage(state_manage)
        .invoke_handler(tauri::generate_handler![
            save_snapshot,
            flush_failed,
            toggle_fullscreen,
            close_ready,
            close_failed,
        ])
        .setup(move |app| {
            // 运行时添加精确 Capability
            let cap_json = crate::capability_json(&origin_for_setup).to_string();
            app.add_capability(cap_json)
                .map_err(|e| format!("添加运行时权限失败: {e}"))?;

            let parsed_url = tauri::Url::parse(&bootstrap_for_setup)
                .map_err(|e| format!("解析引导URL失败: {e}"))?;

            let mut win_builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(parsed_url),
            )
            .title("星际争霸：余烬")
            .inner_size(1280.0, 800.0)
            .min_inner_size(960.0, 600.0)
            .resizable(true)
            .data_directory(profile_dir)
            .initialization_script(init_script);

            if let Some(ref args) = cdp_args {
                win_builder = win_builder.additional_browser_args(args);
            }

            // 严格导航拦截：一次引导 -> 一次 index，拒绝重复 top reload，仅允许游戏页面锚点变化
            let bootstrap_allowed = Arc::new(AtomicBool::new(true));
            let index_loaded = Arc::new(AtomicBool::new(false));
            let expected_origin = origin_for_setup.clone();

            let b_allowed = bootstrap_allowed.clone();
            let idx_loaded = index_loaded.clone();

            win_builder = win_builder.on_navigation(move |url| {
                if url.origin().ascii_serialization() != expected_origin {
                    return false;
                }

                let path = url.path();
                if path.starts_with("/__bootstrap/") {
                    b_allowed.swap(false, Ordering::SeqCst)
                } else if path == "/" || path == "/index.html" {
                    // 仅允许首次加载 index.html，彻底拒绝所有后续重复顶层导航（包括带 fragment 或 query 的重载）
                    !idx_loaded.swap(true, Ordering::SeqCst)
                } else {
                    false
                }
            });

            let window = win_builder.build().map_err(|e| {
                format!(
                    "无法初始化 WebView2 运行环境，请检查系统是否已正确安装 Microsoft Edge WebView2 Runtime。\n错误信息: {e}"
                )
            })?;

            let state_close = app_state.clone();
            let window_close = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    start_close_attempt(state_close.clone(), window_close.clone());
                }
            });

            Ok(())
        });

    let app = builder
        .build(tauri::generate_context!())
        .map_err(|e| format!("构建桌面应用失败: {e}"))?;

    // 运行应用主消息循环
    app.run(|_app_handle, _event| {});

    // 13. 应用退出时优雅关闭 HTTP 服务并释放单实例文件锁
    let _ = rt.block_on(server.shutdown());
    drop(lock);

    Ok(())
}
