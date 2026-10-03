## stage

国内站移动端聊天布局已修复并完成可用的本地验证；用户授权提交 MR，待真实可运行 Bot 验证输入区。

## verified

- 生产页 390px 宽时侧栏占用首屏，聊天输入须滚动后可见。
- 独立工作树基于 `origin/master@b42d361c7`；受影响 CSS 与工蜂 API 最新 `master@a2f68ea8` 相同。
- 本地 320px、390px 视口聊天容器填满导航条下方视口，文档无横向或纵向溢出；导航展开、选择会话、Esc 关闭可用。
- 生产 OpenCraft 输入区距宿主底边约 57.5px；在新布局里首屏可见属于基于相对尺寸的推断，本地真实输入尚未实测。
- 聚焦测试 50 项、`pnpm check`、`pnpm build:cn` 通过。

## unverified

- 本地 Bot 暂停、OpenCraft 连接失败，尚不能实测可发送消息的输入框和手机软键盘。
- 尚未合并或发布，线上仍是旧布局。

## discard

- 主工作区脏分支上的旧布局实现不作为本次修改基线。

## restore

- 工作树：`/Users/pablozhong/.codex/worktrees/cn-chat-mobile-20261002/lightvela`。
- 变更：`frontend/src/pages/marketing/agent-settings-page.tsx`、`opencraft-embedded-workbench.tsx`、`frontend/src/styles.css`。

## next_action

核对最终 diff 与文档门禁，提交 MR；若用户提供运行中 Bot 的测试入口，再做真实输入与手机键盘验证。
