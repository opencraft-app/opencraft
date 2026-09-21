---
id: sandbox-service-context
type: service
scope: Sandbox 实例池、状态机、分配回收与镜像切换的派生服务上下文。
triggers: ["sandbox", "实例池", "pool state"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - sandbox/docs/README.md
  - sandbox/catalog-info.yaml
status: active
reviewed_at: 2026-08-26
review_due: 2026-11-24
revision: 1.0.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime", "release-gitops"]
---

# Sandbox 服务 Context

- 请求路径只做 `CLEAN→ALLOCATED` 与 `ALLOCATED→DRY`，后台 worker 执行重置/补货。
- 并发分配依赖存储锁和 `expected_state` 条件更新，不直改数据库。
- 覆盖状态转移、并发、失败恢复；镜像 rollout/生产操作需要单独授权。
