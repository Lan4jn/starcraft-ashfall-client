# StarCraft: Ashfall 本地便携客户端

Rust / Tauri 2 + WebView2 宿主，保留原 JavaScript / Three.js 游戏内核，不重写战斗数值或解锁条件。目标是 Windows x64、EXE 旁外置资源、运行时不补下载的个人本地版本。

## 当前状态

工程仍处于真实资源接入和桌面验收阶段，**不是已验收的完整离线成品**。

- Lead 已执行 Rust 工作区 81 项测试；路径18、Range13、Manifest13、存档13集成+1故障单测、HTTP11、桌面11、格式基线1。静态检查与构建记录随版本更新。
- 真实 WebView2 样例完成 IPC 保存、特殊键/UUID 恢复、正常关闭重启。
- 原生退出故障实测4场景通过：取消继续、重试保存退出、约5秒超时、明确放弃；故障由CDP注入，并非真实NTFS拒写或崩溃测试。
- 快照/适配/打包工具由Lead独立复验；测试数量持续演进，以[验证记录](<starcraft-ashfall-client/docs/superpowers/plans/2026-10-12-first-implementation-verification.md>)为准。
- 原站资产映射1284项仅是候选清单。当前一致镜像1265项；64项候选素材实际请求返回HTML而非媒体，已按具体路径记录排除（其中1项额外绑定实际引用模块SHA）；不因此认定它们绝不会在游戏中被调用。任何排除项的运行时请求都会使对应功能验收失败。
- 第二版真实适配包已完成普通部署进入WebGL/GLB战斗、正常升级卡点击、OGG解码和BGM Range206。真实关闭重启后完整7键和值摘要相同，回环端口变化且revision8→9。尚未验证系统外网阻断、fresh-profile、完整结算或30分钟稳定性。
- 旧原始/第一版诊断识别并最小化修复WebAssembly/blob/AudioWorklet的CSP问题、动态JS/CSS与Vite媒体漏发现；这些失败证据保留，不把修复后的单次启动扩展成完整离线验收。

完整验收项目及未执行项见[验收矩阵](<starcraft-ashfall-client/docs/acceptance.md>)。

## 运行依赖

1. Windows 10 / 11 x64。
2. 已安装Microsoft Edge WebView2 Runtime；不捆绑运行时、安装器、在线Bootstrapper或自动更新。
3. 当前用户能读游戏目录并写入 `%LOCALAPPDATA%`。

便携包通过后可双击EXE启动。程序目录可移动，存档、浏览器Profile和日志仍保存在用户数据目录。**删除程序目录不会自动删除这些用户数据。**普通用户运行与中文/空格程序目录仍需单独实测。

## 本地服务与存档

Rust只监听 `127.0.0.1:0`，用一次性bootstrap令牌换取独立会话Cookie；校验Host/Origin、规范路径和单段Range。CSP按已证明的游戏需求允许本地模块、blob、WebAssembly和精确Tauri IPC，不开放公网通配。

这是页面层的联网限制设计，尚不能凭此宣称系统WebView2进程完全没有任何外部网络活动；需运行期网络观测。

- F11切换全屏/窗口。
- 主存档：`%LOCALAPPDATA%\StarCraftAshfallClient\save.json`。
- 备份：同目录 `save.previous.json`；损坏内容隔离留存，双份损坏阻止静默重置。
- 完整localStorage Map保存，包含动态UUID和特殊键；单一提交链、revision ACK、退出冻结/刷盘/取消/明确放弃。
- 当前禁止刷新与重复顶层导航；本地辅助页面的导航尚未验收，不宣称军械库预览完整可用。

## 开发与资源构建

在项目根目录执行，Node命令使用系统Node；本环境可替换为 `C:\node\node.exe`。

```powershell
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check
cargo build -p ashfall-desktop --release --locked
node --test tools/*.test.mjs desktop/bootstrap/bridge.test.mjs
```

资源获取是开发步骤，**不是客户端启动步骤**。当前发现规格绑定一个确定的远端映射脚本SHA；原站换构建时必须重新调查并审核，不能删除哈希检查来强行通过。

```powershell
node tools/snapshot.mjs --base https://starcraft-shooter-2026.pages.dev/ --out vendor/original --spec config/source-discovery.json
# 原始快照一致且无未批准失败后，生成新候选策略；已存在时拒绝覆盖。
node tools/create-real-patch.mjs --in vendor/original --out config/local-patch.candidate.json
# 人工核对候选策略的源SHA、9个入口锚点与附加门禁后再执行；不能自动批准未知构建。
node tools/adapt.mjs --in vendor/original --out game --patch-spec config/local-patch.candidate.json
node tools/package-portable.mjs --exe target/release/ashfall-local.exe --game game --out dist/Ashfall-Portable
```

适配器强制原清单/目标文件SHA、字面量锚点计数和物理路径包含性；保留原JS文件不变，新增独立网络门禁。打包仅复制清单批准资源，暂存区重新校验后发布，拒绝覆盖已有目录。PE检查只证明x64结构，不判断Release/Debug；调用方必须传入明确的release产物。构建凭据是本机完整性记录，不是数字签名。

## 版权与许可

原游戏、模型、贴图、音频等权利属于各自权利人，包括原作者、暴雪及社区素材作者；具体归属以原游戏署名资料为准。公开镜像不代表独立许可授予。

源码仓库不跟踪下载的原始游戏资产。用户本机生成的便携目录**会包含**经获取与适配的第三方游戏文件，并不因此取得公开再分发权。本次仅在用户本机测试使用；商业用途或公开传播前须核实相关许可。

本工具源码目前没有LICENSE文件，不宣称已经开源。更多边界见[第三方说明](<starcraft-ashfall-client/docs/third-party-notices.md>)。
