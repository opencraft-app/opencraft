## stage
MR !3619 的目标分支漂移处理与本地复验已完成；更新只推回原源分支，不创建重复 MR，不执行合并或发布。

## verified
- 国内/国际站共享的 favicon head 与 manifest URL 已更新为 `?v=ad386be5`。
- favicon PNG 哈希以 `ad386be5` 开头，内容为用户截图 2 中的机器人图标。
- 聚焦测试 2/2、`pnpm check`、documentation gate 与 change-impact gate 通过。
- 国内站 96/96、国际站 606/606 App Router 静态页面通过 webpack 构建，最终产物中的域名与 favicon URL 正确。
- 最新 `origin/master@450fd67db4e37b709a821725104a3266aa195fe8` 已合入；唯一冲突是 favicon 设计约束与上游首页性能设计说明的相邻编辑，解决结果同时保留两项约束。
- 合并态聚焦测试 36/36、`pnpm check`、CN/Global 首页性能预算与双站 webpack 构建均通过；构建产物继续输出 `?v=ad386be5` favicon URL。

## unverified
- 推送后的 CI 与 MR mergeability 需由远端重新计算；未执行 MR 合并、部署，也未验证生产 Safari 实际缓存刷新。
- 标准 Turbopack `pnpm build:cn` 在本机编译阶段卡住；已用 8GB webpack 双站静态构建补充代码与产物证据。

## discard
- 主检出依赖软链导致的 23 个 velachat 类型诊断不属于本任务；独立安装锁定依赖后 `pnpm check` 新增诊断为 0。
- `frontend/next-env.d.ts` 的构建期自动改写已恢复，不在最终 diff。

## restore
- worktree：`/Users/pablozhong/codex/lightvela/.worktrees/fix-cn-homepage-favicon`
- 基线：`origin/master@450fd67db4e37b709a821725104a3266aa195fe8`
- 分支：`codex/fix-cn-homepage-favicon`（现有 MR !3619）
- Task Pack：`docs/context/tasks/2026-09-05-cn-homepage-favicon.md`

## next_action
- 将已验证的目标分支更新推回现有 MR !3619，并分别回查远端 CI 与 mergeability；不合并或发布。
