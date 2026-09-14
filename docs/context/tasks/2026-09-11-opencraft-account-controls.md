---
id: opencraft-account-controls-2026-09-11
type: task
scope: 账户工具弹窗的自有控件抽象、Radix 交互与主题适配。
triggers: ["account controls", "account utility dialog", "theme-aware account"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/extension-react/src/settings-panel.tsx
  - opencraft/plugins/lightvela-hermes/src/account/lightvela-account-view.tsx
status: active
reviewed_at: 2026-09-11
review_due: 2026-12-11
revision: 1.0.0
precedence: task
derived: false
---

## goal
把用户确认的紧凑账户面板落实为自有控件，使用 Radix 交互并适配宿主主题。

## non_goals
- 不重写账户服务、登录、计费流程，不修改套餐和用量含义，不部署生产。

## requirement_ids / requirement_refs / requirement_excerpt
- ACCOUNT-UI-01：紧凑工具弹窗、内容撑高、分组设置行，移除嵌套大卡片。
- ACCOUNT-UI-02：头像编辑、名称编辑、复制、用量条、状态与按钮由共用控件承担。
- ACCOUNT-UI-03：浅色、深色、自定义主题与窄窗可用，Escape、焦点、错误和加载可验证。

## interface_refs / data_structure_refs
- `ModalDescriptor.appearance` 的 utility 呈现，由 Web Radix Dialog 投影。
- `SettingsPanel`、`SettingsEditableText`（Radix Popover）、`SettingsCopyButton`、`SettingsAvatarEditor`、`SettingsUsageMeter`。
- `PlatformViewHost.openSettings`：从账户切到模型设置，宿主关闭账户浮层。

## history_context
- current_design_refs：平台文档 Fixed navigation entrances 与账户服务归属。
- relevant_evolution：原账户页使用 920×820 画布、独立卡片和未定义 warning/danger token。
- superseded_refs：先前生成的浅深主题图片只作为方向，不替代真实组件验收。

## acceptance
- 共用控件浅深主题、窄窗、loading/error/empty 状态；编辑失败保留输入、Escape 先关闭编辑后关闭账户并恢复焦点。
- 不在真实账户上执行改名、头像上传、退出或计费；状态矩阵使用隔离 fixture。
- 完整 OpenCraft gate 和 packaged macOS 实际显示。

## affected_paths
- `opencraft/packages/extension-react/`
- `opencraft/packages/design-system/`
- `opencraft/apps/workbench-web/src/components/modal/`
- `opencraft/plugins/lightvela-hermes/src/account/lightvela-account-view.tsx`

## required_context
- `opencraft/AGENTS.md`、平台设计、构建矩阵。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md` | workspace gate | 独立构建与验证 |
| `opencraft/docs/platform-architecture.md` | 容器归属 | 保留 Modal 和账户业务边界 |
| `settings-controls.tsx` / `modal-surface.tsx` | 已有原语 | 扩展复用，不再创建独立卡片体系 |

## evidence
- 源码定位与此前 live computed style 确认 warning/danger 缺失。
- 隔离 fixture 实测发现 Dialog 与 Popover 使用两套不同的 Radix focus-scope/dismissable-layer；对齐 Dialog 1.1.23、Select 2.3.7 与既有 Popover 1.1.23，同时将插件 React DOM 固定到共享的 19.2.3。npm 依赖树确认焦点与 dismissable 模块去重。
- 浅色、深色、自定义主题、编辑错误/保存/复制、外部订阅返回刷新、模型导航、loading/empty/error/长名窄窗和 Dialog 焦点恢复通过。
- 最终 fixture 增加头像上传/退出错误、Tab 焦点约束，全部通过；实际截图与记录位于 `/tmp/opencraft-account-controls/`。全量 gate 已通过，最后 loading 骨架微调另经类型与完整浏览器矩阵复验。
- 完整 gate 884 项测试通过；最终 Electron renderer/host 与 macOS preview 打包完成，签名和 ZIP 完整性通过。真实账户的最终 native 截图目前等待用户再次授权重建预览程序的 Keychain 访问（readSession pending，Main 可响应）。

## risks
- Radix 嵌套浮层必须处于命名层级，Escape 和焦点不得越过账户 Dialog。

## validation
- workspace typecheck、隔离浏览器状态矩阵、theme 测试、完整 gate 与 macOS Preview。

## decisions
- 状态色由主题引擎生成；业务只选择 tone。
- 管理订阅通过对应区域系统浏览器页面，返回/重新聚焦时刷新详情。

## scan_scope
- 账户页、ModalSurface、settings-controls、theme-engine；router 无匹配后执行有界精确检索。

## scan_output
- 已有 SettingsRow/Group 和 Radix Popover 可复用。

## handoff
- 组件整改、浅深及自定义主题、键盘和状态矩阵已完成；新版 macOS Preview 已打开，真实账户内容的 native 验收待 Keychain 授权。未提交或发布。

## stage
等待 macOS 钥匙串授权后的真实账户显示核验。

## verified
- 十条隔离控件/主题/状态记录、Radix 焦点模块去重、884 项 gate 测试、构建和签名。

## unverified
- 本次新版 native 账户弹窗的真实数据截图与最终显示；系统权限是当前唯一阻塞。

## discard
- 生成图片仅为设计方向；当前依据为真实 React/Radix 的隔离截图。

## restore
- `/tmp/opencraft-account-controls/report.html` 与 `report.json` 保存实测；native 端口 19555，沿用先前 profile。不要输出会话、账户隐私或系统密码。

## next_action
- 用户完成 Keychain 授权后打开真实账户弹窗，确认新的 utility 布局并收尾。
