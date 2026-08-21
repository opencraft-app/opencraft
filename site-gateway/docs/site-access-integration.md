# 国内站建站访问鉴权接入说明

本文给 LightVela 登录/Auth 团队接入 `site-gateway` 使用。目标是保护
`*.lightvela.tech` 下的用户站点；国际站 `*.lightvela.site` 仍保持公开访问，
不走本协议。

## 1. 分工和边界

Auth 团队负责：

1. 在自己的登录域名校验现有 `lc_session`，判断浏览器是否已经登录。
2. 校验成功后，用 Auth 控制面保存的 Ed25519 私钥签发一次短时访问票据。
3. 把票据带回站点网关的 callback 地址。

`site-gateway` 负责：

1. 生成浏览器挑战状态并保存到 `__Host-lv_site_state`。
2. 校验票据的签名、`iss`、`aud`、`kid`、时间、目标 Host 和 `state`。
3. 校验通过后设置站点域名专属的 `lv_site_session`，再返回原始站点路径。

Auth 方不需要把 `lc_session` 传给站点，也不需要为每个静态资源请求调用 Auth。
前端 JavaScript 不能生成票据；签名私钥不能进入 Git、前端构建产物、SOPS
明文或站点容器。

## 2. 浏览器时序

用户首次访问 `https://<site-id>.lightvela.tech/path` 时：

1. 网关发现没有有效的 `lv_site_session`，生成随机 `state`，设置
   `__Host-lv_site_state`，然后跳转到 `SITE_GATEWAY_AUTH_START_URL`：

   ```text
   https://<auth-origin>/site-access/start
     ?redirect_uri=https%3A%2F%2F<site-id>.lightvela.tech%2F__lightvela%2Fauth%2Fcallback
     &state=<url-safe-state>
     &return_to=%2Fpath
   ```

2. Auth 方读取自己的 `lc_session`：
   - 已登录：签发票据并跳回 `redirect_uri`；
   - 未登录：由 Auth 方自行处理登录或拒绝，不要向站点伪造票据。

3. Auth 方回跳时使用 GET，并保留 `state` 和 `return_to`：

   ```text
   https://<site-id>.lightvela.tech/__lightvela/auth/callback
     ?ticket=<compact-jws>
     &state=<url-safe-state>
     &return_to=%2Fpath
   ```

4. 网关验票成功后设置 `lv_site_session`，清除状态 cookie，跳转到安全校验后的
   相对路径。验票失败返回 `403`，不会读取 COS。

`redirect_uri`、callback Host 和票据 `site_host` 必须指向同一个国内站 Host。
`return_to` 只能是当前 Host 的相对路径，不能是绝对 URL、协议相对 URL 或其他域名。

## 3. 票据格式

票据是 compact JWS（JWT），算法必须是 Ed25519 的 `EdDSA`。Header：

```json
{
  "typ": "LV-Site-Access",
  "alg": "EdDSA",
  "kid": "2026-08"
}
```

Payload 至少包含：

```json
{
  "iss": "lightvela-auth",
  "aud": "lightvela-site-gateway",
  "sub": "<lightvela-user-id>",
  "site_host": "<site-id>.lightvela.tech",
  "state": "<same-state-from-challenge>",
  "iat": 1723977600,
  "exp": 1723977900,
  "jti": "<unique-ticket-id>"
}
```

约束：

- `iss`、`aud` 必须与网关配置完全一致。
- `site_host` 必须是当前请求 Host；建议签发前把 Host 转小写并去掉末尾点。
- `state` 必须原样复制网关挑战中的值，不能重新生成或省略。
- `iat` 不能晚于当前时间；`exp` 必须晚于当前时间，且票据有效期不超过 5 分钟。
- `jti` 用于审计和排查，网关当前无状态存储，不会据此实现一次性消费。
- 不接受 `none`、RSA、HMAC 或其他算法；`kid` 必须存在且对应网关已配置的公钥。

伪代码（签名只发生在 Auth 可信后端）：

```text
claims = {
  iss: AUTH_ISSUER,
  aud: "lightvela-site-gateway",
  sub: current_user.id,
  site_host: validated_callback_host,
  state: query.state,
  iat: now_unix,
  exp: now_unix + 300,
  jti: random_uuid()
}
ticket = JWS.sign(claims, private_ed25519_key,
                  header={typ: "LV-Site-Access", alg: "EdDSA", kid: "2026-08"})
```

## 4. 公钥配置和轮换

网关只配置公钥，格式为逗号分隔的 `kid=base64url(raw-ed25519-public-key)`：

```text
SITE_GATEWAY_AUTH_PUBLIC_KEYS=2026-08=<base64url-public-key>,2026-09=<base64url-public-key>
```

Auth 方保存对应私钥，并负责私钥访问控制和审计。轮换时：

1. 先把新 `kid` 和公钥发布到网关；
2. Auth 方开始使用新私钥签发；
3. 等待旧票据最长有效期（不超过 5 分钟）后再移除旧公钥。

不要在本仓库提交真实私钥、真实票据、生产公钥值或其他凭据。国内部署启用
`SITE_GATEWAY_AUTH_MODE=required` 后才会强制鉴权；国际部署必须保持
`SITE_GATEWAY_AUTH_MODE=public`。

## 5. Cookie 和错误处理

网关创建的两个 cookie 都是 Host-only、`Secure`、`HttpOnly`、`SameSite=Lax`、
`Path=/`：

- `__Host-lv_site_state`：只用于 callback 防 CSRF，成功后立即清除；
- `lv_site_session`：保存已验签的短时票据，平台配置的 TTL 不得超过 5 分钟。

Auth 方不应设置或读取这两个 cookie，也不应尝试复制 `lc_session` 到站点域名。
缺少或失效的登录态由 Auth 方自行处理；网关收到缺少/错误票据、错误 Host、
错误 state 或过期票据时统一失败关闭并返回 `403`，响应为 `private, no-store`，
并带 `X-Robots-Tag: noindex, nofollow, noarchive`。

本协议是无状态方案，因此不提供严格的一次性消费、即时 logout 撤销或持久 denylist。
如果以后需要这些能力，需要另行引入以 `jti` 为键的服务端状态存储。

## 6. Auth 接入验收清单

- [ ] 已在 Auth 后端校验 `lc_session`，未把 `lc_session` 暴露给站点或前端脚本。
- [ ] 只允许可信后端使用 Ed25519 私钥签发 `LV-Site-Access` JWS。
- [ ] `redirect_uri` 使用原始国内站 Host 的 callback，未接受用户提供的跨域地址。
- [ ] `state` 和 `return_to` 从网关请求原样带回，未改写 `state`。
- [ ] 票据包含全部必需 claims，且 `exp - iat <= 300s`。
- [ ] 预先和平台确认 `kid`、issuer、audience、公钥发布及轮换窗口。
- [ ] 已验证未登录、登录成功、过期票据、错误 state、错误 Host 和跨域
  `return_to` 的行为。
