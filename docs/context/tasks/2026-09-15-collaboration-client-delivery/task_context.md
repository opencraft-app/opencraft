---
id: collaboration-client-delivery-2026-09-15
type: task
scope: LightVela Web产品发布入口与vela-computer候选制品交付准备。
triggers: ["collaboration client delivery", "lightvela web publish", "vela-computer artifact"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/package.json
  - opencraft/scripts/publish-workbench-web.mjs
  - vela-computer/scripts
  - .ci
status: active
reviewed_at: 2026-09-15
review_due: 2026-12-15
revision: 0.1.0
precedence: task
derived: false
---

# Collaboration 客户端交付准备

## goal
补齐可验证的客户端源码交付入口，保留产品/候选/正式上线的明确边界。

## non_goals
- 不恢复已取消的OpenCraft专用CI/MR guard，不合并npm与pnpm锁文件。
- 不创建DB/账号、写Secret、激活Argo或更新真实实例；不提交/推送/发布而未获确认。
- 不恢复外部Computer/TAT纳管，不改Human/Runtime/Computer身份、模型或OpenAPI。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户在后台/客户端尚未交付的状态说明后要求“继续”。
- 保持仅一个Collaboration后台，客户端为vela-computer，Web消费LightVela账户。

## interface_refs / data_structure_refs
- OpenCraft LightVela Web产物：apps/workbench-web/dist-lightvela-web。
- publishWorkbenchWeb保留hashed assets并最后切换入口；不得拿通用dist冒充产品包。
- vela-computer候选制品遵循版本、平台、SHA256SUMS，不默认激活更新/下发。
- Collaboration SSM六键及foundation/migration/runtime顺序保持不变。

## history_context
- current_design_refs: opencraft/docs/build-matrix.md、docs/engineering/domains/release-gitops.md。
- relevant_evolution: !4012迁移源码；!4021后台CI候选接线；!4023/!4022修复可信frontend guard。
- superseded_refs: Stream旧OpenCraft#4不是当前专用CI责任；旧TAT Buildx不作为正式下发依据。

## acceptance
- LightVela Web专用发布入口选择正确产品产物，保留通用Web入口。
- 候选制品可本地验证且不暗含实例下发/更新通道激活。
- 缺少DB/Secret/IM配置时保持未激活，不宣称用户可用。

## affected_paths
opencraft/package.json、相关发布测试/说明；vela-computer/scripts、.ci候选构建；正式发布设计。

## required_context
release-gitops、service-ci、service-opencraft、service-collaboration、service-vela-computer、site-environment-routing、agent-gateway-runtime、upstream-subtrees。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| docs/context/domains/release-gitops.md@2.0.0、project/services/ci.md@2.1.0 | 发布 | 源码/制品/GitOps/live分离 |
| docs/context/project/services/opencraft.md@1.0.0、opencraft/AGENTS.md | Web | 保留独立锁、取消专用CI |
| docs/context/project/services/collaboration.md@1.0.0、collaboration/AGENTS.md | 后台前置 | 不改模型/身份/迁移 |
| docs/context/project/services/vela-computer.md@1.0.0、vela-computer/AGENTS.md | 客户端 | 仅候选制品，不恢复TAT纳管 |
| docs/context/domains/agent-gateway-runtime.md@2.1.0、site-environment-routing.md@2.0.0 | 责任与地域 | 不把Web产物当Host/实例 |
| docs/context/project/upstream-subtrees.md@2.1.0、opencraft/MONO2_MIGRATION.md | 真源 | mono2唯一写入，不恢复旧仓库CI |
| .ci/AGENTS.md、opencraft/docs/build-matrix.md、config/build-matrix.json | 构建矩阵 | 独立产品产物与平台 |
| docs/context/project/adjacency/argocd-ci-secrets.md、.ci/runtime/tests/contract_tests/test_vela_computer_artifact.py | checkout修复邻接 | 候选仍只归档精确SHA，不增加部署/凭据路径 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md、references/verification.md | 维护 | 聚焦测试与实机边界 |

## evidence
当前master975b48ef5；此前只读核对Collaboration镜像#1成功、gitops无active catalog；本轮前置继续核对。

## risks
旧Linux构建强制TAT桥与更新签名材料，不能当新托管聊天客户端的正式下发；候选交付不冒充正式。

## validation
- Web发布测试9项、完整npm gate、LightVela Web release与产品边界检查通过。
- 使用错误通用build-root仍正确发布产品包到全新本地临时目录；438个hashed assets，不发布线上。
- 候选Go行为测试2项、真实Darwin ARM64候选构建、VERSION/二进制/元数据SHA256全部通过；sourceDirty=true且未资格化。
- Go首个高并发test中2项OpenClaw shell probe超时；隔离复验通过，限制-p2后完整test/vet/受影响race以及完整guard通过，不改probe超时或跳过测试。
- 完整CI runtime526项、物化smoke、shell/YAML通过；真实Linux构建/归档插件/Runtime Canary尚未执行。
- 文档validator通过；docs-impact需同时同步release-gitops与agent-gateway-runtime，已补相关产品/候选身份边界。
- docs-impact与staged diff check通过；Context26项仍有相同4项既有失败，catalog833项既有错误且本Task Pack无错误。Audit tests33项通过；discovery为needs_agent_review/not_assessed，不称完整评估通过。

## decisions
OpenCraft沿用现有Web本地发布契约，不恢复专用CI；明确产品产物入口。

## scan_scope
本轮修改的脚本、配置和发布说明，不读取/输出真实SSM内容。

## scan_output
本轮脚本、CI配置和发布说明限定范围扫描，不保存凭据或已解密内容。

## handoff
源码实施与本地验证完成；等待提交/推送/MR确认及北京运维机或kubeconfig通道。生产写入/线上发布均未执行。

## checkpoint
- stage: 源码与本地验证完成，尚未提交。
- verified: Web产品发布选择/完整gate，候选行为/原生构建/校验，Go guard，526项CI runtime。
- unverified: Linux候选归档插件、Runtime/IM Canary、北京DB/SSM/IM真实值、Argo和用户可用。
- next_action: 用户确认提交源码；补充北京只读运维通道后核对正式前置，不创建DB实例。

## 候选checkout失败后续

- 用户要求修复候选#2拉代码失败，尚未授权重跑/清理真实CI缓存或部署。
- 缺父对象与浅克隆边界不一致为优先诊断，远端仓库损坏未被证明；修复聚焦复用checkout。
- checkout前内联status/rev-list/fsck检查，健康full与合法shallow保留；仅普通.git私有隔离，拒绝链接/共享gitdir，工作树与业务文件不动。
- checkout后执行任何源码脚本前核对ci.sha与HEAD连通性，不依赖未拉取仓库中的修复脚本。
- RED：真实Git fixture确认缺父对象，因缺pre-checkout步骤而失败；GREEN为3项真实Git测试/6个case，重新depth1 fetch/checkout成功且业务文件保留，正常full/shallow与共享gitdir边界符合预期。
- 完整CI runtime529项、物化smoke、shell/YAML与文档检查通过；真实CI重跑尚未执行，待提交确认。
- Context receipt沿用本Pack，并追加argocd-ci-secrets邻接核对mr-placeholder既有index恢复与候选checkout。

## 预检通过但fetch失败后的修正

- #4实际执行43b6b8bf6预检，日志报告连通性有效；随后SDK depth1按SHA增量fetch仍报相同父对象缺失。MR占位检查已成功，不改其可信语义。
- 用户确认新策略：候选每次隔离全部复用普通.git元数据并fetchDepth=0，全量从空对象库拉取；正常浅缓存不再保留复用，不删除业务文件，仍拒绝链接/共享gitdir。
- RED：旧策略在健康full/shallow fixture仍留.git，且depth仍为1；新回归按目标策略失败。
- GREEN：5项Git回归通过，包括健康full/shallow也隔离、缺父对象后fresh full fetch与父提交可读、空checkout和共享gitdir边界；完整CI runtime531项、物化smoke、shell/YAML/文档通过。

## 全量checkout的旧工作树冲突

- 061ed8a0已推送!4028；候选#6于2026-09-15 17:06:17运行，准备成功2秒，拉取45秒后因`untracked working tree files would be overwritten by merge`失败；尚未执行源码校验/构建。
- 新错误不同于缺父对象，不据此宣称完整checkout已恢复。仅移动.git留下本分支新增源码，基线checkout后merge目标提交会拒绝覆盖。
- 本版取代之前“工作树/业务文件不动”的操作细节：仅候选CI工作目录内，旧工作树及元数据一起私有移动、不删除；业务文件和制品可从隔离目录worktree恢复。无.git遗留也处理，旧隔离目录原位保留，不跟随外部symlink；shared gitdir仍拒绝。
- RED：真实Git基线checkout再ff-only merge复现相同untracked冲突；原强制目标checkout测试漏掉了这个路径。
- GREEN：8项真实Git回归、完整CI runtime534项及物化smoke/shell/YAML通过；文档、docs-impact、限定范围凭证扫描、diff check通过。
- Context仍833条错误（本Pack为0），Context tests26项中4项失败；Audit发现结果needs_agent_review/not_assessed，不称完整Context验收。未手动重跑、清理真实CI缓存、提交/推送新版本或部署；真实SDK新版本仍待CI验证。
- 真实CI重跑/恢复尚未证明，待源码验证及推送确认；不合并、不部署。
