# 任务工作区模型

## 参考与复刻边界

2026-09-13 用户明确不需要下方面板：桌面/Web 产品只呈现右侧工具和 Overlay 聊天。此前 bottom UI、跨区域拖放和入口已经撤销；共享模型里的旧 bottom 数据仅用于兼容归回右侧，不是产品能力。

参考：`ref/codex` 的 r3589 motion-core 恢复树。该目录仅为本地参考，不进入依赖或发行产物。源码被恢复包装，不能用包装文件长度判断原设计优劣。

| 参考入口 | 语义 | OpenCraft 落点 |
|---|---|---|
| `conversations/remote-thread-prefix-03338.ts` | 客户端任务身份与会话映射 | 现有 ConversationScope/Binding/HostRuntime |
| `composer/update-conversation-context-keys-06446.ts` | 草稿与编辑器挂载分离 | 现有 composer-core controller/target |
| `local-conversation-page-DSaHQbBd.js` 的 Yo/es | 普通输入和展开工具输入互斥 | ThreadComposerPresentation |
| `use-toggle-diff-panel-subscription.js` 的 RightPanelComposerOverlay | 主任务浮动输入、最近回复、容器锚定 | ThreadComposerPresentation + AppShell anchor |
| `resolve-or-allocate-component-tab-id-04545.ts` | tab 移动不调用关闭；状态交接 | WorkbenchPanelService + transfer-tab reducer |
| `local-conversation-side-chat-6ZnaX5j8.js` | 独立 fork、临时身份、关闭策略 | SideChatService + side-chat-panel-plugin |
| `browser-sidebar-webview-manager-05645.ts` | 物理呈现与浏览器资源分离 | 现有 BrowserRuntime/PresentationCoordinator |

## 所有权

1. AppServer 仍是 Thread/Turn/Item 写权威，HostRuntime 是客户端访问 owner。
2. ConversationScope 的稳定 scopeId 是面板 owner；viewId 只表示当前路由呈现。跨 Host 身份始终为 `(hostId, threadId)`。
3. WorkbenchPanelService（Cordis）保存标签/激活/MRU/open 和全宽意图；当前 Shell 只呈现 right。旧 bottom 标签在呈现前归回 right，资源身份不变、不执行关闭回调。
4. AppShell 决定实际可见性、尺寸、工具全宽与浮层锚点。响应式覆盖意图不改会话或资源。
5. composer-core controller 拥有草稿；正常输入与浮动输入只是它的不同挂载。不能复制第二份 React 草稿。
6. Browser/Terminal 资源由已有运行时持有。卸载 renderer 只释放视图；显式 tab close 才进入类型的释放策略。
7. SideChatService 拥有临时子会话、独立 controller 和 Thread lease。面板位置不进入子会话身份；主任务路由不被 fork 改写。

## 呈现策略

Web/Electron 不把云端 Bot 创建作为工作区前置条件。账号状态只能更新账号/环境目录投影，不接管 Draft/Conversation；仅当前选中 Host 的真实连接错误可显示相应干预。没有任何 Host 时提供中立的环境入口，不自动展示 LightVela 创建向导。

有效主任务 + 工具面板实际展开时，主 Composer 通过 body Portal 呈现在工作区之上，提供最近一轮回复的展开视图。普通聊天区域不再挂第二个输入框。Side Chat 或后台 Agent 的 tab 前缀排除主浮层，保持参考分类策略，不凭空再增加 capability 状态副本。

浮层从 AppShell anchor 读取矩形；Portal 宿主不拥有布局尺寸。外壳 pointer-events:none，交互内容 pointer-events:auto；层级低于导航和模态。Shell 没有底部工具插槽或为其预留的空间。

浮动输入的显隐意图由 Shell 生命周期内的路由注册表保存，每个标签单独保存手动/自动收起原因；聚焦展开不等于最近回复展开。Browser ready/loading/unavailable 参与呈现派生，不能把不可用网页当成关闭会话。输入与唤回是两个独立锚定宿主；收起把手不进入正常布局流。普通输入和浮动输入将同一个 portal destination 在 inline slot/overlay slot 间移动，编辑器 DOM 及 ComposerController 均保持身份。原生底边追踪通过已登记 guest 的 before-mouse-event 接入，不给网页 Node 或主应用 preload 权限。

完整聊天、浮动输入和 Side Chat 复用现有 Conversation/Turn/CodexComposer 控件与主题。最近回复是 Timeline 的投影，不进入另一份历史存储。

## 标签操作

- reorder：同区域排序。
- 兼容恢复：旧 bottom descriptor 归回 right，保持 id/resource/durableRoute，不调用 disposeTab。没有跨区域移动按钮或拖放目标。
- open 已存在资源：沿用身份，不重复创建；呈现前完成右侧归位。
- close：调用资源类型关闭策略。Side Chat 有内容时使用 Shell 的确认窗口。
- hide：保留标签和资源，可重新显示。

## Side Chat

发起 `thread/fork`，携带源 threadId/cwd、`ephemeral:true`、`excludeTurns:true` 和参考语义的侧聊指令。创建期间在右侧展示不可关闭的占位 tab，完成后换成右侧子会话 tab。失败清除占位并显示错误，不退化为无历史的新会话。

子会话使用自身 host/thread 的 lease 和 controller 提交、停止和响应交互；不是把子问题发送给父任务。取消/服务退出后的晚到 fork 不能挂入界面，必须释放订阅。

标准 AppServer 实测证明 ephemeral fork 没有持久 rollout，因此 **必须采用 fork 返回结果作为权威 baseline，不能再执行普通 thread/resume**。Session 的 `adoptFork` 校验连接代次、复用 metadata projector 和 live notification；Replica 从这一 baseline 同步。临时 thread 不请求持久队列，活跃时采用 steer。断连后失去临时流的视图显示过期，不能自动伪造一个持久恢复。

### 明确的平台适配与尚未等价项

- Codex 私有 `discard-conversation-from-cache` 不属于 OpenCraft AppServer ABI；此处使用生成协议已有的 `thread/unsubscribe`，并释放本地 lease。服务器何时回收 ephemeral 由服务器控制，不能称为立即物理销毁。
- 本机 DSH/远端 Hermes 若不支持 ephemeral fork，呈现明确错误，不能伪造成功。标准 Codex AppServer 的真实 WebSocket 创建/父子运行/关闭已验证，推理边界仅使用本地合成 Responses 服务，未调用外部模型。
- 精细浏览器 peek/手势显隐、完整编辑器选择/撤销的切换连续性仍需对照验证，不因初步输入框可见就宣布整体复刻完成。下方面板已按用户要求移除，不再作为复刻待办。
- 不迁移 owner/follower 协议到 UI；已有 AppHost/HostRuntime 的执行权限保持权威。
