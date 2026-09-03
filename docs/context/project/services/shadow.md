---
id: shadow-service-context
type: service
scope: 腾讯云影子账号、临时凭据、试用订单与回滚的派生服务上下文。
triggers: ["shadow", "shadow account", "影子账号"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - shadow/docs/README.md
  - shadow/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["identity-access", "subscription-entitlements"]
---

# Shadow 服务 Context

- 平台、计费和存储都置于 interface 后；默认 fake 模式用于本地验证。
- 一次性 `auth_code`、临时凭据和 callback token 不写入文档或日志。
- 覆盖注册、交换、订单幂等、callback 鉴权和手机号回滚。
