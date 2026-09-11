# 首页转化入口按订阅态分流 Design

**Status:** 实现与验证完成，PRD 已同步；等待 CR 与合并。

**Size:** M。覆盖双站首页 Hero CTA 判定、订阅上下文就绪标志、订阅页登录续跑、页脚社区栏条目，以及 9 个 locale 静态产物的文案与资产同步。

## 背景

首页 Hero 主按钮此前以「是否登录」作为分流依据：未登录进入 `/subscribe`，登录即进入 `/agents`。

但 `/agents` 的准入控制只拦未登录、不拦未订阅（`NextMarketingAuthGate` 仅判断 `isAuthenticated`），且这是有意设计——未订阅用户看到的是空控制台。因此「已登录但未订阅」的用户从首页点击主按钮后，会被直接送进一个没有内容的页面，而不是回到购买路径。

产品侧据此给出四态判定表，要求把「是否已订阅」作为分流依据，并明确各状态下的落地页行为。

同期还需处理：Hero 轮播词与产品定位脱节、国内平台图标缺少品牌辨识度、页脚 YouTube 入口下线、用户之声补充印尼地区案例。

## 目标

- Hero CTA 按四态分流，未订阅用户（含订阅过期）保留在转化入口。
- 订阅态未查回前不改写产物默认文案，避免已订阅用户出现文案跳变。
- 未登录用户在订阅页选定套餐并登录后，自动续跑该套餐流程。
- 双站 9 个 locale 的文案与行为一致，多语言无遗漏。
- 不改动支付链路与 `/agents` 内部实现。

## 非目标

- 不修改支付成功后的跳转。经核查已为 `/agents?creating=<botId>`，四条支付路径（国内扫码轮询、国际卡支付、零元单、免费试用）均收口于 `finalizeBot`，符合预期。
- 不为 `/agents` 新增订阅准入拦截。空控制台为有意呈现，已与用户确认。
- 不改动移动端头部结构。
- 不处理 OAuth 整页跳转后的套餐续跑（内存态丢失，需独立评估）。
- 不删除 `seo.tsx` 中 Organization `sameAs` 的 YouTube 主页。

## 方案选择

### Hero CTA 分流依据

判定条件由 `isAuthenticated` 改为 `isAuthenticated && isSubscribed`。

四态表中第 3、4 行（已订阅·未建 Agent / 已订阅·已有 Agent）的文案与跳转目标完全一致，因此不读取 Agent 列表——引入 `bots` 依赖不会改变任何分支结果，只会增加一次数据依赖。空态由 `/agents` 落地页自行处理。

文案与链接全部由静态产物的 `data-*` 提供，运行时不硬编码。经核查 9 个 fragment 的 `signed/anon` 四个属性早已齐备且多语言正确，故本次分流改造的静态产物为零改动，国际站 7 个 locale 自动跟随。

### 订阅态就绪标志

`isSubscribed` 初值为 `false`，依赖异步 `GET /v1/passes` 回填。未就绪时无法区分「确实未订阅」与「尚未查回」，直接使用会让已订阅用户先渲染一帧「免费试用」再跳变为「我的智能体伙伴」。

因此在 `OpenClawContext` 新增 `subscriptionReady`，在四处置位：session 订阅快照同步、`refreshPasses` 完成（`finally`，成功与失败均置位）、未登录且 `authReady`、登出与 `subscribe()`。

接口失败同样置为就绪，使依赖方降级到转化入口，而不是停留在加载态。

### 订阅页登录续跑

复用邀请码守卫既有的 `pendingPlan` 范式，未新增机制：点击套餐时记录 `pendingPlan` 再拉起登录弹窗，`onSuccess` 时取出并续跑。

`LoginModal` 的 `onSuccess` 在 effect 内触发且依赖数组包含回调本身，存在重复调用可能。取出待办套餐后立即 `setPendingPlan(null)`，第二次进入时 `plan` 为 `null` 直接返回，幂等天然成立，无需额外标志位。

续跑前重新校验权益与售罄状态，避免以登录前的旧口径下单；关闭弹窗时清空待办，避免下次登录被旧选择带跑。

### YouTube 入口下线

删除 8 个 fragment 页脚、`lightvela-footer.tsx`，以及生成脚本中的**两处**引用（内联 HTML 模板 + 外链映射表）——只删其一会在下次运行 importer 时回流。

保留 `seo.tsx` 的 `sameAs`：该字段不参与页面渲染，仅供搜索引擎与 AI 引擎建立品牌实体信任链，删除会削弱官方频道的实体归属判定。

## 实现要点

| 文件 | 改动 |
| --- | --- |
| `next-site/international-home-runtime.tsx` | 分流条件改为 `isAuthenticated && isSubscribed`；新增 `subscriptionReady` 门控 |
| `src/contexts/agent-context.tsx` | 新增 `subscriptionReady` 状态与四处置位 |
| `next-site/subscribe-page.tsx` | 新增 `handleLoginSuccess` / `handleCloseLoginModal`，未登录分支记录 `pendingPlan` |
| `next-site/public-header-auth-island.tsx` | 登录成功跳转由无条件 `/agents` 改为按订阅与 Agent 状态分流 |
| `src/components/site/lightvela-footer.tsx` | 移除 YouTube 条目 |
| `scripts/import-international-homepage.mjs` | 移除内联模板与外链映射表中的 YouTube |
| `public/lightvela-intl-home/index-fragment.*.html` | 轮播词、Hero 文案、用户之声、平台图标、页脚条目同步（9 个 locale） |

## 验证

- `international-home-rendering.test.tsx`：22 passed（新增 3 个——已登录未订阅停留转化入口、订阅态未就绪不改写、国际站未订阅停留本地化订阅页）
- `subscribe-page.test.tsx`：10 passed（新增 1 个登录续跑源码契约）
- `lightvela-footer.test.tsx` / `international-home-page.test.tsx`：YouTube 改为反向断言，社区栏条目数 21 → 20
- 关联套件串行复跑：7 files / 81 tests、4 files / 77 tests 全绿
- `pnpm i18n:check` 通过；类型检查 175 current / 276 baseline，0 new、101 resolved；`git diff --check` 通过
- 双站 8 个入口线上校验 `data-*` 完整，资源版本 `20260911-hero-cta-subscription-v31`

并发混跑时 `subscribe-page.test.tsx` 曾出现 2 个 `Test timed out in 5000ms`。经 stash 回退做基线对比：单跑带改动 9/9 通过、串行 81/81 通过，确认为并发资源竞争，与本次改动无关。

## 遗留

- OAuth 整页跳转登录后无法续跑套餐（`pendingPlan` 为内存态）。
- 支付轮询在 180s 超时后仅切文案、不停止轮询，为既有设计。
- `finalizeBot` 中 `addBot` 失败（`pass isolated` / `pass expired`）时已支付但不跳转，无自动补偿，需与后端确认。
- 状态 2/3/4 与登录续跑需真实账号实测，线上仅可验证未登录态。
