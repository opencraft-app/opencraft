# Grokbot 输出协议与错误恢复对照

核对时间：2026-11-07。来源为非官方恢复/扩展仓库 [b-nnett/grok-bot-0.18-reconstructed](https://github.com/b-nnett/grok-bot-0.18-reconstructed)，固定提交 `a9f633e09d49a85829b8236331b9e21f7e612634`，与交接包引用一致。旧研究目录在当前机器不存在，本轮重新下载固定源码，仅阅读，未安装依赖、运行其程序或修改助理。该源码不能代表当前官方产品全部行为。

## 主聊天：工具协议、参数校验、错误反馈

1. `source/host/runner/tools/send-message-tool.ts` 定义 SendMessage 为用户可见消息出口。可见文字位于工具参数的 content；普通 assistant 文本被定义为非用户可见。`createZodAgentTool` 由 Zod 参数生成 JSON Schema；`withSafeParsedArgs` 是实际 execute 包装，不只是提示词里的约定。
2. `source/host/host-runner-composition.ts:2028` 创建生产 SendMessage 输入；`source/host/runner/tools/turn-toolset.ts:1380` 附近向主助理加入该工具。`SendMessage` 的执行读取验证后的参数，再通过 onSendMessage / send-message 更新向渠道交付。
3. `source/packages/agent/tools/common.ts:186` 先 JSON.parse，再 schema.safeParse。语法或结构错误产生 ToolCallArgParseError，带可供模型理解的字段错误或重新调用提示；执行回调只在校验通过后进入。工具 Schema 不代表服务端一定采用约束解码，参数仍可能不合法。
4. `source/packages/agent/tools/core.ts:134` 的 executeToolResultOrError 将错误分类、序列化为工具失败；ToolCallArgParseError 对应 INVALID_ARGS。SendMessage 自己的 serializeError/render 将失败渲染成模型可见结果。
5. `source/packages/agent/tool-stream-executor.ts:731` 返回 role=tool 的结果，1436 附近将其并回响应；`source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts:3395` 将响应追加回提示历史。这使模型能在后续步骤看到错误并重新调用，不等于每次错误都必然恢复成功，也不是固定三次的主聊天 JSON 修复器。
6. 参数解析有独立成功率计数；流参数解析另记录 invalid_args、toolCallId、错误信息和字节长度。它将“模型已返回”和“参数能执行”分开观测。

参考：[SendMessage](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/runner/tools/send-message-tool.ts)、[Schema 与解析包装](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/tools/common.ts#L186)、[错误分类](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/tools/core.ts#L134)、[工具结果回写](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/tool-stream-executor.ts#L731)。

## 后台记忆：文本 JSON 加有限重试

`source/host/extensions/memory/memory-synthesis-service.ts` 的实际主链路仍然收集 text-delta，按提示生成 JSON。parseJsonObject 仅截取第一个左花括号到最后一个右花括号，解析失败返回 null；它可容忍对象前后的杂文，但没有修复对象内部未转义控制字符、引号或补造缺失字段的能力。对不含 JSON 对象的普通文字也无效。本轮未保留完整模型响应，不能逐题重放验证提取效果，因此不能把这个提取器视为五题的已验证修复。

后续 parseMemorySynthesisChanges 校验动作、数量、字段与证据引用，不合法就抛带 invalid-output 分类的 MemorySynthesisAttemptError；另一次模型调用必须返回 approved===true 才接受变更。提议和复核位于 perform 内，retry.runWithRetry 包住 perform，applySynthesis 在重试成功之后才执行。

`source/host/extensions/memory/production.ts` 实际装配了 retry/deadline：最多三次尝试，初始退避 2 秒、指数增长、退避上限 30 秒，每次尝试的 deadline 为 90 秒。最终仍失败时，返回 invalid-output/rejected/failed 等结果并发遥测，不将其视为已经写入记忆。相关调度实现是 `source/internal/scheduling.ts:125`。这些配置属于后台记忆，不可套称为所有主聊天工具调用的重试策略。

参考：[提炼及验证](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/extensions/memory/memory-synthesis-service.ts#L92)、[生产装配](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/extensions/memory/production.ts)、[有限重试](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/internal/scheduling.ts#L125)。

## 当前助理的具体差距

当前后台 MemoryLearningCoordinator 已将模型/解析失败交回持久学习 owner，保留有限重试；主要缺口在 ReceptionModel：自然语言要求输出一个 JSON 提议，直接解析；失败后 ReceptionPlanner 包装异常向外抛出，既不形成模型可见的协议错误观察，也不进行有界重新生成。调用用量的 returned 只表示交换已返回，无法反映后续解析成功。此接待适配器与冻结交接包相同。

| 路径       | Grokbot 固定恢复源码                              | 当前助理                                     |
| ---------- | ------------------------------------------------- | -------------------------------------------- |
| 主聊天输出 | Schema 描述的工具调用，SendMessage 为可见消息出口 | 文本 JSON 提议，随后应用结算                 |
| 参数错误   | 类型化 invalid_args，失败工具结果回到模型上下文   | JSON.parse 异常结束本次计划                  |
| 后台学习   | 提议与独立复核、有限尝试后报告结果                | 已有原生持久学习任务及有限重试               |
| 协议观测   | 参数成功率、错误分类、工具身份等                  | 已有交换与用量记录，缺解析阶段结果与结束原因 |

## 可吸收的最小改造

保留现有业务 owner、授权、revision、查询和 SendMessage/outbox 契约。模型交换层按端点实测能力暴露原生工具或结构化输出；接待协议适配器拥有解析与结构校验；Planner 拥有有界反馈/重新生成。只在有效提议产生之前重试模型，不把整个业务执行过程重新播放。状态冲突、权限拒绝、网络失败与格式失败分型处理。

后台提炼/复核仍适合小型结构化 JSON 任务，不必为了统一形式全部改成工具。对当前五题的修复效果必须另测，不能把 Grokbot 的架构或一次重新生成当成必然答对的证明。下一轮应保留原 70 题成绩，再单独跑协议回归与未见过样本。
