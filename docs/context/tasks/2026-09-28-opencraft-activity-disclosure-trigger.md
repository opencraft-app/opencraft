## goal
固化手机上已实测改善的 `Worked for` 首触结构，并让 Conversation 活动折叠项复用同一触发器。

## non_goals
- 不改变各活动项的展开状态机、正文动画、持久化偏好或 Host 协议。
- 不提交、推送或发布生产版本；不把一次手机反馈描述为全平台验收。

## requirement_ids / requirement_refs / requirement_excerpt
- 本会话用户要求：“固化成这样吧”，并从控件统一和建模角度审视。

## interface_refs / data_structure_refs
- `OverlayDisclosureTrigger`：一个带 `aria-expanded`、`aria-labelledby` 的原生覆盖按钮与独立的可见内容层。
- `ActivityDisclosureHeader`、`ActivityDisclosure`、`AgentActivityGroupDisclosure`：各自仍拥有 onToggle 和展开状态。

## history_context
- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`、`opencraft/design/invariants.md`。
- `relevant_evolution`: 手机日志证明失败触摸到达稳定按钮，但没有派发 click；放大命中区无效。覆盖按钮的临时预览曾获“好像解决了”的反馈，但同一版本随后复现，不能据此判定修复。
- `superseded_refs`: 内嵌文字按钮和整行 hover 实验不作为当前方案。

## acceptance
- 三种活动标题复用同一 DOM 触发器；无正文项不显示按钮。
- 覆盖按钮可由可见标题命名，保留键盘语义和调用方状态所有权。
- Web typecheck、聚焦测试、构建通过；临时预览与源码身份分别说明。

## affected_paths
- `opencraft/apps/workbench-web/src/components/`、`opencraft/apps/workbench-web/src/styles/app.scss`、`opencraft/tests/`。
- `opencraft/design/invariants.md`、`opencraft/docs/chat-ui-architecture.md`。

## required_context
- OpenCraft 局部 Agent 规则、维护 Skill 与验证清单；本轮根 Context Router 未命中 pack。

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md`、`opencraft/AGENTS.md` | 根与服务边界 | 限定本轮为 Web 控件固化，不越界发布 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`、`references/verification.md` | UI 维护方法 | 区分代码、构建、运行与手机实测 |
| `opencraft/docs/chat-ui-architecture.md`、`opencraft/design/invariants.md` | 正式设计 | 固化折叠触发器所有权 |

## evidence
- Web typecheck、7 项聚焦测试、Web 构建、边界与文档检查通过。临时预览 build `20260928001327-57cf4ad54d71` 后续 9 次触摸中 3 次未收到 click；抽取共享控件的 build `20260928002608-7ab50a085c59` 也复现，已回退到前者。结构统一已实现，触控可靠性尚未修复。
- 后续有界诊断仅增加 `buttonHovered/frameHovered/actionsVisible/buttonFocused/selectionActive` 布尔字段，不记录选区正文。Web typecheck、7 项聚焦测试及 headless 打包通过；临时预览 `20260928010244-11a7bf7d805b` 已健康运行，尚未收到该版手机触摸记录。
- 该版手机记录的 `whnofgt0-1/-3/-5` 三次失败均为 `pointerdown(actionsVisible=false) → pointerup(actionsVisible=true, hit=button, sameButton=true, no scroll/no preventDefault) → settled(clicked=false)`；`-2` 成功时按下前操作栏已可见并收到 click。按钮与父消息的 hover 在两类触摸里均为 true，焦点与非折叠选区均为 false。显隐过渡与失败高度相关，但尚不能凭相关性证明浏览器为何吞 click。
- 下一轮仅针对包含 Worked-for 标题的助手消息，在触控能力下让操作栏从首帧常显且无 opacity 过渡；Web typecheck、headless 打包通过。实验预览 `20260928011354-1792b2fbb2ef` 已健康运行，手机点击结果待验。
- 实验预览 `20260928011354-1792b2fbb2ef` 的手机记录：8 次触摸中 7 次静止轻触均从 `pointerdown(actionsVisible=true)` 到 `click/commit/settled(clicked=true)`；另 1 次 `pointercancel(travel=large, hit=outside)` 不属于静止轻触漏 click。用户主观反馈“似乎都正常了”。这支持但尚未严格证明操作栏显隐是浏览器 click 抑制原因；不把 7/7 推广为全场景修复。
- 用户刷新/滚动后的补充实测又有 3 次静止轻触全部收到 click；合计 10/10。用户确认“可以了”。保留触控预显规则，移除临时事件上报和诊断专用 Pointer props；没有改为 pointerup/touchend 补发点击。
- 最终源码 Web typecheck、8 项聚焦测试、headless 打包、设计影响与文档校验通过；归档静态资源未包含 `activity-disclosure-trace`。最终临时预览 `20260928013743-ecbc08706fbb` 已运行且健康；用户实机验证的是前一个同规则、带诊断的实验版，不把无诊断最终包自动记为再次实机验收。

## risks
- 抽取控件可能改变 CSS 优先级或键盘聚焦外观；用构建、DOM 测试及真实预览复核。仅凭少量成功触摸易产生假阳性，必须做同版成功/失败对照。

## validation
- Web typecheck、活动折叠聚焦测试、Web 构建、变更影响与文档校验。

## decisions
- 只抽取点击/呈现结构；不抽象各调用方不同的状态机。

## scan_scope
- 三个活动消费者、活动 CSS 与其现有聚焦测试。

## scan_output
- 无批量扫描产物。

## handoff
- 源码已固化规则并删除诊断；最终无诊断临时预览已核对运行。手机已验证同规则的实验版，最终包尚未再次实机点按；不包括 commit、push 或生产发布。
