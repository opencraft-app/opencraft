---
id: hermes-default-provider-alias-20261012
type: task
scope: Hermes 默认模型目录兼容明确声明的提供商别名。
triggers: ["Hermes default provider alias"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/model-catalog.ts
  - opencraft/tests/lightvela-hermes-plugin.test.ts
  - opencraft/tests/chat-workbench-draft.test.ts
status: active
reviewed_at: 2026-10-12
review_due: 2027-01-12
revision: 1.0.0
precedence: task
derived: true
---

## goal
默认模型使用 Hermes 目录明确声明的提供商别名时，用户仍能正常提交对话。

## non_goals
不改生产配置、套餐、凭据、Provider、运行时版本或已有会话选择；用户已授权提交 MR 并合入 master；生产发布不在本次授权范围。

## requirement_refs
用户先授权只读排查套餐开通后发送失败，确认提供商别名未参与默认模型匹配后，明确要求实施兼容修复（“搞起来”），随后授权“提交MR,合入master”。

## interface_refs / data_structure_refs
`HermesModelOptionsPayload` 的 provider/model 和 Provider 的 slug/name/aliases；`mapHermesModelOptions` 的 AppServer `isDefault` 投影；host-default 命令编译器在发送前读取 model/list。
保留目录规范模型身份，不猜测未声明别名，不让 authenticated=false 的提供商变得可用。

## history_context
- current_design_refs：docs/engineering/domains/agent-gateway-runtime.md；opencraft/docs/platform-architecture.md；opencraft/docs/local-agent-custom-providers.md。
- relevant_evolution：已有会话的 canonicalHermesModelSelection 已使用 sameProviderIdentity；默认投影仍严格比较 slug 与 provider，漏掉相同别名。9月代码已有该逻辑；近期图片能力补丁未改变 Provider 身份。
- superseded_refs：无。

## acceptance
目标配置 provider=custom:custom、model=auto、目录 slug=custom/aliases=[custom:custom] 被投影为唯一可用默认模型；host-default 提交到规范身份 custom/auto。
未声明别名、同模型的其他 Provider 与不可用 Provider 不误匹配。
相关测试、插件类型检查、内嵌 Web 构建与浏览器运行时回放通过。

## affected_paths
- opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/model-catalog.ts
- opencraft/tests/lightvela-hermes-plugin.test.ts
- opencraft/tests/chat-workbench-draft.test.ts
- docs/engineering/domains/agent-gateway-runtime.md

## required_context
agent-gateway-runtime；根与OpenCraft AGENTS；opencraft-maintenance。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md | 授权、隔离与检查边界 | 不提交或发布未经授权的修复 |
| opencraft/AGENTS.md | Adapter、类型与构建责任 | 只修改真源并在本工作树安装依赖 |
| docs/context/domains/agent-gateway-runtime.md | Context路由must_read | 运行时目录是身份真源 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md及references/verification.md | 必需维护技能 | 原问题负例和相关测试/构建 |
| opencraft/docs/platform-architecture.md | Host与Client所有权 | 只修改客户端目录投影 |
| opencraft/docs/local-agent-custom-providers.md | 提供商与配置身份 | 不迁移配置或凭据 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 相邻运行时检查 | 检查host-default发送测试及内嵌构建入口 |
| docs/context/tasks/TASK-TEMPLATE.md | Task Pack字段 | 保存证据与交接范围 |

## evidence
只读线网：目标 Profile model.provider=custom:custom、model.default=auto；原生模型目录 slug=custom，aliases包含custom:custom，authenticated=true。7台正常对照默认provider=custom且有生成输出的历史，3台同日同0.21.5版本。
新增回归测试在修复前失败：没有默认目录项；改为复用sameProviderIdentity后通过。

## risks
别名必须来自当前Profile的原生目录，禁止字符串前缀推断或修改用户配置。已有目录认证/隐藏过滤保持生效。变更尚未上线，不能宣称线网用户已恢复。

## validation
- 原问题回归：修复前 declared alias 默认识别测试失败，修复后通过。
- 相关插件与 host-default 测试：122/122 通过（regression-final.log）。
- 插件 tsc --noEmit 通过；内嵌 Workbench release 构建通过，仅既有体积提示。
- Chromium 浏览器运行时回放：声明别名时 thread/start 使用 hermes-model:custom:auto；未声明时发送前失败且执行请求为 0；无 pageerror。远端 AppServer 为模拟传输，未在线推理。
- documentation 与 change-impact 校验通过；git diff --check 通过。
- 完整证据：/data/ops/user-3a84df-model-diagnosis-20261012/。未进行生产写入；用户随后授权 Git 提交、MR 和合入 master。

## decisions
复用已有会话的Provider身份匹配函数，而不维护第二套归一化规则。

## scan_scope
仅Hermes模型目录、已有相邻测试与host-default发送编译链路。

## scan_output
无独立全仓扫描。

## handoff
隔离工作树fix/hermes-default-provider-alias-20261012；实现与本地验证后提交审阅结果。提交、MR和合入 master 已获用户明确授权；上线需另行授权。
