# Cron 删除依赖水合输出优化

## goal
修复任务文件包含大量运行错误历史时，前端删除前依赖校验因 debug exec 输出截断失败的问题。

## non_goals
- 不改 CTL 输出上限，不部署后端，不重启用户机器。
- 不绕过依赖安全检查，不修改现存任务、提示词或历史数据。

## requirement_refs
- 用户 2026-10-12 请求：优化删除定时任务失败并闭环上线。

## interface_refs / data_structure_refs
- `frontend/src/lib/hermes-cron-client.ts` 的 listCronJobs 与 context_from_hydrated。
- debug exec 的 stdout 保留末尾 128 KiB；成功退出不意味着 JSON 完整。

## history_context
- current_design_refs: frontend/AGENTS.md、docs/context/domains/release-gitops.md。
- 线上只读复现：132951 字节 jobs.json 经命令接口返回 131072 字节，JSON 头部丢失。

## acceptance
- 超大错误历史不影响完整 prompt、context_from 及模型绑定的水合。
- 元数据超安全输出预算或不可解析时仍禁止未确认依赖的删除。
- 国内/国际 EdgeOne 构建发布完成，公共资源包含新代码，真实用户只读验证。

## affected_paths
- frontend/src/lib/hermes-cron-client.ts
- frontend/src/lib/__tests__/hermes-cron-client.test.ts

## context_receipt
- frontend/AGENTS.md、frontend 服务与 site-environment-routing/release-gitops pack：类型与双站交付边界。
- frontend-runtime-openspec-i18n 邻接卡、vitest.config.ts：回归测试环境。
- LightVela credentials/delivery-and-hotfix：本机凭据与现行制品发布链。

## decisions
- 列表只在机器侧投影所需字段，排除运行历史；不改变原始记录读取与复制路径。
- 保留数组和 jobs 包装格式、Profile 根目录与 UTF-8 内容。
- 投影后超过 120 KiB 先失败，不输出部分 JSON、不截断提示词或依赖。

## validation
- 先观察两个大文件回归测试按预期失败，再实现；321/321 客户端与组件测试通过（Node 20）。
- frontend pnpm check：0 新 TypeScript diagnostics，既有 baseline 164/171；i18n 结构通过。
- git diff --check；生产构建与双站制品验证沿 .ci/frontend.yml 执行。

## risks
- Python/文件读取异常或元数据本身超预算：保留 fail closed，不放开删除。
- 不部署 dirty 主工作树；隔离分支只包含本次修复，生产回滚使用上一已归档制品。

## handoff
- 本地回归及真实用户精简读取通过；待提交、MR 合并、CI 制品构建与双站发布验收。
