# lightclaw-auth 线上环境变量说明

本文档变更会命中 `lightclaw-auth` 发布流水线的 `user/auth/**` 监听路径。
通过 MR 合入 `master` 时，可用于验证 `lightclaw-auth` 的完整发布触发链路。
如果模板化入口触发漏判，可用同路径文档变更验证直接 stages 入口。
本行用于再次验证手动 MR 合入后 `lightclaw-auth` 发布触发。
本行用于验证 DB job kubeconfig fallback 修复合入后的发布链路。

## 必填

| 变量 | 说明 | 示例 |
|------|------|------|
| `LIGHTCLAW_ADMIN_TOKEN` | 管理接口鉴权 token，用于创建/禁用邀请码等后台操作 | 随机生成的强密码 |
| `LIGHTCLAW_DEVICE_BIND_TOKEN_SECRET` | 设备绑定短 token 的 HMAC 签名密钥，用于 OAuth 登录后给 Mac 客户端换取一次性 TAT 注册码 | 随机生成的 32 字节以上强密钥 |
| `LIGHTCLAW_MYSQL_DSN` 或 `MYSQL_DSN` | MySQL 连接串。**不填则使用内存存储（重启丢数据，仅限本地开发）** | `user:pass@tcp(host:3306)/dbname?parseTime=true` |

---

## 服务地址

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LIGHTCLAW_AUTH_ADDR` | `:8081` | 服务监听地址 |
| `LIGHTCLAW_PUBLIC_BASE_URL` | `https://lightclaw.tech` | 后端 API 对外域名，用于拼接 OAuth Redirect URI |
| `LIGHTCLAW_FRONTEND_BASE_URL` | `https://lightclaw.pages.dev` | 前端域名，OAuth 回调后重定向到此地址 |
| `LIGHTCLAW_OAUTH_RETURN_TO_ALLOWED_HOSTS` | 内置 Lightclaw 主域名 | 允许 OAuth `return_to` 回跳的 host 白名单，测试环境可显式加入 `*.pages.dev` |
| `LIGHTCLAW_DEVICE_BIND_TOKEN_TTL_SECONDS` | `600` | Mac 设备绑定短 token 有效期；token 只允许调用 `/auth/tat/device-bind` |

---

## Cookie

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LIGHTCLAW_COOKIE_SECURE` | `false` | 生产必须设为 `true`（HTTPS 环境） |
| `LIGHTCLAW_COOKIE_SAME_SITE` | `lax` | 可选 `lax` / `strict` / `none`（跨域场景用 `none`，需同时开启 Secure） |

---

## 内容安全审核（昵称）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CONTENT_AUDIT_ENABLED` | `false` | 是否开启用户资料内容安全审核总开关 |
| `CONTENT_AUDIT_NAME_ENABLED` | `true` | 总开关开启时是否审核昵称 |
| `CONTENT_AUDIT_AVATAR_ENABLED` | `false` | 总开关开启时是否审核头像上传 |
| `CONTENT_AUDIT_ENDPOINT` | 空 | 合规中台 proxy 送审地址，例如 `https://proxy.lightmake.site/contentaudit/submit`；主服务和 worker 会按任务类型调用 `CreateTextTask` / `CreateImageTask` |
| `CONTENT_AUDIT_PROXY_TOKEN` | 空 | 可选。Skillhub proxy 开启 `PROXY_ACCESS_TOKEN` 时，主服务和 worker 会通过 `X-Proxy-Token` 携带该值 |
| `CONTENT_AUDIT_PRODUCT_ID` | 空 | 合规中台分配的 ProductID |
| `CONTENT_AUDIT_USER_SID` | 空 | 用户资料/昵称场景 SID |
| `CONTENT_AUDIT_TIMEOUT_MINUTES` | `15` | 已提交任务超过该时间未收到违规回调时自动通过 |
| `CONTENT_AUDIT_WORKER_INTERVAL_SECONDS` | `30` | 独立审核 worker 轮询间隔 |
| `CONTENT_AUDIT_WORKER_BATCH_SIZE` | `20` | 单轮处理的审核任务数 |

开启且主服务可访问 `CONTENT_AUDIT_ENDPOINT` 时，昵称和头像修改会在请求内同步送审；审核通过后直接覆盖正式资料，审核失败则保留原资料。
独立 `lightclaw-auth-content-audit-worker` Deployment 继续负责兼容历史 pending 任务、无直连 client 部署下的任务送审，以及超时通过。

---

## QQ OAuth（不填则禁用 QQ 登录）

| 变量 | 说明 | 在哪里获取 |
|------|------|-----------|
| `LIGHTCLAW_QQ_APP_ID` | QQ 互联应用 ID | [QQ 互联](https://connect.qq.com/) → 应用管理 |
| `LIGHTCLAW_QQ_APP_KEY` | QQ 互联应用 Key | 同上 |
| `LIGHTCLAW_QQ_REDIRECT_URI` | 回调地址，默认 `https://lightclaw.tech/auth/oauth/qq/callback` | 需在 QQ 互联后台填写一致 |

---

## Google OAuth（不填则禁用 Google 登录）

| 变量 | 说明 | 在哪里获取 |
|------|------|-----------|
| `LIGHTCLAW_GOOGLE_CLIENT_ID` | OAuth 客户端 ID | [Google Cloud Console](https://console.cloud.google.com/) → API 和服务 → 凭据 |
| `LIGHTCLAW_GOOGLE_CLIENT_SECRET` | OAuth 客户端密钥 | 同上 |
| `LIGHTCLAW_GOOGLE_REDIRECT_URI` | 回调地址，默认 `https://lightclaw.tech/auth/oauth/google/callback` | 需在 Google Cloud Console 授权重定向 URI 中添加 |

> **Google Cloud Console 配置要点**
> 1. 已启用 **Google+ API** 或 **People API**
> 2. OAuth 同意屏幕已填写（应用名称、支持邮箱）
> 3. 授权重定向 URI 与 `LIGHTCLAW_GOOGLE_REDIRECT_URI` 完全一致

---

## GitHub OAuth（不填则禁用 GitHub 登录）

| 变量 | 说明 | 在哪里获取 |
|------|------|-----------|
| `LIGHTCLAW_GITHUB_CLIENT_ID` | OAuth App Client ID | [GitHub Settings](https://github.com/settings/applications) → Developer settings → OAuth Apps |
| `LIGHTCLAW_GITHUB_CLIENT_SECRET` | OAuth App Client Secret | 同上（创建后需点击 Generate a new client secret） |
| `LIGHTCLAW_GITHUB_REDIRECT_URI` | 回调地址，默认 `https://lightclaw.tech/auth/oauth/github/callback` | 需在 GitHub OAuth App 的 Authorization callback URL 中填写 |

> **GitHub OAuth App 配置要点**
> - Homepage URL：填前端域名，如 `https://lightclaw.tech`
> - Authorization callback URL：填 `LIGHTCLAW_GITHUB_REDIRECT_URI` 的值

---

## 头像存储 COS（不填则禁用头像同步，OAuth 头像不会被缓存）

| 变量 | 说明 | 在哪里获取 |
|------|------|-----------|
| `LIGHTCLAW_COS_BUCKET_URL` | 腾讯云 COS Bucket 访问地址 | COS 控制台 → Bucket 列表 → 访问域名 |
| `LIGHTCLAW_COS_SECRET_ID` | 腾讯云 API 密钥 ID | [CAM 控制台](https://console.cloud.tencent.com/cam/capi) |
| `LIGHTCLAW_COS_SECRET_KEY` | 腾讯云 API 密钥 Key | 同上 |

---

## 实名认证（不填则禁用实名核验接口）

| 变量 | 说明 | 在哪里获取 |
|------|------|-----------|
| `TENCENT_REALNAME_SECRET_ID` | 腾讯云 FaceID API 密钥 ID | 腾讯云 CAM / SSM |
| `TENCENT_REALNAME_SECRET_KEY` | 腾讯云 FaceID API 密钥 Key | 腾讯云 CAM / SSM |
| `TENCENT_REALNAME_ENDPOINT` | FaceID endpoint，默认 `faceid.tencentcloudapi.com` | 腾讯云 FaceID |
| `REALNAME_ENCRYPTION_KEY` | 32 字节 AES-GCM key 的 base64 编码，用于加密姓名/身份证落库 | 腾讯云 SSM |

---

## TAT 设备绑定（不填则禁用 Mac 设备绑定）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TENCENT_TAT_SECRET_ID` | 腾讯云 TAT API 密钥 ID，需允许 `tat:CreateRegisterCode` | - |
| `TENCENT_TAT_SECRET_KEY` | 腾讯云 TAT API 密钥 Key | - |
| `TENCENT_TAT_REGION` | 注册码所属地域 | `ap-guangzhou` |
| `TENCENT_TAT_ENDPOINT` | TAT endpoint | `tat.tencentcloudapi.com` |
| `TENCENT_TAT_REGISTER_EFFECTIVE_HOURS` | 注册码有效时间，单位小时 | `24` |
| `TENCENT_TAT_INSTANCE_NAME_PREFIX` | 注册出来的托管实例名前缀，最长 32 字符 | `lightvela-mac` |
| `TENCENT_TAT_REGISTER_IP_RANGE` | 可选公网出口 IP/CIDR 限制；留空则不限制 | - |

后端会固定把 `RegisterLimit` 设为 `1`，即每个注册码只能注册一台设备。

---

## 仅开发环境

| 变量 | 说明 |
|------|------|
| `LIGHTCLAW_DEV_SMS_CODE` | 固定短信验证码，非空时跳过真实短信发送（**生产禁止设置**） |
| `LIGHTCLAW_SEED_DEMO_USER` | `true` 时初始化一个演示用户（**生产禁止设置**） |
| `LIGHTCLAW_LOG_LEVEL` | 日志级别，默认 `info`，可选 `debug` / `warn` / `error` |

---

## 最小线上配置示例

```bash
# 数据库
LIGHTCLAW_MYSQL_DSN=lightclaw:strongpassword@tcp(db-host:3306)/lightclaw_auth?parseTime=true

# 服务
LIGHTCLAW_PUBLIC_BASE_URL=https://lightclaw.tech
LIGHTCLAW_FRONTEND_BASE_URL=https://lightclaw.pages.dev
LIGHTCLAW_COOKIE_SECURE=true
LIGHTCLAW_ADMIN_TOKEN=<随机生成的强密码>
LIGHTCLAW_DEVICE_BIND_TOKEN_SECRET=<随机生成的32字节以上强密钥>

# 实名认证
TENCENT_REALNAME_SECRET_ID=xxx
TENCENT_REALNAME_SECRET_KEY=xxx
TENCENT_REALNAME_ENDPOINT=faceid.tencentcloudapi.com
REALNAME_ENCRYPTION_KEY=<32字节base64密钥>

# TAT 设备绑定
TENCENT_TAT_SECRET_ID=xxx
TENCENT_TAT_SECRET_KEY=xxx
TENCENT_TAT_REGION=ap-guangzhou
TENCENT_TAT_ENDPOINT=tat.tencentcloudapi.com
TENCENT_TAT_REGISTER_EFFECTIVE_HOURS=24

# Google OAuth
LIGHTCLAW_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
LIGHTCLAW_GOOGLE_CLIENT_SECRET=GOCSPX-xxx

# GitHub OAuth
LIGHTCLAW_GITHUB_CLIENT_ID=Ovxxx
LIGHTCLAW_GITHUB_CLIENT_SECRET=xxx
```
