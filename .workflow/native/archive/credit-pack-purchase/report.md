# 验证报告 — 积分包购买前端 UI

**change**: credit-pack-purchase
**分支**: `feat/credit-pack-purchase-ui`
**日期**: 2026-09-10

---

## 1. 实际执行的验证命令与结果

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npm run i18n:check` | **exit 0**（新增 18 条 × 6 语种全部补齐） |
| `npm run i18n:zh-hant:check` | **exit 0**（2823 条与 zh-CN 转换一致） |
| `npm run i18n:validate` | **exit 0**（错误 0，告警 51 全为既有基线） |
| `npx vitest run`（23 文件，含全部新增与相关既有套件） | **168 total / 167 passed / 0 failed**（1 既有 skip） |

测试覆盖文件清单：`subscribe-page` / `credit-pack-section` / `use-credit-sources` / `credit-pack` /
`account-page-faceid` / `account-page-name-audit` / `account-page-payment-visibility` /
`account-page-renewal.global` / `http-repositories` / `fake-repositories`。

### 新增测试
- `src/domain/__tests__/credit-pack.test.ts`：16 项（汇总/排序/key 生成/product_id 锁定）
- `next-site/__tests__/credit-pack-section.test.tsx`：9 项（卡片渲染/五态按钮/单卡降级/不下单）
- `src/lib/__tests__/use-credit-sources.test.ts`：10 项（多源合并/排序/失败降级/缺 credit 容错）

### 既有失败（与本次改动无关，已在 master 复现）
- `next-site/__tests__/plan-pricing-consistency.test.ts` — AI 版首购价断言
- `next-site/__tests__/search-routing.test.ts` — docs locale 识别

已切到 master 单独运行，同样 2 failed，确认为既有问题，非本次引入。

---

## 2. 交付内容

### 新增
| 文件 | 说明 |
|---|---|
| `src/lib/credit-pack-visibility.ts` | feature flag，复用 `*-visibility.ts` 范式，默认关闭 |
| `src/domain/credit-pack.ts` | 领域模型、面额常量表、汇总与排序纯函数 |
| `src/lib/use-credit-sources.ts` | 合并 pass + credit 两套数据源 |
| `next-site/credit-pack-section.tsx` | `/subscribe` 积分包区域 |

### 修改
| 文件 | 说明 |
|---|---|
| `next-site/subscribe-page.tsx` | 挂载区域、flag 判定、`?section=credits` 定位、套餐区锚点 |
| `src/pages/marketing/account-page.tsx` | 积分改多来源汇总、额度明细、购买入口 |
| `src/repositories/{types,http-repositories,fake-repositories}.ts` | `CreditRepository`（products/inquiry/packages） |
| `src/i18n/generated/*.json` | 18 条新文案 × 7 语种 + zh-to-key |

---

## 3. 过程中发现并修复的真实缺陷

**① product_id 全部写错（会导致询价 100% 失败）**
原按命名习惯写 `credit-pack-1000`，后端 seed 真值为 `credit_1000`（下划线）。
真源：`scripts/seed_credit_beijing_sandbox_products.sql`（在仓库根，不在 `credit/scripts/`）。
已修正并新增测试锁定这 5 个 id。

**② CreditPackSection 无限渲染循环**
`useEffect` 依赖 `loadQuote`，而 `loadQuote` 依赖 `repositories` 对象引用；引用一变即
effect 重跑 → `setQuotes` → 重渲染 → 再变。生产环境因 `useContext` 引用稳定而不触发，
属隐式假设。改为 `useRef` 持有、effect 依赖收敛为空；mock 同步改为稳定引用避免掩盖问题。
**发现方式**：测试卡死。注意 `tsc` 当时 exit 0，类型检查无法发现此类问题。

**③ 账号页 55 个既有测试崩溃**
`useCreditSources` 直接访问 `repositories.credit`，而既有测试的 mock 只有 auth/plans/bots，
导致 `Cannot read properties of undefined`。已加容错：缺 `credit` 仓储时静默退化为仅套餐积分，
并新增测试锁定该行为。

**④ 繁体用词不符仓库规则**
手写了台湾惯用词（登入/使用者/載入），`i18n:zh-hant:check` 拦下 4 条。
改用 `npm run i18n:zh-hant` 由工具按统一规则生成。

**⑤ 中英混排文案**
`One-time charge，不会自动续费。` 改为 `单次付费，不会自动续费。`，英文由 i18n 词条提供。

---

## 4. 遗留事项与上线前置条件

### ⚠️ flag 开启前必须完成（否则用户可见缺陷）

1. **后端补齐支付链路**：`trade/internal/logic/creditorder/service.go:178,229` 的 `payURL` 恒为空，
   拿不到微信二维码 / 信用卡托管页。当前点击购买仅提示「支付通道正在接入中」，**不调用下单接口**。
2. **修复 `/subscribe` 裸路由语言 bug**：`next-site/subscribe-page-client.tsx:12` 默认
   `locale = DEFAULT_PUBLIC_ROUTE_LOCALE.locale`（国际站 `en-US`），经 `LocaleOverrideProvider`
   硬覆盖。账号页「购买积分包」跳的正是裸 `/subscribe`，**国际站中文用户会看到整块英文**。
   本期按用户决定未修；flag 默认关闭使其暂不暴露，但开启前必须修。
3. **核对目标环境 product_id**：`CREDIT_PACK_DENOMINATIONS` 对齐的是 beijing-sandbox seed。
   上海生产等环境需独立确认，不一致会导致询价全部失败。

### 后端补齐后需替换的临时实现

4. **积分数量硬编码**：`products` 接口无 `credit_total`（`credit/AGENTS.md:22` 禁止入表），
   前端用常量表兜底。后端在接口层按 LLM Gateway plan 派生后应删除该表。
5. **积分包 key 用组合值**：查询不返回 `package_id`（`credit/AGENTS.md:79`），
   现用 `${credit_type}-${credit_total}-${expired_time}`。
   **同额度且到期时间相同的两个包会冲突**——`credit-pack.test.ts` 中有一条断言故意固化了这个
   冲突行为，后端补 `package_id` 后该测试会失败，以此强制提醒改造。
6. **排序缺二级优先级**：产品要求「同时间按购买时间先后」，但查询无购买时间，
   本期仅按到期时间排序，同时间保持接口返回顺序。

### 本期未实现（brief 已明确排除）
下单与支付、到账确认与 `delivered` 判定、逐包购买时间展示、退款服务端落闸、
购买资格服务端校验、3 个月包、数量选择器、埋点。

---

## 5. 未覆盖的验证

- **未做真实环境联调**：询价接口连通性、双站币种（CNY/USD）、真实商品数据均需在
  北京测试环境用真实账号验证。本地测试使用 fake 仓储与 mock。
- **未做浏览器手工验证**：响应式布局、键盘操作与焦点、屏幕阅读器可访问名仅按规范实现，
  未实机验证。
- **未跑完整 `vitest run`（全部 431 文件）**：本地执行受终端超时限制，改为精准运行
  23 个相关文件。建议 CI 上跑全量确认。
