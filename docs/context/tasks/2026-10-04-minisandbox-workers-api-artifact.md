---
id: minisandbox-workers-api-artifact-2026-10-04
type: task
scope: 准备含安全日志及fetch/readiness修复的独立Go API制品。
triggers: ["安全API制品", "Workers API候选镜像", "API构建身份"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/workers-api/build-image-via-tat.sh
  - minisandbox/infra/cells/deploy/tencent/fleet/workers-api/test_build_via_tat.py
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-03
revision: 1.0.0
precedence: task
derived: false
---

## goal / non_goals

推进完整stateless/DO/CLS目标，准备带安全平台日志、保留fetch重定向及Registry故障不摘流
修复的Go API候选。不重编workerd/V8/Rust，不更新云Deployment、Argo、inventory或collector，
不改变原strict10k supervisor及36h窗口。制品成功不替代实际CLS正反查询或大规模资格。

## requirement_ids / requirement_refs / requirement_excerpt

2026-09-22-stateless-workers-durable-object-routing正式设计CLS接线要求安全API镜像先行。
Workers API产品README要求完整源码manifest、exact bases及registry cold pull回执；用户要求
工作在/data、COS中转、迭代先探索。已有TAT入口只以source命名receipt，改base/tag会撞旧文件。

## interface_refs / data_structure_refs / history_context

current_design_refs：上述正式设计CLS/Phase5、API生产README。
relevant_evolution：071c3d10安全平台JSON日志，913cb575保留重定向，0ad18383局部就绪。
superseded_refs：source身份可以单独当build身份；本机Buildah manifest代表registry digest。
source取已提交mono2完整infra/cells tree，不复制记忆subset；root依赖匹配当前2757完整lock。
API仍单独构建Go binary，制品ref不能从candidate直接授权云发布。

## acceptance / affected_paths

- source/manifest/base/base/tag的NUL分隔hash决定immutable receipt路径。
- 真实shell及CLI协议double证明五次操作的身份、提交次序和auth清理，不访问云。
- 禁止receipt helper生成Python派生文件；已有relocation验证继续消费新增回归。
- 有界源码export、manifest、标准COS relay、Go build及产品cold pull分别留独立证据。
- 改动API build wrapper/test/verify/README、正式设计、Task与自己的catalog行。

## required_context / context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| 根AGENTS、minisandbox/infra/cells继承AGENTS@362702d9 | 根当前全文，继承前轮全文且当前diff为空 | 不改原任务、独立Go制品和源码发布分开 |
| release-gitops及upstream-subtrees Pack全文 | router全部must_read | 源码不等于发布，mono2唯一源 |
| adjacency/argocd-ci-secrets及实际API verify/test | 邻接卡与邻居 | 部署与构建链回归 |
| API build wrappers、Dockerfile、product recorder全文 | 执行前检查 | 标准临时push权限、isolated registry pull |
| controller artifact Task、relay helper全文及current-lock receipt | 有界历史 | 复用Go tree导出与/data、选当前bases |
| cloud-environment主文及network/Docker参考全文 | 实际环境工具 | TLS/proxy/凭据边界，未提供status/policy不当ready |
| TASK/CHECKPOINT模板 | 任务契约 | 可恢复状态与未验证边界 |

## evidence / risks / validation / decisions

- 新submission回归通过五次fake CLI操作；下载/receipt validator在该测试中为协议double，
  不能用它宣称产品镜像存在或真实TCR cold pull通过。
- permanent verify入口纳入新增测试，relocation fixture也包含实际TAT helpers。
- 只构建候选，不用pull-only Kubernetes Secret作push授权；标准wrapper临时token双清理。
- 源码目录不能污染派生cache，不对比无关旧q01默认registry；本次使用当前目标inventory。
- 局部tests、Bash/diff、root文档/Context历史基线与敏感扫描在交接前执行。
- 当前云变更冻结仍有效；候选准备与业务release的operation lock是不同边界。
- 本地production verify的24项与19项通过，relocation子进程通过；根文档零error/warning，
  Context sorted5026历史问题未增加，26项保持原四项失败，audit33项通过。
- real preflight `inv-a9ftb005xi` SUCCESS/0：约15.4GiB free、无Go/Buildah竞争任务，
  当前base module labels与完整Go tree逐字匹配。首次preflight错误假设SDK在/usr/local，
  终态FAILED；改为实际command-v后通过，不当作构建或运行时故障。
- 源码从已提交42ef7aea完整infra/cells tree导出1349 regular files，2.9MB bundle逐文件验真；
  source tree及manifest写入identity，不从工作区或旧节点记忆subset补文件。
- relay `inv-e9fte0gq15`和stage `inv-e9fte1g6pv` SUCCESS/0，byte/hash与exact closure通过。
- build `inv-d9fteug2em` SUCCESS/0：内部API/router两Go包测试、binary编译、TCR push、
  isolated cold pull及产品回执通过。standard wrapper精确auth二次cleanup与回执下载也通过。
  不把fake submission test当作这条实际OCI证据；回执见API/evidence。
- 当前28项target inventory leaf promotion通过，仅workers-api变化、其余27项与root metadata
  完全保留；结果只在/data/tmp，不更新live inventory或GitOps。
- 04:57:56Z只读`inv-e9fth9gn96`SUCCESS/0：原unit同PID/Invocation仍active/running，
  A111Host/115Machine、B4/4、active0；load failed及cleanup passed结论不变。
- post-build `inv-d9ftihgrb8` SUCCESS/0：源码文件数1352（含三项identity），manifest全部
  复验、无pyc/额外文件或symlink；精确temporary auth已不存在，原supervisor仍同身份运行。

## scan_scope / scan_output / handoff / checkpoint

scan仅本轮文件及自己的catalog行，证据留/data/tmp，不输出auth内容或签名URL。
stage：API候选制品完成；verified：本地submission、完整源码、实际Go/OCI/cold pull与staged闭合；
unverified：云发布、CLB/Registry故障边界、CLS实际采集、完整Phase5。
discard：改base仍能复用source-only receipt的假设。
restore：362702d9源码基线，本轮独立jj修订，原strict10k exact Invocation/PID。
next_action：归档post-build源码/auth清理证据并完成文档门禁；原任务结束后走受锁发布，探索先行。
