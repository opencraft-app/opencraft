## goal
统一 LightVela 定价页和官网文档中的云电脑对外术语与资源单位，并避免国际站后端英文能力 Key 造成重复规格行。

## non_goals
- 不调整套餐价格、权益数值、计费流程或运行时资源分配。
- 不重写定价页其他营销文案。
- 不执行提交、推送、MR、发布或生产操作。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户会话（2026-09-23）：采用 `Dedicated cloud environment`，规格使用 `2 vCPU · 8 GB RAM` / `4 vCPU · 16 GB RAM`，存储使用 `50 GB` / `80 GB`。

## interface_refs / data_structure_refs
- `frontend/next-site/subscribe-page.tsx` 的 `Bundle.description` 到 `PlanFeature` 映射。
- 不变量：套餐资源数值、Bot 配额、积分、价格与订阅流程保持不变。

## history_context
- `current_design_refs`：`docs/context/domains/site-environment-routing.md`、`docs/context/project/services/frontend.md`、`frontend/AGENTS.md`。
- `relevant_evolution`：`1e371aab9` 已将展示规格升级为 2C8G / 4C16G；本任务只统一命名和单位。
- `superseded_refs`：无。

## acceptance
- 国际站套餐卡不再展示 `Cloud Sandbox`。
- 云端运行资源统一展示为 `Dedicated cloud environment`，不暴露当前 VM 实现。
- 运行环境规格显示为 `2 vCPU · 8 GB RAM` / `4 vCPU · 16 GB RAM`。
- 存储显示为 `50 GB` / `80 GB`。
- 后端返回 `Standalone Environment`、`Dedicated Cloud Storage`、`Minimalist Config Panel` 时不出现重复能力行。
- 国际站各语言切换时，英文后端权益 Key 不回显英文；免费链路占位卡的价格单位按当前语言显示。
- 套餐加载与创建失败时，未知后端错误不直接回显英语；已知计费错误码继续显示对应语言的明确提示。
- 国内站与国际站现有文档语言统一使用对应语言的“专属云端环境”表述，并统一 `vCPU`、`GB RAM`、`GB` 单位格式。
- `docs:sync` 后的 `zh-cn`、`zh-sg`、`zh-hant`、`en-us`、`id-id`、`es`、`ja-jp`、`ko-kr` 套餐页保持一致。
- 聚焦测试、`pnpm check` 与相关构建门禁通过。

## affected_paths
- `frontend/next-site/subscribe-page.tsx`
- `frontend/next-site/__tests__/subscribe-page.global.test.tsx`
- `frontend/src/i18n/generated/*.json`
- `frontend/src/content/docs/{,global,en,es,id,ja,ko}/`
- `frontend/scripts/sync-fumadocs-content.mjs`

## required_context
- `site-environment-routing`
- `frontend-product-surface`
- `service-frontend`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@e51dc8196` | 国际站与 locale 边界 | 保持双站共用逻辑与翻译边界 |
| `docs/context/project/services/frontend.md@e51dc8196` | 前端服务门禁 | 确定测试、check 与构建要求 |
| `frontend/AGENTS.md@e51dc8196` | 最近服务级指令 | 遵守前端实现与验证规则 |
| `frontend/DESIGN.md@e51dc8196` | 定价卡现有设计约束 | 确认本任务不扩张为视觉重构 |

## evidence
- `corepack pnpm@10.23.0 exec vitest run next-site/__tests__/subscribe-page.global.test.tsx next-site/__tests__/subscribe-page.test.tsx --api.host 127.0.0.1`：2 个文件、73 个用例通过。
- `corepack pnpm@10.23.0 docs:sync`：通过，生成 548 篇文档；抽查 8 个输出 locale 的 `plans.mdx`，术语和规格一致。
- 定价页与文档发布聚焦 Vitest：5 个文件、142 个用例通过。
- 2026-09-24 国际站语言回归：`subscribe-page.global.test.tsx` 与国内站相邻测试共 94/94 通过，覆盖七种字典的英文后端权益、占位卡价格单位与套餐加载错误。
- 文档专项 Vitest：路由发布、国际文档一致性、更新时间 3 个文件通过；图片预算测试被 139 处既有超大图片阻塞，摘要测试被 16 篇既有定时任务文档缺摘要阻塞，本次 46 个文档源文件未新增相应问题。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：通过，第一方断链 0，文档分类和服务文档覆盖率均为 100%。
- `corepack pnpm@10.23.0 check`：通过；i18n 错误 0，保留仓库现有 50 个告警；TypeScript 基线无新增诊断。
- `corepack pnpm@10.23.0 build:cn`：通过，106 个静态页面完成生成。
- `corepack pnpm@10.23.0 build:global`：通过，664 个静态页面完成生成。
- 2026-09-24 增量修改后重跑 `pnpm check`、`build:global`、`build:cn`：全部通过；TypeScript 171 current / 171 baseline / 0 new，双站分别生成 664 / 106 个静态页面。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`：使用临时 index 校验通过，无命中 change-impact 规则。
- 全量 `pnpm test` 未通过：3704 个通过、136 个失败、13 个跳过，并出现 worker OOM；失败集中在模型配置测试缺少 Python `cryptography`、现有国际路由/文档资源断言、CSS 导入等非本任务路径。本任务聚焦套件在全量运行后再次验证仍为 73/73 通过。

## risks
- 英文后端 Key 与中文 Key 并存导致重复；通过语义别名归一化和英文回归用例覆盖。
- i18n 提取产生多语种字典变更；只保留本次新增/替换词条并运行 i18n 检查。
- 文档翻译可能与生成目录偏离；统一修改源文件并通过 `docs:sync`、国际文档一致性测试和双站构建验证。

## validation
- 聚焦 Vitest：国际站定价页。
- `pnpm check`。
- `pnpm build:global`；若脚本不存在则运行仓库定义的等价国际站构建。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged` 在暂存验证副本上检查或报告不适用。

## decisions
- 用户侧名称使用 `Dedicated cloud environment`，不绑定当前 VM 实现，也不使用 `Sandbox`。
- 规格单位按套餐卡格式使用单数单位符号 `vCPU`，内存明确为 `RAM`。
- 重复项按稳定语义别名识别，不按翻译后的显示文案去重。
- 占位套餐复用现有 `/ 月` 字典键；未知服务端错误通过页面已存在的本地化兜底文案展示，不把后端原文当 UI 译文。

## scan_scope
- `frontend/next-site/subscribe-page.tsx`
- `frontend/next-site/__tests__/subscribe-page*.test.tsx`
- `frontend/src/i18n/generated/`
- `frontend/src/content/docs/{,global,en,es,id,ja,ko}/`
- `frontend/.fumadocs-content/docs/{zh-cn,zh-sg,zh-hant,en-us,id-id,es,ja-jp,ko-kr}/plans.mdx`

## scan_output
- 无独立扫描产物。

## handoff
- 已完成源代码、六语种词典、繁体生成结果、字体子集与回归测试更新。
- 用户要求多语言及官网文档同步，因此区域按 `both` 处理；已更新国内站与国际站 46 个相关文档源文件，并用 `docs:sync` 生成全部 8 个公开 locale。
- 套餐页属于既有正式产品文档，内容分类状态原本已是 `CN ✓ | GLOBAL ✓`，无需变更；本次没有新增或替换图片。
- 国内站与国际站共用映射逻辑，两个生产构建均通过。
- 截图中的英文后端权益 Key 和旧规格来自线上版本；当前工作树已有对应修复，本次补齐全语言回归及免费链路/错误状态的漏翻。代码和构建完成不代表线上已更新。
- OpenCraft 机械副本未同步：`npm run check:mono2-agent-console` 在本次词典文件之前即因 `contexts/runtime-config-context.tsx` 的既有漂移失败；为避免把无关上游漂移并入本任务，没有执行全量同步。
- 用户于 2026-09-24 明确授权提交 MR；合并与发布仍需独立指令。

## stage
本地实现与验证完成，提交 MR 中；不包含合并或发布。

## verified
- 国际站七种字典的英文后端权益、免费链路价格单位与套餐加载错误组件回归通过。
- `pnpm check`、CN/Global 构建及 `git diff --check` 通过。

## unverified
- 线上 `lightvela.ai/zh-sg/subscribe` 尚未发布本工作树改动，截图中的线上现状不能由本地构建证明已修复。

## discard
- 旧线上截图所示 `2核 4G` 规格不是当前工作树的规格；本地使用 `2 vCPU · 8 GB 内存`。

## restore
- 在隔离工作树 `/Users/pablozhong/.codex/worktrees/pricing-cloud-computer-copy/lightvela` 续接；主工作区改动不参与本任务。

## next_action
- 创建并核验 Gongfeng MR，记录 source SHA、目标分支与 CI 即时状态。
