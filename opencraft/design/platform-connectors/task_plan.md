# 平台级 Connector 首个执行闭环

## goal
在既有扩展与 AppServer 之上建立引擎中立的 Connector 声明、准备、选择、调用和撤销机制。

## non_goals
- 不修改设置页连接器原型、Hermes/ref、不重建 Credential/Authentication 真源。
- 不做正文版本更新、无用户意图的自动授权、真实第三方账号授权或生产操作。
- 不新增统一 MCP transport；具体 Provider 保留服务客户端与安装权威。

## requirement_refs / requirement_excerpt
- 用户：“需要你思考，实现。设计文档没问题吧？”
- 参考：`../../docs/session-capability-refresh.md` 第 4 节；`../../docs/agent-capability-fabric.md`。

## interface_refs / data_structure_refs
- 复用 AuthenticationService 的 provider/session epoch，无 token 进入 Connector。
- 复用 ExtensionSupervisor 的内部 contribution transaction/disposal。
- 复用 AppServer DynamicToolSpec、item/tool/call 与 serverRequest/resolved。

## decisions
- 不冻结公共 Extension API：先用 first-party `connectorProvider` 窄通道证明机制。
- 模型使用稳定的发现/调用入口；工具标识绑定会话、连接代次与授权 epoch，撤销立即失效，不依赖刷新模型 schema。
- 明确选择的连接才可发现；模型不能自己授权或连接。连接操作与授权流程分开，匿名返回 authorization-required。
- Skills 和 tools 分别准备、分别报告，部分失败不冒充全部成功；Skill close 不等于卸载。

## phases
- [x] 复核设计及现有 Authentication/Extension/DynamicTool owner。
- [x] 实现领域类型、连接/调用生命周期和扩展注册适配。
- [x] 接入实际 Workbench 的模型工具分发与应用生命周期。
- [x] 真实受控服务 + 扩展/协议回归，覆盖撤销、迟到结果和跨 Host/Thread 拒绝。
- [x] 同步正式设计与验证证据；完整 gate 与真实 DSH smoke 已通过。

## acceptance / validation
- 发现只读且不授权；无授权不准备；登录完成后需明确 connect/select。
- 接通的服务能经真实 AppServer 调用返回；断开后旧 handle 不可使用。
- 半成功、超时、扩展卸载、账号 epoch 改变、取消后迟到成功均有回归。
- 两端 typecheck、聚焦测试、check:boundaries、文档/影响门禁。

## required_context / context_receipt
- 已读根与 OpenCraft AGENTS；路由 must_read：`docs/context/domains/agent-gateway-runtime.md`、`docs/context/domains/site-environment-routing.md`、`docs/context/project/upstream-subtrees.md`、`docs/context/project/services/opencraft.md`。
- 已读 OpenCraft maintenance、trace、planning-with-files；使用当前正式平台架构和父设计。
- 代码：AuthenticationService/Flow、ExtensionSupervisor transaction、Workbench 动态工具、DSH broker。

## affected_paths / scan_scope
- packages/workbench-runtime/src/connectors、apps/workbench-web/src/runtime 的注册和装配；tests、scripts、docs。
- 精确检索未发现已实现的平台 Connector runtime；设置页原型明确排除。

## risks / history_context
- 当前动态工具是固定声明，故新增两级发现/调用入口，不强迫引擎实现热换 schema。
- 既有 dirty Skills/冷恢复改动保留；Connector 是后续独立实施，不表示被取消的正文/Hermes 能力恢复。

## 第一阶段历史 checkpoint
- stage：首个只读机制闭环完成，准备交接。
- verified：真实 DSH/AppServer/HTTP 工具返回和断开拒绝；MCP 原生适配的受控协议链；扩展与账号生命周期。
- unverified：真实第三方 OAuth、普通用户 UI、写操作审批、跨进程选择恢复、内置 Skill 安装 Provider、Expo。
- next_action：交接已实现边界与剩余项，不自动提交/推送或操作真实账号。

## 第二阶段：OAuth、入口、逐次写审批、持久化

用户已要求设计与实现这四项，并同步正式设计；它们不再属于未授权范围。

- [x] Host 原生 MCP OAuth adapter：订阅先于请求、代次/超时、取消不误认迟到成功、token 仍归 Host。
- [x] 独立 Composer 入口与共享 Modal 呈现；不复用 Hermes 设置页原型。
- [x] 写调用逐次确认，绑定原参数/Host/会话/连接代次，确认后再次校验；拒绝/取消不调用。
- [x] 保存非敏感配置与期望会话选择；重启重新准备，不持久化 handle、token 或审批。
- [x] 隔离协议/组件/重启回归与正式文档更新。

持久化是执行配置，不伪装成 UI preference；使用独立领域 store 与平台 adapter。用户明确选择“复用 Host 原生 MCP OAuth 协议，实现通用流程并用隔离授权服务验收，不连接真实账号”。OAuth 不自行接收或保存 code/token。原生完成事件缺少 operationId，因此只重读 Host 状态，后续明确连接/会话选择才能授予使用权。

## 第二阶段 checkpoint

- stage：第二阶段实现与隔离验收完成，准备交接。
- verified：17 项 Connector 回归、浏览器真实授权弹窗/确认/拒绝/刷新、Electron 实际 IPC 和进程重启；真实 DSH 等待 13 秒后批准才调用受控 HTTP。最终期限修复后的 226 项 DSH 回归与完整 `npm run gate` 均退出 0。
- unverified：真实第三方账号、远端 MCP 配置安装、内置 Skill 安装 Provider、Expo 入口、正式签名包。
- context_receipt 补充：OpenCraft maintenance/verification、baseline-ui、fixing-accessibility、vercel-react-best-practices、frontend-design；按现有系统 token/Modal 层实现，不新建 feature 字体与焦点系统。
- unresolved：全仓 context validator/4 项治理测试因已有文档问题失败，正式文档与本轮影响检查通过；详见 progress。
- next_action：交接设计文档和明确限制；不提交、推送或发布。

## 第三阶段：Octop 接入体验、Skills 入口、Host 数据库

用户确认：交互和具体服务学习 ref/octop；Skills 中与技能/技能包并列连接器 Tab；视觉用 OpenCraft token/控件；配置、凭据和 OAuth 事务只存数据库；不改 Hermes 引擎，不接真实账号。

### 当前设计与演进

- current_design_refs：`docs/platform-connectors.md`、`docs/platform-architecture.md`。
- superseded：第二阶段“仅发现已配置原生 MCP”的产品入口不是完整服务目录；其 SPI/审批/撤销仍复用。
- relevant_evolution：新增 OpenCraft Host 管理的接入，原生 MCP adapter 保持兼容，不强制外部 Host 改存储。
- 参考 pin：ref/octop `ae65fe4e26854d2eaf751cee89341ec5d71569f0`；只迁移有源代码依据的服务声明/步骤及适配，保留 MIT 归属，不引入其 Python/harness/Antd。

### phases

- [x] 目录/字段/接入步骤与 Host 管理 contract；多实例身份，不以服务名代替账号实例。
- [x] Host SQLite 配置/凭据/授权事务、CAS、删除/过期清理与脱敏投影。
- [x] 首批 19 项 MCP/API provider 接入、OAuth、探测分级、工具调用与撤销；另 4 项仅说明，不冒充可用。
- [x] Skills 连接器 Tab、目录/已配置/详情引导；Composer 仅会话选择。全部使用现有平台原语。
- [x] 隔离协议/数据库/浏览器/桌面/DSH 验证，正式文档和最终 gate。
- [ ] 剩余服务：个人邮箱 IMAP/SMTP、飞猪签名适配；飞书/企微 CLI 需解决不持久化凭据文件的接入方式，不能照搬 Octop。

### context_receipt

本轮重读路由 must_read 四份、OpenCraft AGENTS、maintenance/verification、executor、planning-with-files、baseline-ui、fixing-accessibility、vercel-react-best-practices、frontend-design。检查 lv-sitepage-skills：本轮目标为 OpenCraft，不变更两站运营内容；若需共享面板 slot，只修改中性 contract 并走同步。已读 frontend AGENTS、adjacency/frontend-runtime-openspec-i18n 及相邻 vitest 配置；现有大 openspec plan 只定位相关边界，不按其中无关任务执行。

### checkpoint

stage：第三阶段首批交付完成，保留剩余服务边界。24 项 Connector 专项、真实 MCP SDK/loopback OAuth/数据库、真实 DSH 延迟审批、Web UI 和 Electron 重启验证通过；完整 OpenCraft gate 退出 0。最终 UI 微调后补跑 Workbench 类型、Web smoke 和 Electron 重建/复验。没有使用真实账号，没有修改 Hermes 引擎、官网生成副本或 ref，没有提交/push/发布。具体本地证据见 progress。

## 第四阶段：连接器呈现整改与清理

用户否定全宽设置列表，要求不保留垃圾代码；保留数据库/协议/审批行为。参考现有设置连接器的限宽/卡片/品牌识别，以及 Octop 的目录与详情接入层级；视觉仍由 OpenCraft token 与共享控件持有。

### 清理范围和顺序

1. 行为锁：24 项 Connector 测试与当前 Web smoke 已通过，作为保存/不回显/会话选择/审批/重启/删除基线。
2. 删除错误呈现：服务目录不再使用 SettingsListItem，不保留旧长列表布局开关或旧 CSS。删除 core 中拼接给所有服务的两段重复引导。
3. 目录只负责筛选与选择：限宽、品牌卡片；已配置实例独立管理。原生 MCP 兼容逻辑移入独立内容组件，不掺入目录主状态。
4. 详情分区：品牌与用途、服务专属接入步骤、凭据表单、内联结果。共享 Modal 提供靠边详情呈现和固定操作区，Radix 仍拥有焦点与关闭。
5. 验证真实窄/宽屏、浅/深色、卡片键盘、滚动恢复与操作状态；删除无引用样式，运行类型/边界/专项/构建/实际 Electron。不开真实授权，不提交发布。

### 本轮状态

- stage：呈现替换与清理完成，正式门禁与实际 Web/Electron 验收通过。
- context_receipt：重读 must_read 四份、OpenCraft AGENTS；ai-slop-cleaner、executor、baseline-ui、fixing-accessibility、better-icons；前轮已核验 frontend-design/maintenance 及 Octop/设置页源码。本轮仅 app UI、必要共享 Modal contract、目录引导和测试/文档，不修改引擎与数据库。
- errors：精确文件查询纠正至 design-system/src/modal.shared.ts；不存在路径未被当成新建平行文件的理由。
- verified：26 项 Connector 测试、原生 OAuth smoke、品牌目录/侧边详情/窄屏/焦点恢复 smoke、真实 Electron Skills 页面和数据库重启验收通过。旧选择器/样式有静态删除守卫；无新增依赖，无真实账号操作，未提交发布。

## 第五阶段：文案与状态对应

用户确认修复 review 的五项文案问题。范围仅为 Connector 反馈/目录/页面和相关测试，不改鉴权或存储机制。

- [x] API 格式检查与 MCP 连接测试使用不同按钮和结果说明。
- [x] 凭据保留/重填提示根据真实字段和当前编辑状态生成，不套用不存在的“服务地址”。
- [x] 授权轮询异常提示继续检查，恢复后清除旧错误；未确认的启动/取消结果不诱导重复提交。
- [x] 已知错误按白名单类别与操作阶段呈现；未知写入结果提示核对，不展示原始异常。
- [x] 清理 Host/上游/探测/会话候选等外露术语；增加单元和实际浏览器/桌面回归。

本轮按 clarify/executor 执行，context 继续采用已读路由四份与 OpenCraft AGENTS。已有 dirty 修改保留，不提交、不发起真实服务授权。

第五阶段 checkpoint：30 项专项、Web 行为矩阵、原生 OAuth 和 Electron 重启验收通过。最后同步设备选择器的可访问名称与 tooltip；完整 gate/文档/类型和构建结果见 progress。未修改数据库和外部权限策略。
