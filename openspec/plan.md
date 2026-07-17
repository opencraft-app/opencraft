# 当前执行计划

> 当前需求：为 LLMGateway 建立 OpenSpec 规格体系。

## 本次文档任务

- [x] 调研 monorepo 现有 OpenSpec 约定。
- [x] 采用子服务内 `openspec/` 目录，不污染 monorepo 根目录。
- [x] 编写 `config.yaml` 项目上下文。
- [x] 编写 `current_state.md` 当前状态。
- [x] 编写 `spec.md` 当前技术规格。
- [x] 编写 `proposal.md` 当前需求提案。
- [x] 编写长期规格 `specs/llmgateway-dropin.md`。
- [x] 编写本次变更包 `changes/2026-07-05-llmgateway-newapi-dropin/`。
- [ ] 后续变更按 OpenSpec 流程先写 proposal/design/tasks，再实现。

## 后续工程任务

- [x] tenant observation projection：保存极薄观测快照，不保存完整账本。
- [x] tenant observation e2e：Compose 级验证 observe 返回、资源表投影和租户列表投影一致。
- [ ] 管理台租户详情：进一步展示 active subscription 列表和 key 列表。
- [x] channel drift/force overwrite：服务层和 Compose mockllm e2e 覆盖远端手工漂移、普通 apply 不覆盖、force_drift 覆盖。
- [x] channel partial failure / disabled Set：服务层覆盖部分失败状态保留和 disabled Set skip。
- [x] channel e2e 增强：partial failure、disabled Set 已提升到 Compose 级验证，并覆盖健康 Set 不被失败 Set 污染。
- [x] control/traffic 进程拆分：保留共享代码，提供 `llmgateway` 本地全量入口、`llmgateway-control` 控制面入口和 `llmgateway-traffic` 流量入口。
- [x] traffic metrics：`/metrics` 暴露 key hash、set、status、upstream status、duration、streaming、error type，并覆盖成功和错误路径测试。
- [x] OpenAPI 控制面 contract test：覆盖 channel bundle 路径、force_drift 和 Redis DB range 字段。
- [x] OpenAPI 与 OpenSpec 双向校验：`openspec/openapi_contract.json` 与 `docs/openapi.json` paths 互相校验，避免接口文档和规格漂移。
