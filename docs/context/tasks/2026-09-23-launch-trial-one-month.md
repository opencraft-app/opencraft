---
id: launch-trial-one-month-2026-09-23
type: task
scope: 双站首页启航标准版与 AI 积分版免费试用统一为 1 个月。
triggers: ["启航试用", "首页试用文案", "双站一个月试用"]
owner: jasminzhao
authority: primary
source_of_truth:
  - wiki/prd-docs/2026-09-23-launch-trial-one-month.md
  - frontend/public/lightvela-intl-home/index-fragment.zh-CN.html
  - frontend/public/lightvela-intl-home/index-fragment.en-US.html
status: active
reviewed_at: 2026-09-23
review_due: 2026-12-22
revision: 1.0.0
precedence: task
derived: false
---

# 双站首页启航版免费试用展示

## goal
双站首页与关联展示统一启航标准版、AI 积分版免费试用为 1 个月。

## non_goals
后端权益、价格、续费、保留期、历史公告正文、部署和远程提交。

## requirement_ids / requirement_refs / requirement_excerpt
用户 2026-09-23 明确双站、两种启航版均为 1 个月，并确认包含共用页脚和检索摘要。PRD：`wiki/prd-docs/2026-09-23-launch-trial-one-month.md`。

## interface_refs / data_structure_refs
`frontend/next-site/international-home-page.tsx` 的 locale 到 fragment 映射；现有 CTA URL 和服务端权益执行权保持不变。

## history_context
- current_design_refs：`docs/engineering/domains/site-environment-routing.md`。
- relevant_evolution：基线 c3f88f8a6；当前首页使用已提交静态多语言 fragment，导入脚本维护文本转换；旧 React LandingPage 为 fallback。
- superseded_refs：`wiki/product-state/geo-fact-table.md` 内旧 14 天试用口径已被本次用户确认取代，仅供历史定位；价格与保留期不在本次变更内。
- 已检查 `.agents/context/change-impact.json`、`design-history-index.json`；llms.txt 路径命中 site-environment-routing，同步正式设计。

## acceptance
双站与全部 locale 一致；CTA 路由不变；check/test/build 与 context 门禁；实际产物抽查。

## affected_paths
`frontend/public/lightvela-intl-home/index-fragment*.html`、导入脚本、共用页脚及测试、i18n 生成物、seo-data、llms.txt、正式设计、PRD、Task Pack。

## required_context
site-environment-routing、frontend-product-surface。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md | 仓库约束 | 路由与交付门禁 |
| frontend/AGENTS.md | 服务边界 | check/test/build |
| docs/context/domains/site-environment-routing.md | 双站 | 独立产物核验 |
| docs/context/project/services/frontend.md | 前端 | 展示与后端边界 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 邻接 | i18n 脚本及页脚测试 |
| docs/engineering/domains/site-environment-routing.md | 正式设计 | 首页 fragment/导入同步 |
| .agents/context/change-impact.json | 影响规则 | 正式文档同步 |
| .agents/context/design-history-index.json | 设计索引 | 当前设计定位 |
| docs/context/tasks/TASK-TEMPLATE.md | 任务记录 | 状态合同 |
| docs/context/tasks/CHECKPOINT-TEMPLATE.md | 检查点 | 交接记录 |
| .agents/skills/product-skills/prd-creator/SKILL.md | PRD | 用户确认范围 |
| .agents/skills/product-skills/prd-creator/references/prd-template.md | 模板 | 轻量 PRD |
| .agents/skills/product-skills/lv-seo-geo/SKILL.md | 检索摘要 | 多语言一致性 |
| .agents/skills/fixing-metadata/SKILL.md | description | 最小内容更新 |
| wiki/product-state/geo-fact-table.md | 旧摘要引用 | 区分试用和保留期 |

## evidence
仓库精确搜索定位旧文案；实际首页 CTA：标准 14 天、国内 AI 3 天、国际 AI 7 天；页脚 14 天。无匹配的初始泛化路由已用具体双站首页 query 替代。

## risks
历史文档还有旧口径，本次仅更新用户确认的首页及关联摘要。改动不代表生产已上线。

## validation
- `pnpm --dir frontend check`：通过，TypeScript 171 项均为已有 baseline，0 项新增；i18n 结构与繁简检查通过。
- 聚焦 5 个测试文件：153 / 153 通过，覆盖首页静态产物、页脚、字典、首页多语言及 SEO 描述。
- `pnpm --dir frontend build:cn`、`build:global`：均通过；分别检查 8 / 42 条公开 SEO 路由。
- 实际构建产物：国内中文和国际 7 个 locale 的试用区、页脚全部为 1 个月；双站 `llms.txt` 覆盖标准版和 AI 积分版。
- 9 份片段（8 locale + 默认英文）与 importer 文案映射一致，所有链接和 DOM 结构与 HEAD 一致；importer 语法检查通过。
- `validate_documentation.py` 通过；`validate_change_impact.py` 对实际工作区变更集合通过，`--staged` 通过（无暂存内容）。
- `context-audit` 单元测试 33 / 33 通过；审计脚本完成，只输出发现结果，不认定成熟度评分。
- 全量 `pnpm test` 在模型配置、Agent 设置等未改动模块出现失败，约 4 分钟后停滞，已中止本次启动的运行；不能宣称全量测试通过。中止时汇总：3675 passed、142 failed、13 skipped、3 errors（包括在该次运行后已更新并通过聚焦回归的旧首页期望）；日志 `/tmp/lightvela-trial-tests.log`。
- context 单元测试 26 项中 4 项失败；catalog 仍存在大量历史 Task Pack 缺字段和中文规范问题。新建 Task Pack 的 frontmatter、triggers 问题已修正，最终独立核查结果见下。
- i18n extract 会顺带清理约 100 个未使用历史 key，造成无关已有字典测试类型错误；恢复无关词条，仅保留本次正式生成的新词条。构建生成的无关字体和 catalog 差异也已恢复。

## decisions
使用 1 个月，不换算 30 天；试用区显式标明启航，避免误解所有套餐均免费。

## scan_scope
frontend 页面、静态片段、导入脚本、相关 i18n/SEO 和邻居测试；未扫描业务服务。

## scan_output
首次 pages/locales 查询发现 locales 目录不存在，改为实际 i18n 路径；通配 home* 未匹配，改为已定位 landing-page；首次 i18n 生成命令工作目录错误，随后在 frontend 成功重跑。

## handoff
本地实现和范围内验证完成。完整门禁存在上述其他模块/历史 context 问题。尚未提交、推送、建 TAPD/MR 或部署；PRD 和改动留在 jasminzhao-newuser-923。

## checkpoint
### stage
本地改动已验证，等待后续评审与发布安排。
### verified
双站构建、153 项聚焦测试、i18n/typecheck、产物文案与链接/DOM 一致性通过。
### unverified
未执行生产发布或生产权益核验；全量测试/context 门禁未全通过；未做浏览器截图验收。
### discard
首次错误工作目录的 i18n 命令。
### restore
本分支工作区和本 Task Pack。
### next_action
由用户决定后续提交与评审安排；完整验证失败详情留在本记录。

最终 catalog 核查：本次 Task Pack 无错误，整体门禁仍被历史记录问题阻断。

## 2026-09-23 文案精简修订
用户要求改为「新用户免费体验1个月，送4500 AI 积分」。首页两条套餐说明合并为一条，全部 locale、导入脚本、检索摘要、PRD 与正式设计同步。页脚短入口仍显示 1 个月试用。4500 AI 积分为本轮用户提供的文案事实，不变更后端发放逻辑。先前验证证据属于上一版文案，本轮重新验证。

### checkpoint
- stage：文案修订及范围内验证完成。
- verified：9 份片段（8 个 locale + 默认英文）已更新。
- unverified：未发布；全量测试及历史 context 问题沿用上轮记录，本轮未重复无关全量测试。
- next_action：由用户决定提交与评审安排。

本轮验证：check 通过（0 新增类型问题），153 项聚焦测试通过，双站 build 通过；实际国内中文与国际 7 个 locale 均仅一条新文案，双站 llms.txt 同步通过。9 份片段与 importer 文案一致，所有链接与 HEAD 相同；documentation、change-impact（实际变更集及 staged）与 diff 检查通过。无关字体生成差异已恢复。首次 Python 文案脚本因输入编码解析失败未执行，随后分段脚本成功执行并验证。

## 2026-09-23 提交与 MR 交付
用户已明确授权拉取并合并 master、提交、推送和创建 MR。执行 git fetch origin master 后 origin/master 与 HEAD 同为 c3f88f8a6539284c649d00760edc1d88b0453752；git merge --no-edit origin/master 返回 Already up to date，无冲突。工蜂 get_current_user 鉴权通过；同源分支和目标 master 的 opened MR 查询为空。

补充 context_receipt：
- `docs/context/flows/tapd-gongfeng-delivery.md`：交付授权、鉴权和 MR 验证。
- `docs/context/flows/change-delivery.md`：交付记录要求。
- `.agents/skills/gongfeng/SKILL.md`：mcporter-internal 工蜂 API。
- `.agents/skills/product-skills/lv-vibe-coding/SKILL.md`：单需求单分支、目标 master 和评审规范。

本地预览生成的 next-env.d.ts 开发类型引用已排除。当前仍保留国内站预览进程。提交前复核通过后，将本次文案、关联测试、正式设计、PRD 和任务记录一起提交；不修改生产资源。

提交前复核：check 通过（171 项已有类型 baseline，0 新增），5 个聚焦测试文件共 153 项再次通过。本次 fetch/merge 未改变基线，沿用同基线下最新文案的双站构建与产物核验；不重复运行已记录失败的无关全量测试。交接阶段为提交并创建 MR，生产发布不在本次授权内。
