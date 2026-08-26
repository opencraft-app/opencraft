# 统一 OIDC 站点鉴权 Proposal

**状态：** 用户已确认协议方向与固定 callback，进入实现。

## 背景

当前 UserAuth Federation 为第一方个人站提供自定义 handoff/exchange 协议，`site-gateway` 则使用另一套自定义 Ed25519 ticket。两套协议无法作为后续第三方应用的统一登录入口，且现有站点 callback 直接落到动态用户子域，不满足 OAuth/OIDC 精确注册 redirect URI 的安全边界。

## 目标

1. UserAuth 提供最小 OIDC Authorization Code + PKCE 能力。
2. 仅注册两个精确 callback：
   - `https://sites-auth.lightvela.tech/auth/lightvela/callback`
   - `https://sites-auth.lightvela.site/auth/lightvela/callback`
3. 授权码存 MySQL，5 秒有效且只能消费一次。
4. `site-gateway` 在固定 callback 兑换 code，再通过绑定原始 Host 的 5 秒内部 handoff 回到具体用户站点，并设置 Host-only session Cookie。
5. 复用现有授权登录页面与账号切换能力，不改变现有 TAT/VMPort 路由。

## 本次范围

- OIDC discovery、JWKS、authorize、token。
- `openid profile email`，ID Token 与短期 access token。
- S256 PKCE、state、nonce、精确 redirect URI、单次 code 消费。
- `site-gateway` OIDC client、固定 callback、二跳 handoff、Host-only Cookie。
- 国内 Pages 开启鉴权；国际 Pages 默认保持公开，配置开启时仍可使用同一 OIDC client。
- 数据库迁移、配置模板和针对性测试。

## 不包含

- refresh token、userinfo、introspection、device code。
- 动态客户端注册、第三方自助管理后台。
- 修改 TAT ownership、VMPort 路由或实例复用模型。
- 发布或生产密钥生成。

## 采用方案

以 OIDC 作为对接方可见协议，保留现有 Federation TAT API 作为后续资源访问能力。固定 callback 不直接设置用户站点 Cookie，因为浏览器不会把 callback Host 的 Cookie带到用户子域；`site-gateway` 必须签发一个 5 秒、绑定 `host + user_id + nonce` 的内部 handoff，在用户站点完成端点消费后设置 Host-only Cookie。

## 方案比较

- **继续扩展自定义 Federation（不采用）：** 首方实现最少，但第三方需要理解私有签名和 ticket 语义，无法复用标准 OIDC client。
- **引入完整 OIDC server 框架（不采用）：** 标准覆盖广，但带来 refresh token、动态注册、持久 consent 等当前不需要的状态与依赖。
- **最小 OIDC 核心并复用现有页面（采用）：** 只实现 code + PKCE、discovery/JWKS 和首批静态客户端，保留未来扩展空间，同时控制本次迁移面。
