# 认证模块 (Auth)

## 概述

认证模块负责用户的注册、登录、邀请码校验、OAuth 第三方登录、会话管理等核心身份能力。
当前主路径为 **手机号 + 短信验证码**，邮箱密码登录、忘记密码已收敛。

## 页面 / 路由

| 路由 | 组件 | 布局 | 守卫 | 职责 |
|------|------|------|------|------|
| `/auth/sign-in` | `SignInPage` | MarketingLayout | AuthRouteGuard | 手机号 + 验证码登录主入口 |
| `/auth/sign-up` | `SignUpPage` | MarketingLayout | AuthRouteGuard | 注册（大部分已重定向至 sign-in） |
| `/auth/sign-up-code` | Navigate → `/auth/sign-in` | — | — | 旧版入口重定向 |
| `/auth/invite` | `InvitePage` | MarketingLayout | AuthRouteGuard | 邀请码校验独立页 |
| `/auth/forgot-password` | Navigate → `/auth/sign-in` | — | — | 忘记密码已下线 |
| `/settings/account` | `AccountProfilePage` | AppShellLayout | AppAccessGuard | 控制台内账号设置（资料/注销） |

## 核心组件

- `pages/auth/auth-shell.tsx` — 认证壳子布局（背景/品牌/文案槽）
- `pages/auth/sign-in-page.tsx` — 登录核心表单（手机号、验证码、邀请码、OAuth 入口）
- `pages/auth/invite-page.tsx` — 邀请码独立校验页
- `pages/auth/phone-code-fields.tsx` — 手机号 + 验证码输入复合字段（含冷却计时）
- `pages/auth/oauth-login-entry.tsx` — OAuth 第三方登录入口
- `pages/auth/use-generated-nickname.ts` — 登录后默认昵称生成 hook
- `components/domain/code-input.tsx` — 6 位数字验证码输入控件
- `components/site/login-modal.tsx` — 跨页面共用的登录弹窗
- `components/site/user-avatar-menu.tsx` — 登录后头像菜单（含登出、进入控制台入口）

## 数据流

**状态管理**：`SessionProvider`（`contexts/session-context.tsx`），由 `useReducer`
驱动的 `SessionState`：

```
{
  authReady,                       // 是否完成首次 getSession 检查
  stage: "anonymous" | "authenticated",
  user,                            // 当前用户
  currentSubscription,             // 当前订阅
  firstBotId,                      // 首个 Bot ID（登录态下）
  inviteValidation,                // 邀请码校验结果缓存
  verificationCooldownUntil        // 短信验证码冷却截止时间戳
}
```

**API 层**：`AuthRepository`（`repositories/http-repositories.ts`）

| 方法 | HTTP | 说明 |
|------|------|------|
| `sendVerificationCode({phone, purpose})` | POST | 发送短信验证码，返回 cooldownSeconds |
| `signInWithCode({phone, code, inviteCode?})` | POST | 登录，返回 AuthSessionSnapshot |
| `signUpWithCode({name, phone, code, inviteCode?})` | POST | 注册 |
| `validateInviteCode(code)` | GET | 邀请码有效性 |
| `prepareInviteCode(code)` / `activateInviteCode(code)` | POST | 邀请码准备/激活 |
| `getSession()` | GET | 恢复当前会话 |
| `getProfile()` / `updateProfile({name})` | GET/PATCH | 个人资料 |
| `uploadAvatar(file)` | POST | 头像（客户端压缩 200KB 后上传） |
| `deleteAccount()` | DELETE | 注销账号 |
| `verifyRealname({name, idCard})` | POST | 实名认证核验；未实名时完成认证，已实名时更新当前实名信息，并由后端保留变更历史（`/auth/realname/verify`） |
| `getOAuthStartUrl(provider)` | — | 同步返回 OAuth 跳转 URL |
| `signInAsGuest()` / `signOut()` | POST | 游客登录 / 登出 |

**Session 动作补充**：`SessionProvider` 额外暴露 `refreshProfile()`，内部调用
`getProfile()` 并 `dispatch({type: "SET_USER"})`，用于实名认证等"后端单点变更用户
字段"的场景，避免刷新整页。

**User 字段**（`domain/types.ts`）：
- `realnameVerified?: boolean` — 是否已完成实名认证。由后端 `/auth/session` 与
  `/auth/profile` 下发（camelCase，与 OpenAPI 契约一致）。字段为可选，老版本后端
  不下发时前端退化为 `false`，向后兼容。

**UI 持久化**：`localStorage[lightclaw-ui-session-v1]` 仅缓存非敏感 UI 态（如 firstBotId、
inviteValidation、verificationCooldownUntil），不存储 Token。

**401 自动登出**：http-repositories 收到 401 时广播 `AUTH_UNAUTHORIZED_EVENT`，
SessionProvider 监听此事件自动 `SIGN_OUT` 并跳转登录。

## 业务规则

1. **主路径唯一**：所有新用户默认走手机号 + 验证码，邮箱密码流程已下线。
2. **邀请码策略**：登录/注册时可选携带邀请码；也可通过 `/auth/invite` 独立校验。
3. **验证码冷却**：发送后返回 `cooldownSeconds`，前端基于 `verificationCooldownUntil`
   时间戳驱动 UI 倒计时，禁止重复发送。
4. **头像上限**：客户端上传前必须压缩到 ≤ 200KB（`compressAvatarFile`），避免后端拒收。
5. **路由守卫**：
   - `AuthRouteGuard`：已登录用户访问 `/auth/*` 时自动重定向到业务页
   - `MarketingAuthGuard`：未登录用户访问营销域业务页时弹出登录弹窗
   - `AuthenticatedGuard` + `PlanGuard`：登录后未选套餐者强制进入 `/plans/select`
   - `AppAccessGuard`：控制台访问权限（需要套餐 + Bot）
6. **OAuth 区域差异（编译期分支）**：登录页 OAuth 入口由 `VISIBLE_OAUTH_PROVIDERS`（`src/lib/oauth.ts`）按 `isGlobal` 选定，**未选中的渠道会被 Tree-shake 不进 bundle**：
   - 国内站：`["qq", "wechat"]`；GitHub 仅作为彩蛋入口，需通过 `useGitHubLoginVisibility` + `show_github_login()` 控制台命令显式启用，由 `ALLOW_GITHUB_EASTER_EGG = !isGlobal` 看守。
   - 国际站：`["google", "github"]`；不展示 QQ / 微信。
   渠道未对接或临时关闭时 `getOAuthStartUrl(provider)` 返回 `null`，UI 隐藏对应按钮。所有 OAuth 错误通过 `oauthErrorMessage()` 统一映射为可读中文文案，禁止把原始 error code 暴露给用户。
7. **实名认证**：
   - 状态以 `user.realnameVerified` 为**唯一真源**，页面通过 session 派生，不在
     组件本地 state 里再造一份副本。
   - 成功后由调用方负责 `refreshProfile()` 刷新 session；`refreshProfile` 失败
     **不阻塞主流程**（下一次进入页面仍会拉到最新状态）。
   - 已认证用户允许从账号页再次打开实名弹窗；新信息通过核验后覆盖当前实名信息，
     后端必须保留每次成功核验的变更历史。
   - 错误码与后端 `user/auth` 服务 1:1 对齐：`invalid_realname` / `invalid_id_card`
     / `realname_mismatch` / `realname_verify_failed`（HTTP 502） /
     `realname_unavailable`（HTTP 503）。UI 需将其映射为可读中文文案，
     **不得**把原始 `code` 或 500 堆栈暴露给用户。
   - 身份证号只在 submit 瞬间携带，前端不落盘、不进 localStorage。

## 测试覆盖

- `sign-in-page.test.tsx` — 登录主流程（手机号、验证码、邀请码、错误态）
- `sign-up-page.test.tsx` — 注册流程
- `phone-code-fields.test.tsx` — 验证码输入组件
- `auth-shell.test.tsx` — 布局快照
- `use-generated-nickname.test.tsx` — 昵称生成 hook
- `contexts/session-context.test.tsx` — 会话 reducer 与动作
