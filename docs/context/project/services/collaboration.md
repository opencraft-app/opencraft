---
id: collaboration-service-detail
type: service
scope: LightVela Collaboration 控制面、腾讯云 IM 资源映射和托管 Computer 业务绑定的派生服务上下文。
triggers: ["collaboration", "server member channel", "tencent im mapping", "协作控制面"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - collaboration/docs/README.md
  - collaboration/catalog-info.yaml
  - collaboration/AGENTS.md
  - collaboration/platform/v1/model-contract.yaml
  - collaboration/platform/v1/openapi.yaml
status: active
reviewed_at: 2026-09-14
review_due: 2026-12-13
revision: 1.0.0
precedence: service
derived: true
related_packs: ["identity-access", "agent-gateway-runtime"]
---

# Collaboration 服务 Context

命中 `collaboration/`、Server/Member/Channel/Task/Reminder、腾讯云 IM 映射或托管 Computer
业务绑定时加载；先读取 `collaboration/AGENTS.md`。

## 当前边界

- Human 登录权威属于 `user/auth`，服务只接收网关验证的 LightVela subject 并 JIT 映射本地 actor。
- 腾讯云 IM 是普通聊天消息、群组、会话和未读的权威；平台只保存稳定资源映射和消息引用。
- CTL 管理真实实例生命周期；Computer 产品界面仍由本域表达，但不开放外部 Computer Enrollment。
- Runtime、Computer、Human 身份域互斥；模型、OpenAPI、ShardKey 与迁移历史优先于行为实现。

## 按需深入

- 权威入口、迁移状态和验证：`collaboration/docs/README.md`。
- 领域和分片：`collaboration/platform/v1/model-contract.yaml`。
- HTTP 边界：`collaboration/platform/v1/openapi.yaml`。
- 涉及 LightVela 登录时追加加载 identity-access Domain Pack；涉及 Agent/Computer 时追加加载
  agent-gateway-runtime Domain Pack。

## 验证

按 `collaboration/AGENTS.md` 执行契约、生成物、Migration、Go test/vet/race 和密钥扫描门禁；
仅行为切片可以先运行聚焦测试，但不能以聚焦结果代替受影响的契约门禁。
