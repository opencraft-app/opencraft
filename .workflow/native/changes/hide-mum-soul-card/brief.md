# 双站 Soul 新推荐移除 MUM/MOMMY

## 需求与来源

- 已确认 PRD：[mono2 MR !4913](https://git.woa.com/wisp/mono2/-/merge_requests/4913)。用户选择双站同步，只调整 LightVela 的新推荐，明确不动 SkillHub。
- 国内站 `MUM`、国际站各语言 `MOMMY` 不得从新抽卡、重抽或人格测试进入卡片盘。
- 已抽到、已应用的目标卡片继续展示、查看详情、重新注入和按现有规则操作；不清理用户状态或 Agent `SOUL.md`。

## 实现范围

- 仅在 LightVela 人设页把目标类型从新候选池排除，原始 Soul 目录仍供历史卡片本地化使用。
- 人格测试从当前候选池的 Soul 中按既有相似度选择最高匹配，避免目标类型被排除后结果页为空。
- 保持国际站中文、英文、印尼语、西班牙语、日语、韩语一致。
- 不修改 SkillHub、源 Soul 定义、详情数据、其他页面、生成文案、路由或埋点。

## 关键现状与方案

- `agent-buddy-panel.tsx` 国内站调用 `fetchSouls`，国际站通过 `getBuddySoulPool` 读取本地数组；同一 `souls` 同时传给抽卡与测试。已抽卡片独立持久化，并通过 `localizeDrawnSouls` 映射详情。
- `agent-buddy-soul-test-modal.tsx` 目前先从完整权重表匹配 slug，再到 `souls` 找卡；简单过滤 `souls` 会在匹配到目标类型时产生空推荐。
- 将原始目录与可推荐候选分开；抽卡和测试只使用过滤后的候选，历史映射仍使用原始目录。匹配函数接收候选 slug 集合，按原有分数和顺序选最高匹配。

## 验证口径

- 聚焦测试覆盖双站候选过滤、人格测试目标命中后的可用结果、历史卡片保留和语言映射。
- 运行前端 `pnpm check`、测试和构建门禁；运行 context / 文档约束检查并记录真实结果。
