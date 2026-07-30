# Tasks: LLMGateway new-api drop-in old ai-gateway

## Spec

- [x] 建立 `llmgateway/openspec` 目录。
- [x] 写入项目上下文 `config.yaml`。
- [x] 写入当前状态 `current_state.md`。
- [x] 写入当前规格 `spec.md`。
- [x] 写入长期能力规格 `specs/llmgateway-dropin.md`。
- [x] 写入本变更 proposal/design/tasks。

## 已完成工程能力

- [x] Set 注册和 bootstrap。
- [x] 用户 binding 和 assignment。
- [x] external key 到 upstream key route。
- [x] `/v1/*` traffic proxy。
- [x] old traffic fallback 和 negative cache。
- [x] subscription apply/cancel/extend/get facade。
- [x] credit facade。
- [x] migration dry-run/migrate。
- [x] channel desired state。
- [x] channel check_only / sync / force_drift。
- [x] OpenAPI 管理面契约。
- [x] tenant observation projection 表和 `observe` API。
- [x] Compose E2E 两 Set 集群。

## 后续工程任务

- [ ] 管理台进一步展示 tenant active subscription 列表和 key 列表。
- [ ] 管理台展示 channel drift check 按钮和每 Set 同步详情。
- [x] traffic proxy 暴露 Prometheus metrics。
- [x] 拆分 control/traffic 启动模式。
- [x] E2E 增加 remote drift 和 force overwrite 场景。
- [x] 服务层增加 partial sync failure、disabled Set 场景。
- [x] E2E 继续增加 partial sync failure、disabled Set 场景。
- [x] E2E 增加 tenant observation 场景。
- [x] 为 OpenSpec 变更建立轻量 docs contract：channel bundle 路径、force_drift 和 Redis DB range 字段。
- [x] 继续补齐 OpenAPI 与 OpenSpec 的双向自动校验。
