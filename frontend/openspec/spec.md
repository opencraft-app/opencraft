# 国内站登录弹窗交互优化 Spec

最后同步：2026-07-30，按本轮交互细节调整后的前端现状记录。

## 总体架构

采用前端状态机切换登录方式，不改动后端。国内站弹窗维护一个 `DomesticLoginMethod = "wechat" | "phone" | "qq"` 状态，默认值为 `wechat`，弹窗每次打开时重置为微信。

## 登录方式

### 微信

- 主体区域渲染一个微信登录按钮。
- 按钮使用现有 `repositories.auth.getOAuthStartUrl("wechat", { wechatMode })`。
- `wechatMode` 继续复用 `wechatOAuthStartTargetForUserAgent(window.navigator.userAgent)`：
  - 桌面浏览器：`website`
  - 微信内浏览器：`official_account`
  - 普通移动浏览器：不跳转，提示“请在微信中打开当前页面后继续登录。”
- 不请求新增 API，不加载 `wxLogin.js`，不嵌入二维码。
- 不实现 `/auth/oauth/wechat/modal-config`；发现后端没有该接口后，微信登录回退为与 QQ 一致的 OAuth start URL 按钮跳转。

### 手机

- 主体区域渲染现有 `PhoneLoginForm`。
- `beforeAction={checkAgreed}`，未勾选协议时拦截获取验证码和提交。
- 登录成功后关闭弹窗并触发 `onSuccess`。
- `PhoneLoginForm` 新增 `variant="modal"`，仅作用于登录弹窗内样式。
- 手机登录不展示副标题；字段 label 保留给可访问性，但视觉上使用 `sr-only` 隐藏。
- 表单使用 placeholder 传达输入内容：`请输入手机号`、`请输入验证码`。
- 输入框文字为普通字重，使用 `h-11 rounded-md border-black/[0.08] bg-white px-3.5`。
- 聚焦态使用浅色边框和 1px ring：`focus-visible:border-black/[0.12]`、`focus-visible:ring-1`、`focus-visible:ring-black/[0.08]`。
- 验证码按钮使用同样的 `rounded-md` 和轻边框，不使用粗重描边。
- 未填写手机号或验证码时，提交按钮保持 disabled。
- 手机号格式错误、验证码格式错误或登录失败时，错误提示落在对应字段下方：
  - 手机号错误：显示在手机号输入框下方。
  - 验证码错误：显示在验证码输入框组下方。
- 字段错误态同步设置 `aria-invalid`、`aria-describedby`、红色边框和红色错误文案。

### QQ

- 主体区域渲染一个 QQ 登录按钮。
- 按钮使用现有 `repositories.auth.getOAuthStartUrl("qq")`。
- 未勾选协议时不跳转，并展示统一提示。

## 弹窗结构

- Header：标题和副标题随当前登录方式变化。
- Body：只展示当前登录方式主体。
- 协议勾选：
  - 微信 / QQ：位于 body 下方、“其他登录方式”上方。
  - 手机：通过 `PhoneLoginForm.beforeSubmit` 注入，位于登录按钮上方。
- 其他登录方式：展示另外两种方式，小按钮为 logo + 文案，无边框；相邻按钮之间使用竖线分隔。
- Error：保留底部错误提示区域。
- 国内站内容容器使用 `pb-6` 保留底部空间，避免其他登录方式贴近弹窗下边框。

## 文案

- 微信标题：`微信登录`
- 微信副标题：不展示
- 手机标题：`手机登录`
- 手机副标题：不展示；删除 `使用手机号和短信验证码登录`
- QQ 标题：`QQ登录`
- QQ 副标题：不展示
- 底部标题：`其他登录方式`

## 视觉与交互细节

- 主弹窗维持白底、`max-w-[412px]`、12px 圆角，遵循 `DESIGN.md` 的弹窗节奏。
- 国内站内容区使用 `px-9 pt-6 pb-6` 和 `gap-5`，主体、协议、其他登录方式在正常文档流中排布。
- 底部其他登录方式按钮使用无边框小按钮，不做描边胶囊。
- 微信、QQ、手机图标都放入固定 `size-5` slot；微信 / QQ 图片为 `size-5 object-contain`，手机图标为 `size-4`，保证视觉体量一致。
- 其他登录方式之间使用 `h-3 w-px bg-slate-200` 竖线分隔。
- 未勾选协议时，OAuth 主按钮不直接禁用，而是设置 `aria-disabled` 和弱化样式；点击后展示协议提示，避免静默无响应。
- 手机表单的获取验证码和提交动作会先做字段校验，字段错误优先于协议 gate 展示。

## 测试策略

- `login-modal.test.tsx`
  - 默认展示微信账号登录按钮。
  - 勾选协议后微信按钮跳转现有 OAuth start URL。
  - 普通移动浏览器点击微信时不跳转，并展示“请在微信中打开当前页面后继续登录。”。
  - 手机 / QQ 切换后底部其他方式正确。
  - 手机登录不展示旧副标题。
  - 手机登录协议勾选位于登录按钮上方。
  - 手机登录填写合法手机号 / 验证码但未勾选协议时不提交，并展示统一协议提示。
  - 国内站底部其他登录方式保留弹窗底部空间。
  - 未勾选协议时 QQ 不跳转并展示提示。
  - GitHub 彩蛋仍可展示。
- `login-modal.global.test.tsx`
  - 国际站 Google / GitHub 行为保持不变。
- `phone-login-form.test.tsx`
  - modal variant 隐藏视觉字段标题，但保留 label 可访问性。
  - 未填写手机号或验证码时禁用登录按钮。
  - 手机号 / 验证码错误分别落在对应输入框下方，并带红色边框。
  - modal variant 使用 `rounded-md`、轻边框、普通字重和浅聚焦态。
- `agent-create-error.test.ts`
  - 动态传入 `t(message)` 的创建失败兜底文案必须保持在 `zh-to-key` 字典中，防止英文站回退中文。
- `i18n:check`
  - 新增中文文案均有英文翻译。

## 非目标

- 不新增任何后端路由或微信配置接口。
- 不修改 `user/auth` OAuth callback。
- 不修改 `service-gateway` public allow。
- 不实现微信二维码内嵌登录。
