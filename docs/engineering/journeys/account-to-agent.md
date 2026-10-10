# Journey：账号进入 Agent

## 目标

用户从国内/国际站完成登录/实名门禁并进入自己的 Agent 实例。此 Journey 用于定位“页面能开但实例不可用”“直连接口正常但公共入口失败”等跨层问题。

## 链路

1. `frontend` 根据站点路由呈现登录与 Agent 入口。
2. `service-gateway` 接收公共请求并校验会话/实名等状态。
3. `user/auth` 提供身份、会话和实名事实；需要腾讯云影子身份时由 `shadow` 编排。
4. `ctl` 查询用户实例归属并编排创建/访问。
5. `sandbox` 分配可用运行机器，`cloudagent` 暴露对应 Agent runtime。

## 红线：定价、订阅、首次创建不得绕过

国内站和国际站执行同一条必要路径：了解价格 → 选择套餐 → **确认订阅已生效** → 首次创建 Bot → 使用 Agent。进入创建界面只是邀请用户配置和确认，不自动创建实例。任何新增首页 CTA、页头、页脚、头像菜单、登录回跳、支付回跳或 `/agents` 子路由，都必须保持以下约束：

| 状态或入口 | 必须发生的行为 | 禁止的捷径 |
|---|---|---|
| 顶部导航「定价」 | 进入完整 `/subscribe` 页面 | 被通用购买入口拦截成弹窗 |
| 「免费试用／免费使用」入口 | 在原页面打开定价弹窗；关闭后仍在原页面 | 未购买就指向 `/agents`，或直接跳到独立定价页 |
| 其他购买、了解套餐或「定价」链接 | 进入完整 `/subscribe` 页面 | 被通用 `/subscribe` 点击拦截误开弹窗 |
| 未登录、未购买且无历史资产 | 不展示「我的智能体」导航、首页主按钮、页脚按钮及「我的」菜单入口；直达 `/agents` 或子路由也不得挂载内容，确认状态后回首页 | 先显示智能体列表、功能页或创建页，再让用户购买；仅隐藏入口而不拦直达地址 |
| 权益或 Bot 列表尚未确认、查询失败 | 等待或给出重试；不挂载 Agent 内容 | 把未知状态当作已购买或未购买，闪出受限入口或误跳转 |
| 订阅生效且服务端 Bot 列表为空 | `/agents` 直接打开首次创建界面；任何 `/agents/*` 深链接先回 `/agents?create=1`，不得渲染功能页；中途退出后再次进入仍如此 | 显示空列表、直接使用 Agent 功能、自动创建实例，或依赖浏览器本地记录判断首次 |
| 订阅生效且已有 Bot | 进入正常列表或所请求的功能页 | 再次强制创建 |
| 曾购买但已到期 | 保留管理入口；无 Bot 的深链接回 `/agents` 管理首页 | 误当作从未购买者挡在外面 |

支付取消、失败、重复通知或订阅尚未生效时，不进入 Agent；只有服务端权益事实可放行。前端入口与路由门禁负责体验，服务端仍须校验身份、权益及资源归属。首页原本指向 `/agents` 的场景详情等静态链接可保留，但未购买时必须经过同一门禁，不能显示受限内容。

**改动验收红线**：双站分别验证顶部「定价」及普通购买链接进入完整页、只有免费试用入口开关弹窗、未登录/未购买无 Agent 入口、直达 `/agents` 和子路由被拦、已订阅零 Bot 直达创建及退出后重进、已有 Bot 正常进入、已到期用户可管理、查询失败可重试。任一项回归即阻断合并。

代码落点：`frontend/next-site/public-site-pricing-modal.tsx`（购买入口分流）、`frontend/next-site/app-route-shell.tsx`（直达门禁）、`frontend/next-site/international-home-runtime.tsx` 与公开站页头/页脚（入口显隐）、`frontend/src/pages/marketing/agent-settings-page.tsx`（零 Bot 创建）、`frontend/next-site/subscribe-page.tsx`（支付后承接）。

## 失败边界

| 症状 | 先查 |
|---|---|
| 前端反复要求登录 | 站点 cookie/session 与 `user/auth` 会话 |
| 直连 Auth 正常、公共入口失败 | `service-gateway` 路由与授权 middleware |
| 实例长期 Creating | CTL 任务、Sandbox 库存/状态和 worker |
| 实例存在但 Agent 不可用 | CloudAgent gateway/selfcheck 与 runtime artifact |

## 验证

至少保留公共入口请求、身份状态、CTL 实例记录、Sandbox 状态转移和 CloudAgent 自检的同一用户/请求关联证据。不得在日志中打印 session、临时凭据或解密 payload。
