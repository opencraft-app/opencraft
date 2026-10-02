---
id: minisandbox-api-business-drain-2026-10-02
type: task
scope: 用真实流式 Worker 请求验证 C Workers API Pod 删除后的在途排空。
triggers: ["API 业务排空资格", "流式请求 Pod replacement", "workers-api-business-drain"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/load/workers-api-business-drain/
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.1.0
precedence: task
derived: false
---

## goal

证明真实 Worker 流在 API listener 停止新准入后继续排空，随后恢复三副本和私网业务请求。

## non_goals

- 不改变生产 30 秒 preStop、50 秒 grace 或十秒 HTTP drain。
- 不调整 HPA、Argo、Cell 容量、Runtime 镜像或透明重试，不重编 workerd。
- 不把 readyz 探测或此单 Pod 故障当作一万活跃对象资格。

## requirement_ids / requirement_refs / requirement_excerpt

- Stateless Workers / DO 设计的 C Router Pod replacement、流式响应与安全缩容矩阵。
- 已发布 Go listener 排空修复；现有 private endpoint HA 仅证明 readyz。

## interface_refs / data_structure_refs

- 公共 Version、Deployment、stateless dispatch 和 Worker DELETE。
- Kubernetes Pod DeleteOptions.preconditions.uid，保持默认优雅删除。
- 接收固定 128 KiB 响应的前半段后才删除；停止新 listener 必须先于原响应完成。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：2026-10-02-minisandbox-api-shutdown-drain.md；双 listener 等待修复。
- superseded_refs：private endpoint HA readiness 不能替代业务排空。

## acceptance

- 一次流式请求不重试，收到完整固定长度和内容，listener 已停止时请求尚未完成。
- 公共 CLB 的独立快速业务请求在替换前后无失败。
- 精确旧 Pod UID 消失，新 UID Ready，Deployment/HPA 身份、策略和 image 未漂移。
- 全流程持共享 operation lock，清理仅限该 run 的临时 stateless Worker。
- 真实 HTTP 和真实子进程回归通过；保存不可覆盖的成功或失败收据。

## affected_paths

- 独立 load/workers-api-business-drain 文件夹、正式设计、本 Task 与 catalog。

## required_context

- release-gitops、upstream-subtrees、根 AGENTS、cells AGENTS、CLAUDE 和 fleet README。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@511ec1a2 | 根入口 | Task 与发布证据 |
| docs/context/domains/release-gitops.md@511ec1a2 | 路由 | 源码不等于上线 |
| docs/context/project/upstream-subtrees.md@511ec1a2 | 路由 | mono2 唯一写源 |
| docs/context/project/adjacency/argocd-ci-secrets.md@511ec1a2 | 邻接 | manifest 与验证邻居 |
| minisandbox/CLAUDE.md@511ec1a2 | 测试边界 | 真实 HTTP/进程，不 mock 模块 |
| minisandbox/infra/cells/AGENTS.md@511ec1a2 | 云边界 | 共享锁、精确 UID、正常删除 |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@511ec1a2 | 运维入口 | 不修改 Cell 或运行并行生产 rollout |
| minisandbox/infra/cells/deploy/tencent/fleet/workers-api/api.yaml@511ec1a2 | 配置邻居 | 保留 30/50 秒合同 |
| minisandbox/infra/cells/deploy/tencent/fleet/workers-api/qualify-private-endpoint-ha.py@511ec1a2 | 已有门禁 | 复用 readiness 与原子收据 helper |

## evidence

- API image 已发布，但上一云 HA 收据只采样 readyz；业务排空仍待验证。
- 当前 Rust cache 和 V8 stage 独立运行，不重发或取消已有构建。
- 新工具真实 HTTP、真实子进程、生成 JS、UID precondition 和失败收据共九条本地回归通过。
- Python/Bash 语法和 diff 检查通过；Docs 无 error/warning；完整 Fleet 静态门禁终态 exit 0。
  日志：`/data/tmp/minisandbox-api-business-drain-fleet-static-20261003.log`，SHA-256 前缀 `1b2dada949d68a82`。
- Context 仍有 4,871 条旧仓库基线问题，本 Task errors 为零。根 Context 26 条测试有四项
  旧仓库整体治理/语言/预算失败，不把全仓检查标为通过；context-audit 的 33 条测试通过。
- catalog 只增加本 Task 行，不顺带刷新无关任务的历史记录。
- 首次云 run 在删除 Pod 前因 framing 断言失败；临时 Worker DELETE 204，未执行 Pod 删除。
  原断言错误地要求普通 ReadableStream 一定有 Content-Length，与 Workers 原生行为不符。
  支持 fixed/chunked 两种合法 HTTP framing，仍要求完整 128 KiB、逐字节核验、EOF、零重试和
  listener-before-completion，不改变服务、超时或业务排空合同；收据增加实际 framing 字段。
- fixed/chunked framing 与真实 chunked HTTP 的聚焦回归共 11 条通过。Host stateless 流式
  代理源码显式删除 Content-Length，CF 官方 Response 文档也明确普通流的 runtime 行为。

## risks

- 故障前 Ready 基线、image、HPA 和生命周期必须一致；漂移时拒绝删除。
- 删除响应丢失不重发；失败收据保留精确受影响 UID，不扩展清理范围。

## validation

- 聚焦 unittest、Python 编译、Fleet 静态门禁、Docs/Context/impact。
- 云上必须有完整业务、listener 与 Pod 身份时间线；本地不能替代云收据。

## decisions

- 用 Kubernetes port-forward 精确选定 API Pod；公共 CLB 独立验证新业务准入。
- 流只调用已有 stateless dispatch，不引入 DO、SQLite 或新服务。

## scan_scope

- fleet/workers-api、相关 load 工具和 cmd/workers-api/http_servers.go。

## scan_output

- readyz HA 没有业务请求；listener 排空已修复，缺口是云上证据而非服务实现。

## handoff

- 工具已实现并注册到 Fleet 静态入口。云上尚未运行，不能宣称业务排空资格通过。
- 收齐 Fleet 和本 Task 门禁后提交；按完整 reviewed source + canonical TAT + operation lock
  执行，使用已发布 API image，不重建 API 或 workerd。
