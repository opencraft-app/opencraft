---
id: ctl-service-detail
type: service
scope: 实例、渠道和实例编排控制面的派生服务上下文。
triggers: ["ctl detail", "instance control", "control plane"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - ctl/docs/README.md
  - ctl/catalog-info.yaml
  - ctl/README.md
  - ctl/AGENTS.md
status: active
reviewed_at: 2026-09-01
review_due: 2026-11-30
revision: 2.1.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime", "identity-access", "subscription-entitlements"]
---

# CTL 服务 Context

仅在实例、渠道、编排或 CTL API 任务中加载；先读最近的 `ctl/AGENTS.md`。

## 当前边界

- CTL 拥有实例、渠道及编排；公开 `/v1/instances` 还经过网关，直连 CTL 测试不等于公共路径验证。
- 实例归属、地域和状态来自权威存储，不能从名称推断。
- 路由或上游变更必须同时覆盖直连上游与公共网关；渠道配置和实例归属需保持可分别审阅。

## 按需深入与验证

服务入口与权威说明：`ctl/docs/README.md`；实现细节只在精确命中相应包、接口、数据结构或设计历史后读取。运行 `cd ctl && go test ./...` 的最小有效范围；跨服务任务同时运行对应 Journey 的验证，并区分源码、GitOps 与真实运行态证据。
