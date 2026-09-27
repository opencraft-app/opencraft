## stage
测试发送已切至 Hermes CLI；用户已授权提交 MR，正在核对暂存差异和远端状态。

## verified
- 当前通道面板使用 `ChannelPanel` 与 `useChannelOperations`，测试命令由 `createHermesCommandBuilder` 按 Profile 构造。
- 已连接卡片显示“测试”；成功提示前往聊天软件确认，失败仅展示统一重试文案。
- 测试期间面板禁用连接、重连和断开，hook 内的同步操作锁也拒绝并发命令。
- 聚焦测试 25 项通过，`pnpm check` 与 `pnpm build` 通过。
- 国内站与国际站共用 `AgentChannelPanel`；国内列表含微信、QQ、企业微信、钉钉、飞书，国际列表含 Telegram、Discord、Slack、WhatsApp、微信、QQ、企业微信、飞书。
- 2026-09-27 本地预览：国内站 `localhost:5174`、国际站 `localhost:5175` 的 `/agents/channels/` 均返回 200，浏览器页面可加载。
- 按后续要求切换为单实例国内站预览 `localhost:5274`：`NEXT_PUBLIC_AUTH_API_BASE_URL=local-proxy`，代理目标 `https://api.lightvela.com`（上海正式环境）。`/agents/channels/` 返回 200，未登录 `/auth/session/` 经同源代理返回 401；浏览器可见登录入口。
- 用户在 Chrome + Whistle 的 5274 预览中连接 QQ 后点击测试，两次后端回执均为 `unknown flag: --agent`；发布包 `channel/send` 无该参数。已删除该标志，命名 Profile 改由运行时目录路由。
- 修正后在同一已连接主 Bot 上复测，页面显示“测试消息已发送”，Whistle 记录 HTTP 200 和 ACLI `data.status = sent`；聚焦测试 7 项通过，`pnpm check` 通过且新增 TypeScript 诊断为 0。
- 用户决定测试发送直接参考定时任务弹窗：现改为 `hermes -p <profile> send --to <platform> --json --file -`，以 JSON `success` 判定。Chrome + Whistle 5274 对已连接主 Bot QQ 复测：HTTP 200，Hermes `success: true`，页面显示成功；聚焦测试 10 项通过，`pnpm check` 新增 TypeScript 诊断为 0。
- 最新代码 `pnpm build` 通过；构建后已重启 5274 开发服务器，HTTP 200 且 Chrome 通道页面正常。构建字体噪音已恢复，`git diff --check` 通过。
- 用户要求卡片按钮略窄：通道卡片的教程、测试、断开、连接按钮水平内边距由 18px 减到 14px，最小高度仍为 36px。Chrome + Whistle 5274 截图显示 QQ 三按钮及未连接卡片按钮正常排布；布局聚焦测试 4 项通过，`git diff --check` 通过。
- 用户随后要求按钮高度也略小：同一组卡片按钮最小高度由 36px 减到 32px，水平内边距保持 14px。Chrome + Whistle 5274 预览截图显示已连接 QQ 与未连接卡片按钮正常排布；页面 HTTP 200，`git diff --check` 通过。
- 用户要求通道配置弹窗按钮对齐定时任务弹窗：连接方式选项卡以及通道弹窗操作按钮改为 8px 圆角；操作按钮采用 8px × 16px 内边距、8px 间距，取消按钮与主按钮颜色对齐。Chrome + Whistle 5274 实际打开钉钉连接方式弹窗，计算样式确认选项卡、取消和确认均为 8px 圆角；布局聚焦测试 4 项通过，`pnpm check` 通过（TypeScript 诊断 171、基线 171、新增 0）。
- 用户指出 8px 圆角视觉上没有达到预期。实测定时任务弹窗 `rounded-lg` 的主题值是 `--radius-lg: 1.35rem`（21.6px），`rounded-md` 是 `--radius-md: 1rem`（16px），而非默认 Tailwind 数值。现通道弹窗的取消/确认按钮使用前者，连接方式选项卡使用后者；Chrome + Whistle 5274 实际计算样式为 21.6px/16px，与定时任务对应按钮一致，按钮高度均为 38px。布局聚焦测试 4 项通过，`pnpm check` 通过（TypeScript 诊断 171、基线 171、新增 0）。
- 用户要求删除 QQ/钉钉连接方式选择弹窗标题下重复的“请选择适合你的连接方式”。已移除该段，共用弹窗在 Chrome + Whistle 5274 中分别打开钉钉与 QQ 方式选择时均不再显示该行，标题和选项间距正常。聚焦测试 2 文件、7 项通过；`pnpm check` 通过（TypeScript 诊断 171、基线 171、新增 0）。
- 用户要求把扫码方式说明末尾的“推荐”移到“扫码连接”标题旁的标签，国内/国际同类弹窗一致。已在 QQ/钉钉共用方式选择组件中添加蓝色标签，QQ/钉钉说明各自改为无“推荐”的独立 i18n key，补齐 en-US、es、id-ID、ja-JP、ko-KR、zh-Hant 译文。Chrome + Whistle 5274 实际打开国内 QQ 与钉钉弹窗，均可见标题旁标签且说明无重复文案；国际 QQ 复用同一组件，译文已通过检查，未做国际站浏览器实测。通道聚焦测试 3 文件、12 项通过，`pnpm check` 通过（TypeScript 诊断 171、基线 171、新增 0），`pnpm build:cn` 与 `pnpm build:global` 均通过。构建产生的字体差异已恢复，5274 预览已重启且 HTTP 200，QQ 弹窗在 Chrome 中正常呈现，`git diff --check` 通过。
- 用户指出聊天软件收到的“请在聊天软件中确认收到”不合语境，随后指定最终测试消息正文为“叮咚！收到一条来自 LightVela 的测试消息。”；网页成功提示保留原文。已同步六种目标语言与繁体生成文案，聚焦发送测试 2 项、`pnpm check`、`pnpm build:cn`、`pnpm build:global`、`git diff --check` 通过。构建产生的字体差异已恢复；5274 国内站预览重启后 `/agents/channels/` 返回 HTTP 200。未再次向真实通道发送消息。
- 用户要求失败提示同时提供检查连接和重新连接后再测试两条路径。统一失败文案改为“测试消息发送失败。请检查通道连接，或重新连接通道后再次测试。”，底层错误仍不展示。已同步六种目标语言与繁体生成文案；通道交互聚焦测试 3 项、`pnpm check`、`pnpm build:cn`、`pnpm build:global` 通过。构建生成的字体差异已恢复，5274 国内站预览已重启。

## unverified
- QQ 客户端是否实际收到消息尚待用户确认；命名 Profile 发送尚未做真实实例验证。
- 全量测试集未通过，多个无关测试失败且一个 worker 持续运行；需要单独的基线修复任务处理。
- 国内本地 Bot 处于“已暂停”，调试命令返回 `DEBUG_NOT_SUPPORTED`，通道列表无已连接项；国际本地预览登录态不可用，认证服务提示暂时不可用。两站均未完成真实发送交互验收。
- 开发服务器生成的 `frontend/next-env.d.ts` 路径差异仅用于运行预览，本次提交已明确排除。
- 2026-09-27 后续改为 Chrome + Whistle 预览：本机 Whistle `lv` 规则中 8 处 `lightvela.com` 映射从 5174 改到 5274，Chrome SwitchyOmega 已选择 127.0.0.1:8899；前端直接使用 `https://api.lightvela.com`。Chrome 在正式域名下读取到现有登录态，代理页面含 Next 开发资源，非 `__releases/` 产物。用户随后连接 QQ，已完成主 Bot 的真实发送交互验收。

## discard
- `pnpm i18n:extract` 产生的大量无关生成差异与构建重写的字体文件均已移除。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/channel-test-send/lightvela`。
- 主要文件：`frontend/src/pages/marketing/agent-channel-panel.tsx`、`frontend/src/pages/marketing/agent-config/hooks/useChannelOperations.ts`、`frontend/src/pages/marketing/agent-config/hermes-command-builder.ts`。

## next_action
按用户授权提交、推送并创建 MR，核验远端分支与 MR 状态；不合并或发布。5274 开发服务器由 detached `screen` 会话 `lightvela-5274` 保持运行。预览结束后恢复 Whistle `lv` 规则原先的 5174 映射，并清理生成的 `frontend/next-env.d.ts` 差异。
