# 主会话长期工作上下文

0.14.0 / schema16，2026-11-04。用户要求「主会话的长期工作上下文 搞定实现吧」，提出人未确认。仅独立runner，不修改或部署Join。

## 要解决的行为

主助理此前每次接待只看以原输入为锚的最近20条、每条1000字符，再按需查原文。现在额外带入可恢复的工作摘要，保存当前讨论的目标、约束、已有决定和未完成事项。长对话不用每回合重读全量历史；原文仍保留，摘要提供真实消息ID供查证。

工作摘要、长期事实记忆和Pi执行压缩分别管理：

| 信息                                      | owner                                       | 权威范围                      |
| ----------------------------------------- | ------------------------------------------- | ----------------------------- |
| 原文消息/工作关联                         | ConversationHistory                         | 实际主会话记录                |
| goals/constraints/decisions/openItems摘要 | ConversationContextService                  | 有损派生背景；语义未验证      |
| 当前工作/完成/等待/交付状态               | 原Work/Completion/Interaction/Outcome owner | 当前业务事实                  |
| agent/user/project事实                    | MemoryService + Markdown文件                | 显式/学习事实及来源、遗忘边界 |
| 执行内token压缩/checkpoint                | Pi durable                                  | 原生执行上下文                |

摘要不会创建或完成工作、回答等待、授予工具或资料权限，也不会自动写入个人事实记忆。最近用户原话和实时业务状态优先。个人记忆forget不会删除原文或本模块历史摘要；这不是语义删除/秘密清理功能。

## 对Grokbot的吸收

参考本机非官方0.18恢复源码，固定提交`a9f633e09d49a85829b8236331b9e21f7e612634`：

- `source/packages/agent/self-summary/self-summary-handler.ts`：摘要流水线、近期尾部保留、有限重试与观察。
- `source/packages/agent/self-summary/anthropic-compaction-handler.ts`：摘要与durable blocks组装、保留尾部和错误处理。
- `source/host/runner/system-prompt-assembly.ts`：compactionEpoch与上下文快照。

采用“旧摘要+新原文前缀→下一版摘要，近期原文保留”的机制。没有照搬provider-specific压缩，也没有在Pi外重建Pi执行checkpoint。本实现是会话层独立用例；恢复源码存在对应机制不等于已验证官方线上所有行为。

## 实际入口与依赖

```text
ReceptionCoordinator（原有串行回合）
  → ConversationContextCoordinator.prepare（一次有界模型交换）
      → ContextService.capture/begin（短事务保存输入/尝试）
      → ConversationContextModel.summarize（事务外）
      → ContextService.commit（父版本/来源/CAS校验）
  → ReceptionContextBuilder（只读workingContext + recent messages + 实时seed）
  → 原ReceptionPlanner/ReceptionService（原命令提交链路）
      → 新委托request.workingContext → 原Execution快照 → 实际Pi输入
```

[模块指南](../src/application/conversation-context/AGENTS.md)说明自己的状态与禁止越界；[总地图](module-map.md)列实际目录。ContextBuilder只接view，模型只得序列化数据，SQL adapter只负责本模块存取。无新manager、消息总线或常驻后台摘要队列。

## 有界处理与原文覆盖

- 以当前真实用户消息，或系统执行报告入队时保存的historyAnchor为边界；尾部保留20条。不会取最新消息替换旧输入，也不会使用覆盖到该边界之后的摘要。
- 旧历史积累至少8条，或填满16000字符批次时开始；每回合最多处理一批，至多16段，单段4000字符，总16000 UTF-16字符。JSON带旧摘要后仍有界，不声称按精确token触发。
- 长消息通过`seq + offset`逐段处理。完整消费后游标移到下一seq；没有用裁剪后的短文本冒充全条覆盖。offset按JavaScript UTF-16字符，支持Unicode/emoji跨段重建。单个原消息上限沿已有canonical消息1,000,000字符。
- 累积不足阈值、长积压、模型失败时，`workingContext.gap`给出未覆盖消息数和最多3条600字符原文片段。它明确不完整；一次接待不会为追完所有历史发无限次模型请求。没有额外空闲后台压缩。
- 新的`history.read {messageId,offset?,limit?}`按真实消息ID读原文，每次最多2000字符；只读当前会话、到原输入锚点为止。原`history.search`在接待时也限制到原锚点。近期消息附稳定id/seq，方便引用。

## 摘要协议与可信范围

模型返回goals/constraints/decisions/openItems四组，每组最多8项，每项text最多400字符，1..4个sourceIds；成功摘要整体最多24000 UTF-8字节。引用只能来自上版已保留来源或本批真实消息；source role由宿主提供。模型不能返回覆盖游标或修改权限。

提示词要求保留活跃目标和取舍、吸收用户更正并退役被覆盖内容；助手计划/声称完成不能当用户同意或完成凭证。host验证引用与结构，无法证明摘要语义正确。所有摘要保留`semanticReview=unverified`；fixture仅抽取用户原文探测链路，不模拟正确的长期取舍。

接待提示词实际消费该协议：当前用户更正优先，实时业务状态优先，有gap时不能宣称完整召回，可按引用分页查原文。原命令权限/CAS/完成条件继续在原owner校验。

## 持久化、失败与恢复

schema16新增`conversation_context`，保存父版本、start/end游标、state、source_json、summary_json、attempts/next_at/error及时间。原文和旧执行快照不改写，不补造历史摘要。

capture将有界生成输入保存为pending；begin在调用前保存尝试。成功后校验当前父版本、原文分段和引用，再同事务发布ready与覆盖游标。ready不覆盖；重复提交只返回duplicate。并发迟到候选不替换新父版本。

模型调用在事务外，最长`min(30000ms, runPolicy.modelTimeoutMs)`；之后才进行原接待规划。发生错误/超时不前移游标，以已有摘要和显式gap继续接待。每个候选最多3次，退避为`1000 * 2^attempts`毫秒；后续回合触发重试，不在pump无限重试。耗尽后failed，当前有效父版本的失败可显式重置。关闭取消后禁止迟到结果提交；纯生成被进程中断可重做，不重放业务工具。

摘要已提交而接待尚未提交时崩溃，重开使用既有摘要；摘要提交前崩溃，从pending原输入继续。真实子进程在两个窗口退出86已验证。SQLite事务失败不发布半个成功checkpoint。

```bash
node bin/assistant.mjs context --profile ./profiles/local
node bin/assistant.mjs context-retry --profile ./profiles/local
```

CLI仍输出`{inputId,result}`。查看不刷新关注或创建工作，重试仅重置摘要作业，下一接待回合处理。模型真实调用以`context-summary`独立观察用量，统计失败不重跑成功生成。

## 验证与剩余边界

专项见`test/conversation-context.test.mjs`；[迭代记录](iterations/0019-working-context.md)保留实际检查和失败。覆盖来源/字节界限、原文完整性、旧锚点、真实socket/CLI/Pi、重开和进程退出。未使用真实模型凭据；保真度、长期信息取舍和语义冲突质量仍未验收。

当前摘要窗口不支持embedding/语义检索，原文检索仍为文字匹配。没有全历史一次性回填、强制保留所有决定的无损承诺、摘要版本清理或跨机事务。用户当前更正保留在近期原文，摘要吸收更正的正确性依赖模型。

这是独立lab既有同步SQLite适配器上的实现。Join网络主线程禁阻塞规则不因本轮实现而改变；内置平台接入必须用Worker/独立进程异步存储端口，并做平台权威映射。本轮未修改Join源码、部署、Core/router或远端凭据。
