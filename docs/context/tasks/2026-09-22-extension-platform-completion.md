## goal
保留 Supervisor，补齐兼容拒绝、局部失败、公共接口与安装更新，使第三方插件可独立演进。

## non_goals
- 不承诺永久兼容旧插件，不改生产、不提交发布，不照搬 BB 全部 SDK。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户目标：兼容拒绝、局部失败、公共接口、安装更新四项完整实施。

## interface_refs / data_structure_refs
- ExtensionManifestV1、ExtensionSupervisor、ExtensionManager、ExtensionInstallationRepository。
- 安装意图与运行状态分开；不兼容保留数据；更新失败不能静默改变 enabled；单插件错误不阻断其他插件。

## history_context
- current_design_refs: opencraft/docs/plugin-architecture.md、opencraft/docs/platform-architecture.md。
- 既有 Supervisor 支持贡献事务；Manager reload 先持久化停用，没有恢复旧实例。
- ref/bb 参考的是兼容状态、公共注册契约和更新故障处理，不移植其全部运行时。

## acceptance
- 不兼容在激活前拒绝，管理页可区分需要更新与普通故障，设置/数据保留。
- 加载、激活、清理的异步失败有界，晚到结果不发布，其他插件可继续启动和操作。
- 公共接口有真实第一方消费者、契约测试与可运行外部样例，内部实现不泄漏给 SDK。
- 安装/启停/更新/卸载保持身份、启用意图与持久化一致；候选失败恢复已知可用实例；明确持久化产物边界。
- 聚焦测试、两端类型检查、边界检查与真实客户端验收通过。

## affected_paths
- opencraft/packages/extension-contract、extension-runtime；Workbench loader、启动与扩展管理界面；插件样例与测试。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| opencraft/AGENTS.md | 局部约束 | 验收与边界 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 维护要求 | 按所有权实施 |
| opencraft/.agents/skills/opencraft-maintenance/references/verification.md | 验证 | 模型与客户端证据分开 |
| opencraft/docs/platform-architecture.md | 扩展责任 | Application/Supervisor 分工 |
| opencraft/docs/plugin-architecture.md | 已有设计 | 区分目标与已实现 |

## validation
- Extension 聚焦测试、contract/runtime/web typecheck、check:boundaries；完成后客户端验收及文档检查。

## risks
- 同进程 trusted 模块同步死循环不能靠 Promise 超时隔离；不宣称安全沙箱。
- module-url 不能保证重启后旧版本字节不变；需产物方案和验收，不能用内存回退冒充完成。

## decisions
- 保留 Supervisor；先修更新意图与回退，再推进兼容状态、局部失败、公共接口和产物流程。

## scan_scope / scan_output
- Context Router 未匹配 `opencraft extension runtime compatibility isolation public API installation update`；精确搜索 extension runtime、loader 和 installations 测试。

## evidence
- 最终 npm run gate 成功退出（0）：check:i18n、全 workspace typecheck、测试门禁与 Web/Expo Web/iOS 构建通过；日志 /tmp/opencraft-extension-platform-gate-final.log。此前两项失败经核实为旧静态断言，修正为国际化消息 ID 及“每个 DropdownMenu 都非模态且挂根 Portal”的不变量，没有删除检查。
- Electron 隔离进程运行 smoke-extension-lifecycle 成功：真实 Settings 安装和不兼容提示、Blob ESM、IndexedDB 重启、离线恢复、更新失败/成功、停用和卸载。不是签名分发包验收，不覆盖用户安装版本。
- 缺失产物测试证明不联网替换版本、不阻断其他插件；cleanup 失败状态不虚报 active，显式重试成功。文档链接、变更影响检查与 diff-check 通过。
- SettingsContent 真实组件 Chromium 安装/不兼容提示验收通过；同一脚本涵盖 Browser loader、IndexedDB 与 Manager/Supervisor，没有替换插件运行时。
- 完整 npm run gate 已执行，至 Workbench 单测失败：Sidecar 源码断言要求 return "Sign in"（现为 intl）、Composer overlay 数量 3 vs 2。对应实现在并行改动中，未为通过门禁修改。日志 /tmp/opencraft-extension-platform-gate.log；后续构建阶段未执行。
- Chromium 实机脚本 `scripts/smoke-extension-lifecycle.ts` 已通过：默认 Browser loader 的 Blob ESM 执行、真实 IndexedDB 页面刷新、断网恢复不请求源 URL、失败/成功更新、停用和卸载。不是 UI Settings 页面验收。
- 模块导入/工厂异常通过 loadOptional 隔离；语音、模型管理、HyperNode、Collaboration、Bot Chat/Management 启动入口已消费。平台账户服务的 bootstrap import 仍是应用依赖。
- 修复恢复记录过早认领内建 ID；Manager 销毁只清理自己实际激活的定义。回归验证外部记录与内建同名时不会卸载内建。
- 产物改为独立持久化文档，列表仅保存摘要引用；真实 IndexedDB adapter（fake-indexeddb 实现）关闭重开、离线恢复与失败更新测试通过。
- Application 已加载第一方扩展激活失败通过 activateOptional 记录并隔离；WebSocket 基础依赖保留关键激活。管理页 incompatible 显示 Needs update。动态 import/工厂边界仍待处理。
- 新安装记录保存自包含 ESM 与 SHA-256，Browser loader 恢复不联网、执行前校验；静态/动态 import/import.meta 拒绝，流式下载上限 512 KiB。真实 ESM 执行测试覆盖离线重启、失败候选保留旧记录、摘要不匹配拒绝、成功更新切换摘要。
- 内部 adapter prepare/commit/rollback 增加有界等待；测试确认前序资源回滚、迟到 commit disposer 执行且公开贡献不发布。
- 公共定义类型及生命周期 AbortSignal 已接通，Theme Pack 消费公共类型；新增外部 self-contained 示例，测试验证导航、公告及卸载清理。当前共 28 项聚焦测试通过，相关三端类型检查已通过。
- 本轮新增 module load、activate 工厂、逐项 cleanup、command drain 超时；迟到工厂资源清理与退休后命令结果拒绝。25 项测试通过，使用未决 Promise 覆盖挂起与晚到路径。
- 已核实 Manager reload 的卸载前持久化停用顺序。
- 已实现并验证候选激活失败/安装保存失败时恢复旧定义、保留版本与 enabled；禁用插件重新安装不启用。
- Manifest API 格式与运行兼容分开；未来 API 安装记录保留，restore 返回 incompatible，其他插件正常激活。
- 21 项 installation/runtime 测试通过；extension-contract、extension-runtime、workbench-web 类型检查通过。

## handoff
- 四项验收已完成：API/平台兼容拒绝且保留记录；插件加载/激活/贡献/清理的局部失败隔离；公共定义/生命周期接口、第一方消费者与外部样例；摘要产物持久化及跨重启恢复、显式更新与失败回退。
- Chromium 与隔离 Electron 使用真实 Settings/Loader/Manager/Supervisor/IndexedDB 验收；全 gate 与文档门禁通过。未提交、发布或更新 /Applications。
- 边界：当前兼容规则是明确的 API major 与平台集合，不承诺永久兼容；可信模块不隔离同步死循环或任意副作用；签名 Marketplace、完整 BB Provider SDK、依赖解析和远端插件执行不属于本次完整 SDK 移植承诺。旧未固定记录在显式更新后固定，旧产物保留不做自动 GC。
