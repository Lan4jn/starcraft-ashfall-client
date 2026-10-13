# StarCraft: Ashfall Windows 便携客户端实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 交付保留原版玩法、支持断网冷启动和可靠存档的 Windows x64 便携客户端。

**架构：** Tauri 2 创建独立 WebView2 窗口；Rust 提供经过认证的回环资源服务和文件存档。原游戏发布产物仅作必要的离线适配，不重写仿真逻辑。资源获取、宿主开发和最终桌面验收分为三个检查点，基础验证失败时不继续全量下载。

**技术栈：** Rust stable / Cargo、Tauri 2、Tokio、Axum、Serde、SHA-256、Windows 文件替换 API；Node.js 原生测试运行器及下载/打包工具；现有 Three.js 游戏发布产物。

---

## 0. 执行环境、约束和检查点

- 工作根目录：`F:\Documents\Project\starcraft-ashfall-client`。用户明确选择原地工作，不创建 worktree。
- 规格：`docs/superpowers/specs/2026-10-12-starcraft-ashfall-portable-design.md`。
- 当前仓库只有规格，没有应用、依赖或测试；没有可运行的应用基线，不把缺少测试称为测试通过。
- 使用 PowerShell 执行命令；文件阅读/改动优先 read/edit/write，搜索用 glob/grep。命令以下均以仓库根目录执行。
- Node 命令使用已发现的 `C:\node\node.exe`；避免额外包管理器与全局安装。Rust 实际依赖解析写入 Cargo.lock，Tauri 使用 2.x，不预先声称某个补丁版本可编译。
- 不改 DSH，不替换 GUI，不使用其端口；桌面资源服务是本客户端的一部分，验证进程以托管后台任务执行并记录 job id。
- 仅 Lead 修改根 Cargo.toml、Cargo.lock、Tauri配置与提交；成员不运行会改共享锁文件的全仓库构建，Lead 串行运行。成员先交付变更，Lead 查看 diff、测试和审查后提交。
- 团队仍使用用户已请求的 Agent Teams；不得伪称成员使用某个未验证的模型路由。
- 检查点 A（任务1—7）：基础服务和真实WebView IPC可用，再进行全量下载。
- 检查点 B（任务8—10）：资源清单一致、适配幂等、实际游戏进入菜单并可开局。
- 检查点 C（任务11—12）：完整桌面/断网验收及便携交付。不具备实测证据时只报告构建产物，不报告完整验收通过。

## 1. 文件职责和团队写入范围

| 文件/目录 | 职责 | 写入责任 |
|---|---|---|
| `Cargo.toml`, `Cargo.lock`, `.gitignore` | workspace、依赖、产物隔离 | Lead |
| `crates/client-core/Cargo.toml`, `src/lib.rs` | 可脱离Tauri测试的核心库 | Lead |
| `crates/client-core/src/path_policy.rs`, `range.rs`, `http_server.rs`, `session.rs` | 路径、分段响应、会话、本地服务 | Rust服务成员 |
| `crates/client-core/src/save.rs`, `replace_windows.rs`, `data_dir.rs`, `manifest.rs` | 存档、Windows替换、目录与完整性 | 存档成员 |
| `crates/client-core/tests/*.rs` | 核心集成测试；同名测试跟随所属任务 | 对应成员 |
| `desktop/Cargo.toml`, `build.rs`, `tauri.conf.json`, `permissions/desktop.toml` | Tauri宿主与应用权限 | Lead |
| `desktop/src/main.rs`, `lib.rs`, `commands.rs`, `lifecycle.rs`, `diagnostics.rs` | 窗口、授权、IPC、退出、原生错误 | Lead |
| `desktop/bootstrap/index.html`, `bridge.js`, `bridge.test.mjs` | 空壳页、同步恢复与快照桥接 | 桥接成员 |
| `tools/snapshot.mjs`, `snapshot.test.mjs`, `adapt.mjs`, `adapt.test.mjs` | 公开快照获取与离线适配 | 资源成员 |
| `tools/package.mjs`, `package.test.mjs` | 便携包生成与验证 | Lead |
| `vendor/original/`, `game/`, `dist/`, `target/` | 第三方快照、适配结果和构建产物；不入Git | 工具生成，禁止并发改写 |
| `tests/fixtures/site/`, `tests/fixtures/game/` | 自建HTTP、GLB/音频和持久化测试样例 | 对应成员，禁止真实存档入库 |
| `README.md`, `docs/validation.md`, `docs/third-party-notices.md` | 使用说明、证据与署名 | Lead |

## 2. 公共接口契约

为避免成员各自发明接口，先在任务1定义下列契约。实现细节在所属模块内，调用者不直接操作文件。

```rust
// crates/client-core/src/range.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange { pub start: u64, pub end: u64 }
#[derive(Debug, PartialEq, Eq)]
pub enum RangeError { Malformed, Unsatisfiable, Multiple }
pub fn parse_range(value: &str, size: u64) -> Result<ByteRange, RangeError>;

// crates/client-core/src/path_policy.rs
pub fn resolve_file(root: &std::path::Path, uri_path: &str)
    -> Result<std::path::PathBuf, PathError>;
// PathError: Invalid(400)、Forbidden(403)、NotFound(404)、Io(500)。

// crates/client-core/src/save.rs
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveSnapshot {
    pub schema_version: u32,
    pub revision: u64,
    pub saved_at: String,
    pub values: std::collections::BTreeMap<String, String>,
}
pub const MAX_SAVE_BYTES: usize = 16 * 1024 * 1024;
pub struct SaveStore { /* 私有：根目录、已确认revision、串行锁 */ }
pub enum SaveLoad { Fresh, Valid(SaveSnapshot), Recovered(SaveSnapshot) }
// SaveStore::open(PathBuf) -> Result<Self, SaveError>
// load(&self) -> Result<SaveLoad, SaveError>
// commit(&self, SaveSnapshot) -> Result<u64, SaveError>
// 其他接口不暴露任意路径读写。

// crates/client-core/src/http_server.rs
pub struct ServerHandle { pub origin: String, pub bootstrap_url: String, /* 私有shutdown */ }
// start(root: PathBuf) -> Result<ServerHandle, ServerError>（async）
// ServerHandle::shutdown(self) -> Result<(), ServerError>（async）

// crates/client-core/src/manifest.rs
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetEntry {
    pub source_url: String, pub path: String, pub content_type: String,
    pub size: u64, pub sha256: String,
}
// verify_manifest(root: &Path, manifest: &Path) -> Result<(), ManifestError>
```

`SaveError` 至少区分 InvalidSchema、TooLarge、StaleRevision、Corrupt、IsolationFailed、Io；禁止把所有失败转成空存档。序列化revision限制在JavaScript安全整数范围内。日期使用UTC RFC3339，不用客户端日期推断新旧。

## 任务 1：建立可独立测试的 Rust workspace 与自建样例

**文件：** 创建 `.gitignore`、根 `Cargo.toml`、`crates/client-core/Cargo.toml`、`crates/client-core/src/lib.rs`、`crates/client-core/tests/baseline.rs`、`tests/fixtures/game/index.html`。

- [ ] **步骤1：写最小失败测试和workspace。**

```toml
# Cargo.toml
[workspace]
members = ["crates/client-core"]
resolver = "2"
```

```toml
# crates/client-core/Cargo.toml
[package]
name = "ashfall-client-core"
version = "0.1.0"
edition = "2024"
```

```rust
// tests/baseline.rs
#[test]
fn format_is_version_one() {
    assert_eq!(ashfall_client_core::SAVE_SCHEMA_VERSION, 1);
}
```

`lib.rs` 最初为空，`.gitignore` 忽略 target/、vendor/、game/、dist/、desktop/gen/，不忽略Cargo.lock。测试样例HTML只包含标题、一个用于验证IPC的按钮和本地模块，不获取真实游戏。

- [ ] **步骤2：** `cargo test -p ashfall-client-core --test baseline`，预期未定义常量失败。
- [ ] **步骤3：** 在lib.rs加入 `pub const SAVE_SCHEMA_VERSION: u32 = 1;`，运行相同命令预期1个测试通过。
- [ ] **步骤4：** Lead为核心库加入 serde/serde_json、tokio、axum、tokio-util、mime_guess、percent-encoding、sha2、rand、fs2、time、thiserror；Windows限定 windows-sys；测试依赖 tempfile、reqwest。先只声明已使用模块，不建立未实现函数的空壳。
- [ ] **步骤5：** `cargo test -p ashfall-client-core`，`git diff --check`；Lead提交：`git commit -m "chore: 建立客户端核心测试基础"`。

## 任务 2：路径规则与 HTTP 单段 Range

**文件：** 创建 `crates/client-core/src/path_policy.rs`、`range.rs`、`tests/path_policy.rs`、`tests/range.rs`；Lead导出模块。

- [ ] **步骤1：写失败测试。**

```rust
use ashfall_client_core::range::{parse_range, ByteRange, RangeError};
#[test]
fn ranges_cover_closed_open_suffix_and_errors() {
    assert_eq!(parse_range("bytes=1-3", 10), Ok(ByteRange { start: 1, end: 3 }));
    assert_eq!(parse_range("bytes=8-", 10), Ok(ByteRange { start: 8, end: 9 }));
    assert_eq!(parse_range("bytes=-2", 10), Ok(ByteRange { start: 8, end: 9 }));
    assert_eq!(parse_range("bytes=10-", 10), Err(RangeError::Unsatisfiable));
    assert_eq!(parse_range("bytes=1-2,4-5", 10), Err(RangeError::Multiple));
}
```

```rust
use ashfall_client_core::path_policy::resolve_file;
#[test]
fn traversal_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    for path in ["/../save.json", "/%2e%2e/save.json", "/a%5c..%5csecret",
                 "/C:/secret", "/%00", "/file:stream"] {
        assert!(resolve_file(root.path(), path).is_err(), "{path}");
    }
}
```

- [ ] **步骤2：** `cargo test -p ashfall-client-core --test range --test path_policy`，预期模块未实现失败。
- [ ] **步骤3：实现。** 路径只解码一次，拒绝剩余百分号编码歧义、反斜杠、NUL、冒号、非Normal组件；`/`映射index.html，文件canonicalize后必须starts_with已canonicalize根，且为常规文件。不存在返回NotFound，目录Forbidden。Range用checked算术，end截断size-1，suffix超过总长返回全文件；size=0、suffix=0、start>end、溢出明确拒绝。
- [ ] **步骤4：补测试。** 建常规文件验证路径、中文和空格；空文件、超大数值、闭区间越界；Windows可创建链接时测试资源目录外链接，无法创建时记录跳过理由而非声称验证通过。运行两测试预期通过。
- [ ] **步骤5：** Lead审查后提交：`git commit -m "feat: 实现受限资源路径与字节区间解析"`。

## 任务 3：经过认证的回环资源服务

**文件：** 创建 `crates/client-core/src/session.rs`、`http_server.rs`、`tests/http_server.rs`。

- [ ] **步骤1：测试无认证请求与关闭。**

```rust
#[tokio::test]
async fn plain_requests_are_forbidden_and_shutdown_releases_port() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("index.html"), "local").unwrap();
    let server = ashfall_client_core::http_server::start(root.path().to_owned()).await.unwrap();
    let response = reqwest::get(format!("{}/index.html", server.origin)).await.unwrap();
    assert_eq!(response.status().as_u16(), 403);
    let origin = server.origin.clone();
    server.shutdown().await.unwrap();
    assert!(reqwest::get(origin).await.is_err());
}
```

- [ ] **步骤2：** `cargo test -p ashfall-client-core --test http_server`，预期模块缺失失败。
- [ ] **步骤3：实现服务。** 使用 `tokio::net::TcpListener::bind("127.0.0.1:0")`；生成独立的256位一次性入口令牌和会话cookie；令牌成功消费返回303至 `/index.html`，Cookie含HttpOnly、SameSite=Strict、Path=/（loopback HTTP不设置会阻断兼容性的Secure）。再次使用入口返回403。不要求正常同源GET一定带Origin；出现Origin时必须精确匹配，Host必须精确匹配。`/api/`和测试上报路由不转发网络。
- [ ] **步骤4：流式文件响应。** 文件先seek到Range起点，通过ReaderStream/take读取精确长度；GET/HEAD返回Content-Length、Accept-Ranges；206附Content-Range；416附 `bytes */size`；非法/多段Range为400；方法405。默认并发16，阻塞文件校验放工作池，未知路径404。CSP从受控配置附加，不开启CORS。
- [ ] **步骤5：补集成测试。** 使用cookie_store客户端消费引导，再验证HEAD、206正文、416、第二次令牌失败、错误Host、跨站Origin、没有Origin的合法Worker/媒体GET、目录遍历、16个并发请求及graceful shutdown。预期全部通过。
- [ ] **步骤6：** Lead `cargo test -p ashfall-client-core` 后提交：`git commit -m "feat: 添加认证回环资源服务"`。

## 任务 4：文件快照、损坏隔离及 Windows 替换

**文件：** 创建 `crates/client-core/src/save.rs`、`replace_windows.rs`、`data_dir.rs`、`tests/save.rs`；数据路径固定为LocalAppData/StarCraftAshfallClient。

- [ ] **步骤1：写乱序和完整值测试。**

```rust
#[test]
fn rejects_stale_revision_and_preserves_dynamic_keys() {
    use ashfall_client_core::save::{SaveStore, SaveSnapshot};
    let dir = tempfile::tempdir().unwrap();
    let store = SaveStore::open(dir.path().to_owned()).unwrap();
    let snapshot = SaveSnapshot {
        schema_version: 1, revision: 2, saved_at: "2026-10-12T00:00:00Z".into(),
        values: [("capsule-uuid-123".into(), "{\"values\":{}}".into()),
                 ("capsule-pointer".into(), "uuid-123".into())].into(),
    };
    assert_eq!(store.commit(snapshot.clone()).unwrap(), 2);
    assert!(store.commit(snapshot).is_err());
    assert!(matches!(store.load().unwrap(), ashfall_client_core::save::SaveLoad::Valid(_)));
}
```

- [ ] **步骤2：** `cargo test -p ashfall-client-core --test save`，预期未实现失败。
- [ ] **步骤3：实现校验与顺序。** serde拒绝未知字段、schema=1、字符串Map、16MiB、安全整数revision、RFC3339日期。互斥锁覆盖检查revision和写入，启动load初始化revision。目标文件固定save.json和save.previous.json，禁止前端传路径。
- [ ] **步骤4：实现安全写入。** 同目录临时文件write_all+sync_all；先验证现主文件，复制有效旧内容至备份临时文件并安全替换备份，再用Windows ReplaceFileW替换存在的主文件，首次使用同卷MoveFileExW；失败不提前删主文件。创建返回值为错误而非panic，隔离文件名加入时间和随机后缀。
- [ ] **步骤5：补测试。** 两次保存后损坏主文件，load返回Recovered并保留隔离文件；下一次保存不能把损坏内容写为备份。两份损坏返回Corrupt；空值Map可持久化clear；注入替换失败验证原文件不变；大于16MiB返回TooLarge；第二次store/load后新revision继续递增。数据目录测环境注入，不改真实用户存档。
- [ ] **步骤6：** Lead跑核心测试后提交：`git commit -m "feat: 添加原子快照保存与备份恢复"`。

## 任务 5：同步恢复与异步保存的 JavaScript 桥接

**文件：** 创建 `desktop/bootstrap/bridge.js`、`bridge.test.mjs`、`index.html`。

- [ ] **步骤1：用自建Storage/IPC写失败测试。**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { installBridge } from './bridge.js';
test('恢复完整Map并删除旧键，不产生反向空快照', async () => {
  const storage = new Map([['stale', '1']]);
  const sent = [];
  const bridge = installBridge({
    storage: {
      get length() { return storage.size; },
      key(i) { return [...storage.keys()][i] ?? null; },
      getItem(k) { return storage.get(k) ?? null; },
      setItem(k,v) { storage.set(String(k),String(v)); },
      removeItem(k) { storage.delete(k); }, clear() { storage.clear(); },
    },
    seed: { schemaVersion: 1, revision: 7, savedAt: '2026-10-12T00:00:00Z',
            values: { 'capsule-pointer':'uuid', 'capsule-uuid':'payload' } },
    invoke: async (_command, args) => { sent.push(args.snapshot); return args.snapshot.revision; },
  });
  assert.equal(storage.has('stale'), false);
  assert.equal(sent.length, 0);
  await bridge.flush();
  assert.equal(sent[0].values['capsule-uuid'], 'payload');
  assert.equal(sent[0].revision, 8);
});
```

- [ ] **步骤2：** `C:\node\node.exe --test desktop/bootstrap/bridge.test.mjs`，预期缺少导出失败。
- [ ] **步骤3：实现bridge。** `installBridge({storage,seed,invoke})` 返回 `{flush,freeze,thaw}`；保存完整Map而非前缀筛选，先用原方法同步恢复后安装hook。种子为null不clear；flush走单一Promise链，确认revision后才能下一批提交，保存错误保留脏标记并通知宿主。hook set/remove/clear调用原方法，短暂合并100ms；freeze阻止状态继续变化并取得末次快照；thaw在取消退出后恢复写入，保留脏标记和待重试队列。browser构建脚本将导出改成闭包，由Rust初始化脚本在精确origin执行；seed通过serde JSON传值，不拼接未经转义的脚本字符串。保护script结束符及Unicode分隔字符。
- [ ] **步骤4：补测试。** remove/clear、两个并发flush、旧revision、失败重试、null seed、不匹配来源、刷新不能重新覆写种子、16MiB超限和字符串转义；确认未hook其他页面或sessionStorage。
- [ ] **步骤5：** 运行Node测试预期通过，Lead提交：`git commit -m "feat: 添加游戏存储恢复与串行快照桥接"`。

## 任务 6：Tauri 窗口与精确来源 IPC 验证

**文件：** 创建 `desktop/Cargo.toml`、`desktop/build.rs`、`desktop/tauri.conf.json`、`desktop/permissions/desktop.toml`、`desktop/src/main.rs`、`desktop/src/lib.rs`、`desktop/src/commands.rs`、`desktop/tests/capability.rs`；Lead加入workspace。Cargo package名为ashfall-desktop，lib名ashfall_desktop，bin名ashfall-local。build依赖tauri-build 2.x，运行依赖tauri 2.x及路径依赖ashfall-client-core；Serde/JSON使用与核心库相同的主版本。

```rust
// desktop/build.rs：应用命令进入ACL，不能沿用默认全窗口可调用。
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["save_snapshot", "flush_failed"])
        )
    ).expect("Tauri permission build failed");
}
```

```toml
# desktop/permissions/desktop.toml
[[permission]]
identifier = "allow-save-snapshot"
description = "允许主游戏窗口提交完整快照"
commands.allow = ["save_snapshot"]

[[permission]]
identifier = "allow-flush-failed"
description = "允许主游戏窗口报告保存失败"
commands.allow = ["flush_failed"]
```

运行期生成精确Capability：

```rust
pub fn capability_json(origin: &str) -> serde_json::Value {
    serde_json::json!({
        "identifier": "game-runtime", "windows": ["main"], "local": false,
        "remote": { "urls": [format!("{origin}/*")] },
        "permissions": ["allow-save-snapshot", "allow-flush-failed"]
    })
}
```

正式注册使用serde反序列化为Tauri公开的Capability类型或其支持的RuntimeCapability输入，按实际锁定版本编译验证；禁止把上述JSON测试当作IPC实测。

- [ ] **步骤1：写应用权限测试。** `desktop/tests/capability.rs` 断言只有main窗口、实际origin、save_snapshot和flush_failed命令授权，其他端口和其他窗口拒绝。测试抽象的capability JSON生成函数，不假装这是WebView实测。

```rust
#[test]
fn capability_is_exact_not_port_wildcard() {
    let cap = ashfall_desktop::capability_json("http://127.0.0.1:31001");
    assert_eq!(cap["remote"]["urls"][0], "http://127.0.0.1:31001/*");
    assert_eq!(cap["windows"][0], "main");
    assert_eq!(cap["local"], false);
    assert!(!cap.to_string().contains("127.0.0.1:*"));
}
```

- [ ] **步骤2：** `cargo test -p ashfall-desktop --test capability`，预期类型/函数未实现失败。
- [ ] **步骤3：Tauri配置。** identifier=`local.ashfall.portable`，productName=`Ashfall Local`，bundle.active=false，不自动创建窗口，frontendDist指向bootstrap。build.rs通过AppManifest.commands显式声明应用命令，permissions仅放allow-save-snapshot、allow-flush-failed（命令名snake_case与权限名按实际生成schema核对）。不添加shell、通用fs或远程通配权限。
- [ ] **步骤4：宿主接线。** core start后生成精确remote capability，使用所解析Tauri2版本公开的 `Manager::add_capability` 动态加入，之后创建main窗口。Command实现验证窗口label和URL精确origin，即便应用命令ACL配置错误也不允许其他来源写盘。seed初始化只在引导后实际index页执行一次，禁止在token入口/外部导航泄露种子。
- [ ] **步骤5：真实IPC检查点。** 编译调试EXE，加载自建样例页，实际执行一次save_snapshot并读取save.json确认落盘。另一个窗口/端口尝试相同invoke应失败；运行F11切换全屏并拒绝外部导航。若无法精确授权，停止并报告，不用 `localhost:*` 或脚本注入绕过权限。
- [ ] **步骤6：** `cargo test --workspace` 和 `cargo build -p ashfall-desktop`；记录真实WebView结果至 `docs/validation.md`，Lead提交：`git commit -m "feat: 接入桌面窗口及受限存档命令"`。

参考已读取的官方说明：https://v2.tauri.app/security/capabilities/ 。应用命令默认可调用，因此不能仅创建Capability文件就声称权限已限制；AppManifest和实际来源验证必须同时存在。

## 任务 7：单实例、关闭握手与原生错误

**文件：** 创建 `desktop/src/lifecycle.rs`、`diagnostics.rs`、`desktop/tests/lifecycle.rs`；修改 `desktop/src/lib.rs`。

- [ ] **步骤1：写关闭状态测试。**

```rust
#[test]
fn save_failure_does_not_silently_exit() {
    use ashfall_desktop::lifecycle::{CloseMachine, CloseAction};
    let mut close = CloseMachine::default();
    assert_eq!(close.request(), CloseAction::FreezeAndFlush);
    assert_eq!(close.failed(), CloseAction::AskRetryOrDiscard);
    assert_eq!(close.cancel(), CloseAction::StayOpen);
    assert_eq!(close.request(), CloseAction::FreezeAndFlush);
    assert_eq!(close.confirm_saved(), CloseAction::Shutdown);
}
```

- [ ] **步骤2：** `cargo test -p ashfall-desktop --test lifecycle`，预期未定义状态机失败。
- [ ] **步骤3：实现。** CloseRequested先prevent_close，发送freeze/flush；5秒无响应提示原生对话框，默认取消退出，可重试或明确不保存退出。成功确认时关闭窗口及await服务shutdown；重复close不启动重复写入或对话框。取消时恢复游戏/桥接写入能力。不要依赖beforeunload异步保存。
- [ ] **步骤4：单实例与诊断。** 在稳定数据目录通过fs2独占锁文件，锁句柄保持至进程退出；第二实例原生提示退出。Windows MessageBoxW或等价原生库用于WebView不可用时显示诊断。日志最多3个，每个2MiB，不含token或完整存档。日志初始化失败仍原生提示原错误。
- [ ] **步骤5：补测试和桌面检查。** 模拟保存错误、超时、重试、明确丢弃、重复close；模拟缺少资源与WebView初始化错误。双启动第二实例失败，关闭后能重新启动；确认服务监听关闭无残留。
- [ ] **步骤6：** Lead提交：`git commit -m "feat: 完善单实例退出与原生诊断"`。检查点A结束，基础可用才开始完整资源下载。

## 任务 8：可重试的公开资源快照工具

**文件：** 创建 `tools/snapshot.mjs`、`snapshot.test.mjs`、`tests/fixtures/site/index.html`、`entry.js`、`worker.js`、`style.css`。

- [ ] **步骤1：解析失败测试。**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverRefs, checkedUrl } from './snapshot.mjs';
test('收集动态模块和worker，拒绝跨源下载', () => {
  const refs = discoverRefs('import("./lazy.js"); new Worker(new URL("./worker.js", import.meta.url));', 'js');
  assert.ok(refs.includes('./lazy.js'));
  assert.ok(refs.includes('./worker.js'));
  assert.throws(() => checkedUrl('https://example.org/x', 'https://starcraft-shooter-2026.pages.dev/'));
});
```

- [ ] **步骤2：** `C:\node\node.exe --test tools/snapshot.test.mjs`，预期缺少模块失败。
- [ ] **步骤3：实现CLI与抓取。** `node tools/snapshot.mjs --base https://starcraft-shooter-2026.pages.dev/ --out vendor/original`。入口/HTML src/href、CSS url、静态与动态JS import、Vite映射数组、Worker/new URL、站内资源映射均解析收集；单纯regex无法证明完整闭包，实际缺失请求日志也纳入收集。全源URL限制，redirect逐次校验同源，URL path不可越界。
- [ ] **步骤4：实现下载约束。** 并发4、请求超时30秒、最多3次尝试、退避1/3秒；已有文件校验SHA后复用。核对响应Content-Type与格式特征：GLB魔数glTF、OGG OggS、PNG/WebP、JS不得HTML。清单输出AssetEntry数组与失败列表；失败导致进程非零退出。下载前后再次读取HTML和版本映射摘要，变化则标记快照不一致，禁止交付混合结果。
- [ ] **步骤5：自建服务测试。** mock站点含动态Worker、CSS图片、GLB外部URI、重定向到跨源、错误HTML、429/500重试、超时、重跑复用、变化入口。全部测试通过后才在真实站执行。真实下载可后台运行，记录job id，禁止另起重复下载；失败逐项处理并收集结果。
- [ ] **步骤6：** Lead提交工具而非第三方资源：`git commit -m "feat: 添加一致构建快照获取工具"`。

## 任务 9：可重复的离线适配与媒体检查

**文件：** 创建 `tools/adapt.mjs`、`adapt.test.mjs`、`docs/third-party-notices.md`；生成 `game/`。

- [ ] **步骤1：写反馈和统计适配失败测试。**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptHtml, offlineCsp } from './adapt.mjs';
test('移除统计且不伪造反馈成功', () => {
  const input = '<html><script src="https://static.cloudflareinsights.com/beacon.min.js"></script><button id="feedback-send">发送</button></html>';
  const output = adaptHtml(input);
  assert.ok(!output.includes('static.cloudflareinsights.com'));
  assert.ok(output.includes('本地版不提供在线反馈'));
  assert.equal(adaptHtml(output), output);
  assert.ok(offlineCsp().includes("worker-src 'self' blob:"));
});
```

- [ ] **步骤2：** `C:\node\node.exe --test tools/adapt.test.mjs`，预期函数未实现失败。
- [ ] **步骤3：实现。** `node tools/adapt.mjs --in vendor/original --out game`，先验证原始清单，复制后生成新的适配清单和补丁报告。Cloudflare统计脚本删除，反馈按钮移除发送处理并禁用，反馈队列不得发送；删除仅负责缓存的SW注册；定位环境检测分支精确关闭开发入口和跑测上报。不篡改simulation。修改锚点数量必须准确，未知构建fail closed，不静默跳过。
- [ ] **步骤4：CSP。** 最小策略起点为 `default-src 'self'; connect-src 'self'; script-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'`。原游戏必要内联脚本移为本地脚本或hash授权，样式现有内联保留；Tauri内部IPC来源根据实际WebView验证精确加入connect-src，不添加公网/通配。CSP违规保留日志。server与适配工具共用受控策略文件，不能两处策略互相覆盖。
- [ ] **步骤5：Worker/音频验证。** 在真实WebView检查模块Worker能加载、BGM分段206与解码正常；明确是否需COOP/COEP，只在实际API需要且完成相应资源验证时添加。不强制GPU绕过黑名单来掩盖不兼容。
- [ ] **步骤6：** Node测试通过、原始与适配清单SHA可追溯、声明署名和许可未知边界，Lead提交：`git commit -m "feat: 增加离线适配及资源归属记录"`。

## 任务 10：资源清单校验与真实游戏集成

**文件：** 创建 `crates/client-core/src/manifest.rs`、`tests/manifest.rs`；修改 `desktop/src/lib.rs`；创建 `desktop/tests/game_boot.rs`。

- [ ] **步骤1：写缺资源失败测试。**

```rust
#[test]
fn missing_or_changed_asset_is_not_success() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("assets.json"),
        r#"[{"sourceUrl":"https://starcraft-shooter-2026.pages.dev/x","path":"x.js","contentType":"application/javascript","size":1,"sha256":"00"}]"#).unwrap();
    assert!(ashfall_client_core::manifest::verify_manifest(
        dir.path(), &dir.path().join("assets.json")).is_err());
}
```

- [ ] **步骤2：** `cargo test -p ashfall-client-core --test manifest`，预期未实现失败。
- [ ] **步骤3：实现。** 清单相对路径经过相同安全规则，拒绝重复条目、越界、缺文件、长度与哈希不符。启动在工作池流式校验，不占UI线程；校验失败宿主原生提示具体相对路径和日志。资源root通过EXE旁game目录解析，开发时可显式指定fixture目录，不读取任意网页路径。
- [ ] **步骤4：接入真实game。** 检查TauriIPC、存档种子和CSP在真实菜单加载时没有被构建脚本覆盖；记录全部404/CSP违规、Worker错误和解码失败。不靠历史SW缓存掩盖缺资源。必要可选页面无法获得时在UI明确不可用，不伪装完整镜像。
- [ ] **步骤5：** 完成一次真实开局/升级/结算以及正常重启，检查文件revision增长和动态UUID键保留；若界面无法由现有工具操作，交由用户人工执行并明确未验证项目。
- [ ] **步骤6：** Lead提交：`git commit -m "feat: 集成真实游戏并校验资源清单"`。检查点B结束。

## 任务 11：故障、断网及跨目录验收

**文件：** 创建 `docs/validation.md`；自动测试追加 `crates/client-core/tests/http_server.rs`、`save.rs`，`desktop/tests/lifecycle.rs`。

- [ ] **步骤1：自动回归。**

```powershell
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
C:\node\node.exe --test tools/snapshot.test.mjs tools/adapt.test.mjs tools/package.test.mjs desktop/bootstrap/bridge.test.mjs
```

package测试在任务12建立后运行；其他测试此时独立运行。失败先读日志定位，不跳过失败项或标记全绿。

- [ ] **步骤2：隔离测试数据。** 先备份任何已经存在的真实客户端存档；验证进程使用专门测试数据目录，验收后不覆盖用户进度。准备两套目录，一个含中文和空格。测试模式由宿主CLI显式启用，不暴露公网调试入口。
- [ ] **步骤3：冷启动和联网观测。** 禁止应用公网网络而保留loopback，使用未缓存Profile启动；完成菜单、开局、移动、增援、升级、结算；验证贴图、音效和BGM。记录应用请求日志/CSP拒绝以及进程网络连接，不把原站渲染截图当本地验收。
- [ ] **步骤4：存档故障。** 服务端口改变、程序目录改变后恢复；损坏主存档从previous恢复、两份损坏原生阻止自动重置；模拟写权限错误和无响应前端，5秒提示、取消/重试可用；第二实例拒绝。实际关窗口后PID和监听均消失。
- [ ] **步骤5：显示/系统边界。** 普通用户运行、F11窗口/全屏、错误资源与模拟WebView创建失败提示；战报/录像逐项标记兼容性。缺少WebView的真实系统未测试时标记“仅模拟错误路径已测试”，不能冒充真实缺失环境通过。
- [ ] **步骤6：记录。** validation表包含日期、构建commit、用例、PASS/FAIL/NOT RUN、证据路径、实际内存/帧率/启动耗时。桌面操作受工具限制时请求用户执行指定用例，不自称全验收。
- [ ] **步骤7：** Lead审查证据后提交：`git commit -m "test: 记录便携客户端离线与故障验收"`。

## 任务 12：便携包工具与中文说明

**文件：** 创建 `tools/package.mjs`、`package.test.mjs`、`README.md`；生成 `dist/Ashfall-Local/`。

- [ ] **步骤1：写缺失资源和目录布局失败测试。**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkInputs } from './package.mjs';
test('没有完整资源不能生成成功包', async () => {
  await assert.rejects(checkInputs({ exe: 'missing.exe', game: 'missing-game', manifest: 'missing.json' }));
});
```

- [ ] **步骤2：** `C:\node\node.exe --test tools/package.test.mjs`，预期模块缺失失败。
- [ ] **步骤3：实现。** CLI `node tools/package.mjs --exe target/release/ashfall-local.exe --game game --out dist/Ashfall-Local`。完整校验文件和清单后复制到新临时包目录，再完成命名；已存在out时拒绝覆盖并提示使用新目录，不计算路径后盲删。包内 `Ashfall-Local.exe`、`game/`、`使用说明.md`、`第三方说明.md`；生成包文件SHA与大小报告，绝不夹带LocalAppData存档/token/log。支持空格与中文路径。
- [ ] **步骤4：构建发布。** `cargo build -p ashfall-desktop --release --locked`；运行package CLI，检查EXE命名按Cargo bin目标设置为ashfall-local。无安装器、无联网bootstrapper。使用实际打包目录再做一次任务11冷启动，不仅验证开发模式。
- [ ] **步骤5：文档内容。** README明确已有WebView2依赖、解压双击、F11、数据路径 `%LOCALAPPDATA%\StarCraftAshfallClient\save.json` 与previous、退出后手工备份恢复、程序删除不删除存档、日志、缺资源排查、版权与个人使用范围、已知未验收项目。
- [ ] **步骤6：** `git diff --check`、全部测试、工作树检查；Lead提交：`git commit -m "build: 添加便携打包与使用说明"`。交付实际存在的EXE所在目录/压缩包及validation，不把源文件列表当客户端交付。

## 3. 团队执行图与审查关卡

任务1由Lead建立公共契约；之后任务2→3由服务成员，任务4由存档成员，任务5由桥接成员可并行，文件互不重叠。Lead串行负责模块导出、Cargo依赖和全仓库测试。任务6依赖3/4/5，任务7依赖6；检查点A完成后任务8→9由资源成员执行，Lead可同时做任务10的清单纯测试。真实集成任务10等待9，任务11等待10，任务12工具纯测试可提前，但打包和最终验收等待所有资源和发布EXE。

每个任务按 team_task_get → 当前revision claim → 实现/测试 → 自测汇报执行。Lead完成两次审查：先核对规格和测试覆盖，再核对代码质量与实际结果；发现问题发给对应成员修正。成员complete表示自测完成，不等于最终交付验收。

若选择子代理驱动，每个实现任务调度新的执行成员/子代理，审查角色与实现角色分离；已有调研成员可以审查，不让成员自我验收。任何命令后台运行记录job id，最终收集输出并结束不再需要的进程。

## 4. 规格覆盖自检

| 规格条款 | 实现任务 |
|---|---|
| 独立窗口、窗口化/全屏、固定标识 | 6、7 |
| 回环地址、token、路径边界、GET/HEAD/Range、流式并发 | 2、3 |
| 精确IPC来源、拒绝外部导航、运行期禁公网 | 6、9、11 |
| 一致快照、哈希、失败报告、递归Worker/动态模块 | 8、9、10 |
| 反馈/统计/SW/开发入口禁用、保留署名 | 9、12 |
| 全localStorage、启动同步恢复、随机端口独立 | 4、5、6、11 |
| 16MiB、revision、删除、单实例、损坏隔离、Windows原子替换 | 4、5、7 |
| 退出握手、5秒提示、取消/重试/明确丢弃 | 7、11 |
| 原生错误、日志轮换、GPU错误、缺WebView说明 | 7、11、12 |
| 普通用户、中文路径、无后台残留、断网实局 | 11、12 |
| 不安装运行时、不重写游戏、不伪造验收 | 0、各检查点、12 |

自检：没有未定功能占位符；公共函数、命令与文件名以本计划契约为准。Tauri实际补丁版本和游戏构建hash不硬编码进迁移工具，采用解析锁定和真实编译/运行验证。必要的协议/权限实现不支持时停在检查点报告，而不是用更宽权限绕过。
