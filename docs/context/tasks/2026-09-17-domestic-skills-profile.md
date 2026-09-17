## goal
国内站 Skills/Experts 的实例技能操作严格绑定当前 Bot 的 Hermes Profile，并在旧/新 ACLI 上安全卸载。

## non_goals
- 不改国际站 Skills 命令、SkillHub 搜索、Bot 创建、部署或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户对话：确认 ACLI 多 Profile 支持后，请求优化国内站技能页代码；无外部需求编号。

## interface_refs / data_structure_refs
- `Bot.profileId` 来自 `/bots` 的 `profile_id`，主 Bot 为 `main`。
- 国内站 `acli skills` 命令使用 `--agent`；旧稳定包的 `list/uninstall` 仍读取 `ACLI_RUNTIME_HOME`，新包通过 `ACLI_SYS_RUNTIME_HOME` 解析 Profile。
- 缺失或非法 Profile 时不能落到根 Profile；同名技能只删除选中 Profile 的实例。

## history_context
- current_design_refs: `frontend/openspec/changes/2026-09-17-domestic-skills-profile-scope.md`、`frontend/openspec/changes/2026-08-20-skill-package-native-batch-design.md`、`frontend/openspec/plan.md`。
- relevant_evolution: 2026-09-17 发布清单 `latest=2026.09.17-4`、`stable=2026.09.04-4`；本地已核对新旧 ACLI 命令包。
- superseded_refs: 无。

## acceptance
- 国内站缺失 Profile 时不下发技能实例命令。
- list/install/batch-install/uninstall 均绑定当前 Profile；Hermes 原生技能走 ACLI 卸载，根与子 Profile 同名时根目录不变。
- 定向测试、`pnpm i18n:check`、`pnpm check` 和 `git diff --check` 通过。

## affected_paths
- `frontend/src/lib/hermes-agent-command.ts`
- `frontend/src/pages/marketing/skills-demo/skill-registries.ts`
- `frontend/src/pages/marketing/agent-experts-panel.tsx`
- `frontend/src/pages/marketing/agent-skills-panel.tsx`
- 相邻测试文件。

## required_context
- site-environment-routing Pack；前端服务约束；Skills 页面 Skill。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@bae27bd19` | 仓库硬边界 | 提交与发布分别授权 |
| `docs/context/domains/site-environment-routing.md@bae27bd19` | 路由结果 | 国内站边界 |
| `frontend/AGENTS.md@bae27bd19` | 服务约束 | 验证命令 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@bae27bd19` | 邻接卡 | 测试与 i18n 邻居 |
| `frontend/openspec/changes/2026-08-20-skill-package-native-batch-design.md@bae27bd19` | 历史设计 | 批量安装兼容性 |
| `frontend/openspec/plan.md@bae27bd19` | 当前前端计划 | Skills 相关范围 |
| `docs/context/tasks/TASK-TEMPLATE.md@bae27bd19` | Task Pack 格式 | 本记录结构 |
| `.agents/skills/product-skills/lv-sitepage-skills/SKILL.md@bae27bd19` | Skills 页面流程 | 范围和验证 |

## evidence
- 开发基点：`origin/master` 的 `bae27bd19`，与主工作区隔离；提交后已无冲突地同步到 `1bb2b67ba`。
- ACLI `latest` 与 `stable` 脚本均已本地校验；旧包 `list/uninstall` 只认 `ACLI_RUNTIME_HOME`，新包经 `agent_scope.sh` 解析。
- 隔离临时目录中，旧稳定包与最新包分别卸载子 Profile 的同名 `shared`；两次主 Profile 的 `SKILL.md` 均保留。
- 前端 6 组定向测试 201 个通过；`pnpm i18n:check`、`pnpm check`（0 个新增 TypeScript 诊断）、`pnpm build:cn`、文档校验通过。构建产生的无关字体与 `next-env.d.ts` 变更已移除。
- 全量 Vitest 曾启动，但输出跨模块失败后一个 worker 持续高 CPU 且无进度，已中断；未得到全量通过结果，也未建立这些失败的基线归因。

## risks
- 旧包批量命令可能不认识 `--agent`：回退逐个安装。
- Profile 未就绪：失败关闭，不执行根目录命令。
- 回滚：仅撤销此 worktree 中相关文件改动。

## validation
- 定向 Vitest、i18n、前端 check、diff check；必要时用隔离临时运行目录做新旧 ACLI 同名技能验证。

## decisions
- 同时传入系统根目录与 Profile 运行目录，兼容新旧 ACLI；保留 `--agent` 明确目标。
- 国内站 Hermes 原生技能使用 `acli skills uninstall --source local`，国际站沿用原路径。
- Experts 根据站点模式选择命令作用域；国际站保留原有包装逻辑。

## scan_scope
- `frontend/src/pages/marketing/skills-demo/`、`frontend/src/pages/marketing/agent-experts-panel.tsx`、相关 lib。

## scan_output
- `rg` 定位结果已用于本次代码入口；未生成扫描产物。

## handoff
- 本地代码及定向验证完成；推送和 MR 状态以工蜂实时记录为准，尚未合并或部署。发布前仍需确认目标实例 ACLI 包版本及实际 Bot Profile 数据。

## checkpoint
- stage: 同步最新 `origin/master` 并完成定向门禁，下一步推送分支和创建 MR。
- verified: 分支位于 `1bb2b67ba` 之上；201 个定向测试、i18n、前端 check、国内站构建和文档校验通过；工作树清洁。
- unverified: 全量前端测试未完成；目标实例的 ACLI 版本和真实 Bot Profile 尚未联调；MR 的 CI/合并状态须创建后查询。
- discard: 旧开发基点的构建产物及被中断的全量测试输出不作为通过证据。
- restore: 独立 worktree `/Users/pablozhong/codex/lightvela-skills-profile-20260917`，分支 `codex/domestic-skills-profile-isolation-20260917`，目标 `master`。
- next_action: 推送并创建工蜂 MR，查询实际分支 SHA、目标分支和 CI 状态。
