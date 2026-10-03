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
revision: 1.2.0
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
- Host/Engine 的实际 tracing 文本包含 ANSI SGR 与带引号 Envoy ID；门禁去掉呈现颜色，
  不改变时间戳、Actor/generation/index 或 Envoy 身份匹配。
- 业务 Actor sleep 走 Guard 6420；reconciliation footprint 只在 API Peer 6421 注册。
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
- 新源码材料化 inv-d9dbja0ick SUCCESS/0，真实 native 23+15、relocated 及 ACK11 通过。
- 新故障门禁 inv-c9dbn2gwda FAILED/1，Registry 通路已恢复，仍在 arm_plan 前：Host
  actor-bj-b01-runtime-hosts-2 的 colored/quoted Envoy 行解析失败。原日志已下载保留。
- 只读 inv-a9dbr80a36 SUCCESS/0 提供实际日志形态；新增两条解析回归先红，13 测试中
  仅这两项失败，证明门禁缺口而非靠换 runtime 配置掩盖。
- 同时复现原文本匹配把 actor-a/actor-ab、generation=1/17、index=1/19 当同一身份的
  三个误判；改为字段精确匹配。全部 15 项测试通过，未放宽身份核对。
- 新 native inv-e9dc17gd6k SUCCESS/0。第三次实际门禁 inv-a9dc3p092h FAILED/1，
  已触发 fault，Stop 一次、ACK replay/barrier 检查通过，但 backlog 错查 Guard6420 得到404。
  日志已官方下载，hash348b133dac59；完整资格仍未通过。
- focused 17 项通过，包含实际 HTTP footprint 的 scope/完整分页拒绝，以及构造真实
  API Peer PortForward 的 listener 检查。增加 fault/Host ACK/backlog 非秘密阶段输出，
  使后续检查失败仍保留已经独立核对的阶段证据，不把部分通过当最终通过。

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

- Registry 与日志修复分别 push master 41268e5b/78b5d0f6 并通过 native；当前修正检查
  listener，使用已有 API Peer，不增加网络暴露。下一轮仍需 Counter2 与 backlog零最终证据。
