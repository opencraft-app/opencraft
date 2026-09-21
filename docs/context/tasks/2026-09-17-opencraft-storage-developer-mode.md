## goal
云存储界面仅开发者模式可见。

## non_goals
不删除存储服务/数据，不改变权限、登录或 Skills，不发布安装版。

## requirement_refs
用户：“云存储界面先隐藏，开发者模式才显示”。

## interface_refs / history_context
复用 ViewContribution/SettingsPage audience 与 isInternalAudienceVisible。现有 connected/hostless 路由在 activeView 不可见时退出；不另建开关。

## context_receipt
已读根与 OpenCraft AGENTS、维护技能/验证清单、platform-architecture。Router 无匹配；有界搜索 extension.ts 与 workbench projection，检查现有 internal-developer-mode 与插件测试邻居。此前已读 frontend-runtime adjacency 与其测试配置邻居，不改 frontend。

## acceptance / validation
正常模式隐藏入口和 View；开发者模式可进入；关闭后退出。插件测试、类型检查、隔离 Electron 验收。

## affected_paths
opencraft/plugins/lightvela-hermes/src/extension.ts；插件测试；platform-architecture。

## stage / handoff
实现与验证完成；未提交/发布。Task 边界为展示策略。

## verified
82 项插件/开发者模式测试、Hermes/Web typecheck、Renderer 构建通过。初轮 Electron 确认普通隐藏、开启可见；关闭时管理路由停在不可用页，已将内部扩展页纳入 SettingsContent 既有回退逻辑，刷新后旧 storage URL 回到 Appearance。验证不涉及账号登录与存储请求。

## decisions
通用 SettingsContent 读取已有 audience 派生布尔值，不创建额外可见性状态。初轮 docs impact 提示需要领域真源，已补充对应展示不变量并通过。

## final_checkpoint
最终 Electron 验收：内部模式打开 Cloud Storage，触发关闭模式后回到 Appearance，Cloud Storage 入口与正文消失。普通模式直接恢复旧 storage URL 也回退。未登录、未访问用户云存储数据；安装版未替换。
