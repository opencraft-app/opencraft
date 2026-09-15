# LightVela Collaboration Workspace 设计

状态：active，Workspace/IM Chat + Members 已实现；Computer 契约与持久化已预埋，但产品能力默认关闭且 UI 不呈现。

仓库归属：本设计及实现只写入 `git.woa.com/wisp/mono2.git`。OpenCraft 已完成一次性历史导入，
不与旧 OpenCraft 仓库或 `mono2-clean4` 工作区建立双写/同步关系。

## 第一不变量：两套 Chat 泾渭分明

OpenCraft 内存在两套完全独立的聊天产品：

| 产品 | 权威数据 | 前端状态 | 呈现 |
|---|---|---|---|
| LightVela IM Chat | 腾讯云 IM 消息与会话；collaboration 保存资源映射和 IM MessageThread 引用 | IM connection、conversation、draft、unread、search、IM thread | Collaboration Workspace |
| Codex 会话 ChatUI | AppServer / Agent Runtime 的 Thread、Turn、Item、Agent Activity 和 Tool 状态 | Workbench Thread lease、Timeline、Composer、panel resources | 现有 OpenCraft Conversation |

硬性禁止：

- 腾讯 IM Message 不得转换为 AppServer Turn/Item 后塞进 Codex Timeline。
- Codex Agent Activity、thinking、tool call 或 token stream 不得写入腾讯 IM 历史。
- IM draft/unread/selection 不得复用 Codex Draft、Thread lease 或 Composer queue。
- IM MessageThread 与 Codex Thread 必须使用不同类型名、route kind、service 和持久 key。
- Collaboration 插件不得 import Codex/AppServer conversation renderer；Codex Chat 插件也不得
  import腾讯 IM adapter。

Agent 可以通过 `vela-computer` 从 IM 收到工作并把结果发回 IM；这是 Agent 侧协议桥接，
不是前端两套 Chat 状态的合并点。

## IM Chat 内部边界

IM 群聊和 Server 内私聊是一套体验、一个消息模型和一套 Composer。两者共用：

- `ConversationAddress`、Message envelope、clientRequestId；
- optimistic send、ACK/reconcile、附件上传和重试；
- conversation directory、draft persistence、未读和实时订阅。

差异只由 capability 表达：

- Channel Topic：支持 @、Task 投影和 IM MessageThread；history/search 使用 sequence；不发送
  普通群已读回执。
- Server 内私聊：底层为腾讯双人 Group；不支持 @、Task 投影和 IM MessageThread；history
  定位与已读行为使用普通 Group 能力。

不得为群聊、私聊复制两套 Store 或两套发送实现。

## 插件与服务归属

```text
lightvela-platform
  ├─ LightVela Account / region / authenticated gateway transport
  ├─ LightVela instance directory
  └─ instance-scoped terminal provider

lightvela-collaboration
  ├─ Server Workspace 与 collaboration API
  ├─ Tencent IM connection + unified IM Chat + Members
  └─ Computers + IM MessageThread

lightvela-hermes
  └─ Agent/AppServer adapter，仅服务 Codex 会话 ChatUI

vela-computer/
  └─ 下发到托管 Computer 的 Agent Chat Client，不是 OpenCraft 插件
```

`lightvela-platform` 拥有账户、LightVela instance directory 和 instance-scoped terminal
provider；Hermes 与 Collaboration 都只借用平台能力，彼此不成为对方的基础层。

## 一个 Workspace View，两个产品区

最终只保留一个顶层 Navigation：`Collaboration`，对应一个
`lightvela.collaboration.workspace` View。View 内部使用 OpenCraft 原生 master/detail 布局：

- **IM Chat + Members**：Server、Channel、私聊和成员目录属于同一个沟通工作区。点击 Channel
  进入群聊；点击 Member 创建或进入私聊；成员资料和管理动作是 Chat directory 的上下文详情，
  不再单独建立 Members 页面。
- **Computers**：后续 capability。只有可信实例目录、创建链路和运行能力全部接通后才显式启用；默认不注册入口、不读取实例目录。
- Server Settings 作为 Workspace 次级页面，不占顶层产品入口。

Tasks、Reminders 和 Inbox 的后台契约继续保留，但暂不进入插件导航、页面和本轮实现范围。

临时 `Servers`、`Computers` 顶层 View 已随 Workspace 落地退役。

所有选择进入 opaque `resourceUri`，不写入全局 singleton：

```text
lightvela-collaboration://servers/{serverId}/chat/channels/{channelId}
lightvela-collaboration://servers/{serverId}/chat/direct/{directConversationId}
lightvela-collaboration://servers/{serverId}/chat/channels/{channelId}/im-threads/{threadId}
lightvela-collaboration://servers/{serverId}/chat/members/{memberId}
lightvela-collaboration://servers/{serverId}/computers/{computerId?}
```

URI 只使用稳定业务 ID；名称只用于显示。需要增加纯 `route-codec` 和 round-trip/非法 URI
测试。现有 Host 只有 replace resource 能力；进入 Channel、IM Thread 或资源详情应支持
browser-history push，因此需先增加窄的 `pushViewResource()` host port。

## 状态所有权

| Owner | 拥有 | 不拥有 |
|---|---|---|
| `CollaborationDirectoryService` | Server 列表、按 Server 的资源 cache 和 single-flight | 当前 route 选择、IM 消息 |
| `ImConnectionService` | UserSig 签发/刷新、一个 Tencent SDK login、server scope generation | 当前会话、draft、页面 loading |
| `ImDirectoryService` | Channel、私聊、Members、成员详情和 membership operation projection | IM SDK lifecycle、消息正文 |
| `ImChatService` | 群聊/私聊统一 conversation 状态、消息、draft、未读、search、send/reconcile | Codex Thread/Turn/Activity |
| `ImMessageThreadService` | root ref、reply ref cursor、IM hydration、thread unread/read | Codex Thread lease、主会话 message array |
| `ComputerService` | Computer 产品身份、Server 归属、desired lifecycle、Agent 绑定和 CAS | CTL 内部任务细节、TAT Enrollment |
| CTL adapter/projection | LightVela instance 的实际执行与 observed runtime state | Computer 产品身份和 Server 权限 |
| Host terminal port | exact instance terminal session、panel tab 和资源生命周期 | Computer 页面状态、active Bot 切换 |

React View 只订阅这些 service 的 snapshot；网络、timer、UserSig renewal、polling 和 SDK
subscription 均不能由组件 mount 偶然拥有。

## Computer 契约

`Computer` 是 collaboration 的独立产品实体；LightVela 用户已有实例是当前唯一可选的
Computer 实现来源：

- 当前默认产品配置不呈现 Computer。仅仅存在 OpenAPI、表结构或前端组件不代表用户可用；
  必须由组合根显式提供可信 `InstanceDirectory` 并打开 `enableComputers` capability。

- `kind = lightvela_instance`；当前 UI 不提供其他 kind。
- 创建 Computer 的唯一入口是从当前 LightVela 账户实例目录选择已有实例；Computer 页面
  不购买或新建 CTL 实例。
- 一个 Computer 只能归属一个 Server；一个 Server 可以拥有多个 Computers。跨 Server 使用
  必须先显式迁移归属，不能让同一个 Computer 同时出现在多个 Server 权限域。
- collaboration 拥有 Computer ID、Server 归属、产品 desired state、Agent 绑定、权限、revision
  和产品生命周期编排。
- `providerRef.instanceId` 是不可变的 CTL 执行引用，不是另一个用户可见 binding 实体。
- CTL 接收 Computer service 的产品动作，拥有底层 instance task 和实际 observed state；观测
  结果回投独立 Computer projection。
- UI 不能出现安装脚本、setup code、Computer credential、TAT 注册或外部 Computer 加入。
- collaboration 旧 `computers`、`tat_instance_bindings`、setup/enrollment/terminal API 已发布，
  不得原地改写；需要新的正式契约版本和迁移/退役策略。

建议通过正式新契约演进 Computer，而不是增加用户可见 binding 概念：

- authority 字段：`id`、`server_id` ShardKey、`kind`、不可变 provider ref、desired state、
  revision、created_by_member_id。
- provider identity registry 保证同一 LightVela instance 最多对应一个未退役 Computer；所有
  Server 查询仍显式携带 `server_id` ShardKey。
- 独立 runtime projection 保存 CTL lifecycle、last synced at、stable error code 和 runtime
  metadata；不得把 observed state 写回 authority 字段。
- Agent 继续引用 Computer ID，不额外引入 binding ID。

## Terminal 接入

不复用 collaboration 旧 `/terminal-sessions`，也不在插件内创建 xterm/TAT client。

使用 platform 的 instance-scoped terminal provider：

1. Collaboration View 请求打开 `lightvela-instance://{instanceId}`。
2. Host 校验账户所有权和当前 Computer/Server 权限。
3. `lightvela-platform` 为精确 instance 创建 terminal session。
4. `plugin-terminal` 继续拥有 terminal registry、right/bottom panel tab、resize 和 dispose。

底层 provider 可以调用 CTL/TAT，但 Collaboration 插件只看见 terminal resource port，不
拥有 TAT 纳管逻辑。

## 源码迁移策略

直接迁移并保持测试的部分：

- `client-core` conversation/message/composer/thread/operation 纯契约；
- Tencent Gateway、Message normalizer、MessagingPort、ChannelChatService；
- member identity、conversation directory/scope 和 Computer status 等纯 view-model；
- clientRequestId、ACK/reconcile、search、IM MessageThread hydration 行为测试。

不直接复制：

- Expo Router route tree；
- React Native、Unistyles、mobile primitive 和旧 WorkspaceChrome；
- Zustand 单体 `app-store.ts`；
- 旧 Human Auth、Computer Enrollment、registration script、TAT terminal controller；
- Codex Conversation/Activity renderer。

## 实施顺序

1. **平台基座**：抽 `lightvela-platform`；增加 resource URI push 和 instance terminal port。
2. **Workspace 骨架**：一个 View、route codec、Server rail、section layout；退役临时双入口。
3. **IM Chat + Members**：迁 conversation/member directory、统一群聊/私聊、Composer、消息
   列表、搜索、附件和成员上下文操作。
4. **IM MessageThread**：独立 service/snapshot，按平台 reply refs 从 IM hydrate。
5. **Computers（默认关闭）**：平台列出现有 LightVela instances；后台实现
   `Computer(kind=lightvela_instance)` authority、唯一归属 registry 和 CTL projection；
   Computer 页面不创建实例。Tasks/Reminders 不进入本轮。
6. **Terminal**：精确 instance provider + host-owned panel，不走旧 Enrollment surface。
7. **退役**：删除插件内临时 View、禁止新客户端调用旧 Auth/Enrollment/TAT surface；旧发布契约
   按版本策略保留或下线。

## 验收门禁

- 静态 boundary：Collaboration 不得 import Codex/AppServer Chat renderer；Hermes 不得 import
  Tencent IM adapter。
- IM 群聊/私聊共用同一 Chat service/UI 测试；capability 差异有独立 fixtures。
- IM MessageThread 与 Codex Thread 类型、storage key、route 和 snapshot 不可互换。
- resource URI round-trip、deep link、Back/Forward、刷新恢复通过。
- Terminal 测试锁定 exact instance；断言不调用旧 enrollment 或 collaboration TAT session API。
- Computer UI 无外部加入、安装、setup code、credential 文案，也不包含购买/创建 CTL 实例。
- 未配置可信 instance ownership directory 时，Computer 导航和实例读取均不存在；不能展示一个
  无法完成加入流程的默认入口。
- OpenCraft extension/typecheck/boundary/build 门禁，以及浏览器宽屏、窄屏、刷新、重连 QA 通过。
