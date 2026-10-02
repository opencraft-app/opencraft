---
id: minisandbox-verified-warm-stage-2026-10-02
type: task
scope: 以完整输入验真接入既有物理workerd构建缓存，重新构建而不继承缺失来源的stage链。
triggers: ["verified warm stage", "warm workerd workspace", "稳定编译路径"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/prepare-stage.sh
  - minisandbox/infra/cells/deploy/tencent/fleet/runtime/verify-warm-stage-cache.sh
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

运行正式fork编译recipe，复用已验真的稳定物理workspace/action cache，生成候选源码绑定的fresh stage。

## non_goals

- 不把复制旧二进制、历史reuse标签或未引用常量当成完整compiled-origin证明。
- 不重写旧源码或其rivet-history链接，不放宽真实万级资格、3秒SLO、零稳态重试或内存边界。
- 不改变Runtime ABI、存储协议或生产路由。源码变化不等于已发布。

## requirement_ids / requirement_refs / requirement_excerpt

- Stateless Workers/DO正式设计Phase5要求不可变输入、SQLite bridge完整本地依赖与正式发布资格。
- 当前stage历史链最早审计源码与候选存在协议常量差异；保持byte/mode证明，不通过删去字段放行。
- 实际旧warm源码的完整stage/生产闭包与当前候选相同，且有可复用的物理路径/Bazel action cache。

## interface_refs / data_structure_refs

- WORKERD_VERIFIED_WARM_CACHE_DIR、verify-warm-stage-cache.sh、prepare-stage.sh。
- actor-runtime-stage/v1继续绑定source/manifest/toolchain/artifacts；warm构建额外记录warmCacheInputDigest。
- locked fork commit/tree、干净working tree、已有source链接、offline Cargo生产闭包、编译前后同一摘要。

## history_context

- current_design_refs：正式Stateless Workers/DO设计、runtime README。
- relevant_evolution：eb1ae1c5已修复完整static对独立闭包helper的集成，GoAPI已正式发布并云验收。
- superseded_refs：不能因HEAD tree等于lock便信任存在未提交改动的checkout；不能因目录有旧binary便声称fresh build。

## acceptance

- existing real directory、exact clean Git fork、existing source link、full offline input equivalence都成立才开始编译。
- source link不改；正常fresh cache仍按fork身份建立；未知新fork不能沿用旧direct-root合同。
- 在正式recipe之后重验Git、输入摘要和candidate source manifest，成功才复制artifact和发布receipt。
- 真实Git/Cargo/文件测试和完整Fleet门禁通过；实际构建与source-bound receipt单独验真。

## affected_paths

- runtime prepare、warm verifier、真实测试与compiler-free materialization合同。
- runtime README、正式设计、此Task与catalog。

## required_context

- release-gitops、agent-gateway-runtime、upstream-subtrees、cells AGENTS、工程规范与发布邻接。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@eb1ae1c5 | 根契约 | 真实证据、单任务提交、正式文档 |
| docs/context/domains/release-gitops.md@eb1ae1c5 | 路由 | build与发布分离 |
| docs/context/domains/agent-gateway-runtime.md@eb1ae1c5 | 路由 | 实际传输不由局部测试推断 |
| docs/context/project/upstream-subtrees.md@eb1ae1c5 | 路由 | mono2唯一写源 |
| docs/context/project/adjacency/argocd-ci-secrets.md@eb1ae1c5 | 邻接 | exact source/digest/Argo验真 |
| minisandbox/CLAUDE.md@eb1ae1c5 | 工程规范 | jj new、真实子进程而非module mocks |
| minisandbox/infra/cells/AGENTS.md@eb1ae1c5 | 云安全 | 操作锁、不可变收据、正式工具链 |
| minisandbox/infra/cells/deploy/tencent/fleet/runtime/test_prepare_stage.py@eb1ae1c5 | 测试邻居 | 保持正常cache、fresh recipe与并行度合同 |
| minisandbox/infra/cells/deploy/tencent/fleet/runtime/build-image.sh@eb1ae1c5 | 下游邻居 | stage receipt/source/manifest与Host进程测试 |
| docs/context/tasks/TASK-TEMPLATE.md@eb1ae1c5 | Task契约 | 明确本轮证明边界 |

## evidence

- 上一goal turn为progress：C GoAPI镜像、Argo发布、Counter和APIHA真实收据均通过。
- 本轮原始readonly云preflight证明A/B各6Engine/4Host、主FDBhealthy/fullReplication；builder本地image不存在，故inspect125失败，不把该缓存缺失当成云故障或已通过build。
- 真实offline Cargo对旧warm源码与候选的完整6根和生产闭包比较通过；旧forkGit clean且ce8/bb0匹配锁。
- 分离jj revision后增加显式验真入口；旧setup在真实bundle checkout已脏但HEAD匹配时返回0，新warm门禁在Cargo和编译前拒绝。
- 七项真实Git/Cargo/文件与无编译器合同通过3.973秒；原stage/reuse共19项也通过，完整Fleet static终态0。
- 日志 `/data/tmp/minisandbox-verified-warm-stage-{regressions,full-static}-20261002.log`；实际fresh编译尚未开始，不作完成推断。

## risks

- warm source不是release整体来源，仅在全部编译输入相同时使用；前后验真、exact toolchain、正式recipe保留。
- 空白builder仍使用默认受控workspace，不依赖旧ID、旧节点或warm路径。
- 高并行冷V8构建会放大内存压力；资源限额与jobs必须显式，缓存不构成跳过编译或校验的权限。

## validation

- Bash/diff、实际Git/Cargo/warm边界测试、原stage/source回归与完整Fleet static。
- 正式文档/Context/impact无新增自有问题；actualstage还需recipe成功、static ELF、hash、不可变receipt。
- Bash/diff/impact与文档errors/warnings为空；实际warm源码合同验证通过，不修改旧source link。

## decisions

- warm目录必须是真实checkout，不以symlink别名改变compiler路径；已有source链接不被更新。
- 脏fork拒绝，即使HEAD commit/tree都匹配；编译后仍重验，cache只加速而不构成来源授权。

## scan_scope

- runtime prepare/receipt消费者、fork build-static/musl recipe、three production packages、锁定cache。

## scan_output

- 完整byte/mode输入一致证明已获得，但必须执行recipe才是fresh stage；不修改旧private源码。

## handoff

- Runtime存储修复尚未云发布；保持完整目标active，后续fresh10k/Router/百万dormant等要求不缩水。
- 自有revision已rebase到54144a74（他人frontend MR）；仅移动本任务，不改其文件或Context基线。
