---
id: minisandbox-ack-registry-reachability-2026-10-02
type: task
scope: 修复 builder ACK 故障门禁错误依赖集群内部 Registry DNS。
triggers: ["command ack registry reachability", "builder ACK qualification", "ACK Registry 通路"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/load/command-ack-disconnect/qualify.py
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

让真实 ACK 断线门禁在 builder 通过 Hub Kubernetes API 访问 Registry，不依赖集群 DNS。

## non_goals

- 不暴露 Registry 公网入口、不改变 ACK 协议、不重编 Runtime，也不自动重试业务副作用。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式 Stateless Workers/DO 设计要求真实 ACK/commit 边界故障收据。
- inv-c9db660cef FAILED/1，fresh autonomy allow 后第一次 Counter 成功，Registry resolve DNS 失败。

## interface_refs / data_structure_refs

- Registry Service worker-registry-system/worker-registry:8080，readyz 就绪检查。
- 复用 persistent-runtime-e2e 的 Kubectl/PortForward；转发必须在任何业务请求前就绪。
- 转发正常及异常退出都关闭，仍保留可选明确可达的 registry-endpoint。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：c592 原 runner 从 C ConfigMap 读取集群 DNS，错误假设 builder 可解析。
- superseded_refs：无。

## acceptance

- 不新增模块 mock；真实子进程 HTTP double 验证 Hub namespace/service、loopback 与异常清理。
- 参数拒绝同时指定 service 与 endpoint；正式 builder 入口固定 service 转发。
- 新 reviewed source 的云上门禁独立执行；旧失败日志和 Object cleanup 保留。

## affected_paths

- command-ack-disconnect qualify/runner/tests/fixture/README，正式设计与本 Task/catalog。

## required_context

- release-gitops、upstream-subtrees、adjacency-argocd-ci-secrets。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@6ddba245 | 仓库规则 | 精确证据与推送 |
| docs/context/domains/release-gitops.md@6ddba245 | 资格边界 | 源码不代替云上结果 |
| docs/context/project/upstream-subtrees.md@6ddba245 | 单写源 | 只修改 mono2 |
| docs/context/project/adjacency/argocd-ci-secrets.md@6ddba245 | 邻接 | 核对 Registry Service 和测试 |
| minisandbox/CLAUDE.md@6ddba245 | 项目规则 | 不 mock 合同或重编 Runtime |
| minisandbox/infra/cells/AGENTS.md@6ddba245 | 操作所有权 | 唯一 TAT 句柄和全程操作锁 |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@6ddba245 | 门禁规则 | 不与压力或 rollout 并发 |
| minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md@6ddba245 | 完整目标 | 保留真实故障矩阵 |

## evidence

- 原失败 inv-c9db660cef 终态，诊断 inv-e9db8m07bb SUCCESS/0：registry_record 的
  urllib URLError Errno -2，发生在 arm_plan 之前；不能宣称 ACK 协议通过或失败。
- focused 11 项测试通过，包含真实子进程 HTTP double、正常/异常后的端口关闭、
  Hub Service/namespace 校验、互斥参数与非 Service 路径拒绝。shell 与 Python 检查通过。

## risks

- 转发不得残留；不增设外部入口或打印 token。
- 重新运行只在原任务终态并完成清理后，用新 run ID 与新源码身份。

## validation

- ACK focused tests、真实网络 double、shell/Python 检查、Context/文档与影响门禁。
- 云上需要同一 Counter 1/2、精确 Actor/Cell UID、Stop 一次、ACK replay/barrier/backlog 零。

## decisions

- 使用已授权的 Hub kubeconfig 与原有 PortForward，不改变生产路由或网络规划。

## scan_scope

- ACK harness、原失败日志诊断白名单、Registry Service、既有 PortForward。

## scan_output

- 只输出错误栈和非秘密资源身份，不读取凭据值。

## handoff

- 本地修复通过；源路径门禁已 push master 6ddba245，待本修复推送后以新 source bundle
  统一 native 验证，再运行真实 ACK 边界故障。不把本地通过写成云上资格通过。
