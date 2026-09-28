## goal
更新 QQ 和钉钉通道的连接方式选择 CTA，并只更新钉钉凭据弹窗的中文文案与开发者后台入口。

## non_goals
- 不改变 Telegram、Discord、Slack 或其他通道的弹窗文案、交互或绑定流程。
- 不改变钉钉或 QQ 的绑定 API、凭据字段、扫码流程、后端、GitOps、发布或生产状态。

## requirement_ids / requirement_refs / requirement_excerpt
- 本轮用户提供的钉钉通道截图与后续确认：QQ 和钉钉的首步主按钮均显示“下一步”；钉钉凭据页显示“连接钉钉”“填入钉钉机器人凭据完成绑定”，并提供新窗口打开的“钉钉开发者后台”链接。

## interface_refs / data_structure_refs
- `ChannelPanel` 的 `methodPickerChannel` 与 `tokenChannelKind` 状态；仅 `qqbot`/`dingtalk` 共享选择弹窗 CTA 和 `dingtalk` 凭据页渲染分支改动。
- 既有 `ops.configureChannel({ channelValue, channelIdValue, channelKeyValue })` 契约保持不变。

## history_context
- `current_design_refs`：`frontend/src/pages/marketing/agent-channel-panel.tsx` 与现有钉钉回归测试。
- `relevant_evolution`：钉钉和 QQ 已在二维码和手动凭据两种绑定方式中复用方式选择弹窗。
- `superseded_refs`：无。

## acceptance
- QQ 与钉钉方式选择弹窗的主按钮均显示“下一步”。
- 钉钉凭据弹窗显示“连接钉钉”和“填入钉钉机器人凭据完成绑定”。
- 仅钉钉凭据弹窗含可新开窗口的“钉钉开发者后台”链接，使用 `https://open-dev.dingtalk.com/`。

## affected_paths
- `frontend/src/pages/marketing/agent-channel-panel.tsx`
- `frontend/src/pages/marketing/agent-config/standard-panel.css`
- `frontend/src/pages/marketing/__tests__/agent-channel-dingtalk.test.ts`
- `frontend/src/i18n/generated/*.json`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/{i18n/generated,pages/marketing}/**`

## required_context
- `agent-gateway-runtime`、`frontend-product-surface`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库边界 | 限定为前端源码与本地验证，不执行发布。 |
| `frontend/AGENTS.md` | 最近服务规则 | 确认前端聚焦测试和 i18n 门禁。 |
| `opencraft/AGENTS.md` | vendored 同步边界 | 确认前端真源改动必须同步 Agent Console 副本并复验。 |
| `docs/context/flows/tapd-gongfeng-delivery.md` | MR 交付流程 | 确认本次以独立提交修复既有 MR 的 CI 生成物门禁。 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | i18n 相邻检查 | 确认生成入口和钉钉相邻测试。 |
| `frontend/src/pages/marketing/agent-channel-panel.tsx` | 当前实现 | 只修改共享选择 CTA 与钉钉凭据页渲染。 |
| `frontend/src/pages/marketing/__tests__/agent-channel-dingtalk.test.ts` | 相邻测试 | 扩充 QQ/钉钉 CTA、钉钉文案和链接断言。 |

## evidence
- `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/agent-channel-dingtalk.test.ts --api.host 127.0.0.1`：6 个测试通过；新增断言覆盖 QQ/钉钉共享 CTA、钉钉专属文案和新窗口链接。
- `pnpm check`：通过；TypeScript 为 171 个当前诊断、171 个基线、0 个新增诊断。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：通过，错误和告警均为 0。
- `git diff --check`：通过。
- `npm --prefix opencraft run check:mono2-agent-console`：通过，已验证 130 个 Agent Console 副本；CI 中的 manifest 漂移已消除。

## risks
- 通用凭据弹窗被多个通道复用。缓解：以 `tokenChannelKind === 'dingtalk'` 为唯一条件，并以回归测试固定钉钉特例。
- 第三方 OAuth 参数冗长且易过期。缓解：链接至开发者后台根地址，由目标站维护登录跳转。
- 前端真源改动会触发 OpenCraft vendored manifest 门禁。缓解：以独立提交运行官方同步脚本并提交生成副本与 `UPSTREAM.json`。

## validation
- 聚焦 Vitest、i18n 提取/校验、`pnpm check`、文档检查与 `git diff --check`。

## decisions
- 选择 `https://open-dev.dingtalk.com/`，不嵌入 OAuth 参数。
- 在原说明行旁加入链接，不新增弹窗、路由或配置。

## scan_scope
- `frontend/src/pages/marketing/agent-channel-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-channel-dingtalk.test.ts`
- `frontend/src/i18n/`

## scan_output
- 有界精确搜索命中上述实现、钉钉回归测试与 i18n 提取脚本；未命中 change-impact 映射。

## handoff
- 功能实现已在首个提交中交付；OpenCraft vendored manifest 已以独立同步提交修复并本地复验。未发布。
