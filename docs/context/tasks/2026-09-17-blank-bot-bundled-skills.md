---
id: blank-bot-bundled-skills-2026-09-17
type: task
scope: 追加空白 Bot 初始化 LightVela 镜像精选的系统预置 Skills，不复制来源 Bot 后续安装的 Skills。
triggers:
  - blank Bot bundled skills
  - 空白 Bot 系统预置技能
  - 新建 Bot 默认技能
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-17-blank-bot-bundled-skills.md
  - docs/engineering/domains/agent-gateway-runtime.md
  - wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md
status: active
reviewed_at: 2026-09-17
review_due: 2026-12-17
revision: 1.0.0
precedence: task
derived: false
---

# Blank Bot Bundled Skills

## goal
追加 Bot 选择“空白创建”时，自动安装当前 Hermes 镜像中 LightVela 精选的系统预置 Skills，并在该 Bot 的已安装列表中显示，不复制主 Bot 后来安装的 Skills。

## non_goals
- 不改变首个 Bot 的初始化、克隆模式、创建方式默认选择或 Profile 隔离。
- 不按固定数量或静态技能名单安装；不自动补装存量空白 Bot。
- 不合并 MR、构建镜像、发布或修改线上实例；提交、推送、创建 MR 已获用户本轮授权。

## requirement_ids / requirement_refs / requirement_excerpt
- 2026-09-17 用户要求：“从空白新建bot的时候，还是会默认安装系统预置的skills”；用户同意独立新变更，不复用旧的来源显示 change。
- 本轮按“与首个 Bot 镜像精选集一致”解释系统预置，不等于 Hermes 上游的完整 bundled catalog；已在会话中说明该差异。

## interface_refs / data_structure_refs
- `POST /v1/instances/{instance_id}/bots` 的 `create_mode=blank` 与 `source_bot_id` 缺省行为不变。
- CTL `buildHermesProfileCreateCommand` 创建命名 Profile；Hermes 新 Profile 默认播种完整 bundled catalog，`--no-skills` 会写 `.no-bundled-skills`。
- 镜像 `curate_hermes_skills` 是首个 Bot 预置集的构建权威；`$HERMES_HOME/.lightvela/base-skills` 记录构建后实际保留的路径。

## history_context
- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md`, `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`。
- `relevant_evolution`: MR !3889 曾用镜像基线收敛空白 Profile；MR !3899 改为 `--no-skills`，本轮恢复精选集语义并保留后续主模型凭据快照修复。
- `superseded_refs`: `docs/context/tasks/2026-09-11-blank-bot-zero-skills.md` 仅作历史参考，不作为新行为权威。

## acceptance
- 空白 Profile 创建后只包含当前镜像精选的系统预置 Skills；来源 Bot 后装的 Skill 不复制，缺失/损坏基线时创建失败并走现有回滚。
- 新 Profile 保留 Hermes bundled manifest 的更新语义，不写 opt-out 标记；已有空白 Profile 不变。
- 克隆模式保持复制来源 Skills，首个 Bot 保持当前镜像初始化；前端空白创建说明准确。
- 聚焦 Go/镜像脚本/前端测试与服务门禁通过；不把源码验证声称为线上发布。

## affected_paths
- `ctl/pkg/instance/bots.go`, `ctl/pkg/instance/bots_test.go`
- `images/build.sh`, `images/tests/test-hermes-build-script.sh`, `images/tests/test-hermes-runtime.sh`
- `frontend/src/pages/marketing/agent-settings-page.tsx` 及相邻测试/i18n 生成物
- `docs/engineering/domains/agent-gateway-runtime.md`, `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`

## required_context
- Router: `service-ctl`, `control-plane-ops`, `agent-gateway-runtime`。
- 最近服务说明：`ctl/AGENTS.md`, `frontend/AGENTS.md`；邻接：`docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`。

## context_receipt
| File | Reason | Use |
|---|---|---|
| `docs/context/project/services/ctl.md@1da70f2a6` | CTL 服务边界 | 命名 Profile 创建归 CTL |
| `docs/context/domains/agent-gateway-runtime.md@1da70f2a6` | Domain 路由 | 保持运行时与公共路由边界 |
| `ctl/AGENTS.md@1da70f2a6` | 服务规则 | 聚焦 Go 测试 |
| `frontend/AGENTS.md@1da70f2a6` | 前端规则 | i18n/check/test/build 门禁 |
| `frontend/DESIGN.md@1da70f2a6` | 列表规则 | 系统预置显示语义不变 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1da70f2a6` | UI 文案邻接 | 检查生成资源与测试 |
| `docs/context/tasks/2026-09-10-blank-bot-base-skills.md@1da70f2a6` | 有界历史 | 复用动态基线方案，不固定数量 |
| `docs/context/tasks/2026-09-11-blank-bot-zero-skills.md@1da70f2a6` | 现行旧行为 | 明确反转范围 |
| `/Users/pablozhong/.hermes/hermes-agent/hermes_cli/profiles.py` | 本机 Hermes 实现 | fresh/clone/opt-out 语义 |

## evidence
- `origin/master@1da70f2a6`: CTL 空白创建带 `--no-skills`；镜像根 Profile 在 `curate_hermes_skills` 中动态裁剪，二者不同。
- 本机 Hermes `profile create` fresh 模式默认播种仓库完整 bundled Skills；仅移除 `--no-skills` 会超出 LightVela 镜像精选集。
- 独立 worktree `/Users/pablozhong/codex/lightvela-blank-bot-bundled-skills-0917` 在 `origin/master@1da70f2a6` 上改动；主 checkout 未改动，本轮未构建实际镜像或调用线上实例。

## risks
- 镜像基线清单必须在 curation 后记录；旧镜像以根 Profile 的 bundled manifest 与当前实际目录推导，排除用户后装的 Skills。
- 未来 Hermes 更新可能调整 bundled 来源，需保持 manifest 与实际目录的一致性，并以镜像运行时 smoke test 验证。

## validation
- `CGO_ENABLED=0 go test ./pkg/instance -run 'TestBuildHermesProfileCreateCommand|TestAlignBlankProfileSkills' -count=1`、`CGO_ENABLED=0 go vet ./pkg/instance ./pkg/errcode`：通过。
- `bash -n images/build.sh images/tests/test-hermes-build-script.sh images/tests/test-hermes-runtime.sh`、`bash images/tests/test-hermes-build-script.sh`：通过；实际构建镜像上的 runtime smoke 尚未运行。
- 前端 CN/global 新建 Bot 聚焦测试各 38/38，通过；Skills 列表客户端与合并逻辑聚焦测试 65/65，通过；`pnpm check`、`pnpm build` 与 OpenCraft `npm run check:mono2-agent-console` 通过。
- `validate_documentation.py --repo . --format json` 通过；显式变更路径的 `validate_change_impact.py` 通过，仍需 owner 审阅；`context-audit` 测试 33/33 通过。新 Task Pack 经 context validator 检查无自身错误，但全仓 catalog 校验有 1165 个其他文件错误，context tests 有 4 项失败。
- 完整 CTL package 测试受本地 Docker/CGO 依赖阻塞；完整前端测试出现其他模块失败且 worker 未退出，手动中止。这两项不能声称通过，未对每项失败完成基线比对。

## decisions
- 以镜像精选的真实路径为权威，不在 CTL 写死技能数量或名单；用户如指定上游全量再调整范围。

## scan_scope
- `ctl/pkg/instance`, `images`, 前端创建弹窗及相邻测试、Hermes Profile/Skills 同步实现。

## scan_output
- 精确命中 `buildHermesProfileCreateCommand`, `curate_hermes_skills`, `seed_profile_skills`；无全仓扫描产物。

## handoff
- 本地实现与聚焦门禁完成；用户已授权本次 commit、push 与创建 MR。仍需 owner 审阅、实际镜像 runtime smoke 与集成验证；未授权合并、构建镜像或发布。

## checkpoint

### stage
本地实现和聚焦验证完成，待 owner 审阅及真实镜像/集成验证。

### verified
- 独立 worktree 基于 `origin/master@1da70f2a6`，主 checkout 未改动。
- Go 聚焦测试、vet、镜像脚本 fixture、前端 CN/global 聚焦测试、Skills 客户端聚焦测试、前端 check/build、OpenCraft 同步校验、文档及显式变更路径 impact 校验通过。
- 新 Task Pack 的 context validator 错误数为 0；全仓 context catalog 有其他文件错误。

### unverified
- 未运行实际构建镜像的 runtime smoke；未验证线上实例、生产部署、Argo revision 或完整 CTL/前端测试通过。
- 完整 CTL 受 Docker/CGO 限制；完整前端测试出现其他模块失败且未完成，每项失败未做基线比对。

### discard
- 不把 `--staged` 且零 staged 文件的 impact 校验算作有效验证；有效的是显式路径校验。
- 不把 Hermes 完整 bundled 目录、历史观察到的技能数量或本机 Hermes 版本当成部署后的固定预置数量。

### restore
- Worktree `/Users/pablozhong/codex/lightvela-blank-bot-bundled-skills-0917`；Task Pack 与正式设计文档记录实现边界。
- 本次用户已授权 commit、push、MR；未授权合并或发布。

### next_action
提交并推送本功能分支，创建以 `master` 为目标的 MR；随后由 owner 审阅，并在包含完整依赖的环境执行镜像 runtime smoke 和集成验证。
