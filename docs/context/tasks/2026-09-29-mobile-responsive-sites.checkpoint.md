## stage
响应式修复与双站构建已完成，用户已授权提交 MR。

## verified
- 独立工作树 `codex/mobile-responsive-sites` 基于 `4a3b49a`；主工作区未触碰。
- 320px 实测修复了更新日志、开源声明与控制台文件页的页面级横向溢出。
- 首页窄屏品牌与操作区无重叠，简体中文长轮播词完整换行。
- 聚焦测试 87/87 与 `pnpm check` 通过；第一次资源测试 3 项失败与 HEAD 中的 `.webp` 资源和旧 `.png` 断言不一致有关。
- 双站构建、文档验证与 change-impact 门禁通过；开源声明移动端专用换行规则已在 1280px、320px 实测，`pnpm check` 再次通过。

## unverified
- 国际站登录后的控制台布局：本地认证 API 暂不可用。
- 真机 Safari、微信内置浏览器与正式环境发布状态。

## discard
- 首页资源断言失败的长快照输出；以测试名和 HEAD 资源路径为准。

## restore
- Task Pack：`docs/context/tasks/2026-09-29-mobile-responsive-sites.md`。
- 改动路径见 Task Pack `affected_paths`。

## next_action
- 暂存核对、运行门禁、提交推送并创建 MR，核验远端分支与 CI 状态。
