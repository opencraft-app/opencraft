# 取消账号驱动的强制创建 Bot 引导

## goal
Web/Electron 的工作区不因账号没有云端 Bot 被创建引导接管；创建只属于主动环境操作。

## requirement_excerpt
用户截图：“为什么会存在遮罩，要求我创建？没必要”。

## non_goals
- 不改登录、凭据、云端创建 API 或真实 Host 的连接错误。
- 不修改用户已有登录配置，不提交/push。

## context_receipt
- context 路由无匹配；限定 App/LightVela extension/onboarding 搜索。
- 已读维护总纲、验证清单相关章节、platform onboarding 边界和当前源码。

## cause
账号零 Bot 发出 applicationIntervention，App 优先于选中 Host 的错误展示它；插件还注册自动 empty-workbench 创建引导。

## acceptance
- 账号零 Bot、不停机/资源不足不覆盖本机或其他 Host 的 Draft/Conversation。
- 不自动要求创建；零 Host 显示中立环境入口。
- 显式选择的 Host 仍保留必要连接/认证处理；环境创建能力保留。
- 聚焦测试、类型、Web/独立 Mac 预览及文档更新。

## handoff
源码/新包已完成，当前已登录窗口尚未重启，等待用户确认。

## checkpoint
- verified: 去掉账号级 workspace gate、自动 empty-workbench 创建入口；显式 Host 无实例也仅提示选择环境。完整 gate、最终类型及 74 项聚焦回归、文档/空白检查通过；Mac 新包签名完整性校验通过。
- unverified: 已登录旧窗口切换新版后的真实体验，需用户确认重启。没有复制真实登录数据、修改云资源或调用外部模型。
- restore: 最终新包 `opencraft/apps/workbench-electron/release/optional-cloud-final-preview/mac-arm64/OpenCraft Preview.app`。源代码与 design/invariants 的 WSP-15 同步维护。
- next_action: 获得确认后识别当前显示创建提示的预览进程，用原 profile 重启新包，验证工作区恢复且账号仍保留。
