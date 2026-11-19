# Grokbot 对照：CLI、API 和记忆的边界

2026-11-10。用户要求先看Grokbot，重点思考CLI/API边界。本轮是已读源码后的设计裁决，不是新实现或新评测成绩；独立实验目录，不部署Join。Hindsight本轮已中断，已完成结果保留，缺失不能算错题。

参考本机会话目录`grokbot-reference-a9f633e`，提交`a9f633e09d49a85829b8236331b9e21f7e612634`。它是非官方恢复/扩展代码，不能等同官方线上服务。我们的代码基线`9c0c80d`。不要把当前文档中建议的接口写成已有产品能力。

## 三条边界分别裁决

| 边界                      | 已核实的代码                                                                                                                                                                                           | 裁决                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 人/Agent访问记忆          | Grokbot的`sand-memory.ts:renderMemorySystemPrompt`注入profile/recent，提示通过Read/Shell grep追读文件，通过update_state写入/遗忘。我们的CLI经socket调AssistantApplication，接待/执行另有受约束查询port | CLI、模型工具和未来远程API都调用相同业务owner。CLI只解析参数、格式化回执，不能各自再写Markdown/SQL。API不必等于HTTP，本机继续复用socket/进程内port |
| 记忆整理调用模型          | Grokbot的`MemorySynthesisService`接受createExecutor或propose/verify，production装配inference.port.createSession().getExecutor()；整理服务本身不调用外部CLI                                             | 整理规则与推理传输分开。原生提炼/复核提示词、解析、重试与存储属于被测系统；Codex CLI或模型API只是明确配置的推理适配器                              |
| Agent运行环境提供文件工具 | 参考提示词明确依赖Read/Shell，不能从记忆模块推断完整CLI工具实现；我们memory.search/file.read/files.list有固定范围、匹配语义和字节限制                                                                  | 不能把自由grep默默映射成SQL连续子串，再声称同一能力。首轮用同一套受约束文件工具测不同记忆文件，原生工具体验另测                                    |

这三条边界是两个不同方向：`CLI/模型工具 → 记忆用例`，以及`记忆整理 → 推理适配器 → 模型`。不能把“用了Codex二进制”“直接调模型API”“按Grokbot整理记忆”合成一个选项。

## 现在确实存在的接缝

1. `bin/assistant.mjs`将memory-search/file/set/forget映射成请求，`src/adapters/local/unix-socket.mjs`在JSON响应里直接使用`this.handler(...)`，没有await。如果以后handler变成异步函数，Promise可能被序列化成空对象；当前同步dispatch路径不能作为异步整理API已经可用的证据。客户端默认5秒超时也不适合等待模型整理。
2. `src/adapters/codex/structured-harness.mjs`将临时进程、thread/turn生命周期与业务kind对应的outputSchema/decode、额外developer指令绑在一起。它适合现有产品的结构化协议，但不能直接作为“中性的Grokbot原交换”使用。参考输入/输出不能被改写成我们的学习协议来迁就这个适配器。
3. `modelRequest`给transport传maxTokens，但当前CodexStructuredHarness没有将它映射成可验证的原生输出上限。已有文档也明确了此限制。同模型ID不代表CLI和API的思考、token限制、工具、系统指令与重试相同。不能把这类差异归因于记忆算法。
4. 当前memory组件评测调用内部应用/查询接口；没有通过真实CLI全链路。它证明组件表现，不证明CLI/API契约、长任务回执或真实文件工具已验证。

## 最小实现：复用owner，只补边界

```text
CLI / Agent工具 / 本地调用 / 将来远程API
                    ↓
       可信身份与范围 + 请求解析
                    ↓
   MemoryService / MemoryLearningService
          ↓                 ↓
  文件事实 + 辅助索引     推理窄接口
                             ↓
                      Codex 或模型API
```

产品的事实写入、CAS、更正/遗忘、墓碑、范围检查仍归原MemoryService；学习批次、复核、重试和恢复仍归MemoryLearningService。参考对照则由原Grokbot服务/存储拥有相应状态，不导入我们的MemoryLearningService替它实现逻辑。

先复用现有search/files.list/file.read、显式set/forget命令，不增加通用memory manager、额外数据库或新的HTTP服务。新增需求只需处理“提交学习”和“读取准备状态”：生产入口返回持久作业回执；评测适配器等待已有学习协调器处理到指定证据位置。`accepted`、`prepared`、`committed`、`failed`分别记实，不能用“队列已收下”证明事实已可读。具体命名及对外API属于后续实现，本文不声称已有flushThrough端点。

提交与查询需要稳定requestId/jobId或证据游标，超时后查原回执，不能凭超时重复提交并重跑模型。评测读取绑定检查点对应的已提交状态，不能到最终数据库检索早期题目，避免未来泄漏。失败/未就绪与空记忆必须区分。

CLI的机器输出使用固定JSON；日志走stderr；区分无命中、权限错误、预算错误、作业未就绪与运行失败。不能解析彩色stdout或自然语言状态。若提供grep形式，只执行明确的受约束匹配/文件读取子集，保留路径、位置、截断与分页语义；不开放任意Shell，也不宣称与完整Shell等价。

identity、当前human/agent/project及grant由可信宿主绑定；模型和CLI的scope参数只是请求目标，不是授权。桌面本地端口与将来多人服务使用同一业务契约，但认证边界分别验证。不能拿本地socket的0600权限宣称已经支持远程多人隔离。

推理适配器只接收明确消息/输出契约、取消与可执行预算，返回内容、用量、结束原因和错误；是否支持schema、工具、思考设置、输出上限要显式记录。进程启动、协议启动和模型生成耗时分开观察。首轮保留用户已选择的Codex路径，不同时切CLI/API和记忆方案；不为这轮对照先做进程池或新调度器。

## Grokbot接下来怎么bench

第一轮比较记忆整理本身：直接运行固定参考版本的MemorySynthesisService及原文件存储，注入窄推理executor；保留其提炼/复核提示词、解析、证据与存储规则。若参考装配缺失，只补显式适配并记录，不能暗中调用我们的实现冒充原版。

两路固定同一因果前缀、模型、思考设置、推理适配器配置、读工具和字节/token预算。对不同方案产出的Markdown使用同一文件发现、文字搜索和追读能力；我们的BM25自动召回作为另一组，不能混入整理差异。禁止原文历史兜底，完整历史对照单列。工具若不是原参考Shell，只称“统一受约束工具下的记忆对照”。

记忆条目粒度不同，初始上下文优先以字节/token预算约束，不凭同样12条宣称同量信息。完整事实、更新、更正与拒答分别审计；准备时间、读取时间、用量、失败/未完成分别报告。严格得分与已知gold冲突分列。

第二轮再比较原生助理体验：参考的profile/recent+Read/grep，与我们的自动召回+受约束查询分别保留；这时比较的是整条链路，不能声称单独证明记忆算法优劣。CLI/API推理传输若要比较，则另用固定输入做消融，不同一轮同时改所有变量。

最小验收包括CLI/API对同一请求返回一致业务结果、异步回执不伪装完成、失败与空命中区分、重复提交去重、旧游标/撤权拒绝、取消后无迟到提交，以及检查点无未来事实。通过这些机制检查后才启动新的付费对照，不沿用中断的Hindsight成绩作完整排名。

## 源码入口

- [CLI](../bin/assistant.mjs)、[socket](../src/adapters/local/unix-socket.mjs)、[业务分派](../src/application/assistant-application.mjs)
- [结构化Codex适配](../src/adapters/codex/structured-harness.mjs)、[模型交换](../src/adapters/models/model-request.mjs)、[既有多Harness边界](multi-harness.md)
- [文件权威与所有权](memory-files-and-shards.md)、[当前模型契约](memory-model-contract.md)、[历史Grokbot差异审计](../evaluation/GROKBOT-COVERAGE-COMPARISON-20261109.md)

只读研究与文档落地，不包含本轮功能修复、Grokbot模型调用或官方产品行为验证。
