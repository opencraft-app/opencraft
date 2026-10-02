---
id: minisandbox-deployment-read-release-2026-10-03
type: task
scope: 将已验证的有界 Deployment 读合并独立发布至北京 C Workers API。
triggers: ["Deployment 读合并发布", "deployment read release", "Go API 性能修复发布"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/workers-api/build-image-via-tat.sh
  - minisandbox/infra/cells/deploy/tencent/fleet/workers-api/gitops/README.md
status: active
reviewed_at: 2026-10-03
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal

将 source 86a11d23 的读合并实现通过独立 Go API product 正式发布；先修正工厂暴露的旧墙钟测试。

## non_goals

- 不重建或更改正在编译的 Runtime，不替换 A/B runtime digest。
- 不轮换 Secret、不调整容量/超时、不断言完整目标或云性能资格已完成。
- 不做 physical restore 或 soak，不手工 patch Argo-owned Deployment。

## requirement_ids / requirement_refs / requirement_excerpt

- Stateless Workers / DO 正式设计中的稳定请求无 Registry 热路径、Router 可扩展与发布排空要求。
- 用户要求从建模消除性能劣化：机制修复须进入实际运行路径，而不止本地测试。

## interface_refs / data_structure_refs

- actor-product-image/v1、完整 image inventory、Workers API render 与 Argo convergence receipt。
- 保留 C Application CAS、Deployment/Service/Secret UID、Cell UID 路由和三节点 HA。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：86a11d23 通过完整 race/vet/build；12 个专项回归，32 并发冷填充由 32 GET 收敛为 1 GET。
- superseded_refs：原 28db API 仅为回退候选，不能将新源码当成已发布。

## acceptance

- immutable source bundle、manifest、product digest 和基础镜像链验证通过。
- Argo 精确 revision 为 Synced/Healthy，三节点副本均为新 digest，原外部 UID 和 capability 不变。
- 公共业务通过，读合并指标有界且已由实际运行镜像输出，失败保留原收据。

## affected_paths

- 本 Task、正式设计的证据边界、workersapi/api_test.go 与单独非敏感发布记录。

## required_context

- 根/cells AGENTS、release-gitops、upstream-subtrees、Fleet README、API/GitOps README。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@86a11d23 | 根入口 | 单任务 revision、授权与证据 |
| minisandbox/infra/cells/AGENTS.md@86a11d23 | 运维边界 | 原作业续接、正式 entrypoint |
| docs/context/domains/release-gitops.md@86a11d23 | 路由 | 源码与真实 Argo 分开 |
| docs/context/project/upstream-subtrees.md@86a11d23 | 路由 | mono2 唯一真源 |
| docs/context/project/adjacency/argocd-ci-secrets.md@86a11d23 | 邻接 | 外部 Secret 不变 |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@86a11d23 | Fleet | 不混入 Cell 资格操作 |
| minisandbox/infra/cells/deploy/tencent/fleet/workers-api/README.md@86a11d23 | 正式入口 | 完整 product inventory |
| minisandbox/infra/cells/deploy/tencent/fleet/workers-api/gitops/README.md@86a11d23 | Argo | prior convergence CAS |
| minisandbox/infra/cells/deploy/tencent/fleet/workers-api/test_install.py@86a11d23 | 测试邻居 | 不创建或替换 Secret |
| minisandbox/infra/cells/Dockerfile.workers-api@86a11d23 | 构建邻居 | 只构建 Go API |

## evidence

- 上一轮是实质 progress：86a11d23 normal push；本轮先 jj new，worktree 起点 clean。
- 原 Runtime stage scope active/running，续接 session 94658 实际仍运行，未重启。
- source 86a11d23 已通过完整 manifest 校验并由 inv-c9dv7c0dxt 成功 materialize。
- Go 工厂 inv-e9dv9mgbai 明确 FAILED/1；旧测试得到正确的 502/indeterminate_result，
  但 382.9 ms 调度延迟违反其 50 ms 墙钟上限。失败日志保留，未产生 product、未发布。
- 该子测试改用真实 HTTP 取消与响应体释放屏障；保持 10 ms header timeout、非 retryable
  副作用错误和完整流响应，删除 sleep/墙钟 SLO 断言，不调整生产配置。

## risks

- 当前发布 inventory 必须保留原 Runtime/controller 与全部基础镜像，仅晋级 workers-api。
- prepared Runtime release wrapper 在 API 新发布后须跟随新绑定，不能将其回滚至旧 API。

## validation

- 原 API verify、product validator、Argo convergence 与真实 public request；Docs/Context/impact。
- 修正后完整 workersapi/objectrouter/cmd-workers-api race 单次通过：2.414/1.018/5.515 秒，
  日志 `/data/tmp/minisandbox-api-event-deadline-race-20261003.log`。vet 与本地 binary build 终态 0。
- 文档校验无 errors/warnings；root Context 原有治理错误独立存在，不宣称全仓通过。

## decisions

- 复用正式 Go API image factory、COS relay、product-lock 与 Argo publication，不自研发布通道。

## scan_scope

- workers-api 构建、render、GitOps、现有 qualification receipt 与 source relay。

## scan_output

- API build 与 Runtime 独立；源码 label、manifest、cold pull 和 full inventory 都由原工具校验。

## handoff

- 首次工厂已失败，专项 race 回归通过；待完整门禁、独立源码提交及正式工厂重建。
- 当前 C 仍为原 28db image，3 Ready、Argo Synced/Healthy；无生产更新或新 convergence。
