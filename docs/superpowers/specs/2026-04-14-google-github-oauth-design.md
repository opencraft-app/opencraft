# Google & GitHub OAuth 授权登录 — 设计文档

**日期：** 2026-04-14  
**子项目：** `user/auth`  
**分支：** `feature/oauth-google-github`

---

## 1. 背景与目标

在现有 QQ OAuth 登录的基础上，新增 Google 和 GitHub 两个 OAuth 2.0 授权登录方式。用户通过第三方账号授权后可直接登录系统，首次登录仍需要有效邀请码。

## 2. 架构决策

### 2.1 客户端实现

使用 `golang.org/x/oauth2` 标准库处理 token exchange（而非手写 HTTP 调用）。原因：
- QQ OAuth 使用自定义协议，无法用标准库；Google/GitHub 均为标准 OAuth 2.0
- 标准库自动处理 token 刷新、PKCE 等细节
- 减少重复实现，代码更易维护

### 2.2 文件结构

独立文件方案（方案 A），不改动现有 QQ OAuth 代码：

```
user/auth/internal/httpapi/
├── qq_oauth.go           # 现有，不变
├── google_oauth.go       # 新建
├── github_oauth.go       # 新建
├── handler.go            # 修改：添加 googleOAuth / githubOAuth 字段
└── server.go             # 修改：注册新路由
user/auth/cmd/lightclaw-auth/
└── main.go               # 修改：新增 buildGoogleOAuthConfig / buildGitHubOAuthConfig
user/auth/secret-templates/
└── test.env.example      # 修改：补充新环境变量
```

### 2.3 数据库

**无需新 migration。** 现有 `oauth_identities` 表的 `provider VARCHAR(32)` 字段天然支持 `"google"` 和 `"github"` 值。

---

## 3. OAuth 流程

### 3.1 完整流程（以 Google 为例，GitHub 相同）

```
1. 前端 → GET /auth/oauth/google/start?invite_code=<code>
2. 后端：
   a. 生成随机 state（crypto/rand，hex 编码）
   b. 设置 cookie lc_google_oauth_state（TTL 10 分钟，Path=/auth/oauth/google/callback）
   c. 若有 invite_code，设置 cookie lc_google_oauth_invite（同 TTL）
   d. 302 跳转到 Google 授权 URL（含 state、scope、redirect_uri）
3. 用户在 Google 授权 → Google 回调 GET /auth/oauth/google/callback?code=xxx&state=xxx
4. 后端：
   a. 读取并校验 state cookie（防 CSRF）
   b. 读取 invite_code cookie
   c. 用 golang.org/x/oauth2 交换 code 获取 token
   d. 调用 Google UserInfo API 获取：sub（ProviderSubject）、email、name、picture
   e. 调用 service.SignInWithOAuth(OAuthSignInInput{Provider:"google", ...})
   f. 设置 session cookie，清除 state/invite cookie
   g. 302 跳转到前端：
      - 成功：<FrontendBaseURL>/?oauth_success=google
      - 失败：<FrontendBaseURL>/?oauth_error=<错误码>
```

### 3.2 新增路由

| 方法 | 路径 | 处理函数 |
|------|------|----------|
| GET | `/auth/oauth/google/start` | `Handler.StartGoogleOAuth` |
| GET | `/auth/oauth/google/callback` | `Handler.HandleGoogleOAuthCallback` |
| GET | `/auth/oauth/github/start` | `Handler.StartGitHubOAuth` |
| GET | `/auth/oauth/github/callback` | `Handler.HandleGitHubOAuthCallback` |

路由在 `server.go` 中按 config 是否为 nil 条件注册（与 QQ 模式一致）。

### 3.3 邀请码传递

- `invite_code` 通过 start 端点的 query param 传入
- 存入独立 cookie：`lc_google_oauth_invite` / `lc_github_oauth_invite`
- callback 时从 cookie 读取，传入 `OAuthSignInInput.InviteCode`
- 授权完成后（无论成功失败）清除该 cookie

---

## 4. 核心数据结构

### 4.1 Config（以 Google 为例）

```go
type GoogleOAuthConfig struct {
    ClientID        string
    ClientSecret    string
    RedirectURI     string
    FrontendBaseURL string
    PublicBaseURL   string
    StateTTL        time.Duration // 默认 10 分钟
}
```

GitHub 的 `GitHubOAuthConfig` 结构完全相同，仅 OAuth2 endpoint 不同。

### 4.2 Client 接口

```go
// google_oauth.go
type GoogleOAuthClient interface {
    ExchangeCode(ctx context.Context, code string, redirectURI string) (*GoogleOAuthToken, error)
    ResolveIdentity(ctx context.Context, accessToken string) (service.OAuthSignInInput, error)
}

// github_oauth.go
type GitHubOAuthClient interface {
    ExchangeCode(ctx context.Context, code string, redirectURI string) (*GitHubOAuthToken, error)
    ResolveIdentity(ctx context.Context, accessToken string) (service.OAuthSignInInput, error)
}
```

接口设计与 QQ 的 `QQOAuthClient` 保持一致，便于 mock 测试。

### 4.3 OAuthSignInInput 映射

| 字段 | Google 来源 | GitHub 来源 |
|------|-------------|-------------|
| Provider | `"google"` | `"github"` |
| ProviderSubject | `userinfo.sub` | `user.id`（转字符串） |
| Email | `userinfo.email` | `user.email` 或 primary verified email |
| EmailVerified | `userinfo.email_verified` | GitHub 验证邮箱视为 true |
| Name | `userinfo.name` | `user.name` 或 `user.login` |
| AvatarURL | `userinfo.picture` | `user.avatar_url` |
| InviteCode | cookie `lc_google_oauth_invite` | cookie `lc_github_oauth_invite` |

---

## 5. 外部 API 调用

### 5.1 Google

- Token Exchange：`golang.org/x/oauth2`（`google.Endpoint`）
- 用户信息：`GET https://www.googleapis.com/oauth2/v3/userinfo`
- 所需 scope：`openid email profile`

### 5.2 GitHub

- Token Exchange：`golang.org/x/oauth2`（`github.com/golang/oauth2` GitHub endpoint）
- 用户信息：`GET https://api.github.com/user`
- 邮箱（私有邮箱需额外调用）：`GET https://api.github.com/user/emails`
- 所需 scope：`read:user user:email`

> GitHub 用户可能未公开邮箱；需调用 `/user/emails` 找到 `primary=true AND verified=true` 的邮箱。

---

## 6. 配置管理

### 6.1 新增环境变量

```bash
# Google OAuth
LIGHTCLAW_GOOGLE_CLIENT_ID=
LIGHTCLAW_GOOGLE_CLIENT_SECRET=
LIGHTCLAW_GOOGLE_REDIRECT_URI=https://lightclaw.tech/auth/oauth/google/callback

# GitHub OAuth
LIGHTCLAW_GITHUB_CLIENT_ID=
LIGHTCLAW_GITHUB_CLIENT_SECRET=
LIGHTCLAW_GITHUB_REDIRECT_URI=https://lightclaw.tech/auth/oauth/github/callback
```

### 6.2 main.go 新增函数

```go
func buildGoogleOAuthConfig() *httpapi.GoogleOAuthConfig
func buildGitHubOAuthConfig() *httpapi.GitHubOAuthConfig
```

当 `ClientID` 或 `ClientSecret` 为空时返回 nil，路由不注册。

### 6.3 secret-templates/test.env.example 更新

追加 Google/GitHub 的 6 个新环境变量（含注释说明）。

---

## 7. 错误码

| 场景 | oauth_error 参数值 |
|------|-------------------|
| state 不匹配 | `google_state_mismatch` / `github_state_mismatch` |
| code exchange 失败 | `google_exchange_failed` / `github_exchange_failed` |
| 用户信息获取失败 | `google_identity_failed` / `github_identity_failed` |
| 需要邀请码 | `invite_required` |
| 邀请码无效 | `invalid_invite` |

---

## 8. 测试策略

参考 `qq_oauth_test.go` 的完整测试覆盖：

- 新建 `google_oauth_test.go` 和 `github_oauth_test.go`
- Mock `GoogleOAuthClient` / `GitHubOAuthClient` 接口隔离外部 HTTP 调用
- 覆盖场景：
  1. state cookie 缺失
  2. state 不匹配（CSRF 防护）
  3. code exchange 失败
  4. 用户身份解析失败
  5. 邀请码缺失（新用户）
  6. 成功登录（现有用户）
  7. 成功注册（新用户 + 有效邀请码）
- 复用 `oauth_test.go` 中现有测试辅助函数

---

## 9. 实现约束

- 不修改 `internal/service/` 层任何代码（`OAuthSignInInput` 已满足需求）
- 不新增数据库迁移
- 不影响 QQ OAuth 现有功能
- 提交前运行 `make setup` 确保 pre-commit hook 生效
- 运行 `go build ./...` 验证编译通过
- 运行 `go test ./internal/httpapi/...` 验证测试通过

---

## 10. 不在本次范围内

- 前端 UI 改动（新增 Google/GitHub 登录按钮）
- k8s overlay Secret 更新（需在实际部署时由运维配置）
- Token refresh 逻辑（session TTL 由现有机制管理）
- OAuth 账号绑定到已有账号的 UI 流程（服务层 `BindOAuthToCurrentSession` 已有实现，暂不暴露新路由）
