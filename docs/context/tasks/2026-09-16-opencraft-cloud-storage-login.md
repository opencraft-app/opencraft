## goal

按 `origin/codex/chat-demo-v2` 的独立管理页结构整改 Cloud Storage 登录状态，移除空白页中的裸提示。

## non_goals

- 不增加本机存储概览或 Electron 存储 IPC。
- 不改变 TAT 文件管理器、账户协议或 Bot 选择语义。
- 不让 Skills 重新依赖 LightVela 登录。

## requirement_refs

- 用户要求整改难看的登录提示，随后明确“不太需要本机存储，界面按照 codex/chat-demo-v2 来改”。

## interface_refs

- `lightvela-management-page` 拥有页标题与内容边界。
- `LightVelaLoginOptions` 消费现有 `AuthenticationFlowPort`，不建立第二套登录状态机。
- 登录成功且存在 active Bot 后，继续挂载既有 `TatFileManagerPanel`。

## acceptance

- 匿名 Cloud Storage 页面显示完整页标题、用途说明、站点选择和登录动作。
- 不再显示 `Sign in from Overview before managing this Agent.`。
- 登录后原位进入既有云文件管理器；无 active Bot 时仍给出明确状态。
- Skills 不在本任务中简化为管理列表；其 `chat-demo-v2` 完整工作台由相邻迁移任务维护。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `origin/codex/chat-demo-v2:.../lightvela-hermes-management-view.tsx` | 指定视觉参考 | 复用独立管理页层级 |
| `origin/codex/chat-demo-v2:.../app.scss` | 指定布局参考 | 移植 page/header/content 几何 |
| `ref/wb/.../login/LoginView.tsx` | 登录状态参考 | 登录控件替代裸 notice |
| 当前 `LightVelaLoginOptions` | 认证 owner | 复用区域、等待、取消和错误状态 |

## evidence

- 对照 `origin/codex/chat-demo-v2@98d772d06` 的 management page/header/content 结构完成 Cloud Storage 页面。
- 匿名 Electron 预览直达 `/settings/lightvela.hermes.storage`，运行时确认存在一个 `lightvela-management-page` 和一个完整 sign-in surface；可见 Cloud Storage、用途说明、国内/国际站选择与“继续登录”，且没有本机存储或旧裸提示。
- `lightvela-work-navigation` 5/5、`test:extensions`、三个受影响 workspace typecheck、平台边界与 Electron build 通过。
- 完整 `test:workbench:unit` 被并行 management-navigation 改动留下的旧源码断言阻断：`workbench-window-chrome.test.ts` 仍要求旧 `conversationSurfaceVisible` 表达式；本任务未覆盖该并行所有权。

## risks

- Cloud Storage 仍需 LightVela 账号与 active Bot；页面改造不伪造离线或本机文件能力。

## validation

- Plugin/Web typecheck、聚焦测试、平台边界、Electron build 与匿名预览。

## decisions

- 使用 chat-demo-v2 的管理页结构；不把 Profile Skills data layer 误当成 Skills 产品页面。

## handoff

- 实现与匿名运行时验收完成；未提交、未发布。完整 Workbench gate 仍有上述并行旧断言待其 owner 同步。
