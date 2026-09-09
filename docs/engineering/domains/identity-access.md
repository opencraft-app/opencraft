# 身份与访问领域

本领域覆盖登录、会话、OIDC/OAuth、实名、影子账号和网关授权。核心 Owner 是 `user/auth`；`shadow` 负责腾讯云影子身份流程；`service-gateway` 消费身份状态执行公共路由门禁。

## 服务与责任

| 服务 | 责任 |
|---|---|
| `user/auth` | 登录、会话、实名与身份 API 真源 |
| `shadow` | 影子账号注册、临时凭据与平台回调编排 |
| `service-gateway` | 在公共入口消费身份/实名状态 |
| `collaboration` | 消费 Gateway 已验证的 LightVela Human 断言并映射本地协作 actor；不签发登录会话 |
| `frontend` / `admin-gateway` | 表达登录状态和引导，不独占授权逻辑 |

## 稳定不变量

- 会话、实名和权限结果来自服务 API/权威存储，不从 UI 状态或用户名推断。
- 一次性 `auth_code`、临时凭据和回调 token 必须保持最小暴露与明确过期语义。
- 公共行为至少验证网关路径；直连 `user/auth` 只证明内部 API。
- 外部 IdP、腾讯云账号/CAM/STS 的实时契约通过登记来源校验，不把凭据或完整响应复制进文档。
- `service-gateway` 必须先完成会话、实名门禁和 Bot 所有权校验，再启动后台 Worker Action；认证完成后的 TAT 执行超时、重试和清理策略属于运行控制，不得改变或绕过身份判定。
- Collaboration Human 请求必须经过 `service-gateway`。浏览器只携现有 LightVela session，不能持有 Gateway 到 Collaboration 的内部 Bearer，也不能通过自定义身份头声明用户。
- 邀请返利上下文不是访问邀请码或登录凭据。浏览器只能先通过公开接口校验返利码，再由 Auth 写入
  30 分钟 HttpOnly Cookie；OAuth/手机号/密码注册仅在新用户事务中消费它并写 outbox。已有用户登录、
  自行构造 `X-User-Id` 或直接提交任意 owner ID 都不能建立归因。成功或退出后清除上下文。
- Referral 的公共面只允许精确的返利码查询和 Auth `/auth/referral/prepare`；`/v1/referrals/me/**`
  必须经过现有 LightVela session 内省。`service-gateway` 在转发前清除调用方提供的 `X-User-Id`
  等身份头并注入会话中的权威用户 ID，Referral 只消费该集群内断言；不得把 Referral ClusterIP、
  任意 owner 参数或宽泛路径暴露为公共身份入口。

## 机器契约与验证

### OpenCraft 第一方客户端登录

原生 App 与 Workbench Web 都是现有 OIDC 的第一方 public client，不是登录渠道。客户端使用现有
GET `/oauth2/authorize`，统一 `/auth/federation/authorize` 页面复用 LoginModal
及其地区可用渠道；渠道成功返回该 HTTPS 页面后，经用户确认再由公共 OIDC
POST `/oauth2/authorize` 签发 code。不新增登录页、Google 专属启动入口或 provider 回调分支。

在 `LIGHTCLAW_OIDC_CLIENTS_JSON` 中显式注册：
`{"id":"opencraft-native-v1","display_name":"Vela","redirect_uris":["opencraft://auth/lightvela"]}`。
以及 `opencraft-web-v1` 的两个精确 HTTPS callback：
`https://chat.lightvela.com/auth/lightvela/callback`、
`https://chat.lightvela.ai/auth/lightvela/callback`。保留 site-gateway 原有两个精确 HTTPS callback。只有 native client 的精确
自定义协议地址被允许；通用 Web return_to 不变，不支持通配、查询、fragment 或路径变体。
OIDC 未启用、无 MySQL 或客户端未注册时不降级到其他认证实现。

App 持有随机 state/verifier，使用 S256、nonce、response_type=code、scope=openid profile。
OIDC 服务校验客户端/地址/参数，MySQL 存储授权码及绑定关系并原子消费。第一方客户端 code 为
256-bit base64url，120 秒过期；site-gateway 保留原有 5 秒寿命。回调仅含 code/state 或
error/state。客户端在 TLS POST `/auth/session/exchange` 携 client_id、verifier 与固定 callback
兑换正常 session（契约 `user/auth/api/native-login.openapi.yaml`）；这是受限的第一方会话适配器，
不是第二个发码器。`/auth/native/token` 只作为已发布原生版本的兼容别名。第一方 session
客户端在标准 `/oauth2/token` 被拒绝，不能另取 JWT；其他 OIDC client 不能兑换普通 App
session。消费时重新核验 registry，不把 OIDC JWT 冒充现有 API session_token。

Workbench Web 不消费 OIDC JWT，也不把任意线程地址注册成 callback。浏览器以
sessionStorage 持有 state/verifier、发起路径和地域，授权只回到固定 callback；兑换成功后
再在同源内恢复发起路径。已有 `lightvela.com` / `lightvela.ai` 会话由统一授权页识别并进入
当前账号确认；未登录时才显示完整 LoginModal，因此手机号、微信、QQ 等地区渠道不需要在
Workbench 内重建。不得用父域 Cookie 共享扩大长期凭据的信任域，也不得恢复 `/auth/sign-in`
加任意 `return_to` 的并行交接协议。

SecureStore 待完成事务寿命 10 分钟。进程共享存储串行化写入及 compare/delete，
旧 owner 仅可删除自己创建的记录；过期/伪造 callback 不得阻断已有 session 恢复。
授权页与登录弹窗共用受 visualViewport 约束的可滚动容器，支持小屏、键盘和长账号。
取消返回已经由服务端校验的 callback/state，不绕过移动浏览器的微信渠道限制。

部署需单独授权：启用现有 OIDC 配置和 MySQL code table，增加第一方客户端注册，
确保既有 /oauth2 路由可达，并仅增加 POST /auth/session/exchange 的公开兑换规则。
不要公开整个 /auth，不再增加 GET /auth/native/start。服务端、授权页面及 App
须一起验证；源码测试不等于生产发布或真实 IdP 登录成功。

### Collaboration 的 LightVela Human 身份委托

OpenCraft 登录仍由上述 LightVela OIDC public client 完成。客户端兑换得到正常
`session_token` 后，通过公共 `/v1/collaboration/**` namespace 请求 `service-gateway`；
Collaboration 本身不是新的 OIDC client，也不接收授权码、ID Token 或用户密码。

`service-gateway` 必须先用原始 Bearer 或 `lc_session` 调用 `user/auth` 的
`/auth/session` 内省。内省成功后，Gateway 清除调用方提供的
`X-Lightclaw-User-ID`、`X-User-Id`、`X-Uin` 等身份头，再注入权威
`X-Lightclaw-User-ID`。转发到 Collaboration 时，原始用户 Authorization 和 Cookie
不得继续传递；Gateway 将 Authorization 替换为运行时 Secret 提供的内部 Bearer，并把
`/v1/collaboration` 重写为 Collaboration 的 `/v1`。

Collaboration 同时验证内部 Bearer 和 LightVela subject。首次出现的合法 subject 只创建稳定的
`lightvela subject -> local collaboration actor` 映射，并调度腾讯云 IM identity projection；
映射记录不包含密码，也不产生第二套登录 session。配置内部 Gateway token 时，本地注册、密码登录、
refresh 和 logout 路由不进入已实现路由集合。Human 产品路径由 Gateway 的精确 allowlist 控制；
旧 Computer/TAT bootstrap 不因复用 Handler 而扩大公开认证面。腾讯云 IM 状态 callback 是单独的
provider callback 路径，仍由 callback token 校验，不产生 Human principal。

部署边界是一个只在集群内可达的 Collaboration Service，以及两端独立挂载但值相同的内部 token。
缺少 token、会话内省失败、subject 为空或 subject 与内部 Bearer 不匹配时必须 fail closed，不能降级为
本地账号认证或信任浏览器身份头。验证至少覆盖身份头覆盖、用户凭据剥离、内部 Bearer 替换、JIT 映射
幂等，以及独立登录路由为 404。

### 个人 DevCloud testing 注册身份（2026-09-17）

个人环境注册是 sandbox-only 的测试控制面，不是新的登录渠道。开发者先用国内或国际 testing 账号
建立正常 LightVela session；`user/auth` 只从该 session 的 active shadow binding 读取 UIN，客户端不能
提交或覆盖 UIN。注册请求只允许提交 callback 端口和 TTL，目标 IP 由 Auth 经已登记的
Service Gateway / ingress 可信代理链计算 `ClientIP()`；直接伪造 `X-Forwarded-For`、自定义用户头或
请求体 IP 都不能改变身份与落点。

Auth 到 CloudLadder Gateway 的注册、查询和注销请求使用独立 route/caller，并在数据面处于
`optional` 或 `disabled` 时仍强制校验 HMAC。国际站返回的 devtunnel capability 只在首次注册响应中
短期交付给当前 DevCloud agent，后续状态接口不再返回；共享 HMAC、SOPS 和 `DEVTUNNEL_TOKEN` 不进入
个人环境。注销或 TTL 过期必须使 capability 和动态路由同时失效。

生产和 staging 不启用 `PERSONAL_DEV_ROUTE_CONTROL_ENABLED` 或 developer route store；同名 HTTP 路由
即使存在也只返回 disabled，不得降级到客户端自报身份或共享 Secret。验收至少覆盖无 session、非 active
binding、伪造代理头、错误 HMAC、跨 UIN、注销和过期；任何日志与测试报告都不得包含 session、密码或
capability 明文。

API 真源是 `user/auth/api/openapi.yaml`，Shadow 的实现/架构在 `shadow/internal/` 和 `shadow/ARCHITECTURE.md`。身份变更至少覆盖成功、过期、缺失、越权、回调伪造和跨站点路径。

相关 Journey：[账号到 Agent](../journeys/account-to-agent.md)。Agent 摘要：[identity-access Context](../../context/domains/identity-access.md)。
