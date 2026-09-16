---
id: opencraft-dictation-ownership-20260915
type: task
scope: Codex 听写controller绑定、追加与成功提交闭环迁移。
triggers:
  - opencraft dictation ownership
  - 听写写入回执
  - Composer 内容替换失效
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/docs/platform-architecture.md
  - opencraft/design/dictation-ownership/task_plan.md
status: active
reviewed_at: 2026-09-15
review_due: 2026-12-14
revision: 1.0.0
precedence: task
derived: false
---

## goal
对照Codex具体controller回调、同步追加文末/readback发送，实现本产品写入归属与回执。
## non_goals
不改DSH/认证/录音历史、不自动录音、不提交发布，不声称回执bool为Codex原接口。
## requirement_ids / requirement_refs / requirement_excerpt
用户要求核对并复刻Codex所有权，修复已发现内容替换/未确认插入后发送风险。
## interface_refs / data_structure_refs
ComposerTransientTextInput、View commit政策/回执、Core内容代次、DictationCompletion。
## history_context
current_design_refs：platform-architecture客户端听写；relevant_evolution：final-only片段账本已迁移，写入仍void且replace-content未失效；superseded_refs：用结果非空当提交成功。
## acceptance
原内容替换同步失效；旧lease不改新草稿，拒绝不发；具体View同步读回，dictation追加文末不覆盖选中文本；泛用输入语义保留。
## affected_paths
composer-core/codex-composer/voice-input、测试、正式设计。
## required_context
无路由匹配，bounded exact search。
## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| opencraft/AGENTS.md | 服务约束 | workspace/gate |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 所有权 | 适配而非猜测 |
| opencraft/docs/platform-architecture.md | 当前契约 | 对照更新 |
## evidence
恢复源码controller/editor/request符号记录在design/dictation-ownership/findings.md。
36聚焦、完整npm gate、真实组件所有权失败路径与签名桌面正常路径通过；所有模拟明确只替换ASR/本地推理端点。
## risks
Store/View分离不能复制同步controller隐含条件；写入失败必须拒绝发送，泛用瞬时输入提交不退化。
## validation
TDD、类型/完整gate、签名隔离客户端，实际录音不在本轮自动验收范围。
文档/设计影响/diff通过；根context有历史失败且本Task无新命中，33项audit通过；不称所有全仓门禁全绿。
## decisions
具体输入lease+内容代次+物理回执；dictation追加文末、泛用默认selection，不新建全局所有权服务。
## scan_scope
限定Core/View/voice和恢复源码对应controller/request。
## scan_output
design/dictation-ownership/findings.md。
## handoff
实施与验收完成，新独立预览启动；未录音/复制认证/提交推送。音频handoff不是本轮所有权写入修复的已验证结论。
## checkpoint
交接：controller绑定/内容失效/View ack/追加文末/失败不发/原生正常链路已验证；真实Speech与音频handoff仍未录音验证。
