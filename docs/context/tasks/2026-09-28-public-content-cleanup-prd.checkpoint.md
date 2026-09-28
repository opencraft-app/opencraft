---
id: public-content-cleanup-checkpoint-2026-09-28
type: task
scope: 双站公开内容清理的交接检查点。
triggers: ["双站内容清理", "文档暂时下线", "Blog 入口隐藏"]
owner: jasminzhao
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-28-public-content-cleanup-prd.md
status: active
reviewed_at: 2026-09-28
review_due: 2026-12-27
revision: 1.0.0
precedence: task
derived: false
---

# 双站公开内容清理检查点

## stage
本地实施完成；聚焦验收与双站构建通过，全量测试有基线失败和运行挂起记录。未提交或发布。

## verified
- 双站 Blog 入口隐藏已获用户确认。
- 指定文档暂时下线已获确认：移除入口、站内搜索、索引及正文引用，旧链接返回 404，保留源稿。
- 四篇指定文章属于国际文档站场景方案。
- 国际文档多处中英文仍含过期公测计费口径。
- 最新 master 国内概览已无公测、内测关键词；国内管理套餐仍有用户指出的 Markdown 写法。
- 正式 PRD：wiki/prd-docs/2026-09-28-public-content-cleanup.md；文档校验零错误、零警告、零死链，PRD 格式及结构自检通过。
- 已运行 docs:sync，生成 513 篇文档；下线源稿保留，所有语言注册和公开反链已清理。
- 聚焦测试最终结果 112/112 通过。
- 新增下线/生成内容/静态首页/Markdown 实际渲染测试均已通过；早期测试路径与 React 导入问题已修正。
- check、双站 build、导出 HTML/索引/链接检查通过；40 个国际旧 URL 返回 404。
- Context audit 33 项测试通过；Context 契约 4 项失败在基线复现，build-catalog 无本任务文件错误。

## unverified
- 全量测试未通过；120 项失败及两个套件加载错误已在未修改 HEAD 复现，onboarding 单例重跑通过；全量有一个被终止的挂起 worker。详见 Task Pack，不能宣称全量门禁全绿。
- 生产发布与线上验收尚未执行。
- 用户已授权 Git 提交、推送与 MR；TAPD 和发布未授权。

## discard
- 不把页面正文最后更新时间中的 2026-08-18 视为过期口径。

## restore
- 任务记录：docs/context/tasks/2026-09-28-public-content-cleanup-prd.md。
- 工作分支 jasminzhao-optimization-0928，基线 e704ced30。
- 保留 next-env.d.ts 和两份 coffee-warmup 用户原有未提交文件。
- next-env.d.ts 原始用户内容备份在 /tmp/lightvela-content-cleanup/next-env.d.ts.original；构建后核对保留。

## next_action
国际站本地预览已启动：http://127.0.0.1:5180/，独立构建目录 .next/optimization-0928。首页与 /zh-sg/docs/overview/ 均返回 HTTP 200，首页已在应用内浏览器打开。登录接口连接失败，当前用于首页与文档内容预览。保留服务运行，等待用户验收；仅在后续授权后执行提交、推送、MR 或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- R1–R4：按 wiki/prd-docs/2026-09-28-public-content-cleanup.md 实施双站内容清理，用户已确认。

## interface_refs / data_structure_refs
- 文档路由清单、sidebar 与 Fumadocs 注册；精确入口见主 Task Pack。

## history_context
- current_design_refs：docs/engineering/domains/site-environment-routing.md、frontend/openspec/specs/blog.md。
- relevant_evolution：基于 e704ced30 开发；完整测试失败已与该 HEAD 隔离对照。
- superseded_refs：无。

## context_receipt
- 已读文件与用途见 docs/context/tasks/2026-09-28-public-content-cleanup-prd.md 的 context_receipt。

## review_update
- 正在交付 MR 到 master；最新目标 cd7b64cc4 已有相同的国际站旧口径修复，将保留上游文案并验证合并结果。
- 修复遗漏的未来计费标题/表格，新增多语种回归断言。
- 已完成合并后复核：check 无新增诊断、112 测试通过、双站 build 及导出检查通过、40 旧 URL 返回 404。下一步推送当前分支并创建 master MR；原始用户文件不纳入提交。

## delivery_result
- MR：[!4689](https://git.woa.com/wisp/mono2/merge_requests/4689)，jasminzhao-optimization-0928 → master，状态 opened。
- 代码提交 aff81be002538b448b949a17fce4473248d58b8a 已验证与远程一致；创建后 CI 为 pending，未合并或发布。
- 5180 国际站预览恢复且首页 HTTP 200。后续由评审人审查 MR 和 CI 结果。

## CI follow-up
- MR !4689 报 OpenCraft vendored manifest drift；本地复现并运行官方同步脚本修复，仅 UPSTREAM.json 的 sourceRevision 变化。
- npm --prefix opencraft run check:mono2-agent-console 通过（130 文件）。与 CI 相同的 .ci/checks/opencraft_guard.sh 也已通过，作为独立提交推送原 MR；生产和镜像操作不在本次范围。
