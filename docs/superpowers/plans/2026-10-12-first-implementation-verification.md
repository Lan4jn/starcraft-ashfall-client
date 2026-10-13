# 第一批实现验证记录

日期：2026-10-12 至 2026-10-13；分支：`feature/portable-client`。

## 自动测试与静态检查

- 路径策略：桩红测6失败；长路径与90汉字文件名回归2失败；最终18通过。
- Range：桩红测10失败；前导加号回归1失败；显式ASCII数字修复后13通过。
- 存档：桩红测10失败；未load损坏和运行期损坏覆盖回归2失败；13集成+1故障注入单测通过。
- JS桥接：缺IPC和非法ACK追加红测2失败（成员执行）；Lead独立15通过。
- HTTP：桩红测8失败；reqwest规范化穿越URL的测试调整为原始TCP；最终11通过，包括重复头、文件根目录及关闭释放。
- Manifest：13通过；规格与质量双审批准，ASCII大小写防碰撞不是全部NTFS Unicode等价关系。
- 桌面：原生诊断3、ACL1、初始化3、单实例2、关闭状态机2通过，共11。初始化第三项是Lead针对真实特殊键丢失追加的1失败→修复通过回归。
- 快照：Lead独立22通过（含入口不变而mapping漂移，以及旧mapping复用校验）。首次真实抓取随后发现未覆盖的非法伪引用与WriteStream打开异常，尚在整改。
- Cargo工作区测试全通过（特殊键追加前桌面10）；2026-10-13 Lead完整 `cargo clippy --workspace --all-targets --locked -- -D warnings` 通过。
- `cargo fmt --all -- --check` 曾失败，Lead协调停写后统一格式化并通过。
- 单实例测试缺业务先红后绿证据：如实记录过程偏差，不回滚可用实现伪造红测。

## 检查点 A：真实 Windows / WebView2 验证

使用debug二进制 `target/debug/ashfall-local.exe --fixture`，专用 `%LOCALAPPDATA%/StarCraftAshfallClientProbe`，CDP端口23389仅用于debug样例。不是替代服务器。

- 实际加载自建样例HTML，动态回环来源，真实Storage与IPC可用。
- 按钮触发中文键值保存，Rust `save.json` 确认revision与完整值。
- 动态UUID键、删除指针、`__proto__`写入、sessionStorage隔离及Symbol标记实测。恢复种子初始dirty会增加revision，因此sessionStorage隔离探针需先flush种子后比较，不能把种子刷盘误判为sessionStorage mutation。
- F11对应受限命令真实调用成功；不存在命令被拒绝。这个检查证明命令注册和动态来源可用，不单独证明所有ACL拒绝情况。
- 正常WM_CLOSE经 `CloseMainWindow()` 触发保存握手，实际进程exit0；关闭前新增键在Rust存档中存在。
- 实际重启后端口变化，常规键/UUID/删除状态恢复。
- 实测发现JSON直接嵌入JavaScript对象字面量吞掉`__proto__`字符串值。Lead新增真实红测并改双层JSON字符串+JSON.parse；随后真实重启确认`__proto__=原型键`、UUID及关闭前键恢复，revision8。
- 截图及CDP证据位于 `target/validation/`（本地忽略目录）；样例favicon404为已知非关键请求，不隐瞒网络错误。
- 关闭失败/超时的原生弹窗、用户取消/显式放弃、模拟WebView崩溃、磁盘拒写尚未完成真实UI验收。

## 双阶段审查

路径/Range、存档/桥接、HTTP、Manifest、桌面候选均完成规格再质量审。审查仅对应读取的源码版本与实测范围，不采纳“100%”“生产级”“完全无风险”泛化表述。快照工具通过Mock双审后真实抓取仍发现缺陷，故不将Mock通过视为真实闭包成立。

## 当前边界与剩余工作

- 真实游戏尚未接入，未验证WebGL、GLB、Worker音频、游戏通关/排行/宠物进度、断网离线与便携发布。
- 禁刷新/重复顶层导航用于避免落盘ACK丢失后旧sessionStorage版本问题；不是完整的任意导航恢复机制。
- rAF关闭暂停与捕获键鼠门禁已实现，但游戏计时器尚未证明完全冻结。
- 同权限本机进程篡改资源仍可能触发路径验证后的TOCTOU；不声明防御本机恶意进程。
- 快照首次真实抓取失败：误发现`image/*,.png`伪资源，引发WriteStream打开ENOENT未处理；正在新增回归并修复，不能记录为完整资源获取成功。
- 离线适配器初版有宽泛正则、manifest路径与发布事务边界，Lead已要求回归整改，尚未批准真实使用。
- 第三方资产仅用于用户本机授权范围内测试；未经权利人许可不发布或再分发原游戏媒体素材。
