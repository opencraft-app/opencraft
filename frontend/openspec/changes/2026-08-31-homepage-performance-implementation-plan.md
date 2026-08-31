# 首页加载性能优化 Implementation Plan

**Status:** 已批准，进入实现。

**Size:** M。改动集中在首页图片加载与场景数据依赖边界；i18n 仅做构建产物 PoC，不直接改变运行时加载协议。

**Goal:** 在不改变国内站和国际站首页内容、语言行为与视觉布局的前提下，减少首屏非必要图片 preload，并切断首页对完整场景任务库的依赖；为 i18n 重复打包形成可复现证据和下一步方案。

## Global Constraints

- 国内站和国际站必须使用同一基线 commit、同一构建机和同一测量配置比较。
- Hero 四张图片和站点 logo 保持 eager/preload；折叠下方 40 个唯一图片资源使用 lazy loading（BrandIcons 1、Feature 跑马灯 18、Cards 12、Process 7、CTA 2）。
- 图片尺寸只使用真实 intrinsic size，或复用已经锁定布局尺寸的容器；不得填写猜测值。
- 首页场景 pack 只能保留一份事实来源，新增 overview 模块不得反向 import `scenario-packs.ts`。
- 场景拆分不得改变全量有序 ID、首页 6 个 ID/顺序、locale 文案或 `promptBuilder` 行为。
- i18n 本批只回答重复字典为何进入两个约 1006 KiB 首页脚本，以及能否先去重；不得直接移除 locale 或改变 hydration 时序。
- 不修改 `fake-repositories`、字体 subset、Hero `fetchPriority` 或废弃图片。
- 先 RED、后最小实现、再 GREEN；完成前运行相关定向测试、`pnpm check`、双区域真实构建与差异检查。
- 未经用户单独确认，不执行 commit、push 或 MR。

## Task 1：折叠下方图片 lazy

**Files:**

- Modify: `src/imports/Frame2147230025/sections/BrandIconsSection.tsx`
- Modify: `src/imports/Frame2147230025/sections/FeatureSection.tsx`
- Modify: `src/imports/Frame2147230025/sections/ProcessSection.tsx`
- Modify: `src/imports/Frame2147230025/sections/CtaSection.tsx`
- Test: `src/imports/Frame2147230025/sections/__tests__/homepage-image-loading.test.tsx`
- Evidence: `openspec/changes/2026-08-31-homepage-lighthouse-evidence.md`

- [x] 写失败测试锁定 BrandIcons 1、Feature 跑马灯 18、Cards 12、Process 7、CTA 2 个唯一折叠下方资源均为 lazy，并确认 Hero 保持非 lazy。
- [x] 保存当前 commit 的 CN/global 构建与图片 preload baseline。
- [x] 最小修改图片属性；只在有真实尺寸证据时补 width/height 或等价比例约束。
- [x] 运行定向测试、`pnpm check`、CN/global 构建并确认唯一图片 preload：CN 从 45 降为 5（logo + 4 张 Hero），global 从 46 降为 6（再含国际站 Footer wordmark）。
- [x] 在同环境冷缓存运行 Lighthouse，各 5 次取中位数，并完成桌面/移动端视觉 smoke。

**Task 1 Result:** RED 为 5 个 lazy 分组预期失败，GREEN 后新测试 6/6、相关首页测试 14/14 通过，`pnpm check` 通过。真实构建达到 CN 45→5、global 46→6。Lighthouse mobile simulated 中位数：global LCP 19,207→18,160 ms、CN LCP 19,207→18,158 ms；两站 FCP 约 4,655 ms、performance 63、CLS 基本不变，TBT 波动较小。该 LCP 档位变化只作为本机观测；baseline 组内极差约 1,502 ms、每组仅 5 次采样，因此本批不主张 LCP 收益。LCP 元素仍是 Hero 装饰图，不在本批顺手修改 Hero priority，实际收益待线上 RUM 验证。global settled 桌面/移动端截图与 baseline 逐字节一致，CN 桌面/移动端 smoke 正常。20 份原始报告的逐次指标、文件路径与 SHA-256 见 `openspec/changes/2026-08-31-homepage-lighthouse-evidence.md`。

## Task 2：首页场景 pack 依赖拆分

**Files:**

- Create: `src/pages/marketing/scenario-tasks/scenario-pack-core.ts`
- Create: `src/pages/marketing/scenario-tasks/overview-packs.ts`
- Modify: `src/pages/marketing/scenario-tasks/scenario-packs.ts`
- Modify: `src/pages/marketing/landing-page.tsx`
- Modify: `src/pages/marketing/scenario-tasks/__tests__/overview-scenario-localization.test.ts`
- Modify: `src/pages/marketing/scenario-tasks/__tests__/scenario-task-builder.test.ts`

- [x] 先写失败测试锁定新 overview 入口、全量有序 ID/无重复、首页 6 个 ID/顺序、各公开 locale 与 `promptBuilder` 行为。
- [x] 抽取两边共用的最小 core，以及 6 个 overview pack、语言文案和 getter；保持单向依赖。
- [x] 原 `scenario-packs.ts` 聚合并按需 re-export，避免无关调用方迁移。
- [x] 运行现有 scenario 定向测试、`pnpm check` 和双区域构建，确认首页 chunk 不再引用完整 `scenario-packs` / `FOCUSED_SCENARIO_PACKS`。

**Task 2 Result:** 新入口测试先因 `overview-packs.ts` 不存在而 RED；抽取后场景目录 9 个测试文件 / 66 个断言 GREEN，`pnpm check` 为 0 new diagnostics。全量 22 个 pack 的有序 ID 与唯一性、首页 6 个顺序、多语言文案和 prompt 行为保持不变。真实首页产物不再包含 `hydration-standup-reminder` / `srs-study-checkin` / `todo-focus-brief` 等非 overview pack 定义；`scenario-pack-core.ts` 仍保留通用 `makePack` 为实体提取任务识别 `cbt-counseling` 的兼容分支，但不包含 CBT pack 本身的标题、任务或提示词定义。场景 core chunk 从 baseline CN 123,173 B / gzip 38,701 B 降至 72,955 B / gzip 23,048 B，减少 50,218 B raw / 15,653 B gzip。

## Task 3：i18n 重复打包 Q0 PoC

**Files:**

- Create: `openspec/changes/2026-08-31-homepage-i18n-bundle-poc.md`
- Optional test/build script only if existing构建产物不足以稳定复现；不得改变运行时 i18n 行为。

- [x] 从 CN/global 构建产物记录首页 script/chunk、模块 ID、client boundary 与重复字典证据。
- [x] 判断重复来自两个入口、client boundary 还是 chunk 分组，并验证共享 chunk/收窄边界是否能移除一份重复字典。
- [x] 记录可复现命令、before/after 体积、风险和下一步建议；若必须改运行时初始化或 locale 注册表，另起实施计划。

**Task 3 Result:** 两份国际站首页字典 chunk 均为 1,030,557 B（gzip 396,513 / 396,470 B），都包含 2,680 个 key 和相同 8 个 JSON module ID。根因是 `(site)/layout.next` 与 `next-site/public-pages.tsx` 两个 client entry 都真实依赖 `useT()`，Turbopack 跨 entry 重复发射静态字典。没有发现不改变 client boundary 或运行时加载协议的配置级安全去重；Q1 需单独验证 layout/docs/search 边界收窄或单 client root。详见 `openspec/changes/2026-08-31-homepage-i18n-bundle-poc.md`。

## Verification

- `pnpm exec vitest run` 覆盖图片与 scenario 定向测试。
- `pnpm i18n:check`、`pnpm i18n:zh-hant:check`、`pnpm check`。
- `pnpm build:cn`、`pnpm build:global`。
- `git diff --check`。
- Lighthouse 同设备、同 Chrome、同限速、冷缓存各 5 次，比较中位数 LCP/FCP/TBT/CLS。
