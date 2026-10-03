---
id: minisandbox-controller-promotion-2026-10-04
type: task
scope: 将独立Go controller候选绑定当前完整制品依赖锁并隔离不同构建回执。
triggers: ["controller promotion", "controller build intent", "完整制品锁晋级"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/gitops/image-seed/product-lock.py
  - minisandbox/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/build-controller-via-tat.sh
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

让candidate符合当前2757 runtime的完整制品锁。构建成功不等于可晋级，更不等于TKE发布。
不放宽base/dependency/UID/PDB门禁，不重编workerd、不改Cell或停止持锁supervisor。

## requirement_ids / requirement_refs / requirement_excerpt

- stateless/DO正式设计Phase5；独立Go controller受同一完整制品锁和串行release合同约束。
- 不得使用老bootstrap input代替当前release inventory；revision、manifest不足以区分bases/tag。

## interface_refs / data_structure_refs

- product-lock.promote只接受与完整inventory逐字匹配的base refs，foundation变更须全generation。
- controller product receipt以source revision、manifest、两base和unique tag的build-input hash隔离。
- 仍保留原immutable invocations、temporary auth双cleanup、cold pull和write_new拒绝覆盖。

## history_context / acceptance / affected_paths

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：bdd7a1e9成功构建候选；实际current lock的base不匹配，候选不能直接晋级。
- superseded_refs：bootstrap/desired-native旧inventory不是当前runtime2757 inventory。
- 验收：不同base/tag产生不同回执、完整mock wrapper无网络；exact current inventory晋级通过，
  除controller外所有refs/metadata保持不变；候选测试/冷拉、文档/context/impact/secret门禁。
- 路径：build wrapper及测试、controller README/evidence、正式设计、Task/catalog。

## required_context / context_receipt

| 文件 | 原因 | 用途 |
|---|---|---|
| AGENTS.md及infra/cells/AGENTS.md@bdd7a1e9 | 上轮全文已读 | 唯一mono2及whole-operation lock |
| release-gitops.md及upstream-subtrees.md@bdd7a1e9 | 本轮route全文 | 不把source/OCI当cloud release |
| adjacency/argocd-ci-secrets.md@bdd7a1e9 | 本轮全文 | 检查release-runtime及binding邻居 |
| topology_kubernetes_test.go@bdd7a1e9 | 本轮前540行 | 本地保护不得放宽成TKE资格 |
| product-lock.py及bind-inventory.sh@bdd7a1e9 | 本轮晋级/binding实现 | exact dependency contract |
| build-controller-via-tat.sh及build-image.sh@bdd7a1e9 | 上轮全文 | immutable source及回执 |

## evidence / risks / validation / decisions

- 上轮是progress：Go候选实际构建/冷拉，bdd7a1e9已push。本轮jj yuynlszx在读取前创建。
- cloud-environment技能及network参考完整读；environment_status不可用/policy缺失不证明ready。
- inv-a9fhae0a6c SUCCESS/0：23:09:16Z原supervisor同InvocationID/PID仍live，A111/115、B4/4、
  active0。下一常规观察不早于23:14:21Z；load FAILED、cleanup PASSED不变。
- inv-c9fh9rgqpi旧input/desired-native inventory只含旧runtime；不是当前晋级基线。
  inv-a9fhaeguxj bounded locator仅列旧metadata；inv-d9fhatg69p未找到假设的2757目录。
  bounded本机release script定位实际runtime-admission目录，未读取凭据值。
- inv-d9fhbj04uk SUCCESS/0：实际2757 inventory匹配已qualified runtime，base为7aecd68f；
  上轮候选base ab0d6ffd虽module graph相同仍不匹配。严格promotion应拒绝，不改foundation。
- current receipt路径仅revision+manifest；换base/tag会撞已有receipt，必须加入完整build-input hash。
- exact runtime2757全inventory经standard tat-download获取，原候选实际promotion因base-golang
  mismatch退出、没有产生output；不得将raw bootstrap input的老runtime当作当前qualified版本。
- 新回执input hash包含source/manifest/两bases/tag；相同intent保持同path，existing receipt在
  build/push前拒绝。3项wrapper测试通过（10项path场景+5次完整mock构建），无真实credential/TAT。
  9项product-lock回归通过，保留foundation mismatch拒绝语义。
- inv-c9fhe80p7p FAILED/1：源树closure多了上轮product-lock/image_contract导入缓存。
  该caller缺少set -e，仍提交了原构建句柄inv-c9fhejgaai；不将失败stage称为成功，
  tracked manifest未变，额外文件是Python缓存、不在Go Dockerfile COPY输入内。
  等原构建结束后只迁移已确认的两项派生缓存，再严格重验closure；不duplicate build。
- inv-a9fhf4gdc6 SUCCESS/0只读证实恰为两项Python pyc；wrapper新增PYTHONDONTWRITEBYTECODE，
  mock门禁验证在Python调用前设置。当前构建提交在该修正前，完成后仍需source hygiene复核。
- inv-c9fhejgaai SUCCESS/0：current-base Go tests/build/push/cold pull/product receipt通过。
  本机waiter却exit2：等待期间编辑其执行文件造成EOF parse错误。不能伪称wrapper整体通过，
  也不能duplicate remote build；后续helper从frozen snapshot执行。
- inv-c9fhiu0dvx SUCCESS/0：exact temporary auth不存在；local protected state也为空。
  两项自己的derived pyc移至可恢复quarantine，未删用户数据；inv-c9fhjbgat7 SUCCESS/0
  重验1310 tracked source、全部metadata/manifest、无extra closure及8GiB reserve。
- new product receipt标准tat-download exact bytes/hash验证（inv-d9fhiugr0e、inv-e9fhiv0v2d）；
  与仓库current-lock evidence逐字一致。完整真实28项inventory promotion通过，只controller变化，
  其余27项及其他root metadata保持不变。target仍仅/data/tmp staged，不是cloud desired state。
- inv-e9fhfmgwq8 SUCCESS/0：23:14:51Z原unit同InvocationID/PID仍live，A111/115、B4/4、active0；
  下一常规观察不早于23:19:56Z，未做TKE probe、Cell/RBAC/replica mutation或开启repair。
- final文档零errors/warnings；context26测试同4个历史失败、audit33测试通过；4970历史errors
  排序数组与上轮完全cmp一致，new Task零错误，audit仍needs_agent_review/Unknown。
- inv-e9fhmq0wn6 SUCCESS/0：23:21:20Z原unit同InvocationID/PID仍active，A111/115、B4/4、active0；
  下一常规观察不早于23:26:25Z。不停止、不复制producer、不改变lock或qualification verdict。

## checkpoint / handoff

- stage：当前制品链已对齐；verified：exact current-base candidate及staged leaf promotion。
- unverified：TKE/full Phase5仍未通过；cloud repair未发布、原supervisor仍live且持锁。
- next_action：完成final source/context/catalog/secret门禁与FF push；保持原句柄观察。
  待原whole-operation lock真正释放，再进入完整TKE fault gate和既有串行release路径。
