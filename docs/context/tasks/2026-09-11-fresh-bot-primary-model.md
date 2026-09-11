## goal
让“空白创建”Bot 以主 Bot 当前主模型为一次性可运行快照，同时保持其他 Profile 数据隔离。

## non_goals
- 不复制备用模型、其他已配置模型、完整 `.env`、人设、记忆、用户 Skills、通道、会话或定时任务。
- 不改变“从当前 Bot 克隆”与“从主 Bot 克隆”的既有语义。
- 不开放当前隐藏的追加 Bot 入口，不提交、发布或操作生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`
- 用户确认：空白创建仅继承主 Bot 当前主模型、对应 Provider 配置及其所需凭据；创建后各 Bot 独立修改。

## interface_refs / data_structure_refs
- `ctl/pkg/instance/bots.go::CreateInstanceBot`
- `ctl/pkg/instance/bots.go::buildHermesProfileCreateCommand`
- `frontend/src/pages/marketing/agent-settings-page.tsx::handleConfirmCreate`
- `POST /v1/instances/{instance_id}/bots` 的 `create_mode=blank` 保持不变。

## history_context
- `current_design_refs`：`wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`。
- `relevant_evolution`：Hermes Fresh Profile 已复制主模型块但创建独立空 `.env`；LightVela 使用 `--no-skills` 后没有复制主模型所需凭据，导致页面有模型而实际调用鉴权失败。
- `superseded_refs`：空白创建完全使用默认模型、或复制主 Bot 全部配置与完整 `.env` 的方案均不采用。

## acceptance
- 空白创建继续使用 `--no-skills`，并只复制根 Profile 当前主模型、匹配的单个 Provider 配置和该配置引用的环境变量。
- 新 Profile 不包含根 Profile 的 fallback、其他 Provider、其他模型或无关环境变量。
- 创建弹窗明确展示空白创建的继承与不继承范围。
- PRD、CTL 聚焦测试、前端聚焦测试和 i18n 检查通过。

## affected_paths
- `ctl/pkg/instance/bots.go`
- `ctl/pkg/instance/bots_test.go`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-diagnostics-multi-bot.test.tsx`
- `frontend/src/i18n/generated/`
- `docs/engineering/domains/agent-gateway-runtime.md`
- `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`

## required_context
- `frontend-product-surface`
- `control-plane-ops`
- `agent-gateway-runtime`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@c914eb43a` | 仓库边界 | 保持凭据安全、验证与提交权限边界 |
| `docs/context/project/services/frontend.md@c914eb43a` | 前端路由结果 | 确认前端与 i18n 验证要求 |
| `docs/context/project/services/ctl.md@c914eb43a` | CTL 路由结果 | 确认实例编排归属与 Go 测试要求 |
| `frontend/AGENTS.md@c914eb43a` | 最近服务规则 | 使用前端聚焦测试与 `pnpm check` |
| `ctl/AGENTS.md@c914eb43a` | 最近服务规则 | 保持公开入口与运行时边界 |
| `docs/context/domains/agent-gateway-runtime.md@c914eb43a` | 模型与 Provider 运行时边界 | 不把 UI 投影当作可运行凭据证明 |
| `docs/engineering/domains/agent-gateway-runtime.md@c914eb43a` | 变更影响映射的正式领域真源 | 固化空白 Profile 主模型快照与凭据隔离契约 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@c914eb43a` | 实现邻接卡 | 核验 i18n 生成入口及相邻测试；按 FE-AI 规则未读取 `openspec/` |
| `frontend/vitest.config.ts@c914eb43a` | 邻接测试入口 | 确认聚焦 Vitest 配置 |

## evidence
- `CGO_ENABLED=0 go test ./pkg/instance -run 'Test(BuildHermesProfileCreateCommand|CopyHermesPrimaryModelScript|HermesProfileConfigUnset)' -count=1`：通过。
- 使用本机 Hermes venv 对嵌入式快照脚本执行凭据存在与凭据缺失两组临时目录 smoke：均通过；目标只保留主模型、单个 Provider 和被引用凭据，未复制 fallback、其他 Provider、通道或无关环境变量。
- `pnpm vitest run src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts src/pages/marketing/__tests__/agent-diagnostics-multi-bot.test.tsx`：2 个文件、41 个测试通过。
- `pnpm check`：通过；i18n 结构错误 0，现存 49 个翻译告警未新增类型错误，TypeScript 新增诊断 0。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：通过，断链 0。
- `validate_change_impact.py`（显式传入本次变更集合）：通过；`agent-gateway-runtime` 要求 Owner review。
- 完整 `go test ./pkg/instance` 在本机环境未跑完：默认 CGO 链接缺少 macOS Security symbol；关闭 CGO 后既有 Testcontainers 用例因没有 rootless Docker panic。聚焦测试和脚本行为 smoke 已独立通过。

## risks
- Provider 配置存在新旧两种 schema；快照逻辑需同时支持 `providers` 与 `custom_providers`。
- 凭据不得写入命令输出、日志、测试 fixture 或 PRD；仅在实例内从根 Profile 定向写入新 Profile。
- Provider 使用外部 Secret/OAuth 时不复制整份环境，只保留所选 Provider 的声明与引用。

## validation
- `cd ctl && go test ./pkg/instance`
- `cd frontend && pnpm vitest run src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `cd frontend && pnpm check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- 采用一次性主模型快照，不建立主 Bot 与新 Bot 的持续同步关系。
- 仅复制被选中 Provider 引用的环境变量；若根 Profile 缺少该值，新 Profile 保持待配置状态，不复制任何替代凭据。
- 产品范围沿用当前 PRD：国内站内部验证，国际站本期不发布。

## scan_scope
- `ctl/pkg/instance/`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/`
- `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`

## scan_output
- 使用现有 `graphify-out/graph.json` 查询后，以源码精确搜索确认创建调用链。

## handoff
- 当前状态：实现与本地验证完成，待用户决定是否提交。
- 下一步：如获授权，检查变更范围后 commit/push/MR。
- 阻塞项：完整 CTL package 测试需要可用 Docker 测试环境；不阻塞本次聚焦逻辑验证。
- 所需权限：本地修改已获授权；未获 commit、push、MR、发布权限。
