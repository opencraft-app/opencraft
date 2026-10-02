# 双站 Soul 新推荐移除 MUM/MOMMY Task Pack

## goal

让 LightVela 双站人设页停止新增推荐 `MUM/MOMMY`，同时保留用户已有卡片和已应用状态。

## non_goals

- 不修改 SkillHub 接口、数据或其他消费方。
- 不清理历史卡片、Agent `SOUL.md`，不新增页面、路由或埋点。

## requirement_ids / requirement_refs / requirement_excerpt

- 产品需求：[PRD MR !4913](https://git.woa.com/wisp/mono2/-/merge_requests/4913)。
- 本次范围：双站新抽卡、重抽和人格测试排除目标类型；历史卡片保留；SkillHub 不变。

## interface_refs / data_structure_refs

- `frontend/src/lib/skillhub-api.ts`：国内站 `SkillHubSoul` 列表和详情契约保持不变。
- `frontend/src/pages/marketing/agent-buddy-localization.ts`：国际站 locale 到本地 Soul 池及 slug 映射。
- `frontend/src/lib/buddy-storage.ts`：已抽卡片与已应用 slug 的持久化形状不变。

## history_context

- `current_design_refs`：上述 PRD；`frontend/src/pages/marketing/agent-buddy-panel.tsx` 与相邻测试为当前运行行为依据。
- `relevant_evolution`：无额外历史变更影响本次范围。
- `superseded_refs`：无。

## acceptance

- 双站的新抽卡、重抽、人格测试不产生目标类型；测试按原有分数推荐其他可用 Soul。
- 已抽到和已应用的目标卡片在刷新和国际站语言切换后仍正确显示和使用。
- SkillHub 与其他 Soul 行为不变；前端聚焦测试、`pnpm check`、`pnpm test`、`pnpm build` 通过或记录明确阻断。

## affected_paths

- `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- `frontend/src/pages/marketing/agent-buddy-soul-test-modal.tsx`
- `frontend/src/pages/marketing/agent-buddy-soul-test-data.ts`
- `frontend/src/pages/marketing/agent-buddy-soul-test-data.en.ts`
- 相邻 `frontend/src/pages/marketing/__tests__/` 测试。

## required_context

- `frontend-product-surface`、`service-frontend`、`site-environment-routing`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
| --- | --- | --- |
| `docs/context/project/services/frontend.md@db673bbb9` | 前端服务门禁 | 确定最小验证与双站要求 |
| `docs/context/domains/site-environment-routing.md@db673bbb9` | 国内/国际站边界 | 分站验证，不以一站代表另一站 |
| `frontend/AGENTS.md@db673bbb9` | 最近服务指令 | 使用前端既有组件与 `check/test/build` 门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@db673bbb9` | 前端相邻测试与 locale | 检查相邻测试，避免直接改生成物 |

## evidence

- 路由器返回上述三个 Pack，已阅读两个 `must_read` 与 `frontend/AGENTS.md`。
- 当前代码中，国内候选来自 `fetchSouls`，国际候选来自 `getBuddySoulPool`，人格测试匹配函数在完整 `soulWeights` 上运行。
- 已实现完整目录与新推荐候选分离；相关测试 53/53、`pnpm check`、`pnpm build`、文档校验、`git diff --check` 通过。
- 全量 `pnpm test` 与低并发复跑均未通过，涉及未改动文件和 worker heap 内存耗尽；详见 FE-AI `report.md`。

## risks

- 只过滤候选而不调整测试匹配会产生空结果；匹配必须限定到可用候选。
- 过滤原始目录会使历史卡片本地化退化；保留原始目录供历史卡片解析。
- 回滚仅需撤销 LightVela 候选与匹配变更，不涉及数据迁移。

## validation

- 相邻组件与匹配单元测试。
- `pnpm check`、`pnpm test`、`pnpm build`。
- `git diff --check`、`python3 .agents/context/scripts/validate_documentation.py --repo . --format json`。

## decisions

- 采用 LightVela 侧候选过滤与测试候选重排；用户已确认双站同步、历史保留和 SkillHub 不变。

## scan_scope

- `frontend/src/pages/marketing/agent-buddy-*`、`frontend/src/lib/soul-*`、相邻测试。

## scan_output

- 有界 `rg` 结果显示目标 slug、候选池和测试匹配入口；未生成独立扫描产物。

## handoff

- 当前阶段：FE-AI verify。相关行为验证通过，全量测试未通过；下一步按引擎推进并交付本地实现。用户本轮未要求提交或推送实现分支。
