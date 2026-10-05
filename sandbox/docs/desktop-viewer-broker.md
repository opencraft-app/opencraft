# 授权桌面观看 Broker

状态：`internal/desktop` 的源码与测试，未挂载到 Sandbox/Gateway 公共路由。
没有默认授权源或默认可信身份头；不因存在 handler 就声明可用能力。

## 所有权

远端桌面与 Agent 拥有独立寿命。Broker 只拥有短凭证、观看连接及确认后的控制交接。
Authority 的 `Resolve` 必须读取当前 Conversation → Server → Instance 的授权绑定、
准备代次、权限 revision 和可信物理 incarnation；不能把客户端 DTO 当权威。
`OpenVerified(opening, lifetime, binding)` 必须验证目标端点和原生输入策略，返回专用连接；
opening 的取消不应取消已成功交接的 lifetime。不得注入无限制旧 VNC 流或浏览器 TAT session。

原生观察流始终只读，不提供 Controller。控制流必须默认拒绝输入，由实际执行器的
`Acquire` 确认独占控制后才允许；执行器负责其他 viewer/Agent 的仲裁。
`Grant.Done` 必须非空，并在撤权/释放时关闭；`Release` 和 stream Close 必须撤权并清除
远端按住的键/按钮，未知释放结果退休整个观看连接。接口和模拟测试不是原生执行器实现。
Sandbox 当前没有生产 Authority 或 Controller；直接只读 TAT 原语不能冒充这些端口。
OpenCraft 本机执行 Host 已另行实现受回环地址限制的 native Codex Thread 授权、一次性观看
连接与 root 核验代理组合；它不挂载本 Sandbox handler，也不等于 Vela 多租户授权或真实 TAT
验收，见 [本机 Host 契约](../../opencraft/docs/cloud-desktop-plugin.md#local-execution-server-authority)。
Provider 已有独立 `InspectDesktopObserver` / `OpenVerifiedDesktopObserver`：消费 CTL 的原生
5902 核验代理，以 root-only key 和每连接新 nonce/MAC 核验实际 Xvfb/x11vnc、已接受 socket
与 incarnation，身份头不进入 RFB。此路径只读，不提供 Controller；不是产品授权源。
真实 Authority 仍须通过会话目录取得 Instance/地域与准备代次，Inspect 得到物理身份，
认领时用 OpenVerified 的预期身份重验；不得从客户端请求取得云实例 ID 或把 5901 原语当成该适配。
CTL 当前只有用户→实例→Sandbox 的 DAO，客户端 Server 投影不是后端会话授权目录。
启动、信任模型及原生验收见 [CTL 资源契约](../../ctl/docs/cloud-desktop-resource.md)。

## 接口与身份

Handler 路径相对挂载点，必须由产品组合显式配置：

| 路径 | 意图 |
|---|---|
| `POST /desktop/attachments` | 认证并重验完整绑定；返回 `OK/data` 封装的短凭证 |
| `DELETE /desktop/attachments/{id}` | 原身份释放自身 attachment；返回 `OK/data:null`，幂等 |
| `GET /desktop/connect` 升级 WSS | 第一帧提供一次性短凭证；验证后才开媒体 |

POST body 为 `target {conversationId,serverId,environmentId,principalId}`、`instanceId`、
`resourceId`、`preparationGenerationId`、`bindingRevision`；当前鉴权主体须与 target 一致，
所有字段须与 Resolve 结果一致。响应增加 version=1、attachmentId、ticket、incarnation、
expiresAt（Unix 毫秒）；不含 TAT 凭据或客户端可指定地址。

HTTP 创建/释放必须注入真正的 Authenticate，非浏览器自报身份头。WS 以 scoped ticket
作能力认证，主体来自服务端已存绑定；可选 SocketPrincipal 为额外的受信 cookie/gateway
身份，配置后不允许错误或不匹配时降级。浏览器无需把通用 bearer 放入 URL 或子协议。
生产公共路由策略必须明确区分 HTTP 登录和 WS scoped-capability 鉴权，而非直接套一个
要求浏览器附加 Authorization header 的升级路径。精确配置允许的 Origin，不用通配。

服务端保存 ticket 的 SHA-256，并作恒定时间比较；ticket 30 秒内仅能认领一次。
认领前和打开后验证绑定/物理身份，迟到或错误流立即关闭。无凭据重试和自动重放。
原始 ticket/媒体/失败详情不写日志、不进入 UI 或会话持久数据。

## 生命周期与界限

- Attachment 自创建起硬到期 5 分钟；未认领 ticket 到期即回收额度。本版无续期协议。
- 每主体最多 4 attachments；最多 128 attachments 和 128 建立中的/活跃 WS。
  有已知 WS 主体时最多 4 sockets；未知主体的预鉴权窗口由总数与 5 秒首帧截止约束。
- 首帧 4KiB，HTTP body 8KiB，媒体 WS 单帧 1MiB；远端→WS 使用 64KiB 定长缓冲并背压。
  WS 写 10 秒截止。输入字节由原生只读/门控执行器检查，Broker 不自造 RFB 解析器。
- 资源/权限目录变更应主动调用 Revoke；5 秒定期重验为兜底，每次查询最多 5 秒。
  Ping/Pong 45 秒截止处理半开连接。关闭仅回收自己的 stream/socket，不停止桌面、Chat 或其他 viewer。
- 控制 ID 在一条连接内严格递增；取消只影响本次请求，迟到成功立即释放，不确认旧请求。
  本地状态不取代执行器的跨连接独占权限。
- 所有内存凭证与连接由单个 Broker 进程拥有。必须按 attachment owner 粘连路由；不能宣称
  多副本一致性、跨重启恢复或持久租约。资源存活不代表观看可无缝恢复；新连接需新凭证。

## 验证

`GOWORK=off go test -race ./internal/desktop` 覆盖身份/代次、重放、限额、到期、取消后迟到流、
二进制媒体、确认/撤权、无 HTTP bearer 的浏览器短凭证连接、单 viewer 回收隔离。
外部 Authority/native stream/Controller 是明确替身，不证明真实 TAT、云端 incarnation 或 Agent 仲裁。
OpenCraft 的 `smoke:cloud-desktop` 使用真实面板、viewer port、session wire 和 noVNC，
HTTP/WS/RFB peer 是本机合成边界。原生只读验收另见 [CTL 资源契约](../../ctl/docs/cloud-desktop-resource.md)。
