# 邀请链接注册后自动加入协作空间设计

## 目标

用户打开邀请链接后，即使尚未注册，也应完成一条连续链路：

```text
打开邀请链接 → 注册或登录 → 等待 IM 身份就绪 → 接受邀请 → 加入 Server → 进入落地 Channel
```

产品语义中的“协作空间”继续映射现有 `Server`，不新增 `Workspace` 表或第二套成员关系。

## 已有能力

当前系统已经具备主要构件：

- `/join#token=...` 会把邀请 token 保存到 sessionStorage，并立即从地址栏删除 fragment；
- 未登录用户会带 `returnTo=/join` 进入登录页，登录与注册之间切换仍保留 returnTo；
- 注册成功后自动建立登录态并回到 `/join`；
- `/join-links/accept` 原子消费邀请，创建 `Member` 与 `AccountServerMembership`，并创建
  `im.membership.ensure` Operation；
- 接受成功返回稳定的 `serverSlug` 与 `landingChannelId`，前端会选择 Server 和 Channel；
- 已是成员时，join-link 语义会返回现有成员和稳定落点，而不是报冲突。

## 当前断点

注册事务把 Account 建为 `imState=provisioning`，并异步创建 `im.identity.ensure`。
`bootstrap(account)` 会立即把前端切为 signed-in，同时尝试连接 IM；账号尚未 ready 时该连接可能
失败，但 bootstrap 仍会完成。随后 `/join` 立刻调用 `acceptJoinLink`，Backend 因账号 IM 身份
未就绪返回 `im_identity_not_ready`。

当前前端只把它归为普通 retryable 错误并显示人工“重试”，因此链路不是自动的；即使稍后接受
成功，初次 IM 连接也可能仍处于 error，现有 `acceptJoinLink` 不会主动重连。

## 方案选择

采用前端 Join Coordinator 的有界自动续接，不修改数据库和 Backend 成员事务。

不采用以下方案：

- 在 Backend 中允许 IM Identity 未就绪时先创建 Member：这要求给两个异步 Operation 增加
  显式依赖与防热循环调度，改动面远大于当前需求；
- 新增持久化 PendingJoin 实体：邀请 token 已有有效期和 session intent，开发阶段没有跨设备
  恢复需求，不应增加长期事实。

## 状态与行为

`joinLinkErrorKind` 增加 `identity_pending`，只对应稳定错误码
`im_identity_not_ready`。其他分类保持：

- `terminal`：邀请无效、过期、撤销或耗尽；清除 token，不再重试；
- `identity_pending`：保留 token，自动重试；
- `retryable`：网络、限流或未知临时错误；停止自动循环，保留 token并显示人工重试。

Join Route 在同一次挂载期间最多运行一个接受流程。遇到 `identity_pending` 时使用有上限的退避
重试；建议间隔为 500ms、1s、2s，之后保持 2s，最长约 30 秒。

Route 为每个自动等待窗口分配递增 generation，并绑定窗口开始时读取的唯一 token。组件卸载、
用户退出或人工开启新窗口时，必须递增 generation、取消尚未触发的 timer，并忽略旧 generation
中已经发出的 HTTP 完成结果。现有 HTTP 接口没有 `AbortSignal`，本轮不伪称能够中止已发请求；
安全合同是陈旧结果不得导航、清 token 或启动下一次重试。当前 route 只在挂载时捕获一次 hash，
本轮不监听运行中的 hash/token 替换。

超过自动等待窗口后显示“账号仍在准备中”，保留 token 和人工重试按钮。人工重试会开启新的
有界等待窗口，不重新注册，也不丢失邀请。

## 成功后的 IM 收敛

`acceptJoinLink` 成功后保持现有顺序加载 Server Context。若 `imState` 不是 `ready`，在选择
落地 Channel 前调用现有 single-flight `reconnectIm()`。

`acceptJoinLink` 的非空 `JoinResult` 只表示 membership 已经接受；它不能因为随后的 IM 重连失败
退化为 `null`。Route 一收到非空结果就清除邀请 token，并检查最终 `imState`：

- ready：进入返回的落地 Channel；
- 非 ready：进入本地 `accepted_chat_unavailable` 状态，保留已加载的 Server Context，显示
  “已加入协作空间，但聊天尚未连接”，提供只调用 `reconnectIm()` 的按钮；不得再次调用
  `acceptJoinLink`。重连成功后才进入原 landing Channel。

这不要求修改公开 Platform DTO；`JoinResult` 加当前 store `imState` 足以区分 membership 结果与
聊天可用性。

这条边界把长期事实和可替换投影分开：Server membership 一旦成功就是权威事实；IM 重连失败
只影响聊天可用性，不回滚成员关系。

## 幂等与安全

- token 继续只保存在 sessionStorage，TTL 保持 30 分钟，不进入 query、日志或持久数据库明文；
- 每次 HTTP 尝试仍携带 Idempotency-Key；网络结果不确定时，join-link 的 existing-member 语义
  返回相同落点，因此不会创建重复成员；
- Route generation/single-flight 是自动加入的权威并发控制；全局 `pendingAction` 只保留为其他
  action 重叠时的防护，`pendingAction` 导致的空结果不得解释为 membership 终态；
- 终态错误清除 token，临时错误保留 token。

## 测试

先增加失败用例，再实现：

1. Join Route 第一次收到 `identity_pending` 后自动重试，第二次成功并进入落地 Channel；
2. 自动重试期间不会并发调用 accept；
3. 卸载或 generation 变化后取消计时器，已发请求的陈旧结果不能导航或清 token；
4. 达到等待上限后保留 token并显示人工重试，人工重试取消旧 timer 并创建新 generation；
5. `invite_invalid` 仍清除 token；
6. App Store 将 `im_identity_not_ready` 精确分类为 `identity_pending`；
7. 接受成功但 IM 重连失败时清 token、保留 membership、不再次 accept、不进入聊天，并允许
   只重试 IM；
8. 原有登录、注册 returnTo、已有成员幂等与普通加入测试继续通过。

完成门禁为客户端类型检查、相关 Jest、全量 Jest、Web 构建、凭据扫描和
`git diff --check`。
