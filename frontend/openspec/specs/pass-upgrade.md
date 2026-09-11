# 升级套餐交互

最后核对：2026-09-12。范围：国内站与国际站的 `/subscribe`、`/account`、`/agents`；当前分支为 `frontsandbox/upgrade-interaction-clean`，MR3941 基础上补充异常恢复及防护测试，保留默认展示调整。本规格描述工作树实现，不表示已上线。

## 1. 升级入口与合法目标

- 国内站、国际站均不依赖控制台 `show()` / `hide()` 或升级专用域名白名单。其他隐藏工具的 `show()` 行为不在本规格范围。
- `usePassUpgrade` 仅在业务启用且存在登录用户 ID 时查询；订阅页额外要求会话已认证，账户页继续受计费启用条件约束。
- 来源 Pass 必须属于当前用户、为 `active`、未删除 / 隔离且未到期；`modifying` 等不可操作状态不提供再次升级入口。
- URL `upgrade_pass_id` 指定来源 Pass。未指定时仅自动选择唯一有效 Pass，不任意选择多个有效 Pass 中的一个。
- 合法目标来自 `listModifyBundles(pass_id)`；响应的来源 bundle ID 必须匹配当前来源套餐，目标 ID 非空、不同于来源且与目标 bundle ID 一致。不按套餐名称、售价排序或 SP 命名推断升级关系。
- `/subscribe` 内合法目标套餐卡片的操作文案为“升级至此套餐”；`/account` 在存在合法目标时显示“升级套餐”，链接携带 `upgrade_pass_id`。
- 资格失败支持重试；账户、来源套餐状态变化或到期使旧资格失效。前端展示判断不替代后端所有权、实例状态、实名与支付校验。
- 预览 / 非生产域名也沿用以上业务资格，不恢复域名白名单。是否允许真实扣款由服务端环境与支付渠道配置决定；本轮未核验各预览环境渠道，不把入口可见当成允许扣款的证据。

## 2. 点击卡片按钮询价

1. 点击“升级至此套餐”后，在该按钮内显示加载图标和“正在查询升级差价...”，禁用重复请求；此时不打开确认弹窗。
2. 再次调用 `listModifyBundles`，校验来源、目标、金额和币种。总差价、税额须有限且非负，税额不超过总差价；当前接受 `CNY` / `USD`。
3. 成功后将完整 `PassModifyOption` 作为 `initialOption` 传入 `UpgradePassModal`，首屏直接展示完整报价，不重复初次询价。
4. 失败在对应按钮旁显示错误并恢复重试。切换套餐档位、计费时长、身份、来源状态或离开页面后忽略迟到响应；旧请求不得清除新请求的 loading 或覆盖新报价。

兼容边界：弹窗未收到有效 `initialOption` 时仍保留内部询价 / 重试兜底。标准订阅入口必须先取得报价再打开弹窗。

## 3. 第一步：确认订单

- 标题“确认订单”，说明“订单详情”。只展示目标套餐名称、CPU / 内存 / 存储配置、目标模型积分、应补差价；税额大于 0 时补充“其中税费”。不展示来源套餐对比或额外步骤导航。
- 应补差价使用后端 `modify_price.real_total_cost`，按分换算金额；不得使用套餐完整订阅价格或自行计算差价。
- 国内支付方式为“微信支付”，国际为“卡支付”，其余信息结构一致。底部为“取消”和“支付 {金额}”。
- 与新购保持一致：弹窗外层圆角 16px，订单详情 / 支付方式 / 支付内容内框 12px，底部操作按钮 8px。桌面宽度 440px，窄屏受视口约束，内容过高时弹窗内滚动。
- 复用站内 Dialog 的焦点管理、可访问标题及关闭能力；外部点击不关闭。提交期间禁用取消并阻止关闭，避免丢失在途订单状态。

模型积分只从升级等待页移除，确认订单中的目标套餐模型积分继续展示。

## 4. 点击支付与创建订单

1. 点击支付后继续保留第一步及完整订单信息，loading 显示在支付按钮内，文案“正在处理...”；覆盖重新询价、创建订单和准备支付凭证三个阶段。
2. 下单前再次询价，复核目标、币种、总差价与税额。报价变化时更新金额并要求用户再次明确点击，不自动按新价下单。
3. 校验通过后调用 `createModifyOrder(pass_id, { target_bundle_id })`。防重包括组件在途标记、可用时的 Web Locks、按用户 / Pass 隔离的本地 `creating` 记录；后端仍拥有最终执行权。
4. 只有二维码或卡支付链接就绪后才进入第二步。国际站支付已无需扣款（`need_charge === 0`）时直接进入升级等待，仍由 Agents 校验交付结果。
5. 已创建订单的支付凭证获取失败或过期，刷新同一订单的凭证，不再创建新订单。创建结果未知时保留 `creating` 状态并提示避免重复付款；明确业务拒绝才清除该在途创建记录。
6. 重新打开正常确认流程不自动恢复历史 `ordered` 订单；仅保留未知 `creating` 的防重保护。不能将入口资格查询当作历史订单恢复。

## 5. 第二步：支付

| 项目 | 国内站 | 国际站 |
| --- | --- | --- |
| 标题 / 提示 | “请完成支付”及微信扫码说明 | “请完成支付”及在卡支付页面完成支付的说明 |
| 主要内容 | 灰底、12px 圆角容器内显示微信二维码 | 托管卡支付页面；原页保留卡支付状态及重新打开链接 |
| 打开方式 | 使用创建订单返回或刷新得到的授权生成二维码 | 点击支付手势中预开新窗口，链接就绪后跳转；弹窗被拦截时与新购一致，当前窗口跳转，并保留显式支付链接 |
| 刷新 / 重试 | “刷新”查询该订单状态，未支付时刷新授权；过期授权亦可自动刷新 | 使用同一订单获取支付链接，不重复下单 |
| 支付后导航 | `/agents` | `/agents?upgrade_return={dealName}`；支付服务 return URL 使用 `/agents/` 对应路径 |

- 支付页不重复展示目标套餐详情或金额；不增加独立成功步骤，也不在支付弹窗内等待实例升级交付。
- 每 3 秒查询订单，校验订单 ID 与 `order_type === modify`；手动刷新得到 `paid` / `success` 也直接进入 Agents 等待，无需依赖下一次查询。
- 同时确认远端和本地均 `cancelled` 时，弹窗可重置并重新询价；失败或尚未一致的终态显示关闭 / 失败提示，不自动再次扣款。

## 6. 国际支付回跳与刷新恢复

- 发起卡支付时，按当前用户与订单保存 Pass ID、目标 bundle ID、订单 ID 和创建时间，最长接受 24 小时内的记录。
- `return_url` 指向带 `upgrade_return` 的 Agents；`cancel_url` 仅包含当前 origin 与 pathname，不携带原页面可能存在的敏感查询或 hash。
- 支付原窗口确认支付后也携带同一标记进入 Agents，支持刷新与独立支付返回页恢复。
- 回跳标记仅是恢复提示，不证明已支付。必须匹配当前登录用户的本地记录及来源 Pass，随后查询真实订单；不认识、过期或属于其他用户的记录不能恢复为已支付升级。
- 本地记录内部订单 ID 也必须等于 URL 标记，即使存储 key 正确仍需校验；`beginPassUpgrade` 拒绝已切换账号的旧用户回调。两项均有直接回归用例和移除校验后的失败验证。
- 支付授权与支付 URL 只保留于内存，不写入本地存储。返回上下文和 URL 标记仅在对应升级完成交付并刷新 Bot 后清理。

## 7. Agents 升级等待页

- 支付确认后先调用 `beginPassUpgrade` 建立本地 `modifying` 等待，再跳转 Agents；不等待服务端旧 `active` Pass 变成 `modifying` 才显示 loading。
- 直接进入或刷新页面时，服务端 `modifying` Pass 也会恢复等待视图。升级期间隐藏具体 Bot 和操作内容，完成后再展示。
- 使用创建流程的咖啡插画，标题“正在为 Hermes Agent 升级套餐”，说明完成后自动展示 Agent；不显示虚构百分比或升级时长承诺。
- 信息卡只显示“目标套餐”和“到期时间”，不显示“当前套餐”或模型积分，保留到期时间不变的说明。
- 目标名称通过 `getModifyCheckout(pass_id)` 的 `target_bundle_id` 与无参数 `listBundles()` 目录匹配取得，不使用旧 Pass 的套餐名称冒充目标，也不为展示名称进行带时长询价。
- 目标元数据未齐或请求失败时显示“—”，每 3 秒重试，取得名称后停止；异常查询暂停、订单失败、切换用户 / Pass 或卸载时取消重试并忽略迟到响应。名称获取不影响支付与交付判定。
- 回跳上下文有效但尚未读到来源 Pass 时，显示“正在确认套餐升级状态”；不编造套餐信息卡或到期时间，不展示旧 Bot。
- 插画仅在可见且未开启减少动画时浮动，失败或暂停时停止；状态文案使用 `role=status` / `aria-live=polite`。
- 账户页同时展示套餐升级中 / 失败状态，升级中不开放续费或删除等原有操作。
- `activePass` 兼容性回退可保留已过期的 `modifying` Pass，并令 `isSubscribed` 为 true，用于继续展示升级与恢复状态；这不延长服务端有效期，也不授予可用权益。升级期间仍隐藏 Bot 操作，不重构全局订阅判断。

## 8. 交付完成与异常判定

有支付确认或国际返回上下文时，结束等待必须同时满足：

1. 对应升级订单类型为 `modify`，远端 `status === success`，本地 `local_status === provisioned`。
2. 同一 Pass 已为 `active`，且 bundle ID 等于此次目标 ID。
3. 成功取得新的 live Bot snapshot，并确认请求仍属于当前用户 / 代次，随后才展示具体 Bot。

只有服务端 `modifying`、没有支付上下文的刷新恢复路径，以同一 Pass 明确回到 `active` 并成功刷新 Bot 为结束条件；不能宣称该路径也验证了特定订单与目标 ID。

- 订单失败 / 取消时展示“套餐升级失败”及联系支持说明，保持 Bot 隐藏；不以旧 `active` Pass 掩盖失败。
- 缺少 Pass、查询失败或旧 `active` 响应不证明升级完成，保持最近等待状态。正常可读的 `modifying` 或已确认订单待交付每 3 秒查询，不设 60 秒升级完成期限。
- 套餐缺失、状态不可确认、查询失败或请求未完成持续 60 秒后，暂停自动查询并显示“暂时无法确认升级进度”，提示刷新状态或联系支持、避免重复付款。60 秒是前端异常恢复阈值，不是支付失败判据、交付 SLA 或 24 小时返回记录有效期。
- 恢复操作为“刷新状态”（在途显示“刷新中...”且禁用重复点击）和“联系支持”（沿用服务条款的 `lightvela@tencent.com` 邮箱）。仅查询原订单，不创建订单、不清除返回上下文；查询恢复后继续等待，完整交付后才展示 Bot。没有 Pass 时也可使用恢复操作。
- 暂停时使在途请求代次失效，卡住的旧请求不能阻止新一轮手动查询或覆盖结果；刷新失败后重新进入有界等待。退出登录 / 切换用户会取消异常计时并清除该用户的界面恢复状态。
- 同用户 / 代次的轮询复用在途查询；并发手动刷新合并为一次后续查询，其 Promise 等到后续查询完成才返回。不同账号 / 新升级代次互不阻塞，旧请求与排队请求不得改变新状态。
- 新旧 Bot 请求使用共同代次，旧请求不能覆盖交付后的新快照；退出登录 / 切换用户后清除该用户等待态。
- Repository 在嵌套 Bot 查询遇到 `PASS_MODIFYING` 时保留实例根 Bot 数据，其他鉴权错误继续抛出；数据层保留实例不代表升级等待页可提前展示 Bot。

## 9. 实现与回归锚点

升级接口由现有 `PlanRepository` 访问，不复用新购 `createPass`：

| 方法 | HTTP 路径 |
| --- | --- |
| `listModifyBundles` | `GET /v1/passes/{passId}/modify/bundles` |
| `getModifyCheckout` | `GET /v1/passes/{passId}/modify/checkout` |
| `createModifyOrder` | `POST /v1/passes/{passId}/modify/order` |
| `getModifyOrderUrl` | `POST /v1/passes/{passId}/modify/order-url` |
| `refreshModifyPaymentAuthorization` | `POST /v1/passes/{passId}/modify/payment-authorization` |
| `getOrderStatus` | `GET /v1/orders/{dealName}/status` |

以下路径相对 `frontend/`：

| 职责 | 实现 | 回归测试 |
| --- | --- | --- |
| 资格与默认展示 | `src/lib/use-pass-upgrade.ts` | `src/lib/__tests__/use-pass-upgrade.test.tsx` |
| 目标卡片与按钮询价 | `next-site/subscribe-page.tsx` | `next-site/__tests__/subscribe-page.test.tsx`、`subscribe-page.global.test.tsx` |
| 确认与双站支付 | `src/pages/marketing/upgrade-pass-modal.tsx` | `src/pages/marketing/__tests__/upgrade-pass-modal.test.tsx` |
| 回跳记录与交付条件 | `src/lib/upgrade-checkout.ts` | `src/lib/__tests__/upgrade-checkout.test.ts` |
| 等待、恢复与 Bot 刷新 | `src/contexts/agent-context.tsx` | `src/contexts/__tests__/agent-context-modification.test.tsx` |
| 目标套餐等待视图 | `src/pages/marketing/agent-upgrading-view.tsx` | `src/pages/marketing/__tests__/agent-upgrading-view.test.tsx` |
| 账户与 Agent 页面接入 | `src/pages/marketing/account-page.tsx`、`agent-settings-page.tsx` | `src/pages/marketing/__tests__/account-page-renewal.global.test.tsx`、`agent-settings-renewal-reminder.test.tsx` |
| 升配期间实例数据兼容 | `src/repositories/http-repositories.ts` | `src/repositories/__tests__/http-repositories.test.ts` |

## 10. OpenCraft 共享副本边界

- `DialogContent` 的 `closeLabel`、`overlayClassName` 与关闭按钮键盘焦点样式属于共享基础组件；OpenCraft 的机械副本必须同步这些变化，同时保留相对 import 和 `lightvela-agent-console-portal` 适配。
- i18n 字典 / 映射和 HTTP Repository 也在共享依赖清单中，使用 `opencraft/scripts/sync-mono2-agent-console.mjs` 一并生成副本与 `UPSTREAM.json`。不得手改生成文件或通过修改检查规则掩盖漂移。
- 2026-09-12 补齐了 Dialog、8 份字典 / 映射、Repository 副本及清单。字典和 Repository 的部分差异来自原 MR 基线；Repository 同步的是既有 `PASS_MODIFYING` 降级逻辑，不新增后端权限或支付行为。
- 前端验证通过不代表共享副本一致。交接前独立执行 `cd opencraft && npm run check:mono2-agent-console`；跨包共享实现按 OpenCraft 约定执行 `npm run gate`。本地结果不代表远端 CI 或生产发布完成。

验证结果及未覆盖边界见[本次变更记录](../changes/2026-09-11-pass-upgrade-interaction.md)与[当前增量计划](../plan.md)。本规格不修改后端定价、支付协议、真实扣款与交付规则，也不声明生产发布完成。
