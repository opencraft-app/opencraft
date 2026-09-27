## goal
把当前 mono2 OpenCraft 工作树构建为新的 headless 预览版本，健康检查后替换现有 `opencraft-server.service`，并按用户授权提交、推送 `master`。

## non_goals
- 不修改 GitOps、生产站、云资源、服务监听地址或既有鉴权模式。
- 不删除、复制或重建预览私有数据目录；不丢弃当前未提交改动。

## requirement_ids / requirement_refs / requirement_excerpt
- 本会话用户：“替换吧”；随后补充：“提交、推送master”。

## interface_refs / data_structure_refs
- `opencraft/scripts/package-headless-linux.mjs`、`scripts/smoke-headless-package.mjs`：制品与隔离运行态验证。
- `/opt/opencraft-server/current`：唯一活跃 release 指针；`opencraft-server.service`：现有单 owner。
- `/__opencraft_health`、`/version.json`：切换后健康与 buildId 对账。
- 预览私有目录 `/var/lib/opencraft-preview-codex-20260923173651` 必须保持原址。

## history_context
- `current_design_refs`: `opencraft/docs/build-matrix.md#headless-linux-server-archive`、`opencraft/docs/platform-architecture.md`。
- `relevant_evolution`: 先前预览通过 release 目录与 `current` symlink 做可回滚切换；本次源码新增 Codex 多逻辑订阅者修复，其他并行工作树变更尚未提交。
- `superseded_refs`: none。

## acceptance
- 当前工作树的敏感信息、diff 和相关门禁检查通过；提交并推送到 `origin/master`。
- 新 archive 由当前 checkout 构建，隔离 headless smoke 通过，buildId 与制品 manifest 一致。
- 现有服务切到新 release；health 为 ok，HTTP buildId 与新制品一致，旧 release 保留可回滚。

## affected_paths
- 当前 mono2 dirty worktree（精确清单以 `git status` 为准）；本 Task Pack。
- 隔离构建输出与 `/opt/opencraft-server/releases/<buildId>`；`/opt/opencraft-server/current` symlink；现有 systemd unit restart。

## required_context
- `agent-gateway-runtime`、`site-environment-routing`、`upstream-subtrees`、`service-opencraft`；误命中 `control-plane-ops` 仅用于排除 CTL。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`、`opencraft/AGENTS.md` | 根与服务 P0 边界 | 确认提交/推送/预览替换授权与验收 |
| `docs/context/project/services/ctl.md` | 首次 router 误匹配 | 排除 CTL 控制面 |
| `docs/context/domains/agent-gateway-runtime.md`、`site-environment-routing.md` | 精确 router must-read | 限定 Agent 与站点范围 |
| `docs/context/project/upstream-subtrees.md`、`services/opencraft.md` | 精确 router must-read | mono2 唯一真源 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`、`references/verification.md` | 预览维护 Skill | 产物/运行时分层与可回滚切换 |
| `opencraft/docs/build-matrix.md`、`scripts/package-headless-linux.mjs`、`scripts/smoke-headless-package.mjs` | 包装权威入口 | 新制品与隔离 smoke |
| `docs/context/tasks/2026-09-26-opencraft-preview-restart.md` | 同机切换历史 | 旧 release 保留、健康检查与回滚 |

## evidence
- 操作前 `master`，44 个 tracked 修改、23 个 untracked 路径；远端 `origin` 为 mono2 仓库。
- 当前服务 active，PID 3695075，监听 `0.0.0.0:80`，当前 release `/opt/opencraft-server/releases/20260926081211-2224a6698459`；health ok，HTTP buildId `20260926081211-2224a6698459`。
- 待填：门禁、敏感信息检查、commit/push、构建、smoke、切换和 live 验证。
- `npm run gate` 全部通过（含全 workspace typecheck、AppServer/Host、Web 与 Expo Web/iOS 构建）；`test:headless-server` 19/19 通过；`check:boundaries` 通过。
- 已暂存 68 个路径；`git diff --cached --check` 与 `validate_change_impact.py --repo . --staged` 通过。新增行的令牌/私钥模式扫描无真实命中，唯一高概率模式误报是 Task Pack ID 中的 `sk-` 子串。
- 初次 archive `/data/opencraft-multi-subscriber-cutover-0rfRJV/OpenCraft-server.tar.gz`，SHA-256 `b247f1155ba8452e03138fdbd35f3efcc117b20aa463dda5e89cb86c4e36e67b`，buildId `20260926094744-87e751512db9`；隔离 `smoke:headless:linux` 通过，包内含新原生订阅回收逻辑。该包在远端基线合入前构建，仅作验证证据，不用于切换。
- 远端 `origin/master` 前进至 `363469dde` 后，本地提交已 rebase 到它之上；唯一冲突的工程文档同时保留远端 Agent Console 漂移说明与本次权限/订阅所有权说明，没有强推。
- 合并后 `check:mono2-agent-console` 验证 130 个文件；全 workspace typecheck、AppServer 和 headless 回归通过。第二份合并后 archive 的隔离 smoke 通过；最终定版制品将在本 Task Pack 入库后重新构建，以保持 `sourceRevision` 与提交一致。

## risks
- 重启会断开当前 WebSocket，可能中断在途 Turn；先通过隔离 smoke，保留旧 release，失败自动回滚。
- 当前服务原已公开监听且无鉴权；本次不扩大访问边界，只替换同一预览。
- 大量并行 dirty 改动会一同进入用户要求的 master 提交及预览；提交前检查敏感信息与门禁，不把脏构建称为干净 revision。

## validation
- `git diff --check`、敏感信息扫描；OpenCraft 相关 lint/type/test、headless server test。
- `package:headless:linux:amd64` 的独立输出；`smoke:headless:linux`；manifest/buildId 对账。
- 切换后 systemd active、health、版本与 AppHost 初始化验证。
- `validate_change_impact.py --repo . --staged`。

## decisions
- 使用现有 release symlink + systemd unit，不运行安装器重建数据目录或 unit。
- 只在新制品隔离烟测通过后切换，保留旧版本供回滚。

## scan_scope
- `opencraft/` 当前改动、headless 构建脚本、systemd unit、`/opt/opencraft-server/current`。

## scan_output
- 有界命令摘要保存在本 Task Pack，不内联凭据或完整日志。

## handoff
- 验证与本地提交完成；待推送、最终定版制品与运行服务切换。
