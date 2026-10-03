---
id: minisandbox-real-eviction-api-2026-10-04
type: task
scope: 用隔离的真实k3s API验证Host UID/RV eviction、PDB与取消前置条件。
triggers: ["minisandbox real eviction", "真实驱逐门禁", "PDB取消竞态"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/internal/hostdrain/topology_kubernetes_test.go
  - minisandbox/infra/cells/deploy/local/mesh/workerd-host-eviction-api-e2e/README.md
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

让实际API server验证PDB拒绝、迟到eviction被取消CAS阻断、RV/UID前置条件、
正常eviction后的同名新UID不继承旧取消操作。生成绑定server version与exact fixture的receipt。
不改云image/RBAC/replicas，不中断原supervisor、不重编workerd，不宣称本地API等于TKE资格。
本测试仅有pause容器和Host stats double，不能代替真实Actor迁移、generation或缩容资格。

## requirement_ids / requirement_refs / requirement_excerpt

- requirement_refs：正式stateless/DO/跨Cell设计Phase5安全缩容章节；infra/cells AGENTS。
- 摘录：UID/RV精确、PDB/正常grace、取消凭据先于unfence、不得强删或继承旧Pod操作。
- 上轮为progress：dc81855c已push源码adapter/capacity，21组测试通过，cloud开关仍false。

## interface_refs / data_structure_refs

- policy/v1 Eviction；DeleteOptions UID/RV；hostdrain State/取消token；AdmissionReview v1。
- 新建GenerateName namespace，所有fixtures绑定其UID/label；仅创建一份namespace限定webhook。
- 清理先移除exact webhook，再按UID正常清理自己的namespace，绝不操作既有Cell资源。

## history_context

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md的末尾缩容章节。
- relevant_evolution：24a7d42c纯FSM；dc81855c实际adapter源码但未发布。
- superseded_refs：HTTP double不证明真实API；普通DELETE webhook不能截获eviction内部删除。
- 官方v1.35.5 eviction.go明确内部Update/Delete使用ValidateAll，所以API CREATE eviction
  admission barrier只能证明condition之前的取消；condition之后RV删除前置条件另测，
  不伪称观察到真实server内部两次存储调用之间的barrier。

## acceptance / affected_paths

- 使用已运行local hub k3s v1.35.5和缓存digest pause，禁止自动创建/重启集群。
- PDB429保留Pod；真实迟到eviction冲突；metadata CAS proof从GET读取；新UID拒绝旧操作。
- 精确fixture UID及正常grace、TLS校验保留；无business数据；cleanup可审计。
- 仅测试文件、独立E2E目录README、Task/catalog及正式设计。

## required_context / context_receipt

| 文件 | 原因 | 用途 |
|---|---|---|
| AGENTS.md@dc81855c | 根P0继承已完整读 | 唯一mono2、无强推、授权门禁 |
| docs/context/project/upstream-subtrees.md@dc81855c | route must_read已完整读 | 不编辑旧独立仓库 |
| minisandbox/infra/cells/AGENTS.md@dc81855c | 已完整读 | PDB/UID、operation lock、无cloud变更 |
| docs/context/project/adjacency/argocd-ci-secrets.md@dc81855c | 已完整读 | 源码不等于发布 |
| minisandbox/infra/cells/deploy/local/mesh/workerd-host-drain-e2e/README.md及test_run.py@dc81855c | 相邻测试 | 新API门禁独立，不运行旧修改Node/Host的suite |
| minisandbox/infra/cells/internal/hostdrain/topology_adapter.go@dc81855c | 精确源码 | 使用同一controller adapter方法 |
| minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md@dc81855c | 正式范围 | 不缩小整体目标或开生产资格 |

## evidence / risks / validation / decisions

- jj ttpxokvl在任务读/计划前创建，保留空父3bebb596。
- cloud-environment技能、Docker/networking参考全文已读；environment_status不可用，policy缺失
  不证明ready。保留Docker配置、代理和TLS，显式只访问本机unix socket。
- 本机k3d hub/A/B均运行；hub真实server为v1.35.5+k3s1。pause缓存exact image digest
  记录在独立E2E receipt的image字段，不重复抄录到Task。
- webhook使用本地bridge172.18.0.1，证书带精确IP SAN并提供CA bundle；不关闭TLS验证。
- 客户端仅接受loopback API、k3d-rivet-mesh-hub context；不读取/输出kubeconfig/token。
- 真实API门禁必须记录哪些interleaving真的发生；未观测内部condition/Delete窗口不作完成声明。
- 门禁：integration测试、全hostdrain race/vet、文档/context/impact/有界secret扫描。

## checkpoint / handoff

- 第一轮fixture使用旧PDB RV更新失败；第二轮真实取消409与post-condition stale DELETE
  已通过，但30秒等待PDB恢复失败。按官方disruption controller实现，reservation保留2分钟。
  第三轮改为自然等待150秒，不清DisruptedPods，不放宽PDB；真实API门禁143.35秒通过。
  11项checks全部true，自己的namespace/webhook已正常移除；receipt已归档独立E2E目录。
- cleanup提前注册到namespace创建后，UID校验的RetryOnConflict仅用于fixture的metadata/spec；
  production eviction不会因此自动重试。两次失败后的namespace/webhook均正常移除。
- 一次race命令误写不存在的runtimeadmission包（hostdrain/runtimecapacity自身通过），
  正确包为internal/runtimecapacity/admission；重跑三包race均通过，integration vet亦通过。
- inv-a9ffwp02h3 SUCCESS/ExitCode0，2026-10-03T22:22:33Z样本A/B Hosts111/4、Machines115/4，
  active0；原unit同InvocationID/PID。两Cell真实server均v1.30.0-tke.22，不是本地1.35.5。
  upstream v1.30.0源码亦有UID/RV、condition RV更新和ValidateAll内部删除，不代替TKE实测。
- 原strict10k load failed、cleanup passed；不发布controller、不启动重复负载。
  整体stateless/DO/跨Cell目标仍active，cloud repair default仍false。
- inv-a9fg78gqwm SUCCESS/ExitCode0，22:31:41Z样本仍A111/115、B4/4、active0；无新增error。
  原systemd相同InvocationID/PID。下一次常规观察不早于22:36:46Z，不提交duplicate producer。
- 文档检查零errors/warnings；audit33测试通过。context26测试仍同四个历史失败，
  新Task零错误，4970历史errors排序数组与前轮完全cmp一致。显式六路径impact门禁通过
  （没有匹配rule，已主动更新正式设计）；credential模式扫描全部catalog命中历史行，随后
  限定实际五个变更文件及新增catalog row通过，不修无关历史。仅包含已核验image/source
  公共digest。catalog只新增自己Task；audit为needs_agent_review/not_assessed/Unknown。
- verified：真实API primitive；unverified：TKE实际gate、server内部condition/Delete故障注入、
  云发布、实际111Host拓扑修复与10k资格。discard：前两次fixture失败不作成功证据。
- restore：jj ttpxokvl，原supervisor immutable handle；next_action：完成本变更最终门禁、
  普通FF push源代码（不发布），继续在原锁边界内推进真实云资格。
