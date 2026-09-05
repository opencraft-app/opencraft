## stage
实现和本地验证完成；下一道门禁是最终 diff/context 检查，之后等待用户授权提交或提 MR。

## verified
- 隔离 worktree 基于 `origin/master@65784cf2e6ae16c5687919b2b01f25febf0096b8`，主工作区未被修改。
- 根路由旧首页静态入口已移除，公共头部重模块改为按需加载，首页三个独立脚本改为并行发起。
- 聚焦测试、`pnpm check`、`pnpm check:homepage-performance`、CN/Global webpack 静态导出以及桌面/移动浏览器回归均通过。
- CN 初始 Next JS gzip 从 953,870 B 降至 725,261 B；正文 Flight 重复仍存在并已作为已知边界记录。
- 构建产物检查可显式阻止旧首页 chunk、超过 22 个初始 Next 脚本以及 HTML/Flight/JS 体积预算回退；未自动接入默认 Turbopack build 链。

## unverified
- 未做线上真实网络环境的 RUM/LCP/INP 对照，也未验证 CDN/EdgeOne 缓存与压缩头。
- 尚未运行远端 CI，代码也未提交、推送、创建 MR 或发布。

## discard
- 默认 Turbopack 构建在本机无输出挂起，不能作为代码失败证据。
- 默认 4 GB heap 的 webpack OOM 已由同版本 8 GB heap 的稳定对照构建替代。
- 单纯移动 fragment 的 Server/Client 边界已被历史及当前产物证伪，不再作为本轮候选方案。

## restore
- worktree：`/Users/pablozhong/codex/lightvela/.worktrees/cn-homepage-performance`
- branch：`codex/optimize-cn-homepage-loading`
- 稳定构建命令：`node --max-old-space-size=8192 ./node_modules/next/dist/bin/next build --webpack`，并显式设置 CN 或 Global region 环境变量。
- 对比与报告目录：`/tmp/lightvela-cn-home-optimization-20260905/`。

## next_action
- 更新验证报告，运行最终 `git diff --check`、context/documentation 检查与工作区审计，然后等待用户决定是否提交。
