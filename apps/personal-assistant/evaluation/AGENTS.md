# Memory evaluation adapters

2026-11-10：pibench/ 导入固定上游用户模拟器与评分，经产品 socket 测试。当前仅完成第一题 4 轮对话，任务切换因缺少保留记忆的新会话操作失败；不把 /new 改成空操作，不把未跑题排除后报总分。默认零调用 readiness，显式 dialogue-probe 才调用模型。工具、附件 trace 和跨会话隔离未对齐；见 PIBENCH.md 与 PIBENCH-RESULTS-20261110.md。

2026-11-10：work-coordination-probe.mjs 是显式 Codex 真模型协调验收，合成两项本地工作、等待/另一项完成、重启、主模型定向回答/修改和汇总；不注入规划替身或失败纠正重试，不算 benchmark 分数。关闭自动记忆学习以隔离链路；保留源版本、阶段、全部失败、profile 和用量，不代表长期目标优先级/依赖或记忆集成通过。

2026-11-09 用户明确当前评的是 Grokbot 派生记忆方案。memory-system\*.mjs / personamem-data.mjs 只负责独立组件回放、受限读取、同 reader 的 memory/full-history/no-history 对照与确定性评分，不改生产记忆策略或建立新检索器。角色、system 背景、因果前缀和已发生失败保留；具体边界见 MEMORY-SCHEME.md。

`MATRIX.md` / `matrix.json` own suite discovery, coverage, readiness and evidence links only. They are a catalog, not a runner. Keep historical quality evidence separate from the current candidate; null revisions and scores are unverified, not zero. Preserve speaker identity, modality and causal boundaries when adding a suite; never coerce two-human dialogue into user/assistant merely to reuse the replay adapter. Run pins, failures and scope-specific contracts follow MATRIX.md and the existing rules below.

2026-11-07: `--assistant-harness codex --codex-config PRIVATE_JSON` selects explicit native structured inference in replay and the paired benchmark. Existing Pi path remains the default. Harness/model/endpoint identity must stay fixed within a run; do not reuse old answers after switching. Native worker descendants share an isolated process group and must be reaped on forced timeout/worker exit. The paired baseline/judge still uses its explicit model config; require matching model/endpoint and document the different API protocols. Never assume a Chat Completions endpoint supports Responses. See ../docs/multi-harness.md.

Inherits ../AGENTS.md. This module owns benchmark input projection, isolated process lifecycle and evidence/output formatting. It owns no assistant memory, history or work state. Use existing application owners and native model/query/summary/learning adapters.

Gold answers, answer-session IDs and has_answer labels stay in the evaluator process. Never send them, question categories or dataset IDs to the assistant. Preserve transcript roles, dates and content. Separate fixture mechanism checks from real model quality scores. Do not silently filter failures or shorten history. New runs and cases get private profiles and no inherited model credentials; real calls require an explicit private configuration file. No leaderboard submission or remote messages.

codex-execution-probe.mjs 是显式真实模型持久执行烟测，合成提问/等待重启/回答/本地笔记，经原公开协议，不产出 benchmark 分数。凭据仍仅来自明确私有配置。

2026-11-09：classic S 配对评测已接入显式 variant 和旧 plan 排除；重复 session ID 保留位置与全文。预声明 native failure gate 在 resume/recovery 中继承：先复用原失败记录，再阻止未启动原生题，不能借补服务限流重跑产品失败。范围、显式记忆与执行器探针的原始 profile 用短临时路径运行并归档保留，扫描诊断副本不得包含模型凭据。P0-RESULTS-20261109.md 保留真实失败与可验证范围。

assistant-session 同样装配本地 telemetry 并包裹 evaluation.replay，准备批次与模型 span 关联，关闭时 flush；不把 gold、问题正文或标签传入观测。日志/依赖变动后不继续假冒旧源码恢复 benchmark；原成绩维持原指纹。

2026-11-09：--background-codex-config 单独选择后台提炼/复核模型，reader 继续固定。plan 固定两者模型/endpoint/二进制及 reasoningEffort；worker 清空继承环境并转发明确配置。新模型或思考设置需新 run，保留旧超时，不能宣称同时改模型/设置的耗时变化已完成纯开关因果消融。

2026-11-09 用户明确授权修正语义、输入与检索并复测。memory-only reader 使用生产共享 MEMORY_QUERY_CONTRACTS 和文件清单/追读，仍禁用原文、工作摘要与写入。相同已知历史的新 run 必须固定新源码；三项合并回归不能当成单变量因果实验。

2026-11-09 用户授权召回独立提交与再bench。retrieval-paired.mjs在每个因果检查点只提炼一次，使用已提交reference源码的原Queries/ReadModel/readerInput与候选读取路径交替答题；不在评测器重写召回，不将问题/选项写入学习。相同模型/指令/预算，记录read-view、共享准备与各支读取用量；禁止把同一题的两个答案算成两份独立数据。

2026-11-09 BM25实验：reference seed也传同一当前问题，旧reference可忽略此参数；比较前必须明确reference是否已支持问题召回，不能把旧recency策略误标为词重合对照。BM25与词重合两路仍共用同一前缀学习状态、reader和预算，保留17题已知回归限制。

2026-11-10：butler-suite / butler-session / butler-cases / butler-worker 为合成管家系统验收，均经公开 socket 命令，不写业务库。每题隔离进程/profile，真实模型仅显式 --model-profile 的 Harness 引用；固定源码指纹，失败与 not_run 保留。自动断言不冒充语义评分，fixture 不运行诚实边界题，自动学习关闭的范围须明示。详见 BUTLER-SUITE.md。

2026-11-10 v5：complex 六题独立分组，原十二题契约保持。当前产物须绑定当前有效 execution 的公开发布回执并验 hash，不从任意历史文件寻找通过文本；显式字段契约不等于语义判卷。自然语言规划与 typed 暂停/rebase/验收分别报告；禁止在失败后代模型改计划或填答案。
