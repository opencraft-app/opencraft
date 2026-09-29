---
id: mobile-responsive-sites-checkpoint-2026-09-29
type: task
scope: Checkpoint for the LightVela mobile browser layout MR and review follow-up.
triggers: ["mobile responsive", "MR 4829", "checkpoint"]
owner: pablozhong
authority: derived
source_of_truth:
  - docs/context/tasks/2026-09-29-mobile-responsive-sites.md
status: pilot
reviewed_at: 2026-09-30
review_due: 2026-10-06
revision: 1.1.0
precedence: task
derived: true
---

## stage
MR !4829 的 CR 问题已在本地修复，准备推送复核。

## verified
- 独立工作树 `codex/mobile-responsive-sites` 基于 `4a3b49a`；主工作区未触碰。
- 320px 实测修复了更新日志、开源声明与控制台文件页的页面级横向溢出。
- 首页窄屏品牌与操作区无重叠，简体中文长轮播词完整换行。
- 聚焦测试 87/87 与 `pnpm check` 通过；第一次资源测试 3 项失败与 HEAD 中的 `.webp` 资源和旧 `.png` 断言不一致有关。
- 双站构建、文档验证与 change-impact 门禁通过；开源声明移动端专用换行规则已在 1280px、320px 实测，`pnpm check` 再次通过。
- 初始 CI failure/block 已复现为 Opencraft vendored 文件漂移；已合入最新 master，待按仓库脚本同步。
- 360px 国内首页实测无溢出或页头重叠；320px 日文、韩文首页无页面级横向溢出。
- 首页导入脚本已纳入窄屏规则，样式测试 3/3 通过。
- 合入当前 master 后，相关聚焦测试 47/47 通过，`pnpm check` 为 0 个新增 TypeScript 诊断。
- Opencraft 同步后只改动生成清单和文件页副本，`check:mono2-agent-console` 输出 `Verified 130`。
- 最新代码的国内与国际站构建通过，分别生成 105、616 个静态路由。

## unverified
- 国际站登录后的控制台布局：本地认证 API 暂不可用。
- 真机 Safari、微信内置浏览器与正式环境发布状态。

## discard
- 首页资源断言失败的长快照输出；以测试名和 HEAD 资源路径为准。

## restore
- Task Pack：`docs/context/tasks/2026-09-29-mobile-responsive-sites.md`。
- 改动路径见 Task Pack `affected_paths`。

## next_action
- 单独提交生成物与验证记录，推送 MR !4829，并核对远端 SHA、合并状态和 CI 快照。
