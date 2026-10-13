use ashfall_client_core::save::SaveSnapshot;

fn js_literal(value: &impl serde::Serialize) -> Result<String, serde_json::Error> {
    Ok(serde_json::to_string(value)?
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029"))
}

/// 在首个游戏文档同步恢复种子。后续同会话文档保留当前来源的存储，
/// 使用已确认的revision继续保存，不能重新应用首次启动的旧快照。
pub fn build_script(
    origin: &str,
    seed: Option<&SaveSnapshot>,
    session: &str,
) -> Result<String, serde_json::Error> {
    let bridge = include_str!("../bootstrap/bridge.js")
        .replace("export function installBridge", "function installBridge");
    let origin = js_literal(&origin)?;
    let seed = js_literal(&serde_json::to_string(&seed)?)?;
    let marker = js_literal(&format!("ashfall-bridge-session-{session}"))?;
    Ok(format!(
        r#"(() => {{
if (location.origin !== {origin} || location.pathname.startsWith('/__bootstrap/')) return;
{bridge}
const marker = {marker};
let seed = JSON.parse({seed});
const last = sessionStorage.getItem(marker);
if (last !== null) {{
  const revision = Number(last);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('会话存档版本无效');
  const values = Object.create(null);
  for (let i = 0; i < localStorage.length; i++) {{
    const key = localStorage.key(i);
    if (key !== null) values[key] = localStorage.getItem(key);
  }}
  seed = {{ schemaVersion: 1, revision, savedAt: new Date().toISOString(), values }};
}}
const rawInvoke = window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke;
if (typeof rawInvoke !== 'function') throw new Error('桌面存档IPC不可用');
const bridgeApi = installBridge({{
  storage: localStorage, seed, expectedOrigin: {origin},
  invoke: async (command, args) => {{
    const result = await rawInvoke(command, args);
    if (command === 'save_snapshot' && result === args.snapshot.revision) {{
      sessionStorage.setItem(marker, String(result));
    }}
    return result;
  }}
}});
window.__ASHFALL_BRIDGE__ = bridgeApi;
const nativeRaf = window.requestAnimationFrame.bind(window);
const pendingFrames = [];
window.requestAnimationFrame = (callback) => nativeRaf((time) => {{
  if (window.__ASHFALL_CLOSING__) pendingFrames.push(callback);
  else callback(time);
}});
window.__ASHFALL_RESUME__ = () => {{
  window.__ASHFALL_CLOSING__ = false;
  for (const callback of pendingFrames.splice(0)) nativeRaf(callback);
  bridgeApi.thaw();
}};
if (last === null) sessionStorage.setItem(marker, String(seed?.revision ?? 0));
for (const type of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'pointermove', 'click', 'wheel']) {{
  document.addEventListener(type, (event) => {{
    if (window.__ASHFALL_CLOSING__) {{
      event.preventDefault();
      event.stopImmediatePropagation();
    }}
  }}, {{ capture: true, passive: false }});
}}
document.addEventListener('keydown', (event) => {{
  if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r')) {{
    event.preventDefault();
  }}
  if (event.key === 'F11') {{
    event.preventDefault();
    rawInvoke('toggle_fullscreen').catch(console.error);
  }}
}}, true);
}})();"#
    ))
}
