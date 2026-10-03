---
id: minisandbox-workers-api-verification-portability-2026-10-02
type: task
scope: 修复 Workers API 正式门禁从源码目录外调用时的测试加载失败。
triggers: ["workers api verification portability", "minisandbox native source qualification", "Workers API 异地目录门禁"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/workers-api/verify.sh
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

使正式 Workers API 验证在 builder 与任意操作目录下执行同一组真实测试，不依赖源码所在路径。

## non_goals

- 不放宽测试、改变产品语义、换临时目录名字掩盖错误或重编 Runtime/workerd。
- 不把源码验证替代云上资格或部署证据。

## requirement_ids / requirement_refs / requirement_excerpt

- Stateless Workers/DO 生产编排门禁；用户要求兼容不同 Python3 环境与可重建部署。
- builder inv-d9damjgc6k 已终态 FAILED/1，源文件检查及 manifest 渲染通过，测试加载失败。

## interface_refs / data_structure_refs

- workers-api/verify.sh：模块测试入口与实际脚本目录。
- fleet/verify-manifests.sh：永久 relocated-source 回归入口。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：df2af17b 镜像清单修复在本地通过，但 native materialization 从操作目录调用
  时，绝对测试文件路径被 unittest 解释为模块路径，带点号目录产生 ModuleNotFoundError。
- superseded_refs：无。

## acceptance

- 从不同 cwd 对带点号的源码路径运行整个正式门禁通过。
- 不 mock 校验器；使用真实复制目录、Python、kubectl kustomize 和子进程。
- builder 使用精确 reviewed source 重新验证，失败日志保留；不更新 current source symlink。

## affected_paths

- workers-api/verify.sh、test_verify_runner.py、README.md 和 fleet/verify-manifests.sh。
- 正式设计、本 Task Pack、对应 Context catalog 记录。

## required_context

- release-gitops、upstream-subtrees、adjacency-argocd-ci-secrets。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@df2af17b | 仓库规则 | 隔离 revision 与精确测试 |
| docs/context/domains/release-gitops.md@df2af17b | 发布边界 | 源码验证不等于部署 |
| docs/context/project/upstream-subtrees.md@df2af17b | 单写源 | 只修改 mono2 subtree |
| docs/context/project/adjacency/argocd-ci-secrets.md@df2af17b | 测试邻接 | 核对真实门禁与 GitOps 邻居 |
| minisandbox/CLAUDE.md@df2af17b | 测试规则 | 不新增模块 mock，不重编 workerd |
| minisandbox/infra/cells/AGENTS.md@df2af17b | 云操作规则 | 续接旧任务，保留失败、不重复 mutation |
| minisandbox/infra/cells/deploy/tencent/fleet/README.md@df2af17b | 操作边界 | 守住 qualification 共享锁 |
| minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md@df2af17b | 完整目标 | 本修复是中央发布前置，不代替其他门禁 |

## evidence

- 源码与 source receipt 已经 COS 中转并在 builder 哈希验真。
- 原 native 失败日志已通过官方工具下载并验证哈希；错误是四个测试模块导入失败。
- 新的 relocated-source 回归先复现同一导入失败，修复后真实执行通过。
- 正式入口再次执行，23 项 Workers API 测试与 15 项 GitOps 测试全部通过。

## risks

- 不通过隐藏 stderr 或直接跳过测试规避失败；原失败证据保持不变。

## validation

- 真实 relocated-source 回归、Workers API 正式门禁、shell/Python 编译、diff、Context/文档门禁。

## decisions

- 在受控源码 cwd 使用模块名称执行 unittest，避免绝对文件路径解析差异。

## scan_scope

- Workers API verify/test、fleet verify、native verification 日志的诊断白名单。

## scan_output

- 仅输出测试名称与 ModuleNotFoundError，不输出任何凭据。

## handoff

- 本地修复与回归通过；待推送后以新 reviewed source 在 builder 重跑，不复用旧失败源码身份。
- A 资格原句柄已成功结束，07:13 UTC 只读观测确认 A/B Hub 与 Spoke 均 Ready，
  两 Cell 各自 MachineSet/Host 4/4，无 hold、无缩容 intent，共享操作锁已释放。
- 独立 ACK 断线门禁使用现有精确 reviewed source，结果另行记录，不替代本源码门禁；
  不与容量负载或 C 发布并发。
