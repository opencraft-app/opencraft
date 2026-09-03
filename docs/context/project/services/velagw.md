---
id: velagw-service-detail
type: service
scope: VelaGW/LLMGateway 控制面、数据面和 Web 的派生服务上下文。
triggers: ["velagw", "llmgateway", "provider routing"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - velagw/docs/README.md
  - velagw/catalog-info.yaml
  - velagw/AGENTS.md
  - velagw/MONO2_SUBTREE.md
status: active
reviewed_at: 2026-09-01
review_due: 2026-11-30
revision: 2.1.0
precedence: service
derived: true
related_packs: ["agent-gateway-runtime", "upstream-subtrees"]
---

# VelaGW 服务 Context

仅在命中 `velagw/`、LLMGateway、模型 provider 或路由契约时加载；这是上游的 squash subtree，不是独立复制代码。

## 当前边界

- 共享变更通过 `git subtree split --prefix=velagw` 回流；同步规则以 `velagw/MONO2_SUBTREE.md` 为准。
- 嵌入 mono2 不等于已经接入 mono2 发布链。
- provider contract 缺少路由级测试时，不用本地兼容 shim 绕过。

## 按需深入与验证

先读 `velagw/AGENTS.md` 和 `velagw/docs/README.md`，再精确定位受影响 Go/Web package。运行最近的 Makefile 或 Go/Web 门禁，并检查上游 pin、mono2 集成差异和 provider 路由；发布状态独立验证。
