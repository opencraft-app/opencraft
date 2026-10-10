---
id: minisandbox-router-capacity-receipt-2026-10-02
type: task
scope: Router 性能资格拒绝空检查、缺失门禁与非布尔容量收据。
triggers: ["minisandbox router capacity receipt", "Router qualification checks", "empty capacity checks"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/load/router-performance/capture.py
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

只有完整通过的万级扩缩容资格才能启动 Router 性能负载与证据采集。

## non_goals

- 不改变 live run94270692、Runtime、SLO、HTTP 重试或云配置。
- 不启动并行资格，不把本地验证当作云端容量通过。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式设计 Phase 5，性能证据必须绑定完整万级容量周期。
- Router performance README，失败或不完整容量收据须在创建资源前拒绝。

## interface_refs / data_structure_refs

- actor-ten-thousand-active-qualification/v1 的八项完整周期门禁。
- capture.py 与 run-on-builder.sh 使用同一验证函数，不维护两个判定。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：master5bbcda45 完成精确尝试清单，严格容量周期仍运行。
- superseded_refs：Python all([]) 与 truthy 值不能证明完整布尔门禁。

## acceptance

- 空、部分或非布尔检查项在任何网络访问、输出创建或远端资源发布前拒绝。
- 目标 active 必须是至少10000的整数，不能由字符串、浮点数或布尔值充当。
- 完整八项通过以及新增全真校验项允许通过；新增失败项也必须拒绝。
- 本地真实子进程重现与修复后的回归通过。

## affected_paths

- Router performance collector、builder entrypoint、真实子进程回归、README。
- 正式设计、本 Task 与 catalog。

## required_context

- upstream-subtrees、cells AGENTS、fleet README、adjacency-argocd-ci-secrets。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@5bbcda45 | 仓库入口 | 保留已有基线与独立任务 |
| docs/context/project/upstream-subtrees.md@5bbcda45 | 路由结果 | 仅 mono2 写入 |
| docs/context/project/adjacency/argocd-ci-secrets.md@5bbcda45 | 邻接卡 | 查真实资格和发布邻居 |
| minisandbox/CLAUDE.md@5bbcda45 | 实现约束 | 真实子进程，不用模块 mock |
| minisandbox/infra/cells/AGENTS.md@5bbcda45 | 云操作约束 | 不并发 live qualification |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@5bbcda45 | 资格边界 | 容量与性能证据分离 |
| minisandbox/infra/cells/deploy/tencent/fleet/load/ten-thousand-active/verify.py@5bbcda45 | 真实生成者 | 核对八项周期门禁与新增校验 |
| minisandbox/infra/cells/deploy/tencent/fleet/load/router-performance/test_capture.py@5bbcda45 | 测试邻居 | 覆盖现有采样与拒绝行为 |
| docs/context/tasks/TASK-TEMPLATE.md@5bbcda45 | Task 契约 | 有界记录 |

## evidence

- collector 对空 checks 使用 all(values)，vacuous truth 会放行。
- builder 虽排除空 checks，但任意非空部分表和 truthy 非布尔值仍可放行。
- 修复前实际运行 builder 内 Python 子进程，部分表及字符串 false 均以 exit0 错误接受。
- 修复后31项 Router 回归全部通过，新5项驱动真实 collector CLI 与 builder 内相同 Python 程序，
  覆盖空或部分表、逐项缺失、非布尔值、附加失败项、畸形目标及 schema/verdict/root shape。

## risks

- 容量 receipt 的 passed 字符串不能替代完整检查集。
- 新检查项不能静默忽略；已有 live 工具的八项周期门禁仍须全部为真。

## validation

- Router31项回归、bash 语法与 diff 检查通过；日志在 /data/tmp/minisandbox-router-capacity-gate-tests-20261002.log。
- 文档门禁 errors/warnings 为空，八文件变更影响检查通过；Context 与4855项基线比较。
- 初次 Context 校验发现本 Task 的 triggers 只有两项，已按契约补齐；不修无关历史基线。

## decisions

- 将门禁函数由 collector 提供，builder 用 runpy 调用相同实现，不新增服务或依赖。

## scan_scope

- fleet/load/router-performance/ 与万级工具的 receipt 生成段。

## scan_output

- 已定位空与部分表检查缺口；不据此宣称云端曾被错误放行。

## handoff

- 完成离线修复与正常 push；原21551继续，所有新云资格等待其终态。
