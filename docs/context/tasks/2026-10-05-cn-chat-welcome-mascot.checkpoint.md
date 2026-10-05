## stage

已同步 `origin/master` 到 `e08b0db87`；按用户最新反馈将欢迎语和形象的间距再缩小，并在 5174 保留国内站本地预览；待用户审阅，未提交或发布。

## verified

- 国内站内嵌工作台的草稿欢迎页通过 CSS 将官网 `lv-cover-lavender.webp` 锚在欢迎语右下，形成用户要求的“文案左上、形象右下”组合；其他页面不匹配该选择器。
- OpenCraft Web 类型检查、两项聚焦测试、Web 构建、内嵌构建和文档影响检查通过。
- 合成 Agent 的真实草稿组件在桌面、390×844 与 390×540 尺寸中图片、文案和输入框不重叠；本地图片路径返回 HTTP 200。
- 上游仅改变 frontend 侧栏等文件，与本轮 OpenCraft 样式没有重叠；工作区保留本轮未提交改动，更新无需冲突解决。
- 5174 由本 worktree 的 `frontend` 进程监听；`/agents/chat/`、本地 OpenCraft 嵌入脚本及官网小形象分别返回 HTTP 200。Chrome 使用现有登录会话能打开国内站，但当前 Agent 已暂停，无法在真实会话中进入草稿欢迎态。
- 首页用独立细线和图片左侧渐隐拼接飘带，本轮复用了该方式；临时视觉页在桌面、390×844 和 390×540 下显示细线与飘带相接，输入框无遮挡。视觉页是 CSS 示意，仍需运行中的 Agent 验收真实草稿态。
- 进一步将细线左端移到标题末尾约三个字宽处；桌面与 390×844 视觉页均显示短线仍和飘带连接。
- 320px 宽标题换行后，形象改为随标题底部定位；320×640、320×540 和 390×844 均重新检查连接与输入框间距。
- 本轮将桌面文字右侧预留从 110px 收至 86px，图片左移 24px；窄屏预留从 76px 收至 62px，图片左移 14px。5174 预览页桌面、390×844 和 320×540 截图未见遮挡，细线仍接到飘带；内嵌脚本已重建并核对包含新样式。
- 最新修改后 OpenCraft Web 类型检查、2 项聚焦测试及内嵌 release 构建通过；5174 脚本、预览页和形象资源均为 HTTP 200。

## unverified

- 当前账号的 Agent 已暂停，尚未在真实可运行 Agent 的草稿页验收；未验证生产发布。

## discard

- 误命中的 `lightvela-hermes-empty-view` 是未连接环境页面，与本需求无关。
- 临时合成预览脚本和本地服务在交接前清理。

## restore

- Worktree：`/Users/pablozhong/.codex/worktrees/cn-chat-welcome-mascot/lightvela`。
- 本轮源码改动：`opencraft/apps/workbench-web/src/styles/app.scss`。
- 素材真源：`frontend/public/lightvela-intl-home/assets/lv-cover-lavender.webp`。

## next_action

保留 5174 国内站和临时视觉预览页供用户查看；确认最终 Git diff 和工作区状态后交接。
