---
id: minisandbox-topology-repair-delivery-2026-10-04
type: task
scope: 为独立Go Host drain控制器补齐无副作用入口及发布镜像预检。
triggers: ["minisandbox topology repair delivery", "Host drain发布预检", "独立Go镜像预检"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/cmd/workerd-host-drain-controller/main.go
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/release-runtime.sh
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

将已实现的拓扑修复controller纳入独立Go镜像的安全交付门禁，不重编workerd。
不发布云image/RBAC/配置，不中断当前supervisor，不缩小stateless/DO/跨Cell总体目标。
本轮不声称修复A111Host实际缩容；本地APIprimitive不等于TKE资格。

## requirement_ids / requirement_refs / requirement_excerpt

- 正式stateless/DO设计Phase5、infra/cells AGENTS：源码不等于发布，operation lock串行。
- 镜像需在变更live Deployment前验证全部新增入口，预检不得连接K8s/读取Secret/启动协调。
- repair flag默认false，PDB与UID/RV、Actor generation等真实资格门禁保持不变。

## interface_refs / data_structure_refs

- workerd-host-drain-controller CLI，policy/v1 Eviction adapter；runtime release的controller image
  使用RIVET_REPORTER_IMAGE独立digest，与统一rivet-runtime分离。
- build-image.sh核验模块图及manifest，Dockerfile.actor-fleet-controller只编译Go。
- preflight-image-pull.sh在控制节点运行精确digest入口，不把help提升为迁移/缩容证明。

## history_context / acceptance / affected_paths

- current_design_refs：2026-09-22-stateless-workers-durable-object-routing.md。
- relevant_evolution：dc81855c adapter；ab06a7e4真实k3s primitive 11项通过、claimEligible=false。
- superseded_refs：不能运行无help的旧Host drain二进制来代替安全预检。
- 验收：CLI帮助在InClusterConfig前return；未知参数fail closed；发布预检顺序及精确输出测试；
  Go race/vet、真实本机binary帮助、shell语法、文档/context/impact/secret门禁。
- 路径：cmd入口/测试、release-runtime.sh、相邻发布测试、正式设计、Task/catalog。

## required_context / context_receipt

| 文件 | 原因 | 用途 |
|---|---|---|
| AGENTS.md@ab06a7e4 | 根P0继承已全文读 | 唯一mono2、FF push、秘密边界 |
| docs/context/domains/release-gitops.md@ab06a7e4 | route must_read全文 | 源码/交付/资格分开 |
| docs/context/project/upstream-subtrees.md@ab06a7e4 | route must_read全文 | 不改旧独立仓库 |
| docs/context/project/adjacency/argocd-ci-secrets.md@ab06a7e4 | 全文邻接卡 | 查实际manifest和发布测试 |
| minisandbox/infra/cells/AGENTS.md@ab06a7e4 | 全文操作契约 | operation lock、正常grace、无cloud并发变更 |
| minisandbox/infra/cells/deploy/tencent/fleet/controller/build-image.sh及Dockerfile.actor-fleet-controller@ab06a7e4 | 独立镜像源码全文 | 不调用workerd/Rust编译 |
| minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_partition_runtime_manifest.py@ab06a7e4 | 相邻测试全文 | rollout前预检顺序 |

## evidence / risks / validation / decisions

- 上轮为progress：ab06a7e4已push，真实k3s primitive通过、fixtures清理；cloud未改。
- 本轮jj kqqstvrz在任务读取前创建，保留空父61f3af42。技能cloud-environment全文及network参考
  已读，environment_status不可用、policy缺失不证明ready，沿用已有credential selector和TLS。
- inv-e9fgbr0pbp SUCCESS/0，22:36:31Z原unit同InvocationID/PID仍live，A111/115、B4/4、active0。
  下一常规观察不早于22:41:35Z。原load failed/cleanup passed不变，不提交重复producer。
- 发布源只有capacity-controller和cell-reporter预检，Host drain缺失；main无CLI帮助会尝试
  InClusterConfig。新增帮助必须在任何K8s/Secret/信号处理之前执行。
- 有界搜索未找到runtime/manifests/runtime-host-drain.yaml和runtime/runtime-host-drain.yaml；
  installer实际委托install-host-autoscaling.sh及host-autoscaling.yaml，按rg --files定位。
- Go CLI/hostdrain race通过，9项相邻发布测试通过，bash语法通过。帮助出口在main子进程
  缺少Kubernetes endpoint/Cell配置时仍exit0，未知或混合参数拒绝且不回显值。
- release新增第三个Host drain image probe，精确Usage作为required output，不等于云gate。
- 本机实际CGO-disabled controller二进制--help exit0，25,780,408 bytes，仅Go编译；vet通过。
  3项preflight helper测试通过，含缺少required output时拒绝旧CLI；Dockerfile纳入CLI测试。
  本机未缓存actor-fleet构建base，没有绕过凭据或TLS去拉镜像，不声称OCI构建通过。
- 文档零errors/warnings；context26测试仍同四个历史失败，audit33测试通过；显式9路径
  impact门禁通过（未匹配rule，仍主动更新正式设计）。不把discovery视为生产资格。
- 新Task修正trigger最小3项后零错误，4970历史errors排序数组与前轮完全cmp一致；
  catalog只新增自己且hash绑定最终Task。8个变更文件及新增row credential模式扫描通过。
  audit仍needs_agent_review/not_assessed/Unknown，不宣称全仓成熟度通过。
- inv-c9fgfn0htx SUCCESS/0，22:40:30Z A111/115、B4/4、active0，原unit同InvocationID/PID。
  此次只读提交比5分钟间隔早约50秒；后续必须先查时钟，下一常规提交不早于22:45:45Z。
  没有提交新负载或做cloud mutation；原load failed/cleanup passed不变。

## checkpoint / handoff

- stage：独立controller交付源码整改；verified：云进程live、本地primitive。
- unverified：TKE API实际fault gate、controller镜像交付、A拓扑修复与strict10k资格。
- discard：不存在的猜测路径；restore：kqqstvrz、原strict10k immutable handle。
- next_action：收集最终context/catalog/secret门禁并FF push源码。后续通过既有受锁流程
  交付独立controller OCI、TKE真实门禁及缩容；本轮不启动cloud rollout或workerd编译。
