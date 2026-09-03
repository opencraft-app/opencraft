# 统一 OIDC 站点鉴权 Spec

## 1. OIDC Provider

UserAuth 暴露：

- `GET /.well-known/openid-configuration`
- `GET /.well-known/jwks.json`
- `GET /oauth2/authorize`：校验请求后跳转到主站授权页面。
- `GET /oauth2/authorize/context`：返回已校验客户端与当前用户上下文。
- `POST /oauth2/authorize`：经当前登录态确认后创建授权码并跳回精确 callback。
- `POST /oauth2/token`：校验 code、client、redirect URI 与 PKCE，原子消费后返回 token。

只支持 `response_type=code`、`grant_type=authorization_code`、`code_challenge_method=S256` 和包含 `openid` 的 scope。

## 2. 客户端注册

首批只注册一个逻辑客户端 `site-gateway`，其 redirect allowlist 仅包含用户确认的两个完整 URL。OIDC registry 只接受 `ExactCallbackURLs`，不得复用 Federation 的 `CallbackHosts` 或任何通配/子域配置。`redirect_uri` 使用完整字符串精确匹配，不支持前缀、大小写折叠或查询参数扩展。

## 3. 授权码

表 `oidc_authorization_codes`：

- `code_hash BINARY(32)`：SHA-256，主键。
- `client_id`、`user_id`、`redirect_uri`、`scope`。
- `code_challenge`、`nonce`。
- `expires_at`、`consumed_at`、`created_at`。

浏览器只看到 256-bit 随机 code；数据库不保存明文。token exchange 使用事务和 `SELECT ... FOR UPDATE`，验证后原子写 `consumed_at`。过期、重放、client/redirect/PKCE 不匹配统一返回 `invalid_grant`。

## 4. Token

- Ed25519 签名，JWKS 使用 OKP/Ed25519，包含稳定 `kid`。
- ID Token 包含 `iss`、`sub`、`aud`、`iat`、`exp`、`nonce`、`name`，有邮箱时包含 `email`。
- access token 仅面向既有 Federation/TAT 后续接线，短期且 audience-restricted；本切片不新增资源路由。
- token、code、verifier、Cookie 不进入日志。

## 5. site-gateway 流程

1. 用户站点未登录时签发加密 launch token，绑定原始站点 Host、相对 return path、固定 callback 和 5 分钟过期时间，并跳到同环境固定 Host 的 `/auth/lightvela/start`。
2. 固定 Host 验证 launch token，生成 PKCE verifier/challenge、nonce、随机 state；把包含 verifier/nonce/launch 摘要的事务写入 `__Host-lv_oidc_state` 加密 Cookie。
3. UserAuth 仅回调固定 `sites-auth` Host；callback 必须同时匹配 query state 与固定 Host 的 state Cookie，并立即清除 Cookie。
4. 固定 callback 服务端使用 Cookie 中的 verifier 调用 token endpoint；OIDC code 的 MySQL 单次消费同时保证 callback 重放失败。
5. 校验 ID Token 的签名、issuer、audience、nonce、时间窗、alg 和 kid。
6. 签发 5 秒内部 handoff，绑定 `host + user_id + nonce`，跳回 `https://<validated-host>/__lightvela/auth/callback`。
7. 用户站点完成端点验证 handoff 后设置 Host-only、`Secure`、`HttpOnly`、`SameSite=Lax` session Cookie，并跳回经校验的相对路径。

不得从请求参数直接信任目标 Host；Host 必须先由站点 resolver/sitemeta 证明属于当前站点命名空间。不得设置父域 Cookie。

CTL 的内部站点元信息必须返回该站点唯一属主 `user_id`。`site-gateway` 在签发 handoff、消费 handoff 和每次受保护内容请求时都必须通过不使用正缓存的 fresh lookup 比较 OIDC/session 的 `user_id` 与当前站点元信息的 `user_id`；任一缺失或不相等均 403，不能把“任意已登录用户”视为站点访问者。普通静态资源状态/流量查询继续使用现有短 TTL 缓存。

认证 Host 解析必须与静态站点解析一致：根域子站使用 resolver，自定义域名使用现有 `DomainLookup`，两者最终都得到同一个 `site_id` 与当前请求 Host。required 模式不得让已绑定 custom domain 退化为 404。

### 5.2 Endpoints 与内容门禁解耦

`site-gateway` 必须分别配置 fixed OIDC endpoints 是否启用，以及普通静态内容是否强制登录：

- endpoints disabled + content public：未接入 OIDC 的默认环境。
- endpoints enabled + content public：国际 Pages 匿名可读，但 concrete site 可显式访问 `/__lightvela/auth/start` 进入本人授权流程，fixed `.site` callback 可用。
- endpoints enabled + content required：国内 Pages 未登录自动进入同一授权流程。
- endpoints disabled + content required：非法配置，启动失败。

fixed auth Host 的 start/callback 以及 concrete site 的 `/__lightvela/auth/start`、`/__lightvela/auth/callback` 只由 endpoints enabled 控制；普通静态内容门禁只由 content required 控制。

### 5.1 配置与密钥

UserAuth 独立管理 OIDC Ed25519 signing key、`kid`、issuer 和 exact client registry。`site-gateway` 独立管理一个至少 32 字节的 AEAD key，并以不同 associated-data scope 编码 launch/state/handoff/session，密钥不得与 UserAuth signing key或现有 Federation key共用。

`site-gateway` 配置明确包含：当前环境 fixed auth host、OIDC issuer、authorization URL、token URL、JWKS URL、client ID、AEAD active key ID/keyring。CN 环境 fixed host 为 `sites-auth.lightvela.tech`，国际环境为 `sites-auth.lightvela.site`；OIDC client 的 exact redirect allowlist 同时只包含这两个已确认 callback。

## 6. 失败语义

- 无效 OIDC 请求：`invalid_request` / `unauthorized_client`。
- callback state Cookie 缺失/不匹配/过期、ID Token 或 handoff 无效：403，不回落到任意站点。
- token endpoint 或 JWKS 不可用：502/503，站点内容不放行。
- 国际 Pages 未开启 auth 时保持现有公开行为。

## 7. 测试

- redirect URI 精确匹配、S256 PKCE、nonce、5 秒过期、重复兑换、并发重复兑换。
- discovery/JWKS 与签名 token 一致。
- callback Host 与原站点 Host 分离；state 篡改、跨站 handoff、开放重定向全部拒绝。
- session Cookie 无 Domain，具备 Secure/HttpOnly/SameSite。
- 国内 required 与国际 disabled 行为不回归。
- 跨服务集成夹具覆盖 `.tech` / `.site` fixed-host start + callback、code replay、launch/state 篡改、跨站 handoff，以及所有 Set-Cookie 不包含 `Domain=`。
- 非属主登录、属主缺失、session 签发后站点属主变化均拒绝访问。
- required 模式 custom domain 完整登录可用；fresh owner lookup 不接受正缓存中的旧属主。
