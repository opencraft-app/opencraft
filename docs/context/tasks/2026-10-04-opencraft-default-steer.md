# 默认立即跟进与聊天设置

## goal
普通会话任务进行中发送新消息默认 Steer，允许在设置中改为排队，并验证后重启当前临时预览。

## non_goals
- 不实现 SSH 接入，不改引擎二进制、队列协议或投递确认。
- 不替换当前预览中的其他改动，不提交或发布生产。

## requirement_excerpt
用户要求“默认可以 steer，设置里面允许选择是否默认 Steer”，随后明确“修改代码重启”。

## interface_refs / data_structure_refs
- `packages/ui-preferences/src/index.ts`: installation-scoped `chat.defaultFollowUpAction`, default `steer`, enum `steer | queue`。
- `CodexComposer.defaultFollowUpAction`: 现有意图选择；MainApp 的发送边界复核实际 active Turn。
- `ChatSettings`: 共享 SettingsSwitch，消费相同偏好 owner；保存中只禁用当前控件，错误原位显示。

## history_context
- current_design_refs: platform-architecture UI preference authority；chat-ui-architecture direct/queued steering。
- relevant_evolution: 之前仅方案评估，本轮获明确实施和当前预览重启授权。
- superseded_refs: 主会话未传 defaultFollowUpAction，Composer 默认 queue。

## acceptance
- 默认运行中直接跟进，关闭开关后排队，重载持久化；空闲正常发送。
- 开关变化不重建编辑器、不丢草稿/选区；键盘反向临时选择保留。
- 临时侧聊仍立即跟进，不声明不存在的队列能力。
- 聚焦测试、两端类型检查、i18n/boundaries、真实 DOM、候选和当前运行状态核验。

## affected_paths
- opencraft/packages/ui-preferences/src/index.ts
- opencraft/apps/workbench-web/src/runtime/use-default-follow-up-action.ts
- opencraft/apps/workbench-web/src/runtime/indexeddb-ui-preference-store.ts
- opencraft/apps/workbench-web/src/components/chat-settings.tsx
- opencraft/apps/workbench-web/src/components/settings-page.tsx
- opencraft/apps/workbench-web/src/app.tsx
- opencraft/apps/workbench-web/src/i18n/locales/zh-CN.json
- opencraft/tests/ui-preferences.test.ts
- opencraft/tests/desktop-ui-preferences.test.ts
- opencraft/tests/chat-composer-queue.test.tsx
- opencraft/scripts/smoke-default-follow-up.ts
- opencraft/docs/platform-architecture.md
- opencraft/docs/chat-ui-architecture.md
- docs/engineering/domains/agent-gateway-runtime.md

## context_receipt
- 完整读取根/OpenCraft AGENTS、maintenance Skill 与 verification、自托管预览 Skill。
- Router 查询 default steer running turn send preference settings UiPreferencesRuntime preview restart 无匹配；限定上述明确目录精确检索。
- 读取平台偏好 authority、Chat steering 契约；邻接卡 product-skill-root-command 与 frontend-runtime-openspec-i18n，检查既有语言设置和 SettingsSwitch 邻居。
- 早期源码/脚本猜测路径失败后纠正明确服务根；未读取凭据，参考源码不执行。

## decisions
- 默认值只在偏好 authority 定义；主 Composer 消费 runtime snapshot，现有提交边界和反向快捷键保留。
- 独立 Chat 设置分类，不把行为塞进外观或远端配置；文案不展示协议名称。
- 当前预览含独立并发修复，基于实际包制作仅本轮变动的候选，不用全量 dirty 构建覆盖。

## risks
- 自托管重启会断开当前会话，由独立 supervisor 负责后续启动与回退。
- 真正付费推理不作为 UI 验收；真实组件使用明确外部边界替身。

## validation / evidence
- 源码真实组件 Chrome：desktop/touch、click/Enter、Ctrl+Enter 反向选择、空闲发送、IndexedDB 重载与跨窗 BroadcastChannel、草稿/编辑器/选区不变、浅深主题与窄屏通过；未调用真实模型。
- 当前包派生候选 `20261004-default-steer-59f854ec977a`：主 App 真实设置路由/中文菜单及开关持久化通过；候选真实 Composer 的 desktop/touch 矩阵通过，零 pageerror/asseterror。
- 候选只新增 typed preference 与过滤器 registry 投影、源码编译的 hook/ChatSettings、MainApp prop、设置入口与四条翻译，全部旧 immutable assets 和运行时原字节保留。
- 两端类型检查、32 项聚焦检查（含 SQLite 新 key 与非法存储回归）、i18n、boundaries、docs-impact staged（无暂存）、文档校验及定向 diff-check 通过。
- staging `/data/opencraft-default-steer-preview-QZZM4u` 包含 prepare/provenance/manifest/smoke/候选截图与证据；没有全量构建替换并发改动。

## scan_scope / scan_output
上述明确消费者、偏好 contract、测试和现有预览元数据；不扫描凭据。

## handoff
源码、验证和当前临时预览替换/重启完成。独立 switch unit Result=success、ExecMainStatus=0；重连后复核 80 端口新 PID 2785955、原 service/cwd/data directory、runtime SHA256 不变，buildId 为 `20261004-default-steer-59f854ec977a`、health.ok=true，无回退。

## live receipt
- staging/status.json phase=complete、success=true、rolledBack=false；oldPid=1554252，newPid=2785955。
- live-evidence.json：真实 Settings 路由/中文开关、默认 Steer、queue 持久化、desktop/touch click/Enter、反向快捷键、idle normal send、草稿/编辑器/选区不变均通过；pageErrors/assetErrors=[]，无真实 Host 写入。
- 重连后逐个复核当前 Web manifest 哈希，运行时 SHA256 `775d26c525045d584a6f3685535aaff3d86d840e14989ab36e37af1d8a62258a` 不变。旧 Web 留在 staging/web 可回退。
- 用户刷新页面即可加载新包；本轮未提交、未推送、未部署生产，未实测原生 iOS/macOS 或付费模型投递。
