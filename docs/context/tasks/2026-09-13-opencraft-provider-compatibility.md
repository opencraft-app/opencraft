---
id: opencraft-provider-compatibility-2026-09-13
type: task
scope: 验证当前打包 DSH 与参考上游的模型配置兼容性。
triggers: ["provider compatibility", "DSH版本验证", "模型配置验证"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/runtime/dsh/package.json
  - opencraft/scripts/smoke-local-agent.ts
  - opencraft/scripts/smoke-local-agent-settings.ts
status: retired
reviewed_at: 2026-09-13
review_due: 2026-12-13
revision: 1.0.0
precedence: task
derived: false
---

## goal
验证现有引擎是否足以支撑已讨论的 Provider 配置设计，不升级或改产品代码。

## non_goals
不读取真实密钥值、不改现有配置、不发起供应商推理、不提交或发布。

## requirement_ids / requirement_refs / requirement_excerpt
COMPAT-01：用户要求验证打包版本与克隆上游的 Provider、凭据和模型接口差异。

## interface_refs / data_structure_refs
runtime/providers/apply、runtime/models/discover/probe、DSH settings/credentials 及启停补丁。

## history_context
- current_design_refs：opencraft/docs/local-agent-custom-providers.md。
- relevant_evolution：此前参考上游0.1.5-rc.2，但现有锁定引擎为0.1.1-rc.2。
- superseded_refs：此前“没有 Test model”的观察不再代表当前源码。

## context_receipt
- docs/context/domains/agent-gateway-runtime.md：router must_read。
- opencraft/AGENTS.md：独立workspace、测试边界。
- prepare-dsh-runtime.mjs / patch-dsh-provider-lifecycle.mjs：精确版本和补丁契约。

## acceptance / validation
核对版本、包内补丁，并用独立临时目录运行真实 DSH/AppServer 和模型设置 UI 脚本。

## evidence
- 工作区与抽查两份.app的DSH均为0.1.1-rc.2，包含启停/modelSelection补丁。
- 参考克隆 c291e796 为0.1.5-rc.2，Remote API与旧host-apiproxy不同。
- smoke-local-agent.ts、smoke-local-agent-settings.ts 均退出0；写入仅在脚本创建/清理的临时目录，模型HTTP为本地fixture。

## decisions / risks
可以继续基于当前引擎实施UX，不直接升级或复制新Remote调用。原生DeepSeek测试入口、已存凭据安全测试路径仍需补齐；真实调用未验证。

## stage / handoff
验证完成，无产品源码修改。详细研究保存在参考目录 compatibility-20260913.md。

## verified
版本/补丁、保存启停重启、目录发现、模型编辑、草稿probe、默认模型保护。

## unverified
真实供应商和最新上游替换后的运行兼容性。

## discard
不能把引擎支持某协议等同于OpenCraft已接入全部配置/测试能力。

## restore / next_action
按报告边界规划UX，不需要先升级DSH。
