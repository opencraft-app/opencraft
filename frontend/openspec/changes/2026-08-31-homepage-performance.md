# 首页加载性能优化

**归档日期：** 2026-08-31

**变更类型：** 性能优化 / 构建分析

**影响模块：** 首页图片加载、场景任务数据边界、国际化构建产物分析

**兼容性：** 国内站与国际站的首页内容、文案、语言行为、场景顺序和视觉布局保持不变，无破坏性变更。

## 1. 需求概要

减少首页首屏非必要资源：将折叠下方图片改为 lazy loading，切断首页对完整场景任务库的依赖，并为两个首页脚本重复包含完整 i18n 字典的问题形成可复现证据和后续方案。本批不改变运行时 i18n 协议。

## 2. 任务完成情况

- [x] 折叠下方 40 个唯一图片资源改为 lazy，Hero 四图与站点 Logo 保持首屏加载策略。
- [x] 抽取首页 6 个 overview 场景 pack 的单一事实来源，保持全量 ID、顺序、locale 文案与 prompt 行为。
- [x] 完成 i18n 重复字典 Q0 PoC，定位 Turbopack 跨 client entry 重复发射静态字典的原因。

原实施计划记录 3/3 个任务全部完成，无跳过项。

## 3. 关键决策

- 先移除可确认的资源浪费，再收窄数据依赖，最后只分析 i18n，不把高风险运行时改造混入同一批次。
- 图片只调整折叠下方资源；Hero priority、字体 subset、fake repository 和废弃图片均不在范围内。
- 首页与全量场景库复用中立 core，避免复制 6 份场景数据形成双真源。
- i18n Q0 没有发现不改变 client boundary 或运行时加载协议的安全配置级去重，因此留作独立后续需求。

## 4. 实施摘要

- 构建记录显示唯一图片 preload：国内站从 45 降至 5，国际站从 46 降至 6。
- 场景目录定向测试记录为 9 个文件、66 个断言通过；首页场景 core chunk 从 123,173 B / gzip 38,701 B 降至 72,955 B / gzip 23,048 B。
- 两份国际首页字典 chunk 均约 1,030,557 B，并包含相同的 2,680 个 key 和 8 个 JSON module ID；根因记录为两个 client entry 都依赖 `useT()`。
- 原实施记录包含图片与场景定向测试、`pnpm check`、双区域构建、`git diff --check`、Lighthouse 各 5 次及桌面/移动 smoke。

详细证据继续保留在：

- `openspec/changes/2026-08-31-homepage-performance-implementation-plan.md`
- `openspec/changes/2026-08-31-homepage-lighthouse-evidence.md`
- `openspec/changes/2026-08-31-homepage-i18n-bundle-poc.md`

## 5. 规范沉淀

- 首页首屏资源必须通过真实双区域构建清点 preload，不能只凭源码属性判断。
- 性能数据比较必须使用同一基线、设备、Chrome、限速和冷缓存设置；本机 Lighthouse 波动较大时不宣称确定收益。
- 场景数据拆分必须同时守住全量有序 ID、首页子集顺序、locale 文案和 promptBuilder 行为。
- Turbopack 跨 client entry 的重复字典问题需要单独验证边界收窄或单 client root，不在低风险资源优化中顺手修改。

## 6. 回顾与改进

- 本次低风险图片与场景依赖优化已完成；LCP 元素仍是 Hero 装饰图，真实收益需要继续观察线上 RUM。
- i18n 重复打包只完成 Q0 诊断，后续如调整 layout/docs/search client boundary，必须另起方案并覆盖 hydration 与各 locale。
- 归档时本机无可用 `feai` CLI，因此未执行自动评分、用量审计和远端上报；`localUsageAudit` 记为 `null`，不伪造统计。
- 仓库现有 OpenSpec 仍包含旧式聚合历史段落。本次只做最小状态标记，避免误删无关需求；归档门禁为有条件通过，后续由独立维护任务迁移旧格式。

**归档门禁：** 有条件通过。功能任务与验证记录完整；自动 report pipeline 不可用，旧式聚合状态清理未在本需求内扩大处理。
