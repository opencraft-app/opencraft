---
id: minisandbox-router-load-preflight-2026-10-02
type: task
scope: 修复 Router 性能门禁的 Registry 可达性预审与部分创建清理。
triggers: ["minisandbox router load preflight", "router Registry reachability", "partial performance load cleanup"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/load/router-performance/run.py
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

让真实 Router 性能门禁在发布前验证 Registry 可达，部分准备失败也精确清理并留下失败收据。

## non_goals

- 不改变运行时、路由协议、五分钟零重试门禁或正在运行的万级资格。
- 不修改现网、手工扩容或将本地协议测试当云端资格。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式 Stateless Workers/DO 设计 Phase 5 要求真实跨 Cell 绑定性能证据与精确清理。

## interface_refs / data_structure_refs

- actor-router-binding-performance-load/v1，保留失败、对象清理计数和不可覆写收据。
- Registry Service 8080 与 /readyz；builder 不可依赖 C 集群内部 DNS。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：41268e5b 修复 ACK 门禁同类 Registry DNS 问题；性能入口仍读取内部 ConfigMap URL。
- superseded_refs：内部 DNS 不作为集群外 builder 可达性证据。

## acceptance

- 实际 HTTP 与 port-forward 子进程证明预审先于发布、正常及异常关闭。
- 部分准备失败清理已尝试 Object，未知执行结果也清理，不删除别人的命名空间。
- CLI endpoint/service 互斥，官方入口采用 Hub Service；保留原性能门槛。

## affected_paths

- router-performance 入口、测试、README，正式设计、本 Task 与 catalog。

## required_context

- release-gitops、upstream-subtrees、adjacency-argocd-ci-secrets。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@0eb0965b | 仓库规则 | 单写源与正式证据 |
| docs/context/domains/release-gitops.md@0eb0965b | 发布边界 | 不把源码当发布 |
| docs/context/project/upstream-subtrees.md@0eb0965b | 源码身份 | 只写 mono2 |
| docs/context/project/adjacency/argocd-ci-secrets.md@0eb0965b | 邻接 | 检查入口测试而不读取凭据 |
| minisandbox/CLAUDE.md@0eb0965b | 实现约束 | 无模块 mock，隔离 revision |
| minisandbox/infra/cells/AGENTS.md@0eb0965b | 操作规则 | 不与万级任务并发 mutation |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@0eb0965b | 资格入口 | 保留全程门禁 |
| minisandbox/infra/cells/deploy/tencent/fleet/load/router-performance/README.md@0eb0965b | 当前协议 | 性能窗口与清理 |
| minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md@0eb0965b | 完整目标 | Phase 5 真实跨 Cell |

## evidence

- bounded search 确认 builder 读取 registry-url，run.py 仅在正常尾部清理。
- 邻居 ACK qualifier 已采用实际 Kubectl/PortForward，可复用相同协议实现。
- 26 项测试通过；真实 HTTP 服务与 kubectl 子进程覆盖准备前 503、部分创建响应失败、placement 不符、清理失败、forward 生命周期及正式窗口计数。
- CLI 的五分钟/一万请求条件不变，本地短窗口只验证协议，不宣称云端性能通过。

## risks

- 请求响应丢失可能已创建 Object，必须在发请求前登记精确清理对象。
- 清理失败必须体现在收据中，不掩盖原始失败，也不自动重试非幂等请求。

## validation

- Router focused tests、Bash/Python、文档/Context 与 change-impact 门禁。

## decisions

- 复用既有真实 PortForward，准备与负载共用 finally 清理。

## scan_scope

- router-performance、ACK reachability、persistent-code-e2e PortForward。

## scan_output

- 仅源码契约与非秘密状态，不输出认证信息。

## handoff

- 当前万级 run f56405fe9169424fb97d3c81b3da2704 仍 live；本 Task 仅本地修补下一门禁。
- 09:18 UTC 只读 inv-c9der5g75k SUCCESS/0：1192 Object、31893 成功交互；两 Cell runtime 节点目标35/32、Ready31/29，FDB健康全复制。不能提前声明万级通过。
