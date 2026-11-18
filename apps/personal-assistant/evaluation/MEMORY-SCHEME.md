# 评测对象：从 Grokbot 借鉴的记忆方案

本轮用户明确：评测我们的记忆方案，不是给大模型打分，也不以完整助理的委托/通知能力代替记忆质量。模型与 Harness 是固定实验条件；读取记忆、对话摘要、原文兜底须分开。旧 LongMemEval 助理成绩保留，不能改称纯记忆成绩。

## 最小可解释对照

`memory-system.mjs` 使用 PersonaMem v1 的官方 32k 文本与选项题，同一模型、Codex Harness 和 reader 提示词下运行三条路径：

| 路径         | 读取内容                                                                      | 用途                               |
| ------------ | ----------------------------------------------------------------------------- | ---------------------------------- |
| memory       | 原生产 profile/recent 投影、默认 recall，以及受限 memory.search/get/file.read | 被测记忆方案                       |
| full-history | 当前问题因果边界前的完整原始角色/文本；不读记忆                               | 完整信息参照，不预设为质量上限     |
| no-history   | 当前问题与候选回答，不读聊天或记忆                                            | 判断题目本身是否可猜，衡量记忆增益 |

三者均得到该问题前已出现的原始 system/persona 背景。system 角色不改成用户，不能当作用户证据写入记忆；原有重复 system 消息也按前缀保留。三者的无记忆路径因此不是没有任何用户信息。

被测端走 `MemoryLearningService.capture/pending` → 原 `MemoryLearningModel.propose/verify` → 原 `MemoryService` → 原 Markdown 文件权威和索引。读取复用原 SELECT-only query service，不建立检索器。查询工具由宿主只允许 memory.search/get/file.read，禁止 history、material、工作命令与学习写入。查询前后核对记忆/学习任务未改变，不将题目或回答作为新学习证据。

不启动 ReceptionService 动作、ConversationContextCoordinator、持久执行或渠道。公共问答数据没有显式遗忘协议，本 track 不认证自然语言遗忘或隐私擦除。相关边界继续见 [P0 原始失败](P0-RESULTS-20261109.md)。

## 回放与因果边界

当前 CLI 为每个 shared_context 分开 controls 与 memory 两个 profile，先跑完整历史/无历史对照，再跑记忆路径。controls 缺省 300 秒、memory 缺省 900 秒，各有独立进程与截止；对照不捕获学习证据。记忆准备超时不会取消已完成的对照。

首批真实运行使用修正前的共享 group 截止，原始文件保留；触及该截止的对照调用按 censored 解释，不当成模型答错。上述独立调度已有离线验证，修正后未重新付费跑公开样本，不能将旧结果说成新调度已通过。

选中问题按 `end_index_in_shared_context` 顺序准备，严格使用官方 `context[:end]`。同一历史前缀可供多道只读问题复用；不跨问题写答案或提前导入后面的历史。CSV gold、题型、persona/数据集 ID、距离及其他标签只留在父进程；worker 只收 history role/content 和 end/question/options。

首次 pilot 用固定种子选 1 个 shared_context，再在该段实际存在的每一原始题型中按 ID 哈希选 1 题。缺失类型在 plan 明示，不换历史补足。选择不看答案、历史长度或旧结果。上游实际 CSV 的类型标签与 README 新命名不完全一致，本入口保留 CSV 原标签，不静默合并。

历史以最多 12 个用户 exchange 的快速到达批次录入，再用虚拟时间推进原缺省 15000ms 静默窗口，结算原服务的有界重试；到每个查询前缀也排空。没有将多轮拼成一条长用户消息，没有把生产 debounce 改成 0。每侧 8000 字符的原生证据裁剪、12 轮合并、512 事实快照及有限提示投影继续生效，另记被裁剪消息数与任务终态。完整原文保留，但 memory reader 没有原文读取能力。

该回放是**声明的批次工作负载**，不是任意真实用户到达节奏的仿真。PersonaMem 没有机器时间戳，因此使用固定 2026-11-09 UTC 起的单调合成时钟；正文日期不改写，后台日期复查不启动。准备墙钟不包含真实静默等待，不与旧逐轮强制学习协议混合报告。

## 评分与证据

固定 PersonaMem 数据 revision、两个数据文件哈希、官方 inference.py revision/哈希、源文件和依赖锁快照、原生二进制哈希、模型/endpoint、reader 指令哈希、种子、选择、并发及截止。`--plan` 无模型调用、不创建输出目录。真实运行仅接受显式私有 Codex 配置；子进程清除继承的凭据/原生 HOME，超时回收整个进程组，保留原 profile 和失败记录。

用官方 `Evaluation.extract_answer` 的 JavaScript 等价移植确定性评分，无另一个 LLM judge。它保留官方 final_answer 和原回答的 fallback 行为。模型收到的 query 仍是共同 reader JSON 格式，故这是自定义系统实验，不是官方推理入口或排行榜成绩。

报告分开给准确率、有效答案率、未跑分母、与无历史/完整历史的配对差值，以及学习和查询两段的调用量、已知 token 与未知覆盖。准备只收取一次，不在每题重复算；查询随前缀复用同一准备结果。OTel 仍为原本地 OTLP JSONL。不能按未知单价推算真实账单，也不能将调用跨度相加当端到端墙钟。

## 使用

数据目录需包含固定来源的 `questions_32k.csv`、`shared_contexts_32k.jsonl`、`official-inference.py` 和 `source.json`。本机下载位于 `datasets/personamem-v1-32k/`，未纳入源码。

```bash
node evaluation/memory-system.mjs \
  --dataset evaluation/datasets/personamem-v1-32k \
  --codex-config /private/codex.json \
  --output evaluation/runs/NEW-MEMORY-RUN \
  --contexts 1 --seed opencraft-memory-personamem-20261109-v1 \
  --timeout-ms 900000 --control-timeout-ms 300000 --plan
```

检查 plan 后去掉 `--plan`，写入一个全新目录。不自动重跑答错、产品失败或超时的题，不覆盖旧 evidence。

首批只有一个独立历史组，不能从数道相关问题推导普遍质量或狭窄置信区间。没有执行原 Grokbot；对齐来源仍是 [非官方恢复源码](../docs/grok-memory-parity.md)，不能称为与官方线上 Grokbot 的直接胜负比较。

本轮实测与两组证据见 [记忆方案结果](MEMORY-SCHEME-RESULTS-20261109.md)。
