---
id: opencraft-dictation-interaction-20260915
type: task
scope: Composer 听写互斥呈现、完成与发送事务。
triggers:
  - opencraft dictation
  - Composer voice footer
  - 听写交互
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/docs/platform-architecture.md
  - opencraft/design/dictation-interaction/task_plan.md
status: active
reviewed_at: 2026-09-15
review_due: 2026-12-14
revision: 1.0.0
precedence: task
derived: false
---

## goal
深入对照Codex恢复源码/BB，整改原位语音Footer，保留本产品主题及原生识别。
## non_goals
不替换引擎/认证，不自动录音、不提交推送，不覆盖旧客户端。
## requirement_ids / requirement_refs / requirement_excerpt
用户明确要求确定不变量与所有权后实现，而非单纯缩小按钮。
## interface_refs / data_structure_refs
ComposerTransientTextInput、ComposerController、语音平台事件、语音Footer。
## history_context
current_design_refs：platform-architecture的client voice ownership；relevant_evolution：原生输入已接通但动作追加普通工具栏；superseded_refs：设置页面取消按钮呈现。
## acceptance
普通/听写互斥，同编辑器，真实音量反馈，停止与发送分别编译，取消/草稿/View失效隔离迟到文本和发送。
## affected_paths
composer-core/codex-composer/extension-react、voice-input、Main native bridge/Swift、app.scss、测试与文档。
## required_context
路由无匹配，有界精确检索。
## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| opencraft/AGENTS.md | 服务边界 | 独立workspace与门禁 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 所有权 | 事务/呈现分层 |
| opencraft/.agents/skills/opencraft-maintenance/references/verification.md | QA | 模拟/真实证据分开 |
| opencraft/docs/platform-architecture.md | 当前设计 | 客户端音频归属 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 邻接检查 | 本服务UI测试/配置，不改frontend |
## evidence
参考符号与版本记录在design/dictation-interaction/findings.md。
26项聚焦与最终完整npm gate退出0；严格签名检查、真实无录音probe、合成OS事件驱动的签名客户端交互及一次本地正文请求通过。独立title请求已按真实结构区分。
## risks
停止完成和发送必须同草稿归属，真实识别/权限不能由模拟证明。
## validation
TDD、受影响类型/测试、完整gate、签名隔离桌面与主题/窄容器/键盘检查。
文档/设计影响/diff检查通过，33项context-audit测试通过；最终根context仍4项历史失败，本Task新增frontmatter问题已修正，不称全仓门禁全绿。
## decisions
呈现属于既有瞬时输入事务，不另建可失步的全局UI状态。
## scan_scope
本服务Composer与语音源码，限定BB/Codex对应听写文件。
## scan_output
design/dictation-interaction/findings.md。
## handoff
整改实现与签名客户端验收完成，新预览已打开Chat且麦克风idle。未录音/提交/推送，旧预览保持；真实权限/识别与端侧输入本轮未复验。
## checkpoint
阶段：交接；verified：源码边界、事务/呈现归属、pointer释放、final后发送、取消/换草稿、明暗/窄容器、构建签名；unverified：真实麦克风识别、Developer ID/notarization。
