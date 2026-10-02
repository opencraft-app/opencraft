---
id: minisandbox-foundation-module-identity-2026-10-02
type: task
scope: 修复正式 Go foundation 工厂缺失 module identity labels，恢复依赖闭合的发布能力。
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

让 canonical foundation 构建产生 controller build 所要求的 exact go.mod/go.sum labels；
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
- focused Bash/process tests、image-seed 静态门禁、docs/diff 与 Context 无新增问题。
- 云上 dependency-closed inventory 通过后才可进入正式 Runtime release。

## evidence

- reviewed source 00770 经 COS 中转已物化；inv-d9d4t2g82e SUCCESS，builder fleet static gates passed。
- inv-e9d4xq0fk5 的 product-lock promote 拒绝 base-golang 不匹配，尚未修改 workload。
- inv-e9d52kg8ux 回查：A/B HPA floor 4、max 301、scale-up cohort 6/min；近期两 Cell
  command-ack autonomy decision 均为 allow。9 月 15 日 decision 不代表当前最新状态。
- A Host 已缩至 4，而 MachineSet 仍 201；B 已到 9。failed 10k 仍不能作为资格收据。

## validation

- 新增 4 tests、image-seed verify 和完整 fleet verify-manifests 全部通过；bash syntax 与
  diff --check passed；documentation errors=[]，显式变更集 change-impact passed。
- Context 的 4,798 项既有错误与 f06 baseline 精确一致，无新增；26 tests 仍是相同的 4 项
  baseline 失败，不宣称全库门禁全绿。Context-audit 测试与 discovery 在收尾时独立运行。

## decisions

- 只修工厂缺失的输入身份，不扩大 release 绕过权限。
- 基础镜像改变必须闭合 reverse dependencies；Runtime-base 不变时复用已有 Runtime 收据。

## handoff

- stage：canonical factory 的标签修复与完整 fleet 静态门禁已通过，正在收尾源码门禁。
- verified：源码已送达、两候选镜像已构建、leaf promotion 确定性 fail closed。
- unverified：新 generation 构建、正式 controller-first release、A Node 缩容、strict 10k。
- discard：错误默认 autonomy 路径、旧 bootstrap inventory 和猜测的 HPA 名称。
- restore：00770 reviewed source、7073 controller 与 a2 Runtime product receipts 保留于 builder。
- next_action：通过局部门禁后推送工厂修复，生成正确 labels 的 base 与闭合 inventory。
