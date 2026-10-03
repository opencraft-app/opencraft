---
id: minisandbox-cloud-prepared-stage-2026-10-02
type: task
scope: 在正式云端Runtime构建入口接入候选源码的已验证fresh stage，保留原构建来源证据。
triggers: ["prepared Runtime stage", "云端fresh stage", "stage精确收据"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/build-runtime-via-tat.sh
  - minisandbox/infra/cells/docs/design/2026-09-22-stateless-workers-durable-object-routing.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

正式云构建可使用exact候选源码的fresh workerd/FDB stage，不被默认的旧镜像提取路径阻塞。

## non_goals

- 不绕过来源证明、不把旧reuse收据改名为fresh、不重绑source身份。
- 不改生产SLO、容量、配置或完整Bottomless/HA门禁。
- 不用本机原生Rust替代云端glibc匹配的镜像构建。

## requirement_ids / requirement_refs / requirement_excerpt

- Stateless Workers/DO正式设计Phase5要求source-bound不可变产物和真实容量验收。
- 072e504b已推送warm输入验真；候选源码fresh编译正在执行，旧云factory始终提取旧image。

## interface_refs / data_structure_refs

- QUALIFICATION_PREPARED_STAGE_DIR、QUALIFICATION_PREPARED_STAGE_RECEIPT必须成对提供。
- actor-runtime-stage/v1 source/manifest、fork/FDB/toolchain、正整数jobs、canonical四文件hash。
- 预检与copy后同一verify函数；原receipt字节不变，最终build-image仍执行原生Rust及Host进程验证。

## history_context

- current_design_refs：Stateless Workers/DO Phase5、qualification actor-bj-q01 README。
- relevant_evolution：072e504b允许已有物理缓存真实编译；当前云build-runtime-via-tat只支持旧image。
- superseded_refs：旧stage历史链缺失original provenance，不因label存在就允许绕过。

## acceptance

- 预检失败时不签发临时TCR权限；复制后身份与artifact仍一致。
- 路径或pair错误、坏hash、错source、非fresh/无toolchain收据、symlink和非ELF必须拒绝。
- 默认reuse、stable Cargo workspace、ABI、CPU/RAM限额、离线vendor与凭据cleanup不变。

## affected_paths

- cloud runtime factory、真实文件/ELF回归、compiler-free Fleet contract。
- qualification README、正式设计、此Task/catalog。

## required_context

- release-gitops、agent-gateway-runtime、upstream-subtrees、cells AGENTS及CLAUDE。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md@072e504b | 根契约 | jj new、Task和正式文档 |
| docs/context/domains/release-gitops.md@072e504b | 路由 | 产物与上线分离 |
| docs/context/domains/agent-gateway-runtime.md@072e504b | 路由 | 真实路径门禁 |
| docs/context/project/upstream-subtrees.md@072e504b | 路由 | mono2唯一来源 |
| docs/context/project/adjacency/argocd-ci-secrets.md@072e504b | 邻接 | exact发布证据 |
| minisandbox/CLAUDE.md@072e504b | 工程规范 | 不mock module、真实子进程 |
| minisandbox/infra/cells/AGENTS.md@072e504b | 云安全 | 不可变receipt、限额及正式builder |
| minisandbox/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/test_runtime_build_log.py@072e504b | 测试邻居 | 保留完整日志/有界TAT输出 |
| minisandbox/infra/cells/deploy/tencent/fleet/runtime/build-image.sh@072e504b | 消费者 | source/receipt/ABI校验 |
| docs/context/tasks/TASK-TEMPLATE.md@072e504b | Task要求 | 证明范围和状态 |

## evidence

- 新候选072e504b完整source bundle和manifest已验真只读提取；fresh build有8G/CPU200%边界。
- 云factory新增显式输入分支；真实文件和静态ELF测试将验证拒绝边界。
- 九项真实ELF/文件/实际copy测试、旧parallelism九项和build-log一项通过；完整Fleet static终态0。
- compiler-free路径只跑合同两项，保持干净source落地不要求新compiler；正式文档errors/warnings为空。
- 本轮尚未云Runtime发布，不声称严格万级资格已通过。

## risks

- 文件在预检后变化：copy后的canonical hash/原receipt digest验证拒绝。
- 编译来源和操作工具版本分离：收据始终绑定实际候选源码；工具升级不允许改其source字段。

## validation

- Bash/diff、完整prepared-stage测试、原parallelism/build-log测试、Fleet static及正式文档/impact。
- 源码materialization只执行两条无compiler合同，完整ELF测试在已有compiler环境执行。

## decisions

- 原四参数接口保留，显式fresh分支不使用base image；默认行为不变。
- 只复制规范四artifact和manifest到独占临时目录，不接受receipt中任意相对路径。

## scan_scope

- qualification cloud build、stage reuse/fresh、build-image消费者、相邻tests/README。

## scan_output

- 找到默认旧image-only瓶颈；用可审计可测试的官方接口解决，不复写Cargo/buildah流程。

## handoff

- 下一步完成测试和正常push，COS relay freshstage并运行实际云factory；发布与万级验收仍独立。
