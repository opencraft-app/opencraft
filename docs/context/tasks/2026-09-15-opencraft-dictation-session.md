---
id: opencraft-dictation-session-20260915
type: task
scope: 原生听写会话与识别片段身份及最终提交重构。
triggers:
  - opencraft dictation session
  - utterance ledger
  - 听写片段账本
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/docs/platform-architecture.md
  - opencraft/design/dictation-session/task_plan.md
status: active
reviewed_at: 2026-09-15
review_due: 2026-12-14
revision: 1.0.0
precedence: task
derived: false
---

## goal
持续Capture与识别片段分离，原草稿不被临时识别覆盖，收尾成功后一次提交。
## non_goals
不改模型/DSH/认证、不保存录音、不自动录音、不提交发布，不宣称ASR全语言离线或零误差。
## requirement_ids / requirement_refs / requirement_excerpt
用户同意BB简洁交互与Codex片段账本的重构。
## interface_refs / data_structure_refs
NativeSpeechEvent、SpeechInputProvider、Composer瞬时输入事务、原生识别task与音频request。
## history_context
current_design_refs：platform-architecture客户端voice；relevant_evolution：此前仅Footer/完成发送迁移，临时文本持续更新与原生final即terminal仍未对齐；superseded_refs：无身份字符串合并。
## acceptance
片段ID更新隔离、重发无重复、final不终止Capture、stop完整收尾，取消/失败/草稿变化无自动写入；正文最终只提交一次。
## affected_paths
app-host-protocol、Electron native manager/helper、voice-input、CodexComposer、测试与设计。
## required_context
路由session词误匹配identity-access；未扩认证范围。
## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| opencraft/AGENTS.md | 服务规则 | npm与门禁 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 所有权 | 同输入事务 |
| opencraft/.agents/skills/opencraft-maintenance/references/verification.md | QA | 原生/模拟分开 |
| opencraft/docs/platform-architecture.md | 当前设计 | 明确被替代语义 |
| docs/context/domains/identity-access.md | must_read误匹配 | 不改认证 |
## evidence
Codex/BB实际符号与边界记录在design/dictation-session/findings.md。
32聚焦、编译native生命周期自检、完整npm gate、Swift universal/签名及两个隔离桌面脚本退出0。
## risks
系统自然识别task终结与音频边界需真录音；不把中间猜测当已确认文本。
## validation
TDD、受影响类型/完整gate、Swift universal、签名客户端与无录音probe；真录音另获授权。
多片段final-only、原草稿与选区保护、取消/切页、长按/Enter、明暗/窄窗、一次正文发送及设置重启通过；根context历史问题另列，不称全仓所有门禁全绿。
## decisions
身份与账本在语音会话，插入/发送归Composer；不增加可不同步的全局UI开关。
## scan_scope
限定本服务语音/Composer，参考对应Codex/BB听写文件。
## scan_output
design/dictation-session/findings.md。
## handoff
重构与无录音验收完成，新预览启动；旧窗口保持，未提交推送。真实Speech识别及音频交接仍待实录验证。
## checkpoint
交接：verified为协议/账本/生命周期/输入事务/模拟客户端/构建签名；unverified为真实语音、自然task交接与ASR精度，不承诺零丢失/全语言离线。
