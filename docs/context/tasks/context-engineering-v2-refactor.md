---
id: context-engineering-v2-refactor-task
type: task
scope: 将 mono2 全仓文档组织与 Agent Context 建成可执行、可路由、可审计的分层体系。
triggers: ["context v2 refactor", "repository context rebuild", "23 rules landing"]
owner: mingyuxiao
authority: primary
source_of_truth:
  - docs/context/tasks/context-engineering-v2-refactor.md
  - .agents/context/tests/test_validate_context.py
  - .agents/skills/context-audit/tests/test_observation_assessment.py
  - .agents/context/tests/test_documentation_system.py
status: stale
reviewed_at: 2026-08-26
review_due: 2026-09-04
revision: 2.2.0
precedence: task
derived: false
---

# Task Pack：Context Engineering V2 重构

> 状态：该 Pack 记录 V2 初建过程，后续治理由 [Context Engineering V1 补强 Pack](context-engineering-v1-hardening.md) 承接；不得把本页的历史实验或未验证能力当作当前设计依据。

> 中文执行摘要：本 Task Pack 的唯一主目标是把 mono2 仓库 context 建为可路由、分层、可审阅且可静态验证的 Team、Project、Service、Domain 与 Task 体系。它不改变产品运行时代码、不部署服务、不把 evaluation 数据或 grading 记录接入运行时、不宣称未实现的 compaction、model routing、memory promotion 或 trace collection。每次跨边界或多步骤工作必须保留一个 Task Pack、明确 non-goals、affected_paths、风险、验证与 handoff；所有实际读取的 context 文件写入 `context_receipt`。运行时源码和测试、生成 API contract、环境与 GitOps manifest 的权威级别高于摘要；任何外部云、计费或 API 事实必须通过登记来源确认。中文化仅改变人读叙述，保留 `id`、类型状态枚举、route/pack ID、命令、路径、模型、指标及历史评测证据。当前中文化 query 未匹配现有 Pack，已记录为 bounded exact search，不扩大默认 Context 加载。此摘要不替代下方完整验收、风险、证据和决策条目。

## goal

将 mono2 的正式工程文档、服务共置知识、产品文档边界和 Agent Context 建为可路由、分层、可由 owner 审阅且静态验证的体系，保留具体 LightVela 规则，并分别产出 Context 行为证据与全仓文档组织证据。

## non_goals

- 不变更产品运行时代码或部署任何服务。
- 不得宣称已实现 runtime compaction、model routing、自动 memory promotion 或 trace collection。
- 不得将 evaluation dataset、Gold answer、模型输出或评分记录路由进运行时 context。
- 未经单独授权，本任务不得 commit、push、创建 MR 或变更外部服务。

## acceptance

- 全部非 evaluation 的 `docs/context/**/*.md` 通过 metadata Schema，且出现在生成的 Catalog。
- 代表性的单 Domain、跨 Domain、project/runbook 和精确路径 route case 均通过。
- 根 `AGENTS.md` 不超过 8 KiB，任一真实嵌套 instruction chain 不超过 16 KiB。
- 23 条规则矩阵保留原始 ADOPT/PILOT/RESEARCH 选择，并单独报告实现事实。
- 审计报告 route case、route failure、catalog coverage 和真实 Task Pack receipt；最终得分至少 85、低于 100，且无 P0 finding。
- Context validator test、audit Skill test、validator、audit command 和 `git diff --check` 均能从干净命令调用通过。
- 23 个主要服务全部具备 `catalog-info.yaml`、`README.md`、短 `AGENTS.md` 与 `docs/README.md`，并有 derived Service Context 与可执行 route。
- `docs/engineering/` 提供架构、五个 Domain、五条 Journey、平台、运维、治理与 ADR；文档地图将全仓 Markdown/MDX/RST 分入明确生命周期类别，未分类文档为 0。
- Context 控制面得分与 Repository Documentation 结构得分独立报告；不得用 Context Catalog 覆盖率代表全仓文档覆盖率。
- 产品文档 Skill 与真实代码一致地记录 `en-us`、`zh-sg`、`zh-hant` 和页面级 `id-id` 源/产物边界，不改产品正文或生成物。
- 新 GLM5.3 实验必须显式选择固定 CC Switch Provider、`high` 与 Responses；Key 仅通过子进程环境变量注入。本任务只验证入口，不运行付费实验。

## affected_paths

- `AGENTS.md` and bounded service `AGENTS.md` entries
- `.agents/context/`
- `.agents/skills/context-audit/`
- `docs/context/`
- `docs/engineering/` 与 23 个主要服务的共置文档入口
- `.agents/skills/product-skills/lv-docs/`
- `docs/context/evaluation/scripts/` 与评测 Runbook（不含结果资产）

## required_context

- `context-governance`
- `repository-context-index`
- 原始 LightVela context-engineering HTML plan
- OpenAI Codex Skill 指引和 Anthropic Skill 编写指引

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 建立仓库 P0 边界和加载 contract | 保留 Team 级安全与验证门禁 |
| 原始 `lightvela-context-engineering-plan.html` | 恢复精确的 23 条规则与成熟度分配 | 不改变提案地重建实现矩阵 |
| `.agents/context/context-routing.yaml` | 检查实际 route channel 和任务覆盖 | 设计多 Pack 与补充 route |
| `.agents/context/context-pack.schema.json` | 检查必需 metadata contract | 使所有正式文档可由机器验证 |
| `.agents/context/authority-policy.yaml` | 建立事实 precedence 和外部边界 | 保持代码/contract/manifest 高于文案 |
| `.agents/context/lifecycle.yaml` | 检查 candidate 晋级状态 | 不将未实现的 memory automation 写入 active claim |
| `.agents/context/tool-contracts.yaml` | 检查支持的 context tool 和 failure policy | 约束审计与 fallback 设计 |
| `.agents/context/tests/test_validate_context.py` | 阅读可执行验收标准 | 驱动 Validator 重构与回归 case |
| `.agents/skills/context-audit/SKILL.md` | 检查当前 audit workflow | 分离入口指令和 script/rubric 细节 |
| `.agents/skills/context-audit/tests/test_observation_assessment.py` | 阅读可执行 audit 期望 | 添加行为证据并防止机械 100/100 |
| Git 中旧版根 `AGENTS.md` | 恢复 Playground、TAPD、Product Skills 与 subtree 的具体约束 | 将稳定规则迁入可路由的 Project/Runbook 文档 |
| `new-api/web/AGENTS.md` | 度量并分类超长局部指令文件 | 将稳定细节拆入服务文档，入口只保留短路由 |
| `velalink/AGENTS.md` | 保留桌面预览与可观测知识 | 建立延迟加载的 VelaLink 服务指南 |
| `velalink/vendor/openai-codex/AGENTS.md` | 保留 vendor Rust/TUI/API 硬约束 | 建立延迟加载的 vendor 指南并降低祖先指令链体量 |
| `docs/superpowers/plans/2026-08-26-context-v2-chinese-localization.md` | 记录本次中文化实施计划与不变量 | 执行中文化范围、验收与风险控制 |
| 路由器查询 `中文化 AGENTS.md docs/context 文档` | 本次中文化 query 未匹配现有 Pack | 按 bounded exact search 执行；未扩大运行时 Context 读取范围 |
| 路由器查询 `全仓上下文工程与文档组织建设` | 本次全仓建设 query 未匹配现有 Pack | 记录失败 query，转为有界读取文档设计、Validator、Audit 与产品文档契约 |
| `docs/superpowers/specs/2026-08-26-vela-documentation-architecture-design.md` | 读取已获批的混合式文档架构 | 固定服务共置、跨服务集中、产品隔离、Context 派生的分布方式 |
| `docs/superpowers/plans/2026-08-26-vela-documentation-system.md` | 读取已获批实施步骤与边界 | 继续执行未完成的独立评分、产品 locale 与 Provider 隔离任务 |
| `.agents/context/scripts/validate_documentation.py` | 检查全仓文档母集、服务入口、链接和分类算法 | 以 1,811 份仓库文档为母集生成独立文档证据 |
| `.agents/context/tests/test_documentation_system.py` | 检查文档系统可执行契约 | 以 TDD 锁定 23 服务、工程层级、Context 派生与 `id-id` 规则 |
| `docs/engineering/governance/documentation-policy.md` | 检查正式文档类型、权威和生命周期 | 明确通用文档建设方案及工作产物退出机制 |
| `docs/engineering/governance/documentation-map.yaml` | 检查仓库文档分类与链接例外 | 区分 canonical、product、work、generated、context、evaluation、archive、vendor、upstream |
| `.agents/skills/product-skills/lv-docs/SKILL.md` | 核对产品文档双区域工作流 | 修复遗漏的印尼语页面级源与生成物说明 |
| `.agents/skills/product-skills/lv-docs/references/docs-rules.md` | 核对产品文档目录、同步与图片契约 | 以实际代码补齐 `id-id`、`ID_DOC_METADATA` 和 `globalDocsForIndonesian` |
| `frontend/scripts/sync-fumadocs-content.mjs` | 验证产品文档真实同步逻辑 | 确认 `id/<file>` 显式开放、Responses 无关、`id-id` 产物与 `-en` 图片策略 |
| `frontend/src/app/(site)/[lang]/docs/[[...slug]]/page.next.tsx` | 验证国际站 locale 路由 | 确认 global 构建支持 `en-us`、`zh-sg`、`zh-hant`、`id-id` |
| CC Switch SQLite Schema 与固定 Provider 的非敏感字段 | 验证用户指定实验来源 | 只读确认 Provider ID、名称、`glm-5.3`、`high`、Responses 与 Key 环境变量名，未输出 Key |
| `docs/context/evaluation/scripts/run_context_eval.py` | 检查旧 runner 的全局 Provider 歧义 | 增加显式 Provider 门禁和每臂隔离 `CODEX_HOME` |

## evidence

- 初始 Validator：四个聚焦路由/解析/指令链测试通过；仓库契约仍暴露四份路由文档缺失、23 份 frontmatter 无效、三条祖先链超限、外部来源不完整、Catalog 过期和一条路由漏召回。
- 初始 Audit：完成门禁失败且缺少 `behavioral_evidence`，证明旧分数不能代表真实消费行为。
- 指令拆分阶段：Validator 达到 30 份 Schema 合法文档、route smoke 零失败、外部来源完整，最大祖先链为 12,532 字节；随后继续完成 Catalog 与 Audit。
- V2 第一阶段门禁：34/34 正式 Context 通过 Schema 与 Catalog hash，16 条 route smoke、6 个 Validator 测试和 3 个 Audit Skill 测试通过。
- 安全门禁：扫描 66 份运行时 Context/AGENTS 文件；移除迁移文档中继承的操作凭据与解码/打印指令后，明文凭据发现为 0。
- V2 第一阶段 Audit：95/100、P0/P1 为 0、Catalog 覆盖 100%，包含一个真实 Task Pack receipt、三个反馈案例，并对缺少运行时消费 trace、自动 compact 和自动晋级明确保留 P2 扣分。
- 中文化路由记录：`python3 .agents/context/scripts/validate_context.py --route "中文化 AGENTS.md docs/context 文档"` 返回 `no route matched; perform a bounded exact search and record the failed query`；随后仅扫描已授权的 `AGENTS.md` 与 `docs/context/` 人读 Markdown 路径。
- 中文化门禁覆盖全仓 32 份 `AGENTS.md`、正式/评测 Context Markdown 与 Context Audit Skill；逐段忽略 frontmatter、代码块、内联代码、URL 与路径后，人读段落不得保留不少于 12 个英文词且完全没有中文的叙述。机器契约的人读说明同样通过中文优先测试。
- 冻结版本边界：旧 `freeze-manifest.json` 保持不变；中文 Context 使用独立的 `freeze-manifest.zh-v2.json`，runner 仅在显式传入 `--freeze-manifest freeze-manifest.zh-v2.json` 时选择它。
- 原始评测证据保护：翻译前为 465 份 JSONL、GZ 和 `evaluation/runs/**` 资产建立 SHA-256 清单，翻译后逐项校验全部一致。
- 中文化阶段验收：34/34 正式文档通过 Schema 与 Catalog hash，16/16 route smoke 通过，11 个 Context 测试、3 个 Audit Skill 测试和 17 个 evaluation runner 测试通过；Audit 为 95/100，P0/P1 均为 0。
- 文档系统基线：Repository Documentation Validator 纳入 1,811 份文档，分类为 canonical 774、product 280、work 57、context 51、evaluation 8、archive 106、vendor 190、upstream 345；未分类 0、未登记失效链接 0。
- 服务与路由基线：23/23 服务入口、23/23 derived Service Context、5/5 derived Domain Context、39/39 route smoke 均由命令验证。
- 独立审计：Context 控制面 95/100；Repository Documentation 结构 90/100。后者保留 10 分，因为尚未逐文验证 1,811 份正文的事实正确性、时效和读者任务成功率。
- 产品文档契约：真实同步代码支持 `en-us`、`zh-sg`、`zh-hant`、`id-id`；新增测试先因 Skill 缺少 `id-id` 失败，补齐说明后通过。未修改产品正文和 Fumadocs 生成物。
- GLM5.3 隔离契约：固定 Provider `ccf642d4-1927-4769-a8f7-e2882c488455` 已只读验证为 `glm-5.3`、`high`、Responses；测试证明 API Key 不写入隔离配置、model catalog 或 `auth.json`，本轮未启动实验。
- 本轮全量静态门禁：51/51 Context 文档、39/39 route smoke、19 个 Context/Documentation 测试、4 个 Audit 测试、23 个 evaluation runner/provider 测试和 9 个产品文档 parity 测试通过；Context Audit 为 95/100，Repository Documentation 结构得分为 90/100，P0/P1 均为 0。

## risks

- 迁移冗长本地规则可能隐藏硬约束。缓解措施：在本地入口保留 P0 约束和精确命令，在服务文档保留具体细节，并验证链接和 route case。回滚：从 Git 恢复受影响的 `AGENTS.md` 内容，同时保留无关 context 工作。
- 派生摘要可能偏离代码。缓解措施：每份文档都含 `source_of_truth`、review date、revision、precedence 和生成的 source hash。回滚：标记文档为 deprecated 并从路由移除。
- 审计可能奖励文件存在而非行为。缓解措施：评分可执行 route case、Catalog coverage、instruction-chain limit 和实际 receipt；未实现运行时功能不得获得满分。
- 全仓分类可能被误解为逐文质量验收。缓解措施：Repository Documentation 独立评分固定标记 `content_quality_scope=structural-only`，并为事实、时效与任务成功率保留 10 分。回滚：不删除已建入口，只移除未经证据支持的质量宣称。
- CC Switch 配置可能把 Key 泄露到临时文件或日志。缓解措施：SQLite 只读、固定 Provider ID、生成最小 config、Key 仅注入 `OPENAI_API_KEY`，并以 fixture 扫描持久化内容。回滚：禁用 `--ccswitch-provider` 执行入口，不影响历史结果资产。

## validation

```bash
python3 .agents/context/scripts/validate_context.py --build-catalog
python3 .agents/context/scripts/validate_documentation.py --repo . --format json
python3 -m unittest discover -s .agents/context/tests -v
python3 -m unittest discover -s .agents/skills/context-audit/tests -v
python3 -m unittest discover -s docs/context/evaluation/scripts -p 'test_*.py' -v
python3 docs/context/evaluation/scripts/ccswitch_glm_provider.py --database "$HOME/.cc-switch/cc-switch.db" --provider-id ccf642d4-1927-4769-a8f7-e2882c488455
python3 .agents/context/scripts/validate_context.py --format json
python3 .agents/skills/context-audit/scripts/audit_context.py --repo . --format json
cd frontend && pnpm exec vitest run scripts/international-docs-parity.test.ts
git diff --check
```

## decisions

- 允许一个主任务目标加载多个必要 Domain Pack；跨 Domain 需求不能为满足单 Pack 口号而丢弃必要边界。
- 将五个业务 Domain Pack 与补充 Project/Runbook route 分离。
- 保持 Validator 无依赖，并验证仓库支持的 frontmatter/Schema 子集。
- 将运行时行为证据与静态结构分开审计，并有意保留未实现运行时功能的扣分。
- 采用混合式文档架构：服务知识与代码共置，跨服务知识进入 `docs/engineering/`，产品文档保留区域真源，Agent Context 只做 derived 路由层。
- 23 条上下文工程规则不承担完整文档分类；仓库文档类型、分布、owner、权威和生命周期由 Documentation Policy、Map、Service Catalog 与 ADR 补足。
- `id-id` 是国际站页面级显式源，不强制每个国际站页面自动生成；已有印尼语源的事实更新必须同步维护。
- 新 GLM5.3 实验不再复用当前全局 Codex Provider；必须显式选择固定 CC Switch Provider，并为每个实验臂创建无持久化 Key 的隔离 `CODEX_HOME`。

## scan_scope

- `docs/context/` excluding `docs/context/evaluation/`
- `.agents/context/`
- All `AGENTS.md` files excluding `.git`, `node_modules`, and isolated worktrees

## scan_output

- 结构化 Validator JSON summary 与 Context Audit JSON；不得把原始仓库 dump 注入运行时 context。

## handoff

- 仓库 Context V2、中文化和全仓 Documentation System 均保存在 `codex/context-engineering-repo-context` 的本地工作区 diff 中；未执行 commit、push、MR、发布或生产操作。
- 已完成静态组织与契约建设；尚未实现的运行时 retrieve/rerank/assemble/utilization trace、自动 compact、自动记忆晋级和模型效果提升仍保持 P2/未验证状态。
- 下一步由 Owner 审阅完整 diff，并另行决定是否提交；若要验证模型效果，必须基于新的冻结清单用固定 CC Switch GLM5.3 Provider 启动独立实验。
