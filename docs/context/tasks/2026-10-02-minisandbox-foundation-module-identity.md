---
id: minisandbox-foundation-module-identity-2026-10-02
type: task
scope: 修复正式 Go foundation 工厂身份标签与增量构建，恢复依赖闭合的发布能力。
triggers: ["minisandbox foundation module identity", "base golang labels", "controller base dependency mismatch"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - minisandbox/infra/cells/deploy/tencent/fleet/gitops/image-seed/README.md
  - docs/context/tasks/2026-10-02-minisandbox-foundation-module-identity.md
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.0
precedence: task
derived: false
---

## goal

让 canonical foundation 构建产生 controller build 所要求的 exact go.mod/go.sum labels，并严格支持增量 root 构建；
用同一依赖闭合 generation 发布控制器，不绕过 product-lock 的基础镜像一致性检查。

## non_goals

- 不改 Registry schema、用户 API、Go module graph、V8 或 Rust 实现。
- 不通过手工改 inventory digest、弱化 consumer labels、直接 patch Deployment 解决失败。
- 不将 source materialization、镜像构建或静态测试报告为云上资格完成。

## requirement_ids / requirement_refs / requirement_excerpt

- stateless-workers-do-routing/phase-4、phase-5：正式发布恢复、安全缩回低容量和真实规模资格。
- image-seed generation：28 项完整 inventory，11 个产品收据及 exact dependency closure。
- controller/build-image：Go dependency base 必须绑定当前 reviewed module graph。

## interface_refs / data_structure_refs

- foundation OCI labels：fleet.actor.dev/go-mod-sha256、go-sum-sha256。
- actor-product-image-build/v1 receipt；product-lock assemble/promote。
- reviewed-source-bundle/v2、Runtime static ledger、MachineSet exact downscale intent。

## history_context

- current_design_refs：image-seed/README.md、controller/README.md、stateless-workers-do-routing。
- relevant_evolution：00770 controller-first 恢复已推送并通过 builder 静态验证；leaf promote
  因 7073 controller 的 Go base 与现行 6170 inventory 不一致而在 mutation 前拒绝。
- superseded_refs：直接选择 TCR 中一个“可编译”的 base 不等于完整 generation 已可发布。

## context_receipt

- root、minisandbox 与 infra/cells AGENTS；release-gitops、upstream-subtrees、MONO2_SUBTREE。
- argocd-ci-secrets adjacency；image-seed verify.sh、product-lock、foundation builder 和 controller build。
- cloud-environment-runtime/networking；只使用授权配置的 TAT/COS，不输出 credential。

## acceptance

- 完整 manifest 验证之后，Go base 获取 exact input hashes；其他基础镜像不声明 Go graph。
- Go module 变化使标签变化，缺失输入 fail closed；消费者严格校验不变。
- root selection 必须在完整 lock/source 验证后生效；非法 selection 在任何 build 前失败。
- 增量构建不改变完整 11-product/28-repository dependency closure 门禁。
- focused Bash/process tests、image-seed 静态门禁、docs/diff 与 Context 无新增问题。
- 云上 dependency-closed inventory 通过后才可进入正式 Runtime release。

## evidence

- reviewed source 00770 经 COS 中转已物化；inv-d9d4t2g82e SUCCESS，builder fleet static gates passed。
- inv-e9d4xq0fk5 的 product-lock promote 拒绝 base-golang 不匹配，尚未修改 workload。
- inv-e9d52kg8ux 回查：A/B HPA floor 4、max 301、scale-up cohort 6/min；近期两 Cell
  command-ack autonomy decision 均为 allow。9 月 15 日 decision 不代表当前最新状态。
- A Host 已缩至 4，而 MachineSet 仍 201；B 已到 9。failed 10k 仍不能作为资格收据。
- d943451a 已确认推送 mono2/master；经 COS relay 物化，inv-c9d5jn0g6t SUCCESS，远端完整
  fleet 静态门禁再次通过，manifest 前缀 a75dafb30c22d；完整 hash 绑定于 reviewed-source receipt。
- inv-e9d5jg0q18 无法重建现行 seedReceiptDigest 的 exact preimage，未写出伪造收据。
- inv-d9d5ms03ip 正式五-root build 因 gcr.io timeout 终止于 distroless；没有 workload mutation。
  已按 terminal TaskStatus 收尾，不因无输出重复提交；待增量 root 工厂通过门禁再重建 Go base。

## validation

- 标签 4 tests、增量 planner 9 tests（新增 5 项）、image-seed 与完整 fleet verify 全部通过；bash syntax 与
  diff --check passed；documentation errors=[]，显式变更集 change-impact passed。
- Context 的 4,798 项既有错误与 f06 baseline 精确一致，无新增；26 tests 仍是相同的 4 项
  baseline 失败，不宣称全库门禁全绿。Context-audit 33 tests passed；discovery 为
  needs_agent_review / not_assessed，不伪造成熟度评分。

## decisions

- 只修工厂缺失的输入身份，不扩大 release 绕过权限。
- 基础镜像改变必须闭合 reverse dependencies；Runtime-base 不变时复用已有 Runtime 收据。

## handoff

- stage：标签修复已推送并远端验真；增量 root selection 已通过完整静态门禁，准备送达 builder。
- verified：源码已送达、两候选镜像已构建、leaf promotion 确定性 fail closed。
- unverified：新 generation 构建、正式 controller-first release、A Node 缩容、strict 10k。
- discard：错误默认 autonomy 路径、旧 bootstrap inventory 和猜测的 HPA 名称。
- restore：00770 reviewed source、7073 controller 与 a2 Runtime product receipts 保留于 builder。
- next_action：严格验证并推送增量工厂，生成正确 labels 的 Go base；对未变化产品做 exact registry
  cold pull；重新取得完整 seed 与 product inventory 后进入正式 controller-first release。
