# Journey：账号进入 Agent

## 目标

用户从国内/国际站完成登录/实名门禁并进入自己的 Agent 实例。此 Journey 用于定位“页面能开但实例不可用”“直连接口正常但公共入口失败”等跨层问题。

## 链路

1. `frontend` 根据站点路由呈现登录与 Agent 入口。
2. `service-gateway` 接收公共请求并校验会话/实名等状态。
3. `user/auth` 提供身份、会话和实名事实；需要腾讯云影子身份时由 `shadow` 编排。
4. `ctl` 查询用户实例归属并编排创建/访问。
5. `sandbox` 分配可用运行机器，`cloudagent` 暴露对应 Agent runtime。

## 失败边界

| 症状 | 先查 |
|---|---|
| 前端反复要求登录 | 站点 cookie/session 与 `user/auth` 会话 |
| 直连 Auth 正常、公共入口失败 | `service-gateway` 路由与授权 middleware |
| 实例长期 Creating | CTL 任务、Sandbox 库存/状态和 worker |
| 实例存在但 Agent 不可用 | CloudAgent gateway/selfcheck 与 runtime artifact |

## 验证

至少保留公共入口请求、身份状态、CTL 实例记录、Sandbox 状态转移和 CloudAgent 自检的同一用户/请求关联证据。不得在日志中打印 session、临时凭据或解密 payload。
