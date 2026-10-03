---
id: minisandbox-tke-eviction-gate-2026-10-04
type: task
scope: 为独立Go拓扑修复准备精确身份绑定的真实TKE API primitive门禁。
triggers: ["TKE eviction gate", "cloud UID RV fixture", "云驱逐取消门禁"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/internal/hostdrain/topology_kubernetes_test.go
  - minisandbox/infra/cells/internal/hostdrain/topology_tke_test.go
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

把真实PDB/UID/RV primitive门禁接到单独、明确授权的TKE入口，保持原local loopback guard。
当前持锁阶段只实现/离线测试，不在A/B创建fixture、不部署controller、不打开repair开关。
不重编workerd、不缩小完整stateless/DO目标、不把pause/stats double称为Actor迁移资格。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式stateless/DO跨Cell设计Phase5安全缩容：本机1.35.5不证明实际TKE1.30.0行为。
- user continuation：保持原strict10k不可变句柄，持锁期间不重复producer或运行云probe。
- 真正发布前须验证精确server行为；测试不允许任意kubeconfig或记忆Node名称。

## interface_refs / data_structure_refs

- policy/v1 Eviction、UID/RV、PDB429、authoritative cancellation GET。
- 独立strict JSON intent绑定API endpoint/context、kube-system UID、server版本、control Node UID/
  provider ID、私有callback IP、已锁定镜像与实际adapter source hashes；不存Secret。
- 同一primitive fixture helper，local独立入口继续loopback/context/single-node检查。
- 正常exact UID cleanup、TLS CA/SAN、scope限定新namespace、claimEligible=false。

## history_context / acceptance / affected_paths

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md缩容章节。
- relevant_evolution：ab06a7e真实k3s primitive通过；03e7e7b7 Go controller制品未发布。
- superseded_refs：本地receipt不能当TKE资格，source/candidate不能当cloud release。
- 验收：strict intent/identity失败在任何mutation前被拒绝；local guard不放宽；Go integration
  compile/race/vet与source hashes；cloud运行入口必须whole-operation lock、禁止skip变通过。
- 影响：hostdrain integration tests、独立fleet qualification目录、正式设计、Task/catalog。

## required_context / context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md及infra/cells/AGENTS.md@c09a3a7a | 全文 | 唯一mono2/operation lock/无强删 |
| release-gitops.md及upstream-subtrees.md@c09a3a7a | route全文 | source/primitive不是release |
| adjacency/argocd-ci-secrets.md@c09a3a7a | 全文及local README邻居 | 门禁邻接与source定位 |
| topology_kubernetes_test.go@c09a3a7a | 563行全文 | 原local guard及全部race primitive |
| local/mesh/workerd-host-eviction-api-e2e/README.md@c09a3a7a | 全文 | local claim边界 |
| 2026-10-04-minisandbox-real-eviction-api.md@c09a3a7a | 全文 | 两分钟PDB自然恢复历史 |

## evidence / risks / validation / decisions

- 前轮progress：c09a3a7a已FF push；缩容超时失败回执63+5回归通过。当前干净工作副本保留历史。
- cloud-environment技能/network参考全文；environment_status不可用/policy缺失不证明ready。
- 当前完整2757 inventory含observability-busybox immutable ref，可运行纯sleep fixture，
  不新增foundation镜像或依赖public pause镜像；该容器不运行Actor。
- local门禁不能通过改context/loopback检查来复用到TKE，改为独立entry共享已验证primitive helper。
- 实际cloud reachability、TKE调用及真实Actor/目的AZ/最终111Host缩容均未验证。
- parser重复JSON key红测试失败后，增加bounded nesting及recursive duplicate拒绝；19种
  不完整intent及14种live target场景验证失败只GET，不mutation。policy race及full hostdrain
  integration-tag race通过，vet通过。未配置的两个实际API entry均SKIP，只作compile证据。
- shared helper正常webhook UID cleanup更严格，receipt改O_EXCL0600、增加前后Node UID检查。
  真正local hub回归147.43秒通过，12 checks、own namespace/webhook正常移除，仍claimEligible=false；
  receipt已归档local evidence目录。不把local回归称为TKE或Actor资格。
- actual whole-lock/source/receipt wrapper的8项离线回归通过；Go skip/非零exit/held lock/
  source extras/已有receipt被拒绝。SDK仍Go-only，无workerd/Rust build或云fixture。
- inv-c9fici0cqh SUCCESS/0（23:45:40Z），inv-c9fihwgn89 SUCCESS/0（23:51:26Z）：原unit
  同InvocationID/PID仍active，A111/115、B4/4、active0。下一观察不早于23:56:31Z。
- P0输出边界失误：本机k3d raw JSON意外包含join token，已向用户披露；未复制到源码、
  回执或catalog。后续仅白名单字段，不复述值。旋转需独立维护操作，未自动更改集群。
- 续接inv-a9fipa0d58完成SUCCESS/0，23:57:09Z原unit仍同InvocationID/PID active；
  capacity采样23:56:55Z仍A111/115、B4/4、active0，无缺失metric或warning。
- context单测26项仍相同4个历史失败；context-audit单测33项通过。discovery只给
  needs_agent_review/not_assessed/Unknown，不伪造完成评测或成熟度得分。
- documentation校验0错误/警告；context错误列表4970项与前轮逐项一致，新Task无错误。
  actual local receipt与归档字节一致；wrapper可执行权限已补齐，不改实际运行句柄。

## scan_scope / scan_output

- hostdrain/topology_kubernetes_test.go及local fixture README、controller release邻居，有界rg。
- local run.sh不存在，已明确记录失败locator；不据此扩大到credential或业务日志。
- catalog首次locator误用docs/context/catalog.jsonl而失败；按validator精确定位到
  docs/context/.context/catalog.jsonl，只追加本Task记录，不重写历史条目。

## checkpoint / handoff

- stage：受锁TKE入口source prepared，local shared fixture真实复验通过。
- verified：readonly target guard、source/receipt wrapper及local 12 primitive检查。
- unverified：cloud callback/gate、真正Actor/目的AZ缩容及完整Phase5；join token需独立维护。
- next_action：完成source/context/impact/secret门禁与授权FF push；下一观察不早于00:02:14Z，
  继续同原handle观察，
  不执行云fixture或发布。锁释放后才运行独立TKE primitive，随后还需完整业务资格。
