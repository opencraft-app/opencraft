---
id: minisandbox-controller-artifact-2026-10-04
type: task
scope: 从mono2完整Go subtree准备独立Host拓扑修复controller的可审计制品。
triggers: ["minisandbox controller artifact", "独立controller制品", "Go源码包交付"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/controller/build-image.sh
  - minisandbox/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/build-controller-via-tat.sh
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

交付包含UID/RV adapter和安全help入口的独立Go controller候选镜像；不重编workerd/V8/Rust。
只准备制品，不修改Cell workload/RBAC/replicas、不停止原strict10k supervisor或绕过operation lock。
OCI构建成功也不等于TKE eviction/Actor generation/实际缩容或全Phase5资格。

## requirement_ids / requirement_refs / requirement_excerpt

- stateless/DO/跨Cell正式设计Phase5：真实低容量扩缩容未通过，A111Host阻塞须修复。
- infra/cells AGENTS：完整source manifest、registry digest、normal grace/UID/PDB、受锁release。
- 用户：全部新工作在/data；COS中转源文件；不能因controller改动重编workerd。

## interface_refs / data_structure_refs

- sourceRevision是mono2完整commit，scope是该commit的完整minisandbox/infra/cells Git tree。
- 导出到infra/cells/，manifest覆盖全部regular tracked files；不依赖工作目录改动或记忆subset。
- 标准build-image.sh验证Go module graph与manifest、record-product-image.py冷拉验证registry digest。
- 标准COS relay只传content-addressed artifact，temporary registry authority沿用既有wrapper流程。
- source_link严格绑定/data下revision+manifest canonical路径，不接受任意目录或旧current指针替代。

## history_context / acceptance / affected_paths

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：dc81855c adapter，ab06a7e4真实本机primitive，03e7e7b7安全help及image probe。
- superseded_refs：旧q01默认registry与current source link不能当本次北京builder的事实。
- 验收：实际builder工具/空间/base graph，源码包exact manifest与Git scope，候选OCI/helper gate，
  非敏感receipt；wrapper新增source-path接受/拒绝测试，context/文档/impact/secret门禁。
- 路径：build wrapper及测试、controller README、正式设计、Task/catalog、非敏感制品证据。

## required_context / context_receipt

| 文件 | 原因 | 用途 |
|---|---|---|
| AGENTS.md@03e7e7b7 | 根P0继承全文 | mono2、FF push、秘密边界 |
| docs/context/domains/release-gitops.md@03e7e7b7 | route must_read全文 | 构建不等于发布 |
| docs/context/project/upstream-subtrees.md@03e7e7b7 | route must_read全文 | 唯一mono2 Git源 |
| docs/context/project/adjacency/argocd-ci-secrets.md@03e7e7b7 | 全文邻接卡 | release-runtime.sh及相邻测试 |
| minisandbox/infra/cells/AGENTS.md@03e7e7b7 | 全文 | 不改持锁qualification，不跑physical restore |
| controller/build-image.sh及Dockerfile.actor-fleet-controller@03e7e7b7 | 上轮已全文读 | 独立Go路径及模块base绑定 |
| qualification/actor-bj-q01/relay-upload-to-builder.sh@03e7e7b7 | 全文 | COS relay、签名URL不输出、exact byte/hash |
| qualification/actor-bj-q01/build-controller-via-tat.sh@03e7e7b7 | 上轮全文 | 严格source link、temporary push token与cleanup |

## evidence / risks / validation / decisions

- 上轮为progress：03e7e7b7已push，CLI/race/vet/发布preflight门禁通过；cloud未发布。
- jj vmwmkyuw在本轮任务读取前创建，保留空父e018e986。cloud-environment及Docker/network参考
  已完整读；environment_status不可用、policy缺失不证明ready；沿用configured credentials/TLS。
- runtime-builder历史publication指出ops ins-55ry1kb1、guest ins-mh9mruw7，只作定位，不作live readiness。
- inv-d9fgkp06rj SUCCESS/0：22:45:56Z原unit同InvocationID/PID，A111/115、B4/4、active0。
  ops有buildah/python3.11/git，/data实际在root文件系统且剩余约18.4GB，不能套用runtime builder
  的500GB证据。只准备2.8MB Go源码，不做Rust或V8构建，不清旧缓存/扩云资源。
- inv-c9fgna0mx3 SUCCESS/0：ops无active Go/buildah进程；两个cached Go base的module label均
  匹配本次完整Go subtree。所选base/digest放制品receipt，不抄到Task。
- 全Git subtree导出1310个regular files，2,826,525字节bundle，manifest逐文件校验通过；
  导出来自已提交03e7e7b7，不包含当前Task/helper工作区修改。
- wrapper新增/data canonical source路径；2项测试通过（10种路径），任意路径、嵌套/..、
  wrong revision/manifest在mint credentials前拒绝；新temporary auth路径也在/data。
- 已核验03e7e7b7的Go subtree没有symlink/submodule，仅regular Git modes；归档全tree。
- source export/build只涉及Go controller，不启动TKE probe Pod或Cloud rollout；原repair flag仍false。
- inventory只读字段没有relay输出；本地当前management.create.tfplan.json的单项
  bootstrap_relay_bucket output提供模板identity，标准COS helper的exact-key stat/PUT验证访问。
  inv-c9fgxtg1mq SUCCESS/0：2.8MB源码包COS中转成功，remote exact bytes/hash一致。
- stage inv-d9fh0cgq49 FAILED/1：归档的./前缀被过严scope校验拒绝，未解包或构建。
  只规范化安全相对path，仍拒绝parent/absolute/link/重复/超限member；
  inv-d9fh0vgh46 SUCCESS/0：1310源文件、Git tree、manifest、完整closure及8GiB reserve通过。
- inv-d9fh0d0ge9 SUCCESS/0，22:58:34Z原unit同InvocationID/PID；A111/115、B4/4、active0。
  原load FAILED、cleanup PASSED不变；下一常规观察不早于23:03:39Z。
- standard build原句柄inv-d9fh1a0su6 SUCCESS/0：registry/private DNS、module verify、三个Go包
  测试、四个Go binary编译、OCI标签、TCR push、isolated cold pull与product receipt均通过。
  未编译workerd/Rust/V8；inv-d9fh3t05kb SUCCESS/0验证exact auth文件删除，local trap也清理。
- product receipt经标准tat-download exact bytes/hash获取（inv-d9fh4509d2、inv-c9fh45gh0r），
  与仓库evidence逐字一致，product-lock验证通过；见controller/evidence，不复制digest到Task。
  inv-c9fh45gh0p只读表明local Buildah manifest与registry digest不同，因此只能使用回执后者。
  这不是OCI runtime probe，更不是TKE发布；本轮未运行任何TKE probe Pod。
- 2项新source-path测试、5项product cold-pull测试、9项相邻release测试及TAT helper tests通过。
  文档零errors/warnings；context26测试仍同4项历史失败，audit33测试通过。
  当前context4970 errors与前轮排序数组cmp完全相同；audit仍needs_agent_review/Unknown。
- final文档仍零errors/warnings，shell语法及显式变更impact门禁通过；未修改全仓历史catalog。
- inv-d9fh59ghn5 SUCCESS/0，23:03:47Z原unit同InvocationID/PID仍active；A111/115、B4/4、
  active0，原load FAILED/cleanup PASSED不变。下一常规观察不早于23:08:52Z。
  未提交重复负载，也未通过direct replicas、delete、repair开关或release去绕过持锁supervisor。

## checkpoint / handoff

- 续跑定位：inv-d9fgtng45u虽SUCCESS/0，输出实际为remote rg缺失，不能当定位成功。
  改用bounded find的inv-c9fgw60ujq找到management.inventory.json；只读relay字段的
  inv-d9fgwhg6k2及inv-c9fgwsgcjk为空，不得猜旧bucket。扩大到该inventory schema及input目录。
  历史publish-intent路径已不存在；inv-e9fgqtgwuh FAILED/1，不依赖旧临时路径。
- stage：独立Go候选制品完成；verified：源码/Go test/OCI/registry cold pull；
  unverified：实际TKE eviction/Host fencing/A拓扑修复/full Phase5；cloud发布仍未执行。
- restore：vmwmkyuw、原supervisor immutable handle、只读inv-d9fgkp06rj；不得duplicate mutation。
- next_action：收集final context/catalog/secret门禁并FF push证据；原supervisor退出并释放lock后，
  才进入既有串行release路径和TKE真实fault gate，不以镜像成功自动开启repair。
