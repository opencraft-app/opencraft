# Hindsight 独立记忆后端对照

用户于2026-11-10授权“作为记忆子系统bench”。只在独立评测目录运行，不接入或部署Join。

固定上游 Hindsight `58e8ccf119a60028cad7b4407c4c25a8313d7096`（1.2.0），从源码安装到独立Python3.12环境；实际依赖在run的python-environment.txt冻结。适配器调用原MemoryEngine.retain_batch_async/recall_async，不重写提炼、关联、排序或观察。PostgreSQL18.1由pg0管理，数据与人物隔离。容器UID缺少passwd记录用进程局部libnss_wrapper补齐；pg0状态探针不返回uri时由其报告端口构造本地连接，经真实迁移验证，不触碰系统用户或远端数据库。

沿用BM25实验17题/3人物的同一数据哈希及因果前缀，全部记忆、答案重新生成。每次最多12条用户交流连同原assistant回复，以带角色JSON文本送入Hindsight；学习不接收题目、选项、gold或类别。原system背景由共用readerInput保留，不能当成用户事实。

两路主reader均DeepSeek Flash1017；后台hy4、reasoningEffort=none，均经已固定的原生Codex传输。Hindsight原生提示词、结构化校验及有限重试保留；bridge只适配传输，json_schema请求传给Codex原生outputSchema。无额外事实复核提示词，不调用reflect。它自己的观察合并使用上游SyncTaskBackend同步完成，成本计入准备。我们的提炼和独立复核仍按原产品逻辑执行。

Hindsight使用之前腾讯pilot相同的本地多语言MiniLM-L12-v2，384维、128输入token，原生四路检索/RRF、MID检索预算及4096返回token，无神经重排。只将原顺序前12条事实及日期投影给reader，不暴露chunks/原文/诊断。我们的原生profile/recent加12条自动召回仍保留；两种表示的实际事实数不强行相等，共用的是reader总输入与查询字节预算。此配置不是官方最优成绩复现。

共用reader指令、每题最多6查询/7轮、单次查询12000字节/总48000字节、初始128000字节。每人物每记忆后端900秒，controls300秒，原生调用120秒。对照包括fresh full-history与no-history。按人物交替ours/Hindsight顺序；每后端独立学习，比较的是系统，非单机制消融。一次重复、已知回归集合，不声称泛化、统计显著或SOTA。

保留启动失败、模型错误、预算失败、未完成与逐题答案。音乐合作/独奏更正与gold的已知冲突不改评分，另审计。报告分开准备/读取用量和耗时、失败及实际可见记忆；token用量不是账单金额。运行前冻结代码与plan，之后核对源码、显式key泄漏和进程清理。

入口：`evaluation/comparison/hindsight-run.mjs [新输出目录]`。默认输出`evaluation/runs/hindsight-comparison-20261110-v1`，禁止覆盖旧目录。模型只读取用户原先明确提供的`.private/tokenhub-codex.json`、`.private/tokenhub-hy4-nothink-codex.json`。源码及权威状态不因比较改动。

准备记录在`evidence/hindsight-20261110/setup-v1`（UID失败）、`setup-v2`（pg0探针失败）、`setup-v3`（真实提炼/观察/检索通过）；失败不计质量分数，也不删除。协议检查覆盖因果输入、原生结果前12条顺序、日期保留和禁止泄露原文chunks。
