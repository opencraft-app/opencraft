## goal
在国内站实现一台 LightVela 实例内多个产品 Bot，并让每个 Bot 稳定路由到独立 Hermes Profile，同时保持存量根 Profile `main` 无迁移兼容。

## non_goals
- 国际站发布、团队共享、Bot 市场、跨 Bot 编排、跨实例迁移和按 Bot 计费。
- 修改 Hermes 原生 Profile 语义或把存量根 Profile迁移为命名 Profile。
- 未经明确确认提交、推送、创建 MR 或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- PRD：`/Users/pablozhong/codex/lightvela/wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`。
- FE-AI brief：`/Users/pablozhong/codex/lightvela/.workflow/native/changes/lightvela-multi-bot-profile/brief.md`。
- 用户截图反馈（2026-09-10）：钉钉通道卡片图标需与其他通道统一为浅色品牌背景。
- 用户截图反馈（2026-09-10）：新版控制台默认 Bot 不得展示 Hermes 内部 ID `default`，无自定义名称时继续显示本地化的“我的 Hermes”。
- 用户截图反馈（2026-09-10）：默认 Bot 的定时任务加载失败，原生 Hermes CLI 报错 `Profile 'main' does not exist`。
- 核心要求：Hermes Profile 是 Bot 唯一事实来源，不新增数据库迁移；默认 Bot 使用 `main`；Profile 级命令显式路由；微信同实例唯一占用。

## interface_refs / data_structure_refs
- `ctl/pkg/transport/instance.go`：现有实例 API contract。
- `ctl/main/api/server.go`：`/v1/instances` 路由入口。
- `ctl/pkg/model/instance/entity.go`：实例归属真源；多 Bot 不新增模型表。
- `frontend/src/domain/types.ts`、`frontend/src/repositories/types.ts`：前端 Bot repository contract。
- `frontend/src/pages/marketing/agent-config/hermes-command-builder.ts`：Hermes ACLI 命令生成入口。
- 不变量：前端只消费后端返回的 `profile_id`；命名 Bot 的 `bot_id` 与 Profile ID 相同，默认 Bot 继续使用实例 ID 兼容存量行为。

## history_context
- `current_design_refs`：`docs/engineering/domains/agent-gateway-runtime.md`、`docs/context/domains/agent-gateway-runtime.md`、`docs/context/project/services/ctl.md`。
- `relevant_evolution`：现有前端 `Bot.id` 直接映射 CTL `instance_id`；现有下拉切换的是实例，不是实例内 Profile。
- `superseded_refs`：无。

## acceptance
- 存量实例读取 Bot 列表时直接投影 Hermes `default` 为不可删除的 `profile_id=main` 默认 Bot。
- 普通 Bot 可创建、克隆、改名和删除；失败直接返回且不产生数据库孤儿记录。
- `/agents` 和分区页切换 Bot 后保留 section，并刷新 Profile 级数据。
- Profile 级 Hermes 命令显式使用后端 `profile_id`；实例级命令不追加 Profile 参数。
- 微信同实例只能有一个占用 Bot；其他 Bot 不可覆盖或复用。
- 钉钉通道图标使用 8% 品牌蓝背景，扫码与凭据连接行为不变。
- 默认根 Bot 没有 Profile 展示名或存量实例名称时不返回内部 ID `default`，前端对旧后端泄漏的 `default` 兼容回退为本地化默认名称；命名 Profile 的 ID 兜底不变。
- 产品层继续使用默认 Bot 的公开 `profile_id=main`；原生 Hermes CLI 命令在执行边界转换为 `default`，命名 Profile 保持原 ID，定时任务查询与增删改运行统一走同一转换。
- 通过 CTL、service-gateway、frontend 聚焦测试及各服务门禁。

## affected_paths
- `ctl/pkg/transport/instance.go`
- `ctl/pkg/instance/`
- `ctl/main/api/`
- `service-gateway/`
- `frontend/src/domain/`
- `frontend/src/repositories/`
- `frontend/src/contexts/agent-context.tsx`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-channel-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-channel-dingtalk.test.ts`
- `frontend/src/pages/marketing/agent-config/`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `agent-gateway-runtime`
- `control-plane-ops`
- `frontend`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md@2.0.0` | Profile、渠道和路由边界 | 区分 CTL 元数据与运行时真源 |
| `docs/context/project/services/ctl.md@2.1.0` | CTL 服务责任 | 复用实例归属与 API 约束 |
| `ctl/AGENTS.md` | CTL 局部规则 | 覆盖直连与公共路由测试 |
| `frontend/AGENTS.md` | 前端局部规则 | 类型、测试和视觉验证门禁 |
| `service-gateway/README.md` | 公共 `/v1/instances` 路由 | 同步 allowlist 与代理测试 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端相邻约束 | 检查 OpenSpec、测试和国内站边界 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端服务边界 | 选择聚焦测试与视觉验证 |
| `docs/context/domains/site-environment-routing.md@2.0.0` | 双站边界 | 确认本次只调整共用展示，不改变区域门禁 |

## evidence
- `python3 .agents/context/scripts/validate_context.py --route "frontend /agents multi bot profile switching channel home channel domestic"` 命中 `agent-gateway-runtime`。
- `python3 .agents/context/scripts/validate_context.py --route "ctl profile bot model API frontend agents profile routing"` 命中 `control-plane-ops`。
- `graphify query ...` 定位 `AgentSettingsPage`、`agent-context`、命令执行与配置面板邻接。
- 当前实现确认：`projectInstanceToBot()` 把 `instance_id` 写入 `Bot.id`；CTL 无 `profile_id` contract。
- 嵌套 Bot API 与国内 service-gateway allowlist 保留；`sgprod` 保持原路由。Bot 列表通过 Hermes 官方 `GET /api/profiles` 读取，创建和变更使用 Hermes Profile 原生能力，不新增 migration、DAO 或表。
- Hermes Profile 命令统一消费后端 `profile_id`；模型、Channel、Gateway、Skills、Cron、Memory、User Profile、SOUL 均按 Profile 路由，实例生命周期和 AgentChat token 仍按 `instance_id`。
- 创建支持空白、复制当前和复制主 Bot；克隆后清理消息通道配置、消息通道环境变量和 Home channel，初始 SOUL 使用 base64 传输写入，避免明文进入命令。
- 微信占用记录保存到实例 `$HERMES_HOME/.lightvela/channel-bindings/weixin.json`，通过文件锁原子更新；登录会话表保持原结构，Bot/Profile 仅由运行时和绑定文件承载。
- `pnpm check` 通过，TypeScript baseline 为 `0 new`；最终 11 个前端聚焦文件共 217 个测试通过，覆盖 Bot repository/context/sidebar、Profile 命令、Memory、Skills 与运行时开关。
- `pnpm build:cn` 通过，Next.js 国内站生产构建完成并生成 96 个静态页面；新增中文文案对应的字体子集已重新生成。
- CTL API、Bot/Profile 命令、微信单 owner 文件锁、微信登录和 service-gateway policy 聚焦 Go 测试通过；CTL 全包 `-run '^$'` 编译覆盖到本次相关包，随后仅在既有 SQLite 初始化包因 `CGO_ENABLED=0` 失败。本机原生 CGO 又受 Go 1.26 与系统 Security.framework 链接不兼容影响。
- 本机 Hermes venv 通过进程内 ASGI transport 实际请求官方 `GET /api/profiles`，返回 `200` 和完整 Profile 列表结构；该方式不启动第二个 Dashboard/Gateway 进程。`get_profile_dir("default")` 解析到根 `$HERMES_HOME`，命名 Profile 解析到 `profiles/<id>`。
- 本地 mock 浏览器回归通过：创建后 URL 收敛为 `/agents/?bot=<backend_bot_id>`；进入模型页保留 Bot，模型页切回主 Bot 后 section 不变；再切回新 Bot 并进入通道页仍保留选择。桌面截图无重叠；创建弹窗桌面宽度从 384px 加宽到 672px（增加 75%），并在 390x844 视口内保持完整可滚动。
- Bot 切换器改为 Radix Popover 浮层，最终使用 46% 半透明白底、8px 背景模糊和 8px 圆角；浏览器测量展开前后创建按钮、页签、导航的纵坐标均保持 `178 / 243 / 297`，位移为 0，并验证 Bot 切换与 Escape 关闭。
- 已有实例创建的是实例内 Bot/Profile，不复用首台实例的订阅跳转：存在当前 Bot 时直接打开创建弹窗；仅没有 Bot 且未订阅时进入 `/subscribe`。本地无 Pass 预览已验证 URL 留在 `/agents/channels/?bot=bot_local_preview`。
- 创建弹窗首屏精简为 Bot 名称、创建方式和复制范围，标题使用“创建 Bot”以避免与 Agent 实例创建混淆，主操作使用“确认创建”；复制提示以用户语义说明继承模型、人设、技能、用户偏好和长期记忆，不继承当前对话、历史会话、运行状态或通道连接，不暴露内部文件与 Channel/Home Channel 术语。初始人设默认收进可展开的“高级设置”，标题不使用分隔线，箭头紧随标题。取消和确认创建改为右下角 36px 高紧凑按钮。当前 Bot 是主 Bot 时合并重复克隆来源，仅显示“复制当前（主 Bot）”与“空白创建”；切换到其他 Bot 时仍显示复制当前、复制主 Bot、空白创建。浏览器验证默认态不渲染人设输入框，展开后通过 `aria-expanded` 和 `aria-controls` 显示对应区域，按钮仍保持右对齐。
- CR 回归验证通过：国际站的微信唯一绑定协调方法不再请求国内站 nested Bot API，国内站 repository 用例 60 个通过、国际站 59 个通过；CTL 新增默认 Bot 不可删除和微信 owner Bot 不可删除的行为测试并通过。
- 钉钉图标视觉回归测试先以旧白底和 52px 图标按预期失败，证明用例覆盖目标缺陷。
- 钉钉图标改为 `rgba(0, 137, 255, 0.08)` 品牌蓝弱背景；聚焦 Vitest 5/5 通过，`pnpm check` 通过且 TypeScript 为 0 new diagnostics。
- 新增默认 Bot 名称回归测试：CTL 将空名称根 Profile 保留给客户端本地化，前端同时把旧后端返回的根 Bot `default` 视为未命名；命名 Profile 仍使用原生 Profile ID 兜底。
- 默认名称修复聚焦验证：`CGO_ENABLED=0 go test ./pkg/instance -run '^TestProjectHermesProfiles' -count=1` 与 CTL 公共路由测试通过；前端 repository 测试 61 passed / 1 skipped；`pnpm check` 通过且 TypeScript 为 0 new diagnostics。CTL 全包测试因本机没有 rootless Docker 在既有 MySQL testcontainer 用例阻塞，与本次默认名称逻辑无关。
- 定时任务根 Profile 问题已在本机当前 Hermes 复现：`hermes -p main cron list --all` 返回 Profile 不存在，`hermes -p default cron list --all` 正常。前端命令层新增 `main -> default` 的原生 Hermes CLI 转换，覆盖 Cron、Memory 与 Skills；ACLI 命令继续使用既有公开 `main` 约定。
- 定时任务与原生 Hermes Profile 路由聚焦验证：4 个 Vitest 文件 194/194 通过，覆盖默认 Bot 列表加载、Cron 统一作用域、Memory 和 Skills；`pnpm check` 通过且 TypeScript 为 0 new diagnostics。文档校验、显式 change-impact 与 `git diff --check` 通过。
- 国内站本地预览 `/agents/channels/` 已实测：钉钉卡片显示浅蓝圆角底；24px 方案因原 SVG viewBox 留白导致主体过小，最终保留原 52px SVG 补偿尺寸。预览中的 Hermes 配置读取失败来自未连接真实实例，与本次样式无关。
- `validate_documentation.py`、显式变更集 `validate_change_impact.py` 和 `git diff --check` 通过；仓库级 `validate_context.py --build-catalog` 仍被分支既有旧 Task Pack 缺少 frontmatter 等基线问题阻塞，本次未扩大范围清理。
- 完整变更集执行 `validate_change_impact.py` 通过，命中 `agent-gateway-runtime`、`site-environment-routing`、`release-gitops`，高风险边界需 maintainer review；`git diff --check` 通过。

## risks
- Profile 创建失败可能留下不完整目录；CTL 会尽力执行 Profile 删除补偿，最终列表只读 Hermes 真实状态。
- 克隆可能复制敏感通道/Home channel；不具备选择性清理能力时返回 capability 不支持。
- 公共 API allowlist 漏配会导致 CTL 直连成功但国内站 404；加入 service-gateway policy 测试。
- 当前主 checkout 有重叠未提交改动；实现位于独立 worktree `feature/multi-bot-profile-0909-domestic`。

## validation
- `cd ctl && go test ./pkg/model/... ./pkg/instance/... ./main/api/...`
- `cd service-gateway && go test ./internal/gateway/...`
- `cd frontend && pnpm test -- <focused files>`
- `cd frontend && pnpm check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`
- 国内站 `/agents` 桌面与移动端截图验证。

## decisions
- CTL 只拥有实例归属校验和稳定 HTTP contract；Hermes Profile 目录及 `profile.yaml` 是 Bot 元数据与运行时状态真源。
- 默认 Bot 采用公开选择器 `main`；命名 Profile ID 由后端生成且不可变，同时作为命名 Bot 的公开 `bot_id`。
- 本期不硬编码 Bot 数量上限；以后由套餐/capability contract 下发。
- 多 Bot API 归属于 `/v1/instances/{instance_id}/bots`，保持实例作用域显式。
- 钉钉图标沿用既有通道图标容器和品牌色 8% 弱背景规则，不新增独立组件或样式层。
- `main` 只作为 LightVela 产品/API 的默认 Bot 标识；原生 Hermes 根 Profile 标识为 `default`，不得要求用户创建命名 Profile `main`。

## scan_scope
- `ctl/pkg/instance`, `ctl/pkg/model`, `ctl/main/api`, `service-gateway/internal/gateway`, `frontend/src/{domain,repositories,contexts,pages/marketing}`。

## scan_output
- Graphify 结果仅用于定位；行为结论以当前源码、Hermes 当前源码和测试为准。

## handoff
- FE-AI verify 已通过；archive 仍等待用户另行明确授权。
- 当前步骤：已移除 Bot/Channel Binding 数据库 migration 与 DAO；前端、CTL、service-gateway、文档门禁与 5174 浏览器回归完成。
- 用户已授权 commit、push 和创建 MR；MR !3801 已创建并同步最新 `master`，尚未合并、发布或执行生产操作。
