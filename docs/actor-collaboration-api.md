# 单 Hub 主体协作接口

Headless 的首期协作闭环：已认证自然人和 Session 共用消息、投递及执行请求接口；Codex 运行通过显式绑定接纳 queue / steer。此处是已实现契约，长期方向见[主体与 Hub 纲领](architecture/actor-collaboration.md)，账户入口见[服务器登录](server-authentication.md)。

## 身份与授权

所有请求位于 `/__opencraft_actors/collaboration/`。人类沿用已配置的本地、OIDC 或 企业身份 登录与实例准入；Session 使用核心签发的 `Authorization: Bearer <token>`。匿名请求拒绝。请求体不能指定作者或当前行动者；核心从认证入口建立 ActorContext。人类 POST 需要匹配可信入口的 Origin；Session bearer POST 不依赖浏览器 Cookie。请求体限制为 UTF-8 JSON、64 KiB。

调用者必须获得针对目标 Actor 的显式授权：

| 动作 | 允许的操作 |
|---|---|
| `message.send` | 给目标主体发送私聊消息 |
| `execution.queue` | 请求目标 Session 排队执行已引用的消息 |
| `execution.steer` | 请求向目标 Session 的指定 Turn 追加输入 |
| `execution.cancel` | 目标接收者取消尚未领取的执行请求；原请求者可取消自己的请求 |

创建者身份不自动授予这些权限。Grant 使用既有 Actor 管理接口，只有明确的 registry 管理者可设置。运行绑定也由 registry 管理者设置；绑定管理权限不是发送或执行权限。首期只支持当前 Hub 的 `local-codex`，每个 Session 一个当前 Thread、每个 Thread 一个当前 Session；这是当前适配约束，不是 Actor 永久身份。重绑使用 epoch CAS，旧代次工作不会进入新绑定。

Session bearer 仍被旧共享 HTTP / WebSocket 入口拒绝。自然人原有共享入口保持兼容；本接口不证明旧原生接口、Shell、文件或进程已经具备租户隔离。不要把部署在共同高权限系统账号下的敌对执行者视为隔离租户。

通用 `Collaboration` 和进程内 `createConversationExecution` 要求执行端明确提供 `hostId`；缺失或非法时在打开存储或连接 Host 前拒绝，不能根据缺省值推断执行引擎。当前 Headless 装配仍明确选择上述原生适配，不扩大 Session 绑定能力。新绑定和请求保存声明的 Host，用量恢复按该 Host 或明确 Server 身份匹配。已发布 v2 SQL 的旧默认值与既有记录不改写；只读恢复历史 nullable 请求时保留原先的本地原生身份，不把它用作新请求默认值。

## HTTP 操作

以下路径相对接口前缀。返回 JSON 使用私有、禁止缓存策略。ID 是不透明值；请求者从返回结果引用，不从显示名推导。

| 方法与路径 | 请求 | 返回 |
|---|---|---|
| POST `messages` | `targetActorId, content, idempotencyKey, replyTo?, execution?` | `messageId, requestId?, replayed` |
| POST `requests` | `targetActorId, messageIds, execution, idempotencyKey` | `requestId, replayed` |
| GET `inbox?after=0&limit=50` | 当前主体的收件箱 | `messages`，含投递状态 |
| GET `messages?peerActorId=…&after=0&limit=50` | 当前主体与对端的私聊 | `messages` |
| POST `read` | `messageId` | 标记当前接收者已读取 |
| GET `requests?id=…` | 仅原请求者或目标主体可查 | `request`，含输入消息 ID |
| POST `cancel` | `requestId` | 未领取时取消；已领取/不明时拒绝 |
| GET `bindings?actorId=…` | 仅自身或 registry 管理者 | `binding` 或 null |
| POST `bindings` | `actorId, threadId, expectedEpoch` | 经验证的新绑定 |

内容最多 16,384 字符；输入引用最多 32 个、不能重复，必须是调用者可见且与执行目标有关的消息。分页 limit 为 1–100，after 使用返回消息的 seq。私聊 Channel ID 从双方稳定 Actor ID 得出；没有多人频道、成员邀请或跨 Hub 路由接口。

例如，Session A 已获准向 B 发送并排队：

```json
{
  "targetActorId": "session://issuer/target-id",
  "content": "请复查测试结果",
  "idempotencyKey": "review-request-1",
  "execution": { "mode": "queue" }
}
```

`execution` 缺省表示只发送消息，不唤醒引擎。也可先发送多条消息，再用 `requests` 引用它们组成一个输入。请求者与不可变消息作者分别保存；转交可见消息不会把作者改为当前请求者，也不产生代办权限。

`steer` 必须明确提供 `expectedTurnId`：

```json
{ "mode": "steer", "expectedTurnId": "current-turn-id" }
```

目标 Turn 已结束、不匹配或不支持时拒绝，不自动降级到 queue，不把内容带入下一轮。queue 可以在目标忙碌时等待；这两种动作分别授权。

## 所有权、恢复与撤销

`Collaboration` 拥有独立受迁移管理的 `actor-collaboration.sqlite`：消息、每个接收者的投递状态、运行绑定、执行请求与输入引用、幂等键。消息与接收回执在同一事务提交。`received` 仅表示进入持久收件箱，`read` 表示接收客户端显式标记，均不表示模型已消费或任务完成。

执行权威仍是 `OpenCraftHostQueue`。协作服务保存交接过程，不另建能独立领取运行的队列；以稳定的 `actor-input:<requestId>` 关联现有队列。可信进程内上下文允许有限的入队、查询、steer 和取消；JSON / Wire 中伪造同名字段无效。管理中的输入不可通过旧队列界面编辑、删除、重排或手动启动；只能经协作接口操作，原消息不可变。

| 执行状态 | 含义 |
|---|---|
| accepted / transferring | 已接受请求 / 正向既有队列交接 |
| queued | 已有持久队列回执，尚未证明领取 |
| submitted | queue 已收到原生 Turn 接纳回执 |
| injected | steer 已收到指定 Turn 接纳回执 |
| rejected / cancelled | 请求拒绝 / 已确认未领取并取消 |
| unknown | 交接或领取结果不明，保持对账，不盲目重新提交 |

提交或注入不表示模型任务成功。原生队列保留已领取结果，恢复时先查询相同标识，再对账；丢失应答不生成第二个输入。若交接前后崩溃且查不到可靠回执，保持 unknown，首期不提供人工“重试成新执行”的捷径。

协作入口验证当前证明。已接纳请求随后按当前 Actor 启用状态/代次、实例成员资格（含已配置的认证来源默认成员策略）、目标授权、运行绑定 epoch 复核，既有队列在最后一次异步准备完成后、领取前再次同步校验。退出浏览器登录或撤销用于接入的单个凭据阻止新调用，不自动抹除已接纳工作；停止待执行工作应取消请求或撤销相关 Actor / grant。已接纳工作不再绑定一次登录；自然人的任一已绑定身份被显式撤销成员资格时，保守停止其待执行工作，避免从多个登录来源中自行选择宽松的一项。已提交的事实在撤销后仍保留；撤销不能撤回已经送入原生 Turn 的输入。

`actor_run_bindings`、消息与请求随 Headless 数据根保存，关闭页面或普通服务重启不删除它们。新增库使用 v1 迁移，不改写已发布账户或队列迁移。健康接口报告该库迁移 outcome。回退前应暂停入口并确认所有协作输入已终结；旧版本不识别领取校验，不应带着可执行的 Actor 队列直接启动旧二进制。保留完整数据和 WAL，不手工删行。

## 当前边界

本期提供 HTTP 后端与本地 Codex 适配，不提供新聊天 UI、自动给模型分发 Session 密钥、自动把每个历史 Thread 发行成 Actor、模型回复自动回传、Hermes 适配、多频道订阅或跨 Hub 联邦。主动 Session 客户端可用自己的受限凭据收发；模型工具如何代表绑定 Session 发起调用须经后续受限运行能力接口接入，不能把 bearer 塞入提示词。共享系统资源隔离仍是独立工作。


会话资源使用同一核心服务，新增版本2迁移保留旧消息与回执。原Actor HTTP路由仍为渠道适配；初始化Host的`opencraft/collaboration`命令及服务端工具共用会话资源授权、幂等与交接。稳定引用、读取边界和实际能力见[会话互通](architecture/conversation-interoperability.md)。

## Thread orchestration control ledger

The collaboration owner appends schema v3 to `actor-collaboration.sqlite`. Its
`ThreadOrchestrationLedger` stores immutable parent/lifecycle/owner relationships,
root-Turn runtime projection, tool intent and result receipts, wait subscriptions
and parent notification batches. Existing v1/v2 migrations and communication data
are preserved. This ledger does not create a second native input queue or own an
engine connection.

Tool intents bind a stable tool call key, delegation, source, arguments fingerprint
and optional source-scoped idempotency key before execution. A committed result is
immutable; a pending intent alone does not prove whether a native mutation was
accepted. The Broker must reconcile that case with the execution owner. Wait
subscriptions outlive the short polling call and retain their original expiration.
Notifications retain per-root outcome deduplication after delivery; pending batches
coalesce for two seconds with a five-second maximum deadline and preserve direct
user intervention. A gateway restart reloads remaining deadlines from the ledger.

This storage increment supplies no model tools or HTTP endpoint by itself. The
Broker, Engine Host reconnect/replay and recovery integration remain separate
Stage 1 increments; the target design is in
[the orchestration specification](../design/thread-orchestration-spec.md).
