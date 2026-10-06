# 身份与访问领域

本领域覆盖登录、会话、OIDC/OAuth、实名、影子账号和网关授权。核心 Owner 是 `user/auth`，包括腾讯云影子身份和绑定状态；`service-gateway` 消费身份状态执行公共路由门禁。

## 服务与责任

| 服务 | 责任 |
|---|---|
| `user/auth` | 登录、会话、实名、影子账号注册/绑定与身份 API 真源 |
| `service-gateway` | 在公共入口消费身份/实名状态 |
| `collaboration` | 消费 Gateway 已验证的 LightVela Human 断言并映射本地协作 actor；不签发登录会话 |
| `frontend` / `admin-gateway` | 表达登录状态和引导，不独占授权逻辑 |

## 稳定不变量

- 会话、实名和权限结果来自服务 API/权威存储，不从 UI 状态或用户名推断。
- 一次性 `auth_code`、临时凭据和回调 token 必须保持最小暴露与明确过期语义。
- 公共行为至少验证网关路径；直连 `user/auth` 只证明内部 API。
- 实名短信发送的 IP 级限流只可使用可信代理链计算出的客户端 IP。Service Gateway 会重写 `X-Forwarded-For`；Auth 的 `LIGHTCLAW_TRUSTED_PROXY_CIDRS` 必须覆盖其实际直接对端，否则所有用户会按网关 Pod IP 共享限额。`LIGHTCLAW_VERIFICATION_SEND_IP_LIMIT` 配置每分钟发送上限，默认 100；上海生产按 600 配置，收件人冷却和供应商限流保持独立。
- 外部 IdP、腾讯云账号/CAM/STS 的实时契约通过登记来源校验，不把凭据或完整响应复制进文档。
- Frontend 的复用 OAuth 登录入口只负责呈现既有身份 Owner 构造的 authorize URL；无 URL 时不展示，也不在组件内签发 state、拼接 callback、交换 code 或保存 token。路由适配器只能在权威兑换完成后恢复站内路径，不能成为并行认证协议。
- `service-gateway` 必须先完成会话、实名门禁和 Bot 所有权校验，再启动后台 Worker Action；认证完成后的 TAT 执行超时、重试和清理策略属于运行控制，不得改变或绕过身份判定。
- Collaboration Human 请求必须经过 `service-gateway`。浏览器只携现有 LightVela session，不能持有 Gateway 到 Collaboration 的内部 Bearer，也不能通过自定义身份头声明用户。
- 邀请返利上下文不是访问邀请码或登录凭据。浏览器先通过公开接口校验返利码；未登录用户由 Auth 写入
  30 分钟 HttpOnly Cookie，在 OAuth/手机号/密码认证成功后消费。新用户写 `user.registered.v1`，存量用户
  写幂等 `user.referral_claimed.v1`；已登录用户打开 `?ref=` 时直接以当前权威 session 认领，不等待再次登录。
  浏览器自行构造 `X-User-Id` 或直接提交任意 owner ID 不能建立归因，成功或退出后清除上下文。
- Referral 的公共面只允许精确的返利码查询和 Auth `/auth/referral/prepare`；`/v1/referrals/me/**`
  必须经过现有 LightVela session 内省。`service-gateway` 在转发前清除调用方提供的 `X-User-Id`
  等身份头并注入会话中的权威用户 ID，Referral 只消费该集群内断言；不得把 Referral ClusterIP、
  任意 owner 参数或宽泛路径暴露为公共身份入口。
- Attribution 重置不是用户能力。它只通过 Admin Gateway 的 Basic Auth 管理面暴露
  `/admin/api/referral/attributions/{invitee_user_id}` 预览和 `/reset` 执行，不进入用户 Service Gateway。
  执行必须携带期望 attribution ID、操作人、原因和幂等键；Referral 不信任调用方提交的奖励或订阅列表，
  只能从自身数据库快照生成 CTL 精确撤销请求。

## 机器契约与验证

### 认证用户后台分页

Gateway Dashboard 的“认证用户”列表通过 User Auth `GET /admin/users` 做服务端分页。请求使用 `page` 和 `page_size`，响应中的 `total` 必须是搜索条件下的完整匹配数，不能用当前页长度代替；未传 `page_size` 时继续接受旧 `limit` 参数作为兼容页大小。MySQL 查询按 `created_at DESC, id ASC` 稳定排序，搜索条件变化时 Dashboard 回到第一页。

### 影子账号后台查询与 testing 绑定管理

Gateway Dashboard 在“认证用户”页面内展示 User Auth 持有的影子账号绑定。Dashboard BFF 复用
`AUTH_ADMIN_API_URL` 和服务端 `AUTH_ADMIN_TOKEN` 调用 `GET /admin/shadow-accounts`；浏览器只携
Dashboard 管理员会话，不接触 Auth admin token，也不得跨服务或直接读取数据库。

查询以 `shadow_bindings` 为分页主体，并从同一 Auth 用户存储补充手机号和实名状态；支持按用户 ID、
影子用户名、UIN、OwnerUIN 或 AppID 搜索。UIN、OwnerUIN 和 AppID 在 HTTP 契约中使用十进制字符串，
避免 JavaScript 精度丢失。该管理面只读，不得增加后台修改实名、换绑手机号或删除绑定的捷径。

个人 DevCloud 的 testing mock 账号分配是另一套受控事实：它只修改 Auth MySQL 中既有的
`shadow_bindings`，不修改 Shadow SQLite。Auth 提供 admin token 保护的查询、绑定和显式解绑接口；
功能开关默认关闭，只有 `sandbox-*` 环境名与精确匹配的
`https://api-<environment>.lightclaw.tech` 公共地址同时成立时才可启用。当前只允许
`sandbox-bj-7` 开启。Gateway Dashboard 的“DevCloud 测试绑定”页签通过 BFF 调用该接口；BFF 必须先
验证浏览器管理员会话，再使用仅服务端可见的 Auth admin token 转发，匿名请求不能借 BFF 获得写权限。
相同映射可幂等重试；同一用户改绑、UIN 或影子用户名转移必须先解绑。操作必须携带原因并记录 request ID、
用户、UIN、OwnerUIN、AppID 的结构化审计日志，不接收 SecretID、SecretKey、密码或客户端自报登录用户。

### 个人 DevCloud testing 账号租约（2026-09-22）

为让新同学在公司 DevCloud 上从全空 state 直接启动，`user/auth` 提供 sandbox-only 的
`POST/DELETE /auth/dev-environments/account-lease`。功能默认关闭；只有环境名为 `sandbox-bj-7` 或
`sandbox-kr-1`、
`LIGHTCLAW_PUBLIC_BASE_URL` 精确为 `https://api-<environment>.lightclaw.tech`，且配置了明确的 Auth
`user_id` 池和 DevCloud 出口 CIDR 时才注册路由。Service Gateway 只在北京、韩国 testing 对这两个
method/path 做精确公开放行，并覆盖客户端可伪造的 forwarding headers；Auth 仅接受 Gateway 写入且命中
`PERSONAL_DEV_ACCOUNT_LEASE_SOURCE_CIDRS` 的 `X-Lightclaw-Client-IP`。production 和 staging 不配置账号池，
也不放行该路径。

账号池只包含当前站点合格且 shadow binding 为 active 的 testing 用户：国内候选必须完成实名，国际候选
必须完成国际开户映射。Auth 在发放前重新读取用户与 binding，拒绝缺 UIN、OwnerUIN 或 AppID 的候选；
客户端不能提交 UIN、AppID、密码或云 Secret。MySQL
`developer_test_account_leases` 是并发真源：以账号为主键保存 `lease_owner=<sandbox>:<DevCloud IP>`、
目标地址、TTL 与单调版本。同一 DevCloud 幂等续租现有账号，不同 DevCloud 不能同时占用；池满返回 409。
发放的会话标记为 `developer_lease`，释放时在同一事务中撤销该用户的全部 developer-lease sessions，避免
续租前的旧 token 在账号转租后继续可用。续租不会立即撤销仍在 TTL 内的旧 session，避免服务端成功续租但
客户端超时丢失新 token 时把个人环境锁死；旧 session 最迟随自身 TTL 过期，并在显式释放时全部撤销。
首次领取在受控 DevCloud 网络内无需账号凭据；如果该 `lease_owner` 已存在有效租约，POST 必须携带当前
`developer_lease` bearer session，Auth 校验 session 用户与租约用户一致后才续租。仅知道或伪造另一台
DevCloud 的 `targetIp` 不能签发新 session。

同一台 DevCloud 可能在重新 checkout、清空私有 state 或 `down` 中断后丢失本地 session，从而既不能续租
也不能释放自己的租约，最长被自己的 TTL 锁死 24 小时。为此 POST 支持可选 `force`：只有在请求**没有**
携带续租 session 时才生效，续租 token 始终优先。服务端在同一事务内作废该账号全部陈旧 `developer_lease`
sessions、推进租约版本并签发新 session，因此被接管的旧 token 立即失效。`force` 不改变信任边界：owner
身份仍然只由通过 CIDR 校验的来源与 `lease_owner` 决定，其他 DevCloud 携带 `force` 仍返回
`developer_test_account_busy`，也不能跳过来源网段校验或访问其他站点的账号池。

当前入口的组织信任边界是 sandbox-only 配置、Gateway 规范化的 DevCloud 出口 allowlist，以及脚本校验的
公司 DevCloud `9.0.0.0/8`、`21.0.0.0/8` 目标地址，不是独立的 WOA 员工 OAuth 证明。因此它只能服务
受控 testing 账号和测试余额，不能扩展到生产账号、
客户数据或公网 CIDR。长期 AppSecret、CloudLadder HMAC、admin token、账号密码和 SOPS/age identity
都不得进入账号池、响应、Skill 或 Git。环境 owner 通过智研/计费助手完成账号开户、充值和 active binding
后，只把 Auth `user_id` 加入对应 sandbox 配置；普通开发者只消费短期租约。

清理顺序必须是 callback unregister 成功后再释放账号租约；若 unregister 失败，保留租约直到 TTL，避免
仍有 active callback 的账号被另一台 DevCloud 立即复用。数据库迁移必须先于启用配置执行，不能只发布二进制。

### OpenCraft 第一方客户端登录

原生 App 与 Workbench Web 都是现有 OIDC 的第一方 public client，不是登录渠道。客户端使用现有
GET `/oauth2/authorize`，统一 `/auth/federation/authorize` 页面复用 LoginModal
及其地区可用渠道；渠道成功返回该 HTTPS 页面后，经用户确认再由公共 OIDC
POST `/oauth2/authorize` 签发 code。不新增登录页、Google 专属启动入口或 provider 回调分支。

在 `LIGHTCLAW_OIDC_CLIENTS_JSON` 中显式注册：
`{"id":"opencraft-native-v1","display_name":"Vela","redirect_uris":["opencraft://auth/lightvela","opencraft-intl://auth/lightvela"]}`。
双包由构建 edition 选择国内或国际的精确原生 callback；服务兼容仅注册国内 callback 的既有配置，
新增双包时须显式注册这两个地址。区域切换只在开发者模式中提供，不从当前页面、缓存或错误推断区域。
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
映射记录不包含密码，也不产生第二套登录 session。
当前资料通过同一 Human 身份域的 `GET /me/profile` 返回 `HumanProfile`，不要求该 actor
保存邮箱。旧 `GET /me` 的已发布邮箱 Account 响应保持不变；没有邮箱的委托 actor 不得
伪造邮箱满足旧 DTO，旧接口必须在写成功状态前拒绝编码无效资料。OpenCraft 使用新的资料接口，
Gateway 只按精确路径放行，身份断言和内部 Bearer 校验不变。
协作客户端的 IM owner、目录、历史、草稿及一次性邀请显示按共享账户
`authGeneration` 分代。身份变化时立即废弃旧 scope，旧 SDK 注销完成后才可登录新用户；
旧请求迟到不能向新 View 返回 Server/私聊导航。该消费侧不销毁共享账户或建立第二套登录态。
配置内部 Gateway token 时，本地注册、密码登录、refresh 和 logout 路由不进入已实现路由集合。
Human 产品路径由 Gateway 的精确 allowlist 控制；
成员邀请只公开经 Human 会话验证的 `POST /servers/{serverId}/invites` 与
`POST /join-links/accept`，异步诊断只公开同身份域的
`GET /servers/{serverId}/operations/{operationId}`；不因此开放 Computer bootstrap、
本地 Auth 或任意 Collaboration 管理路径。
旧 Computer/TAT bootstrap 不因复用 Handler 而扩大公开认证面。腾讯云 IM 状态 callback 是单独的
provider callback 路径，仍由 callback token 校验，不产生 Human principal。

Human IM identity projection 的幂等键必须绑定由 IM Secret 与长期稳定 identity key 派生的非明文
credential epoch。账号处于 `error` 时，只有当前 epoch 尚未创建过 identity operation，JIT 映射才允许
在同一账号分片内把账号恢复为 `provisioning` 并追加新的 operation/outbox；同一 epoch 已失败时不得因
页面刷新重复请求腾讯 IM。这样凭据修正后用户下次访问可自愈，同时保留旧失败 operation 作为审计事实，
不修改 OpenAPI、身份映射或聊天正文权威边界。

部署边界是一个只在集群内可达的 Collaboration Service，以及两端独立挂载但值相同的内部 token。
缺少 token、会话内省失败、subject 为空或 subject 与内部 Bearer 不匹配时必须 fail closed，不能降级为
本地账号认证或信任浏览器身份头。验证至少覆盖身份头覆盖、用户凭据剥离、内部 Bearer 替换、JIT 映射
幂等，以及独立登录路由为 404。
同值 token 的权威只保留在 Collaboration SSM；交付工具只选择 `gateway.token` 并重命名投影到
Gateway 专用 Secret，禁止把同一 SSM 中的数据库、JWT 或 IM 密钥带入 Gateway namespace。
Gateway 配置该 upstream 后若专用 token 环境变量为空，进程必须在启动阶段失败。
北京本地预览入口只允许显式的 localhost/127.0.0.1 Origin；不得因 sandbox 全局 CORS 为 `*`
而扩大 Collaboration 的 credentialed CORS。该环境变量从专用 Secret 非 optional 注入。北京主 sandbox
使用普通 Kustomization 同时拥有 base、平台值 replacements、Secret generator 和身份桥接 patch，确保
patch 与基准 Deployment 在同一累计器；禁止通过 Component 注入内部 token，因为 Component patch
无法修改其引入的 Deployment。
浏览器 CORS 只由公共 Gateway 判定和响应；通过 allowlist 后，Gateway 必须从私有 Collaboration hop
删除浏览器 `Origin`，避免 Collaboration 的直连 CORS allowlist 再次解释公网来源并拒绝合法本地预览。
该删除不影响权威 subject、内部 Bearer、请求 ID 或客户端 IP 投影。

### 个人 DevCloud testing 注册身份（2026-09-17）

个人环境注册是 sandbox-only 的测试控制面，不是新的登录渠道。开发者先用国内或国际 testing 账号
建立正常 LightVela session；`user/auth` 只从该 session 的 active shadow binding 读取 UIN，客户端不能
提交或覆盖 UIN。国际站注册请求只提交 callback 端口和 TTL，目标 IP 由 Auth 经已登记的
Service Gateway / ingress 可信代理链计算 `ClientIP()`。国内 sandbox 因公网 NAT 无法保留 DevCloud
地址，可在独立开关开启时由 Skill 显式提交自动探测的 `targetIp`；Auth 只接受 `9.0.0.0/8` IPv4 和
固定端口 `18084`，CloudLadder 仍执行第二层 CIDR、端口和 health probe。生产、staging、默认配置以及
国际 testing 均不开启该能力；请求体中的 UIN、自定义用户头或代理头都不能改变 session 派生的身份。

Auth 到 CloudLadder Gateway 的注册、查询和注销请求使用独立 route/caller，并在数据面处于
`optional` 或 `disabled` 时仍强制校验 HMAC。国际站返回的 devtunnel capability 只在首次注册响应中
短期交付给当前 DevCloud agent，后续状态接口不再返回；共享 HMAC、SOPS 和 `DEVTUNNEL_TOKEN` 不进入
个人环境。该内部控制面 JSON 契约中的 UIN 使用规范十进制字符串；Auth 只在服务边界内转换为整数类型，
不得让 Go 默认数字编码与 CloudLadder 的字符串主键产生隐式类型漂移。CloudLadder 与 devtunnel 通过同一 HMAC 内部接口读取 Auth testing MySQL 的
`developer_route_registrations`；表内只保存 capability SHA-256，不保存 capability 明文。注销写入
disabled tombstone，TTL 过期由消费者按 `renewed_at + ttl_seconds` 判定，二者都必须使 capability 和
动态路由同时失效。registry 不可用、响应字段不合法或目标超出 DevCloud CIDR/端口约束时必须 fail closed。

同一短期 capability 也可用于 sandbox-only 的个人计费代理，但它不是计费长期凭据。Auth 逐请求从
capability 解析 UIN，重新读取 registry 并校验 digest、TTL、disabled 与 `delivery_mode=devtunnel`，
然后只允许固定的 Jifei `ModifyResourceStatus` 和 Billing CloudAPI 支付动作。Jifei envelope 的
`ownerUin/uin` 必须等于 registration UIN。CloudAPI 用户身份由绑定账号签发的短期 TC3 凭证负责；
`X-Qcloud-User-Id` 是 testing 路由服务账号，不等于购买用户 UIN，个人客户端不得提交，只能由中央 Trade
注入。客户端 capability 不转发给 Trade，Auth 改用既有内部 Bearer，并把个人 Trade 已生成的 TC3
Authorization 放入内部专用 header。
续租覆盖 digest 后旧 token 立即失效，注销后同一 token 必须返回 `401`；`403` 只能用于已验证 capability
的业务 allowlist 拒绝探针。个人环境不得取得 Jifei AppSecret、CloudLadder HMAC 或中央内部 Bearer。

个人环境必须把中央 testing 身份和本地浏览器身份分开保存：`central_*` 只用于恢复持有真实 shadow
binding 的 testing session，`local_*` 只用于个人 Auth。自动生成的 `lv-local-*` 身份不得尝试登录中央
Auth，中央 session 失效时也不得静默新建另一个账号或覆盖原 UIN。计费 capability readiness 使用固定
探针穿透个人 Trade、中央 Auth 和中央 Trade；只有完成 capability、registration、UIN 和内部 Bearer
校验后，中央 Trade 才在调用 Jifei/CloudAPI 之前返回 `200 + {"code":"OK","message":"ready"}`。
空 `204`、业务 allowlist `403` 或页面可访问都不能证明该链路已就绪。

生产和 staging 不启用 `PERSONAL_DEV_ROUTE_CONTROL_ENABLED` 或 developer route store；同名 HTTP 路由
即使存在也只返回 disabled，不得降级到客户端自报身份或共享 Secret。验收至少覆盖无 session、非 active
binding、伪造代理头、错误 HMAC、跨 UIN、注销和过期；任何日志与测试报告都不得包含 session、密码或
capability 明文。

API 真源是 `user/auth/api/openapi.yaml`，影子账号实现位于 `user/auth/internal/shadowbinding/`。身份变更至少覆盖成功、过期、缺失、越权、回调伪造和跨站点路径。

相关 Journey：[账号到 Agent](../journeys/account-to-agent.md)。Agent 摘要：[identity-access Context](../../context/domains/identity-access.md)。


## 建站无状态 API 身份边界与隐藏发布

`site-gateway/internal/httpapi/fullstack.go` 在转发 `/api`、`/api/*` 前读取实时站点
归属，校验绑定站点 host 的加密会话中的 SiteID 与 UserID。只有站点 owner 可以调用；
国际 public 静态页、分享会话或普通访客不因此获得 API 权限。写请求必须是同源 HTTPS
Origin，所有请求必须携带当前 `X-Website-Release`。浏览器 Cookie/Authorization、
平台凭据和任意身份头不转发给用户 JavaScript，不提供网站自建用户体系或数据库权限。

Auth 的准备变更只对两个明确的测试 issuer 允许其精确 site-gateway callback，并拒绝
任意回调覆盖与通配；生产 issuer 继续沿用既有 site-gateway registry 校验分支。
因此源代码合入不自动要求生产 Auth 镜像滚动；是否需要发布由真实运行配置/兼容验收确定。
2026-10-01 隐藏发布通过生产 CTL API/service/bypass 的显式空
`WEBSITE_BACKEND_BETA_USERS` 保持能力关闭，不创建 canary owner 或生产用户站点。
后续开放必须独立核验 OIDC 登录、owner 隔离、同源写请求与错误/旧版本拒绝链路。
