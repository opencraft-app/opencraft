# 跨端存储生命周期与插件持久化设计

## goal
实现已定稿方案的第一个跨端纵向切片：client-local scoped JSON/KV、SQLite/IndexedDB 持久 CAS 与迁移、扩展设置/安装记录平台接线和生命周期验收。本期保留 node:sqlite，不引入 Drizzle。

## non_goals
- 不接管 DSH/Hermes 引擎内部数据库，不统一成单一大库。
- 不操作真实用户数据库、不安装新依赖、不覆盖已安装应用、不提交或发布。
- Host 只提供 API，不加载插件；本地 Worker 由插件自行创建并登记清理。不新增 Host 插件运行时、多租户权限系统或后台任务框架。
- 不把 JSON 文件、IndexedDB 或 Expo 存储顺带改成桌面数据库。

## requirement_refs / requirement_excerpt
当前对话：用户要求先设计，随后补充 Web IndexedDB、插件兼容、BB 与 Obsidian 参考，并要求“定一下”。最终决策替代早期以 Drizzle 为目标的草案；只定设计。

## history_context
current_design_refs: `../../docs/platform-architecture.md`、`../../docs/platform-connectors.md`、`../invariants.md`。
relevant_evolution: 当前 OpenCraft 自有 SQLite 多为建表初始化；session-routing 存在按列检测追加 intent 的历史升级。参考研究在根 `.omx/research/summary.md`，仅作定位，结论重新核对源码。
superseded_refs: 本任务早期“Drizzle 为默认方案”的设计草案已被后续需求取代；不把待实施契约写成既有能力。

## interface_refs / data_structure_refs
`apps/workbench-electron/src/{ui-preferences-store,connector-configuration-store,sqlite-debug-reader}.ts`；`apps/local-agent-host/src/{thread-catalog,dsh-session-routing,dsh-execution-authority}.ts`；`packages/connector-host/src/store.ts`。

## phases
1. [complete] 存储清单、物理路径、owner 和不可丢数据分类。
2. [complete] Paseo/WB/BB/Obsidian 证据核对；决定保留驱动、有限平台迁移代码、跨端契约与不同区域 authority。
3. [complete] 定稿生命周期与插件持久化文档、同步旧架构和索引；按文档门禁验收。
4. [complete] Client-local 文档契约、双后端与迁移/CAS contract tests。
5. [complete] SDK scoped handle、Cordis 生命周期、Main/Preload 和设置/安装记录接线。
6. [complete] Web 多实例与真实 Electron 重启验收、类型/边界/测试和正式文档回写。
7. [complete] Host 通用文档 API：提取共用文档端口/SQLite、Host RPC/能力/通知、绑定明确 Host 的 SDK adapter、隔离协议与重启验收。

用户追加：先 clone 官方 Paseo 到 `ref/paseo`，加入有界 SQLite/客户端升级参考研究，再收敛设计。授权克隆，不执行参考仓库脚本，不修改参考源码。

## acceptance
正式文档明确所有权、版本轴、文件拓扑、无版本旧库接管、新旧客户端兼容、失败恢复、安全边界和阶段验收。未定兼容性必须作为实施前门禁，而非猜测已支持。

## affected_paths
extension-contract/runtime、Workbench Web 存储适配、Electron Main/Preload/存储、相关测试与脚本、正式设计文档。其他任务的 sidebar/settings UI 改动不撤销。

## required_context / context_receipt
- 根 AGENTS、RTK、opencraft/AGENTS.md：本轮授权、当前 dirty 保护、真源/验证边界。
- context router `--route opencraft`：无匹配；执行 OpenCraft apps/packages 有界 SQLite 精确搜索。
- opencraft maintenance Skill 及 verification：按 owner 设计，仅文档门禁。
- planning-with-files：计划、发现、验证记录分开。
- 当前平台/连接器设计：存储边界与已有正式事实。

## validation
文档链接/治理检查、变更影响检查和 git diff --check；不宣称实现或运行时已通过。

## risks / decisions
原工作区有大量前序修改，保留全部。兼容性不仅是 SQL schema：JSON payload、CAS revision、数据库世代、引擎格式分别建模。

- SQL 用小型有界执行模块与单一账本；IndexedDB 用原生升级事务；不造 ORM、SQL diff 或通用迁移框架。
- 默认插件 API 是异步 scoped JSON/KV；本地与 Host 数据不同 authority，Host 断线不回退本地；复杂 SQL 能力不进跨端基本 API。
- 插件内容版本和物理结构版本分开，namespace CAS 与成功提交后通知；复用现有 ExtensionSettingsStore。
- schema/转换失败保留原数据；重载撤销旧实例能力；卸载默认留数据；不承诺自动同步、加密或任意降级。
- Host API 沿用现有单用户 Host token 授权，不新增多租户或按插件安全隔离承诺；插件 ID 是 SDK 命名空间而非 Host 认证凭据。不提供 SQL、文件路径、插件代码上传或回退本地。
- Host 文档与 Electron profile 文档物理分离；已有基线 SQL/hash 保持不变，提取共用实现不重写已发布迁移。

## handoff
client-local 与 Host 文档切片完成：最小API、持久CAS、内容转换、稳定Electron存储、Web升级协调、Cordis生命周期及显式Host绑定。旧IndexedDB保留，仅迁移当前可访问来源。历史其他origin找回、其他既有数据库全量迁移及其他Host实现仍待后续，不宣称全部模块已完成。未提交/发行/覆盖安装版。

2026-10-13：上述 handoff 是早期切片记录；九个自有 Node SQLite 库的账本、备份、旧库处置与 Host 启动门禁现已实现，当前状态与未覆盖边界以 [存储生命周期](../../docs/sqlite-lifecycle.md) 为准。

## 实施 evidence / checkpoint

Host切片：4项专用测试、真实Chromium双标签→真实认证Host→SQLite及停机/重启报告 `/tmp/oc-host-storage-web-xxm5DA/report.json`。第一轮gate因Metro解析新包contract.js失败，已改为直接导出纯contract；随后完整gate退出0。共享存储的源码Electron回归报告 `/tmp/oc-extension-desktop-fCg9Pq/report.json`；最终桌面补验/文档检查记录于progress。

17项存储专项、4个相关workspace类型检查、完整OpenCraft gate通过；最终源码Electron构建及两种真实运行时smoke通过。报告：`/tmp/oc-extension-desktop-pffNFI/report.json`、`/tmp/oc-extension-web-XRy1Bq/report.json`。没有真实账号/付费推理/用户库操作。最新边界/文档检查在交接前执行。

## 设计阶段历史 checkpoint（非当前实施状态）
Paseo HEAD `3cc4ae28664493b2f1ad75a6a6ed1d318c76e944`，BB HEAD `62fe3bc46bd1d935b71482b62a1e0887ffb83487`。查阅生产入口及相邻测试，未执行外部参考脚本。最终文档 validator errors=[]、warnings=[]，两个专题共 17 个本地链接存在，git diff --check 通过；staged impact 检查通过但 staging 为空，不把它称为覆盖全部工作区。架构已定，后续实现首先交付同一契约在 Electron/Web 的真实纵向验证；本轮不进入实现。
