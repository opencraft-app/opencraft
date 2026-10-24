# 实施进度

## 2026-09-25：Sidebar Activity 触控 hover

已实现：活动行的 hover 底色和“…”显露仅在精细指针且当前未处于触摸输入时生效；无 hover 或触摸输入时直接显示独立 44px 菜单入口，并为来源/状态槽位留出空间。已测试：Sidebar 聚焦测试 25/25、Shell 布局测试 17/17、Web 类型检查与构建、独立 Linux headless smoke 通过。当前运行服务已切换至 buildId `20260925022532-668d30451312`，健康与 HTTP 版本核对通过。未实机验证：iPhone 手指拖动、松开和菜单点击。

后续用户反馈：常显“…”已出现，但手指滑动仍有问题。查得共享 `quiet-control` mixin 仍给 Activity 行生成无条件 hover 背景；源码已让该行关闭共享默认 hover，编译 CSS 核对无此规则，聚焦测试 25/25 和 Web 类型/构建通过。第二次修正已部署至 buildId `20260925024353-72c7b9ab13f4`，服务健康；手机实测仍待确认。触控与桌面继续消费同一 Activity 组件与 Design System 状态/token，只按输入能力适配瞬时交互。

## 2026-09-14：云端 Bot 不是工作区前置条件

根因是账号零 Bot 产生 applicationIntervention，并在 App 中优先于选中 Host 的错误接管主内容。已删除该优先级及下游产品自动 empty-workbench 创建入口；无 Host 时显示中立环境入口。显式环境创建、选中 Host 的连接干预仍保留。正在验证匿名/已登录零 Bot、类型/门禁与新版预览。

源码与构建已完成。完整 gate 通过；随后将显式选中但无实例的 Host 提示改为中立“选择运行环境”，最终 Web 类型与 74 项聚焦回归通过。该 Host 提示也不再调用创建 Bot 向导。新包 `release/optional-cloud-final-preview` 签名完整性校验通过。已询问用户是否重启当前已登录预览；尚未收到确认，因此未关闭旧窗口或改动登录/配置。真实已登录窗口的新版验收待重启确认。

## 当前范围修订：右侧工具，不要下方面板

用户明确否定 bottom 能力。本轮移除 AppShell bottom 插槽、resize 组件、跨区域拖放域、移动按钮及 Show bottom panel；保留 Overlay。共享旧状态在接入时归回右侧，不释放资源。类型检查和 6 项聚焦测试已通过，Web/native 新版本验证进行中。下方历史迁移记录不是当前产品要求。

本轮完整 gate、Web smoke（无下方入口、Overlay 草稿/提交目标、网页最大化/隐藏后的状态保留）、文档/空白检查均通过。新版 `release/right-only-preview` 已打包，签名完整性校验通过。旧预览目录和用户数据未删除；底部组件和跨区域拖放代码已移除。

独立 Mac 新预览已启动；实测下方控件数量为 0，右侧原生终端及最大化/恢复 smoke 通过。用户已登录的旧窗口未关闭、未改配置。

## 2026-09-13

- 已读取根/OpenCraft 入口、维护总纲和验证清单；context 无匹配。
- 工作树已有大量用户变更，按增量编辑保留。
- 阅读 OpenCraft 的 Chat、Browser、Plugin、Platform 相关设计。
- 尚未修改行为，尚未运行实现验证。

### 实施更新

- 已接入主 Composer overlay/最近回复，复用现有 controller/Turn renderer；添加 Shell 锚点与命名层级。
- 已添加 transfer-tab 原子投影、底部面板、移动/隐藏/重新显示入口；open 已移动资源保留其区域。
- BrowserPanel 改读实际 outlet 可见性及 right/bottom surface。
- SideChatService + 面板插件接入真实 ephemeral fork 和 unsubscribe，独立 controller/lease、晚到失效与关闭确认。
- 首轮 TypeScript 暴露不存在的 Collapsible 依赖和枚举值：改用原生 details 语义及现有类型；后续暴露缺少 theme，已修正。
- 聚焦 panel/sidechat 测试：20/20 通过。尚未完成 Web/真实 Host/Mac 验收；不是整体完成。
- Web smoke 首次发现 reduced-motion 写入早于派生订阅，底部高度保留 0；调整订阅/写入顺序，并同步修正 full-width progress。第二次拖动采样发生在 reopen 的 DOM 帧提交前，增加实际高度就绪条件后再按下。
- 完整 gate 已启动，结果待收集。
- 第一轮 gate 的唯一失败为源码断言仍固定 `state.right`；面板现在复用 `regionState`，更新该断言后，完整 gate（类型、测试、Web/Expo Web/iOS bundle）通过。随后新增 fork adoption，需要再次跑最终 gate。
- Web smoke 通过：light/dark、缩窄、普通/overlay 草稿保留、工具输入不被挡、隐藏/恢复、底部 held height 342px、跨区域真实拖放无资源 close。
- 真实 Codex AppServer（隔离 profile）首次 ephemeral child 走 Resume 失败；改成 Session.adoptFork、跳过持久队列后，父任务与子任务各运行一轮、关闭 unsubscribe 全部通过。两次推理均为本地合成 Responses 服务，外部模型请求 0。
- Session/fork/panel 聚焦回归 33/33 通过；源码/呈现回归 64/64 通过。
- Mac host/renderer 初次构建成功，新增 adoption 后需要刷新产物及实机验证。

## checkpoint

- stage: 实施后段；下一道门为新增代码最终 gate 与独立 Mac QA。
- verified: 普通/浮动主 Composer、双区域移交、Codex ephemeral fork adoption 的真实协议闭环。
- unverified: 本机 DSH 临时 fork 不支持；浏览器精细 peek、编辑器选择/撤销切换、真实侧聊窗口确认与完整 Mac 交互。
- discard: 不能再使用“fork 后 resume”或持久 queue 假设；不能把空父 Thread（无 rollout）的 fork 失败当作服务不可用。
- restore: 本目录规范/计划及源码；原用户工作树未提交改动全部保留。测试/构建日志位于 /tmp 的 opencraft-workspace-*。
- next_action: 刷新最终门禁、验证浏览器 slot 迁移与独立 Mac 产物。

### 最终核心验证

- 完整 gate 再次通过：协议/类型、扩展、AppServer/Lab、Chat、工作区、账户/环境、Web 发布测试以及 Web/Expo Web/iOS bundle。
- 最后的小范围提交契约/拖动作用域检查后，Web 类型检查及 Session/Panel/Browser/drag 聚焦回归 40/40 通过。
- Web smoke 在普通动效与 reduced-motion 下通过。真实 iframe 页内计数 1→2→3 跨右/底移动及隐藏保持；显式关闭释放页面。初始 about:blank 的 null-origin bridge 竞态已修复，不向不合法 origin 发消息。
- 主 Composer 在 Overlay 里实际提交的 target 为原 Host/parent Thread；不是只检查草稿文本保留。
- 临时 fork 真实 AppServer 测试通过父/子各一轮本地合成模型运行；无外部模型请求。
- macOS arm64 ad-hoc Preview 实机：底部按住高度 342px；终端移下、移回后分别输出 `after-transfer:retained` 和 `after-return:retained`，证明同一 shell 状态保留。截图已人工检查。
- 最终产物：`apps/workbench-electron/release/workspace-model-preview-final/mac-arm64/OpenCraft Preview.app`；codesign --verify --deep --strict 通过。使用独立测试 profile，不覆盖用户已有预览。
- 文档检查无警告；diff whitespace 检查通过。`validate_change_impact --staged` 通过但当前没有 staged 文件，因此该项不作为本轮映射覆盖的独立证据；正式领域文档与 design 已同步更新。

### 明确未完成/不支持

- 本机 DSH 0.1.1-rc.2 的 session.fork 只有 sessionId/atSeq，不支持 Codex 的 ephemeral fork；未用持久分支冒充临时侧聊。远端 Hermes 同样按实际协议能力执行。
- 浏览器紧凑/peek 细节尚未完整验证；输入选择/撤销历史跨呈现与完整 Side Chat 窗口确认流程尚未专门实机验收。
- Expo 只通过共享内核/构建检查，本轮未移植桌面 Overlay 布局到 Native。
- 未 commit、push 或发布，本次证据仅覆盖已列出的核心能力。

最终产物已实际启动，并在同一独立测试 profile 上再次通过原生终端迁移/held-drag；旧测试进程已退出，用户此前其他预览未被修改。当前窗口停在匿名本机工作区和原生 Terminal，可直接预览。Side Chat 的全流程成功证据来自标准 Codex AppServer + 本地合成模型，不来自 DSH。
