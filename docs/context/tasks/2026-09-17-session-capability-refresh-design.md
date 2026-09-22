# 存量会话能力刷新设计收敛

> 后续决定：R2 的正文版本更新、Hermes 自动热刷新及强版本隔离已取消。当前实现与收尾以 `opencraft/docs/session-capability-refresh.md` R3 和 `opencraft/design/skills-refresh/task_plan.md` 为准；本文保留设计阶段历史，不自动续做 B/D/E。

## goal
将 Codex/WB 复核结论落实为 OpenCraft 可分阶段实施的目标设计。

## non_goals
- 本轮不修改运行时代码、参考副本、用户安装、凭据或云服务。
- 不提交、推送、打包；不宣称目标能力已经实现。

## requirement_ids / requirement_refs / requirement_excerpt
- 本任务用户请求：“行思考一下怎么落地，更新一下文档。”
- 延续同一会话的 Skills 更新、Connector 授权/通知与原生引擎适配讨论。

## interface_refs / data_structure_refs
- `opencraft/packages/appserver-protocol/src/profile-skills.ts`：本机 update/enablement 仍为 false。
- `opencraft/apps/local-agent-host/src/dsh-capability-plugin.mjs`：discovery scope、Provider、forceReload。
- `opencraft/apps/local-agent-host/src/dsh-profile-skills.ts`：现有安装/卸载写入入口。

## history_context
- current_design_refs：`opencraft/docs/session-capability-refresh.md`、`opencraft/docs/platform-architecture.md`、`opencraft/docs/agent-capability-fabric.md`。
- relevant_evolution：前一轮只读复核确认 WB 集成可贡献 Skill/MCP；Codex UI 失效与运行时 reload 分离。
- superseded_refs：本文将刷新文档 R1 的统一步骤级承诺、Connector 等同物理连接和强版本隔离前置替换为 R2 分级设计。

## acceptance
- 修正全篇相关表格、流程、拓扑、阶段及验收，避免只追加相互矛盾的新结论。
- 明确阶段 A 的入口、失败语义、真实 DSH 回归和 non-goals。
- 文档校验、链接检查与 whitespace 检查通过。

## affected_paths
- `opencraft/docs/session-capability-refresh.md`
- 本 Task Pack；其他既有 dirty 文件不属于本轮修改。

## required_context
- agent-gateway-runtime、site-environment-routing、upstream-subtrees、service-opencraft、identity-access。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md` | 服务增量规则 | 维护边界、参考只读、文档级验证 |
| `docs/context/domains/agent-gateway-runtime.md` | Router must_read | 原生运行时与协议责任 |
| `docs/context/domains/site-environment-routing.md` | Router must_read | 不混淆平台和环境能力 |
| `docs/context/project/upstream-subtrees.md` | Router must_read | mono2 唯一写入真源 |
| `docs/context/project/services/opencraft.md` | Router must_read | 服务入口 |
| `docs/context/domains/identity-access.md` | Router must_read | 授权不可用 UI 替代 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | 架构维护必读 | 最小充分复杂度、连续性 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | 文档验收 | 不为文档重新打包 |
| `opencraft/docs/platform-architecture.md` | 平台责任 | Host、Conversation、Credential owner |
| `opencraft/docs/agent-capability-fabric.md`（1–80 行） | 父设计边界 | 不再建立另一套 Fabric |
| `docs/context/tasks/TASK-TEMPLATE.md`、`docs/context/tasks/CHECKPOINT-TEMPLATE.md` | 任务与交接 | 有界记录 |
| `.agents/context/change-impact.json` | 影响规则 | Markdown 排除，无需修改无关领域设计 |

## evidence
- 有界源码查询确认本机 Skills 契约与装配入口；参考证据的精确入口已补在正式设计第 9 节。
- 首次 patch 含多余匹配行，原子校验失败，移除该行后成功；没有部分写入。

## risks
- 参考副本不完整；不能把客户端行为推断为后端热更新保证。
- DSH 原生 scope、正文来源扩展和 Hermes 刷新能力须在实施阶段验证。

## validation
- 文档、相对链接与 whitespace；不运行不相关产品构建。
- `validate_documentation.py --repo . --format json`：通过，errors/warnings/broken 均为空。
- 两份本轮文档专项检查：8 个本地链接有效，代码围栏配对、行尾空白通过；覆盖未追踪文件。
- `git diff --check`：通过；`validate_change_impact.py --repo . --staged`：通过，但暂存集为空，不能当作实现变更验收。

## decisions
- 统一状态语义与安全边界声明，不统一 hook 实现。
- Connector 分派贡献，各领域保留唯一写入者。
- A 目录、B 正文、C 集成、D 第二引擎、E 强版本隔离；E 不阻塞 A–D。

## scan_scope
- 上述三个 OpenCraft 源码入口和目标文档；不扫描用户会话或凭据。

## scan_output
- 未生成外部扫描产物。

## handoff
- 文档 R2 与文档门禁已完成；运行时实现尚未开始，未提交。

## checkpoint
- stage：文档交接完成；下一道门禁为阶段 A 的负例与真实 DSH 验证。
- verified：R2 已落盘，既有运行时代码未变更。
- unverified：所有新增目标行为的实际 Engine/Electron 验收。
- discard：R1 过强的通用步骤级保证和版本隔离前置。
- restore：从正式设计第 7.1 节继续，不改其他 dirty 文件。
- next_action：获准实施后从正式设计第 7.1 节的回归用例开始。
