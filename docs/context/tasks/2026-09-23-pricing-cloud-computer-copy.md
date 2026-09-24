## goal
统一 LightVela 定价页和官网文档中的云电脑对外术语与资源单位，并避免国际站后端英文能力 Key 造成重复规格行。

## non_goals
- 不调整套餐价格、权益数值、计费流程或运行时资源分配。
- 不重写定价页其他营销文案。
- 不执行合并、发布或生产操作；提交与 MR 已由用户于 2026-09-24 单独授权。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户会话（2026-09-23）：采用 `Dedicated cloud environment`，存储使用 `50 GB` / `80 GB`。
- 用户会话（2026-09-24）：套餐卡改为易懂的 `2 CPU cores · 8 GB memory` / `4 CPU cores · 16 GB memory`（中文为 `2 核 CPU · 8 GB 内存` / `4 核 CPU · 16 GB 内存`）；文档规格保留准确的 `2 vCPU · 8 GB RAM` / `4 vCPU · 16 GB RAM`。

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
- 国际站英文套餐卡显示 `2 CPU cores · 8 GB memory` / `4 CPU cores · 16 GB memory`，中文套餐卡显示 `2 核 CPU · 8 GB 内存` / `4 核 CPU · 16 GB 内存`；其他语言自然本地化。
- 官网套餐文档的技术规格保留 `vCPU` 与 `RAM`，不称为独享物理核心。
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
| `docs/context/flows/tapd-gongfeng-delivery.md@32a6a807d` | MR 交付边界 | 区分源码修复、CI 检查和合并 |
| `docs/context/project/services/ci.md@32a6a807d`、`docs/context/domains/release-gitops.md@32a6a807d`、`.ci/AGENTS.md@32a6a807d` | CI guard 与授权边界 | 定位 trusted guard 和验证要求 |
| `opencraft/AGENTS.md@32a6a807d`、`opencraft/MONO2_MIGRATION.md@32a6a807d` | vendored 同步规则 | 生成而不手改 OpenCraft 副本 |

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
- 2026-09-24 MR !4576 CI 日志：frontend guard 通过，7 个测试文件共 130 个用例通过，CN/Global 构建分别完成 106/664 页；真正失败点为 trusted `opencraft_guard.sh` 未初始化 Node，runner 报 `node: command not found`。MDX deprecated option 与 i18n 空白提示未使 frontend guard 失败。
- 2026-09-24 重新运行 `node opencraft/scripts/sync-mono2-agent-console.mjs`：同步 130 个文件，仅 12 个 vendored 文件有差异；`npm --prefix opencraft run check:mono2-agent-console` 和 `npm --prefix opencraft run typecheck --workspace @opencraft/plugin-lightvela-hermes` 通过。
- 独立 `origin/master` worktree 中已准备 `.ci/checks/opencraft_guard.sh` 的 Node bootstrap 修复；聚焦 guard 测试 7/7 通过。完整 `.ci/runtime/check_ci_runtime.sh` 在本机临时 PyYAML 环境运行至 592 个单测，19 个因 macOS Apple Git 2.24 不支持 `git init -b` 而失败，并非该补丁诊断。
- 用户确认后，独立 CI 修复提交为 MR !4603，源分支 `codex/fix-opencraft-guard-node`，目标 `master`；`2dc1b7a68` 已随 `d39c9352d` 合入 `master`，trusted guard 现已包含 Node bootstrap。
- !4576 以普通 merge 同步 `master@96abc2691` 并重新生成 OpenCraft 清单；合并后 `pnpm check`、235 个聚焦测试、CN/Global 构建（106/664 页）、OpenCraft 同步校验与插件类型检查均通过。
- 2026-09-24 套餐卡改为易懂的 CPU 核数表述后：套餐页聚焦测试 105/105、字典测试 18/18、`pnpm check`（TypeScript 171 current / 171 baseline / 0 new）、CN/Global 构建（106/664 页）、OpenCraft 同步校验及文档校验均通过；8 个 locale 的生成套餐文档仍保留 `vCPU` 技术规格。

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
- 套餐卡以 `CPU cores` / `核 CPU` 与 `memory` / `内存` 方便 Agent 用户理解；技术规格文档仍使用 `vCPU` 与 `RAM`，不承诺独享物理核心。
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
- OpenCraft 机械副本原本未同步；CI 失败后确认 `opencraft` guard 必须先有 Node。原 MR 的 vendored 同步已推送且 CI 通过；本轮卡片文案对应的字典副本已重新生成并纳入 MR 更新。
- 用户于 2026-09-24 明确授权提交 MR；合并与发布仍需独立指令。

## stage
MR !4576 已打开；独立 `.ci` trusted guard 补丁已通过 MR !4603 合入 `master`。本轮卡片友好文案及其 OpenCraft 生成副本追加至该 MR；本任务不执行 !4576 合并或发布。

## verified
- 国际站七种字典的英文后端权益、免费链路价格单位与套餐加载错误组件回归通过。
- `pnpm check`、CN/Global 构建及 `git diff --check` 通过。
- 原 MR 的 OpenCraft 同步校验和插件 TypeScript 检查通过；独立 CI 补丁聚焦测试 7/7 通过。

## unverified
- 线上 `lightvela.ai/zh-sg/subscribe` 尚未发布本工作树改动，截图中的线上现状不能由本地构建证明已修复。
- 本轮卡片文案的远端 CI 结果以 MR 当前提交的最新检查状态为准，不能由本地构建代替。

## discard
- 旧线上截图所示 `2核 4G` 规格不是当前工作树的规格；本地套餐卡使用 `2 核 CPU · 8 GB 内存`，文档技术规格仍使用 `2 vCPU · 8 GB 内存`。

## restore
- 在隔离工作树 `/Users/pablozhong/.codex/worktrees/pricing-cloud-computer-copy/lightvela` 续接原 MR 的生成物；CI-only 补丁在 `/Users/pablozhong/.codex/worktrees/opencraft-guard-node/lightvela`。主工作区改动不参与本任务。

## next_action
- 核验 !4576 的远端 source SHA、冲突状态与新 CI 检查；不自行合并或发布。
