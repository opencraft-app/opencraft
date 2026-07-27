# 国内站续费用户交互优化：技术规格

## 1. 目的

补齐国内站续费链路，让用户能从 `/account` 和 `/agents` 两个真实场景进入同一个续费弹窗，并在 `/subscribe` 过期或隔离拦截时获得明确回流路径。实现必须复用现有 Pass 续费接口和微信支付中转页，不新增后端接口、不影响国际站。

## 2. 术语

- **可续费 Pass**：未删除且状态为 `active`、`expired` 或 `isolated` 的 Pass。
- **有效 Pass**：未删除且 `expired_time` 晚于当前时间的 Pass，对应 `activePass`。
- **到期提醒窗口**：有效 Pass 距离 `expired_time` 小于等于 7 日。
- **Agent 头部状态提醒**：`/agents` 左侧 Agent 信息头部中贴近“运行中”的套餐到期短提醒。
- **续费成功**：同一 `pass_id` 刷新后 `expired_time` 大于打开弹窗时的原始时间。

## 3. 架构与数据流

```text
/account 订阅卡片
        └── RenewPassModal

/agents Agent 信息头部
        └── 到期状态提醒
              └── RenewPassModal

RenewPassModal
        ├── getRenewPrice(passId, { period, time_unit: "month" })
        ├── createRenewOrder(passId, { period, time_unit: "month" })
        ├── /auth/wechat-pay?...&pid=<passId>
        └── listMyPasses() / refreshPasses() 校验 expired_time 推后
```

`RenewPassModal` 不直接持有页面级订阅状态。调用方负责传入当前 Pass、套餐列表、刷新函数和成功后的 UI 收束动作。

## 4. 续费弹窗

### Requirement RENEW-MODAL-1：可复用组件

续费弹窗必须从账号页局部实现中抽取为可复用组件，供 `/account` 与 `/agents` 两个入口共同使用。组件应接收：

```ts
type RenewPassModalProps = {
  pass: Pass;
  plans: BundlePlan[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRefreshPasses: () => Promise<Pass[] | void>;
  onSuccess?: (pass: Pass) => void;
};
```

实际类型命名可按仓库现有类型调整，但必须保持调用方可控制打开、关闭和刷新。

#### Scenario：账号页打开

- Given 用户在 `/account` 持有可续费 Pass
- When 点击“立即续费”
- Then 打开 `RenewPassModal`
- And 弹窗关闭后焦点回到“立即续费”

#### Scenario：Agent 页打开

- Given 用户在 `/agents` hover 到期提醒
- When 点击提醒
- Then 打开同一个 `RenewPassModal`
- And 弹窗关闭后焦点回到到期状态提醒

### Requirement RENEW-MODAL-2：周期与信息结构

弹窗确认阶段必须展示当前套餐、套餐状态、当前到期时间、续费时长、预计续费后到期时间和应付金额。

- 状态映射：
  - `active`：`生效中`
  - `expired`：`已过期`
  - `isolated`：`隔离期`
- 周期选项：
  - 月付：`period=1`，`time_unit="month"`
  - 季付：`period=3`，`time_unit="month"`
- 默认选中月付。
- 不展示 6 个月或 12 个月选项。
- 预计到期时间按当前 Pass 到期时间顺延；若当前时间晚于到期时间，以后端成功刷新后的 `expired_time` 为最终真源。

### Requirement RENEW-MODAL-3：询价与下单状态

- 打开弹窗后立即对默认月付询价。
- 切换周期后重新询价，并忽略旧请求的晚返回结果。
- 询价中展示 `正在查询价格...`，确认按钮暂不可点击。
- 询价成功展示应付金额。
- 询价失败展示轻量错误，确认按钮可点击，文案说明最终金额以支付页为准。
- 点击确认后进入 `正在创建订单...`，禁止重复点击。
- 下单失败保留已选周期并允许重试。

### Requirement RENEW-MODAL-4：微信支付与刷新校验

支付阶段必须展示套餐、续费周期、应付金额、二维码和“刷新”按钮。

- 文案仅保留：`支付完成后页面会自动刷新。`
- 不展示：`二维码有效期约 9 分钟。`
- 不展示：`我已完成支付`。
- “刷新”按钮立即触发一次 Pass 刷新校验。
- 自动轮询可以保留，但成功判定必须以同一 `pass_id` 的 `expired_time` 推后为准。
- 未确认支付结果时展示 `暂未确认支付结果，请点击刷新或稍后再查看套餐状态。`
- 弹窗关闭不取消订单，只结束当前页面的等待。

## 5. `/account` 续费入口

### Requirement ACCOUNT-RENEW-1：恢复入口

国内站 `/account` 中，`paidBillingActive` 为真且存在可续费 Pass 时展示“立即续费”。

| Pass 状态 | 展示 |
| --- | --- |
| `active` | 展示“立即续费” |
| `expired` | 展示“立即续费”和过期提示 |
| `isolated` | 展示“立即续费”和“销毁套餐”，续费为主操作 |
| `deleted` | 不展示续费入口 |

国际站不得展示国内续费入口或中文续费提示。

### Requirement ACCOUNT-RENEW-2：成功刷新

账号页发起续费成功后必须刷新账号页 Pass 数据和订阅卡片有效期。刷新未确认成功时不得展示成功。

## 6. `/agents` Agent 头部到期提醒

### Requirement AGENTS-RENEW-1：展示条件

`/agents` 到期提醒必须同时满足：

- 国内站。
- 用户已登录。
- 当前页面存在至少 1 个非 `provisioning`、非 `deleting` 的 Agent。
- `activePass` 存在。
- 当前时间距离 `activePass.expired_time` 小于等于 7 日且大于 0。

无 Agent、无有效 Pass、Pass 已过期或隔离、国际站都不展示此提醒。

### Requirement AGENTS-RENEW-2：位置与视觉

提醒放在 Agent 信息头部，贴近“运行中”状态，不放在主内容区顶部。更多菜单位置保持不变。

桌面参考结构：

```text
┌────────────────────────────────────┐
│ [头像] 我的Hermes              [⋮] │
│        ● 运行中  ·  套餐将到期      │
└────────────────────────────────────┘
```

移动端参考结构：

```text
[头像] 我的Hermes          [⋮]
       ● 运行中
       套餐将到期
```

颜色规则：

- 剩余 2-7 天：琥珀色状态点或浅色 chip。
- 剩余小于 2 天：红色或橙红色状态点或 chip。
- 正常大于 7 天：不展示套餐到期提醒。

### Requirement AGENTS-RENEW-3：hover 与点击

- 默认短文案：`套餐将到期`。
- hover 大于等于 1 天：`套餐剩余 {{days}} 天到期，点击续费。`
- hover 小于 1 天：`套餐剩余 {{hours}} 小时到期，点击续费。`
- hover 不足 1 小时：`套餐不足 1 小时到期，点击续费。`
- 点击提醒直接打开 `RenewPassModal`，不跳转 `/account`。
- 移动端没有 hover 时短文案常显，点击短文案打开弹窗。
- 提醒不提供关闭按钮，不阻断 Agent 管理操作。

### Requirement AGENTS-RENEW-4：成功刷新

从 `/agents` 发起续费成功后，必须刷新 `useOpenClaw()` 中的 Pass 状态。若有效期已延长，到期提醒消失或恢复为普通运行状态。

## 7. `/subscribe` 续费回流

### Requirement SUBSCRIBE-RENEW-1：错误引导

当 `/subscribe` 创建 Pass 返回 `PASS_EXPIRED` 或 `PASS_ISOLATED` 时，页面必须展示明确引导：

- 标题：`当前套餐需要续费`
- 描述：`你的套餐已过期或进入隔离期，请前往我的账号续费当前套餐。`
- 操作：`前往续费`

点击操作跳转 `/account`。订阅页不自动打开续费弹窗，不自动选择新购套餐，不允许绕过续费规则直接新购。

## 8. 兼容性、区域化与隐私

- 续费接口仍使用现有 `getRenewPrice`、`createRenewOrder`、`getRenewOrderUrl`。
- 微信中转页继续通过 `pid` 或 `passId` 判断续费场景。
- 国内站差异必须通过 `isCN` / `isGlobal` 编译期常量控制。
- 不新增敏感数据存储，不把订单号、支付 URL、Pass 明细写入普通日志或埋点。
- 工具能力、SkillHub、MCP、自动任务相关入口不得在本次改动中出现。

## 9. 测试要求

### 单元测试

- 续费周期映射：月付到 `{ period: 1, time_unit: "month" }`，季付到 `{ period: 3, time_unit: "month" }`。
- 预计到期时间计算。
- 到期提醒剩余天数、小时、不足 1 小时文案。
- 到期提醒颜色状态：2-7 天与小于 2 天不同。
- 可续费 Pass 判断不包含 deleted。

### 组件测试

- `/account` active、expired、isolated 展示“立即续费”；deleted 不展示。
- `RenewPassModal` 默认月付、可切季付、不展示 6/12 个月。
- 支付阶段展示“刷新”，不展示“我已完成支付”和“二维码有效期约 9 分钟”。
- `/agents` 有 Agent 且 7 日内展示头部提醒，hover 有 tooltip，点击打开弹窗。
- `/agents` 无 Agent、无有效 Pass、国际站不展示提醒。
- `/subscribe` 对 `PASS_EXPIRED` / `PASS_ISOLATED` 展示可点击续费引导。

### 项目门禁

- 目标 Vitest 测试通过。
- `pnpm i18n:extract` 生成新增文案。
- `pnpm i18n:check` 通过。
- `pnpm check` 通过。
- `git diff --check` 通过。
- 国内站本地页面完成 `/account`、`/agents`、`/subscribe` 关键路径 smoke。
