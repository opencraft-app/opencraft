# 2026-07-28 国际站定价入口展示与未登录卡片错位修复

## 需求概要

国际站（global site）此前隐藏了「Pricing / 定价」导航入口，订阅页内测公告的「查看详情」链接在国内外站点指向同一路径，且未登录态订阅页存在卡片布局错位与「7 天免费试用」误导文案。本次统一国际站定价入口展示、按站点区分内测公告链接、修复未登录卡片错位。

## 任务完成情况

- [x] 国际站显示 Pricing 入口（`src/lib/public-site-navigation.ts` 去 `cnOnly: true`）
- [x] 新增 global 站 pricing 用例（`src/lib/__tests__/public-site-navigation.test.ts`）
- [x] view details 链接按站点区分（国际站 `lightvela.ai/docs/overview/` + `_blank noopener`；国内站原 `/docs/announcements/public-beta/`）
- [x] 未登录免费卡 `bundle_name` 由「免费试用 7天」改为「启航 Launch」，命中 `tierOfPlan="launch"` 消除与 Cruise/Voyage 的卡片错位
- [x] 「限时免费标签去除」「CTA 改立即订阅」两处改动经评估后回退（净效果不保留）

完成 5/5，跳过 0。

## 关键决策

1. **卡片错位根因定位**：`tierOfPlan` 按 `bundle_name` 判 tier，未命中关键字（`启航/巡游/远航/launch/cruise/voyage`）返回 `null` 落入 `uncategorized`，导致免费卡脱离 tier 网格错位。修复方式是改 `bundle_name` 而非加白名单/特殊分支，复用现有 tier 机制，改动最小。

2. **`bundle_id` 保留 `bundle_free_7d`**：`bundle_free` 前缀使 `isFreeTrialBundle=true`，维持「`paidBillingActive=false` 展示并走 `CreateTrialPass` 免费链路 / `=true` 被过滤换成真实付费 `bundle_launch_01`」的互斥门控。只改展示名，不动计费门控。

3. **「限时免费」「立即订阅」回退决策**：国际站线上计费闭环状态与 runtime-config `paidBillingActive` 开关可能不同步，贸然去标签/改 CTA 会导致前置口径与账号页/后端口径错位裂缝（参见 user/auth `projectUserForAssuranceMode` 投影机制）。用户评估后选择回退这两处，仅保留低风险的 `bundle_name` 重命名。

## 实施摘要

**影响文件**（3 个，+20/-5）：
- `next-site/subscribe-page.tsx`
  - `buildStaticBundles`：免费卡 `bundle_name: "免费试用 7天"` → `"启航 Launch"`，`description: [{Key:"独立环境",Value:""}]` → `STATIC_GENERAL_DESC`
  - view details `<a href>`：三元按 `isGlobal` 切换，国际站加 `target="_blank" rel="noopener noreferrer"`
- `src/lib/public-site-navigation.ts`：pricing 项删除 `cnOnly: true` 属性
- `src/lib/__tests__/public-site-navigation.test.ts`：新增用例断言 global 站 pricing 存在、`href=/subscribe`、`cnOnly` 为假、英文文案 `Pricing`

**验证**（见 `.workflow/runtime/verification-ledger.md`）：
- `vitest run public-site-navigation.test.ts`：3/3 passed
- `tsc --noEmit`：0 errors
- lint / e2e：项目未配置（`review-inspect` 确认 `lint: null`、`e2e: null`）

**提交**：3 个 commit（`435867730` → `215938546` → `a083cde07` 回退），已 push，MR !2584（`can_be_merged`）。

## 规范沉淀

- `tierOfPlan` 按 `bundle_name` 关键字判 tier 的设计：新增套餐卡必须让 `bundle_name` 含 `启航/巡游/远航` 或 `launch/cruise/voyage`，否则会脱离 tier 网格单独展示导致布局错位。静态/占位套餐同样适用。
- 国际站与国内站共用 `mapBundleToPlan`，但走不同计费分支（`paid = paidBillingEnabled && !isGlobal`）。国际站改免费/计费语义时，需同时核对 `promoTag`、`ctaLabel` 两个 if/else 分支，避免单边改动导致口径裂缝。
- 三套实名判定口径（订阅页前置 runtime-config 开关 / 账号页 `realnameAssuranceMode` / 后端 `projectUserForAssuranceMode` 投影）来源独立、不联动；绝大多数用户结论一致，个别中间态用户落进口径裂缝。涉及实名态改动需三处同步评估。

## 回顾与改进

- **做得好**：卡片错位根因精确定位到 `tierOfPlan` 关键字匹配机制，用最小改动（改 `bundle_name`）解决而非加补丁分支；`bundle_id` 门控保留避免误动计费链路。
- **可改进**：最初一并改了「限时免费标签去除」与「CTA 改立即订阅」，未充分评估国际站计费闭环与 `paidBillingActive` 开关的同步态就推进，导致后续回退。后续涉及国际站计费语义改动，应先核对 runtime-config 真实开关值与线上 assurance mode 是否一致再动 CTA/标签。
- **后续**：MR !2584 评审通过合并后，国际站「限时免费」文案是否要彻底下线，需待海外计费闭环确认 `paidBillingActive` 稳定为 `true` 后另行处理。
