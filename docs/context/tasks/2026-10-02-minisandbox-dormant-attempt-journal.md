---
id: minisandbox-dormant-attempt-journal-2026-10-02
type: task
scope: 百万休眠对象验收在响应丢失后仍可按持久精确清单恢复与清理。
triggers: ["minisandbox dormant attempt journal", "dormant cleanup lost response", "public Object qualification manifest"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/qualify_dormant_actors.py
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

大基数验收失败后不遗漏已尝试的精确对象，不依赖 namespace list 或重发业务来找回清理范围。

## non_goals

- 不启动并发云端资格或改变 live run94270692。
- 不修改 DO、Registry、SQLite 持久化或 HTTP 重试协议，不宣称百万规模已通过。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式设计 Phase 5：百万 dormant Object 真实公开路径验收。
- fleet autoscaling README：本地 manifest 是精确清理权威，禁止扩大删除范围。

## interface_refs / data_structure_refs

- qualify_dormant_actors.py 的 populate/probe/cleanup 与 SQLite manifest。
- public Object PUT、expected-value advance、DELETE，不能用内部 Actor API 替代产品路径。
- 本地 intent 必须先于远端请求；confirmed result 和 intent 状态在同一事务提交。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：master740bf6b1 已加强万级容量证明，百万门禁仍未运行。
- superseded_refs：仅持久成功返回的结果，无法涵盖响应丢失或进程崩溃后的清理范围。

## acceptance

- 真实 HTTP 测试覆盖 Object PUT/advance commit 后断线，重开 SQLite 后精确清理且无残留。
- intent 在第一次远端请求前可从第二个 SQLite connection 看到。
- 一个 manifest 在整个 phase 中只有一个 owner；真实进程未退出时 cleanup 不得取得所有权。
- 不匹配 manifest 的配置在任何 Code Plane 写入前拒绝；cleanup/summary 不重新发布代码。
- 正常 populate/resume/probe/cleanup 与原 FDB qualification 测试保持通过。

## affected_paths

- minisandbox/infra/cells/deploy/tencent/qualify_dormant_actors.py 与真实 HTTP 回归。
- autoscaling README、正式设计、本 Task 与 catalog。

## required_context

- upstream-subtrees、cells AGENTS、fleet README、adjacency-argocd-ci-secrets。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@740bf6b1 | 仓库入口 | 仅 mono2 写入与外部授权 |
| docs/context/project/upstream-subtrees.md@740bf6b1 | 路由结果 | 不修改旧独立仓库 |
| docs/context/domains/agent-gateway-runtime.md@740bf6b1 | 恢复后的路由结果 | 公开路径与直连证据分开 |
| docs/context/project/services/ctl.md@740bf6b1 | 恢复后的路由结果 | 不扩大到 CTL 实例编排 |
| docs/context/project/services/sandbox.md@740bf6b1 | 恢复后的路由结果 | 不混入另一个 sandbox 服务 |
| docs/context/domains/release-gitops.md@740bf6b1 | 恢复后的路由结果 | 源码提交不等于云端发布 |
| docs/context/project/adjacency/argocd-ci-secrets.md@740bf6b1 | 邻接卡 | 检查实际 autoscaling 门禁邻居 |
| minisandbox/CLAUDE.md@740bf6b1 | 实现约束 | 真实 HTTP/SQLite 测试，不模拟模块 |
| minisandbox/infra/cells/AGENTS.md@740bf6b1 | 云端操作 | 唯一 live qualification 不并发变更 |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@740bf6b1 | 资格边界 | 避免伪造百万收据 |
| docs/context/tasks/TASK-TEMPLATE.md@740bf6b1 | Task 格式 | 记录目标和非目标 |
| minisandbox/infra/cells/deploy/tencent/fleet/autoscaling/README.md@740bf6b1 | 真实消费者 | public-only 和精确 manifest 清理 |
| minisandbox/infra/cells/deploy/tencent/test_qualify_dormant_actors.py@740bf6b1 | 测试邻居 | 复用真实 HTTP protocol double |
| minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md@740bf6b1 | 正式目标 | Phase 5 大规模资格 |

## evidence

- 修复前只在 bounded_results 完成后 insert_results；cleanup 只读取返回成功的 actors/probes。
- 修复前 prepare_public_worker 在 initialize_manifest 前执行，cleanup/summary 也有 Code Plane 写入。
- 修复前真实 HTTP 复现 PUT 响应丢失后的残留、Code Plane 提前写入及 cleanup/summary 重发布。
- 修复后10项真实 HTTP/SQLite 测试通过，含子进程在远端创建 commit 后强制终止、原始 probe epoch 清理、
  live owner 拒绝并发 cleanup、DELETE 响应丢失恢复、population resume、损坏清单不扩大删除范围和显式 SQL 索引检查。
- 原6项 dormant/Actor 回归、FDB autoscaling 消费者8项门禁均通过。

## risks

- 必须保留 probe epoch 的精确 ID，不能用当前 epoch 推导历史对象。
- 清理部分运行成功与完整 population 成功是不同结论；不能伪造缺少的对象和 latency。

## validation

- 运行原 public/Actor 回归、新响应丢失 HTTP 回归、相关 FDB autoscaling 门禁、文档与 Context 差异。
- 测试输出在 /data/tmp/minisandbox-dormant-journal-{before,after,final-tests}-20261002.log，
  原回归与消费者日志分别为 dormant-qualification-original、dormant-journal-fdb-consumer。
- 文档门禁 errors/warnings 均为空；Context 仅与既有4855项错误基线比较，不重写无关 catalog。
- 最终回归10项、原6项和 FDB 消费者8项全部通过，六文件变更影响检查通过。
- Context 错误数4855，与修复前基线没有新增或移除；审计33项通过，根26项仍只有既有4项失败。

## decisions

- intent 由 harness 本地 SQLite 持有，不新增生产权威、服务或凭据。
- live run 继续使用原 immutable source，不热替换其脚本。
- manifest schema4 只用于新资格；schema3 运行保留原工具，不增加生产服务兼容层。
- scheduled_operations 保存 pending work 再次排程，不能把 resume 宣称为整个历史零失败。

## scan_scope

- qualify_dormant_actors.py、测试邻居和 fleet autoscaling README。

## scan_output

- 已定位成功结果与尝试范围的缺口，尚未据此宣称现网有孤儿。

## handoff

- 先复现并收敛本地门禁，同时续接原21551；云端百万验收须等当前严格扩缩容终态。
