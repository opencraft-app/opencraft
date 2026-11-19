# 独立助理的记忆评测

最新[虚拟管家三轮复测](BUTLER-REPEAT-RESULTS-20261110.md)：14/18 场景通过，4 次主助理结构化协议失败；成功场景中仍有内部超时、验收拒绝和重试。此前单轮 6/6 不能代表稳定性。

新增[虚拟管家系统验收集](BUTLER-SUITE.md)：六个合成情境覆盖并行等待、澄清取消、Goal 依赖/恢复、显式记忆与幂等；首轮真实模型 6/6 场景、33 项自动检查通过，语义复核单列。见[结果与限制](BUTLER-RESULTS-20261110.md)。

BM25辅助索引首轮配对：同一提炼记忆下8/17 → 9/17，无失败；但唯一加分题同时遗漏用户退出合作的反向偏好，尚未确认语义收益。仅保留独立实验分支。见[结果与反证](BM25-RESULTS-20261109.md)。

当前候选已全新重跑旧oracle70：完整助理67/70、直读61/70；助理总分持平，旧超时与追读两题改善、两道偏好题回退，全部返回。它允许摘要和原文查询，不能当作纯记忆组件分数。见[本轮结果](ORACLE70-RERUN-RESULTS-20261109.md)。

最新读取侧配对复测：同一次学习、相同模型与17题，旧7/17 → 新9/17，新增2题、无旧对新错；新路无失败，双方都完成的16题token减少17.6%。仅3人物已知回归，腾讯两路未重跑。见[独立提交与证据](RETRIEVAL-PAIRED-RESULTS-20261109.md)。

腾讯两套引擎三方17题pilot已完成，腾讯云适配修正后另行补跑。本方案 7/17、Hy 6/17、腾讯云 8/17；完整历史 10/17，无历史 6/17。仅3个人物/1次重复，不作通用优劣结论。见[本轮结果与限制](TENCENT-COMPARISON-RETEST-20261109.md)；[旧额度中断](TENCENT-COMPARISON-RESULTS-20261109.md)保留。

此前：[记忆契约修正与复测](MEMORY-CONTRACT-RESULTS-20261109.md)，写入覆盖/开销改善，公开问答未改善；已有文件发现、追读与显式关键词模式见[模型与查询契约](../docs/memory-model-contract.md)。

本轮重点改为[记忆方案的组件对照](MEMORY-SCHEME.md)：固定模型和 Codex Harness，分别给我们的提炼/复核/文件记忆、完整历史和无历史路径评分；不将旧助理端到端成绩改称记忆成绩。

后台模型可独立配置为混元 4 非思考模式；主聊和共同 reader 保持原配置，具体配置、原生请求验证和评测参数见[后台模型](../docs/background-models.md)。[混元后台实测结果](HY4-BACKGROUND-RESULTS-20261109.md)单独归档，不覆盖旧运行。

新增：[助理评测矩阵](MATRIX.md)及[机器可读目录](matrix.json)，区分公开基准、产品机制与性能稳定性，列出当前接入程度和下一批顺序。矩阵本身不启动模型，未接入项不产生分数。

2026-11-09 [P0 实测记录](P0-RESULTS-20261109.md)：范围隔离与原生执行器单独烟测通过；主助理显式动作失败；S 两道原生题在准备阶段超时，按预定 gate 保留其余 12 道待跑，直读对照为 10/14。没有原生 S 整体准确率。

2026-11-09：配对驱动增加显式 `--variant oracle|s|m`、可重复的 `--exclude-plan PREVIOUS_PLAN_JSON` 和只规划不调用模型的 `--plan`。S/M 保留全部会话；上游重复 session ID 按原位置保留并在计划记录，不去重历史。当前 S 运行结果以独立记录为准，不能继承旧 oracle 成绩。

以下为 S 接线命令模板，凭据与数据路径需显式提供。先用 `--plan` 检查，再在不存在的输出目录运行；`--native-failure-limit 2` 是预先声明的连续产品失败停止条件，已发起题会结算，未启动题留为 pending，直读对照继续。使用 resume 不会绕过已触发的 gate。

```bash
node evaluation/benchmark.mjs \
  --dataset /path/longmemeval_s_cleaned.json --variant s \
  --exclude-plan evaluation/runs/codex-oracle70-20261108-final/plan.json \
  --output evaluation/runs/NEW-S-RUN \
  --model-config /private/model.json \
  --assistant-harness codex --execution-harness codex \
  --codex-config /private/codex.json \
  --official-scorer /path/official-evaluate_qa.py \
  --per-stratum 2 --seed opencraft-heldout-s-20261109-v1 \
  --concurrency 1 --timeout-ms 900000 --native-failure-limit 2 --plan
```

父进程读取完整 S 数据可能需要增大 Node heap（本机使用 `node --max-old-space-size=2048`）；不要删历史来适配默认 heap。`benchmark-report.mjs RUN_DIR` 按 plan.variant 输出对应版本；`telemetry-report.mjs RUN_DIR` 聚合该 run 的 profile 内 OTLP JSONL（包含轮转文件）。阶段耗时含父子重叠，不相加当成墙钟；文件缺失与未完成 span 明示，不补成零。

产品小场景为独立验收，不产生公开 benchmark 分数：`lifecycle-probe.mjs --codex-config PRIVATE --output NEW_DIR` 观察显式记忆命令、遗忘与重启；`codex-execution-probe.mjs --codex-config PRIVATE --all-codex --output NEW_DIR` 验证主助理到原生执行与交付的整链。运行 profile 使用短临时路径以符合 Unix socket 长度限制，结束后保留并复制到结果目录，不删除失败现场。

历史端到端证据：Codex + DeepSeek Flash 同一 70 题已完成，助理 **67/70（95.7%）**，本轮直读对照 **60/70（85.7%）**；JSON 失败为零、一次单题超时，代价是更高的准备耗时与用量。见[完整结果与限制](CODEX-RESULTS-20261108.md)。

现可通过 `--assistant-harness codex --codex-config PRIVATE_JSON` 切换原生 Codex 推理，默认仍为 Pi。配置、评测命令、原生版本与验证边界见[多 Harness](../docs/multi-harness.md)。旧成绩不随适配改变；本次原生协议测试使用模型替身，没有付费 Codex 质量分数。

这是交接包 0.15.0/schema17 的独立工作副本。TokenHub 实际试跑见 [2026-11-07 结果](TOKENHUB-RESULTS-20261107.md)。冻结包没有修改，也没有接入或发布 OpenCraft。本目录首先接通 LongMemEval 经典版的历史回放/问答输出，并复用原有记忆机制测试。

## 两种证据

- **机制回归**：`npm run test:memory-mechanisms`。更正、遗忘墓碑、旧事实防复活、角色/授权、记忆文件和原文长上下文的恢复等行为。确定性模型与真实本地存储，不能充当真实模型分数。
- **LongMemEval 问答**：跨会话回忆、知识更新、时间推理和拒答。使用真实模型时才能评答案质量；本适配器导出官方 `question_id/hypothesis` JSONL，正确率由官方 scorer 单独计算。fixture 的 `accuracy` 永远是 null。

LongMemEval 官方说明：https://github.com/xiaowu0162/LongMemEval
官方 cleaned 数据：https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned

先用 oracle 排查接线，再用 `longmemeval_s_cleaned.json` 做完整历史评测。oracle 只含证据会话，成绩不能冒充 S/M 的长历史成绩。V2 是多模态网页/企业轨迹记忆，本版没有接入；本版也不支持 tau-bench 工具环境。

## 开始

Node >=24，依赖由 package-lock.json 固定。在本目录执行：

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run test:eval-memory
npm run eval:memory -- --dataset evaluation/smoke-data.json --output /tmp/superapp-memory-smoke-NEW --mode fixture --limit 1
```

每次使用一个不存在的新 output 目录，避免覆盖历史证据。smoke-data 是合成样本，不是官方题目，也不产生模型质量结论。

已有官方数据可先规划，不调用模型，也不创建 output：

```bash
npm run eval:memory -- --dataset /path/longmemeval_s_cleaned.json --output /tmp/lme-plan --limit 5 --plan
```

目前读入官方 JSON 数组，文件上限 512 MiB、单题上限 20 Mi 字符；更大数据显式分片。不自动下载、截短或跳过历史。数据文件 SHA256、模式和选题范围均写入结果。

## 真实模型

现有助理模型适配支持固定 Pi 目录中的 DeepSeek/Anthropic 模型，以及显式配置的 OpenAI-compatible Chat Completions 端点。使用一个本机权限为 600 的 JSON 配置，字段为 `provider`、`modelId`、`apiKey`；兼容端点使用 provider=openai-compatible，并增加 baseUrl，可选 thinking=disabled/enabled。内置 provider 的 `modelId` 必须在固定目录中；兼容端点的 modelId 必须由该端点实际支持。TokenHub 本轮已通过 /models 验证 deepseek-v4.1-flash-1017。不要把此文件放进项目、日志或归档。

```bash
chmod 600 /private/path/model.json
npm run eval:memory -- --dataset /path/longmemeval_s_cleaned.json --output /tmp/lme-real-NEW --mode model --model-config /private/path/model.json --limit 5 --timeout-ms 900000
```

每题一个独立子进程、profile、SQLite 和记忆目录，进程 HOME 指向题目目录，清除继承的模型凭据与 Node preload。只接收本次显式配置；输出不保存密钥。没有配置时不访问机器其他账户。题目执行截止后终止进程，确认退出后才处理下一题。

推荐先少量题验证模型格式、耗时和实际 token，再扩大题量。默认逐题执行，不做隐式并发，也不自动提交榜单。

## 回放协议与公平性

1. 评测父进程只向助理进程传递问题、问题时间、历史日期和逐条 role/content。`answer`、`has_answer`、`answer_session_ids`、题型和数据集问题 ID 都不进入被测进程。
2. 按日期稳定排序历史，保留所有文本和原始角色。用户/助手历史写入原 ConversationHistory；MemoryLearningService 负责提议、独立复核和落盘，ConversationContextCoordinator 负责原有有界摘要。没有从 gold 预填记忆，也没有另建一套检索器。
3. 历史是**录制内容回放**，不重新执行旧的工作/记忆命令；回放期间不启动渠道投递。每轮学习设置 debounce=0 并结算原服务的有界重试；这是评测协议差异，不改变生产默认15秒。日历维护/后台时间复查未模拟。
4. 回答走原 ReceptionPlanner、ReceptionModel 和只读查询端口，可同时使用原文、摘要与记忆。因此它衡量助理原生问答路径，不能称为纯记忆检索器成绩。若模型返回执行任务/修改状态而非 reply/clarify，本版记为失败，不伪造答案。
5. 官方 oracle 数据含部分晚于问题时间的历史会话。默认保留官方输入和全部日期、记录 `futureSessionCount`，不擅自清洗；自建因果测试可加 `--strict-time` 拒绝。日期没有明确时区的官方 `YYYY/MM/DD (day) HH:mm` 统一按 UTC 解释。
6. 学习失败状态、查询轨迹、摘要覆盖、实际用量和索引/查询时延均保留。失败题也输出空 hypothesis，留在分母；模型成功回复只记 completed，不记答案正确。
7. 自动学习只接受用户证据；历史助手发言仍在原文中。依赖助手发言的问题应由原生历史查询补足，不能把助手改成用户角色提高分数。

## 结果和评分

- `summary.json`：来源哈希、模型、模式、题型、成功/失败、时延、学习状态、摘要覆盖、查询轨迹、用量和限制。`accuracy=null/scoring=not-run` 直到独立评分。
- `hypotheses.jsonl`：官方格式，每行恰为 `question_id`、`hypothesis`。使用官方仓库固定版本的 `src/evaluation/evaluate_qa.py` 和同一份数据另行评分。scorer 有自己的模型凭据和成本，运行本适配器不会自动调用 judge。
- 每题目录：原助理真实 profile、业务库和记忆文件，供复查。全是评测合成/公开数据，不复用用户 profile。

评分应固定数据文件哈希、助理代码、被测模型和 judge 版本；分别报告题型、拒答、失败率、索引/查询耗时和 token，不只给一个平均数。本版未实现官方 judge、排行榜提交或基线模型对照。TokenHub 少量试跑采用逐题对照，不合并成官方准确率。兼容端点没有配置价格，单次模型调用的费用估算保持 null，不能把 SDK 必填的零价格占位解释为免费。

## 固定分层 benchmark 与对照

2026-11-07 已完成 70 题及完整历史直读对照：原助理 58/70（82.9%），自定义直读对照 62/70（88.6%）。结果、失分原因和限制见 [benchmark 结果](BENCHMARK-RESULTS-20261107.md)；首次额度中断及恢复入口保留在 [事件记录](BENCHMARK-20261107.md)。

`benchmark.mjs` 当前专用于 classic oracle 数据。默认固定种子，在六个官方题型及单列拒答层各选 10 题；排除此前已试跑的四题。选题只依赖 ID 的哈希，不按答案或历史长度筛选。样本不是完整 500 题，也不是 S/M 长历史版本。

先从官方仓库取得 `evaluate_qa.py` 的固定版本 `9e0b455f4ef0e2ab8f2e582289761153549043fc`。驱动核对 SHA256 后直接读取其中的五种评分提示模板；无 Python 依赖，不执行下载的脚本。官方源码与许可证应随评测证据保留。

```bash
mkdir -p evaluation/runs
node evaluation/benchmark.mjs \
  --dataset /path/longmemeval_oracle.json \
  --output evaluation/runs/NEW-RUN \
  --model-config /private/path/model.json \
  --official-scorer /path/evaluate_qa.py \
  --per-stratum 10 --concurrency 4 --timeout-ms 900000
node evaluation/benchmark-report.mjs evaluation/runs/NEW-RUN
```

两条路径使用相同模型：原助理原生学习/摘要/问答，以及自定义的完整原文直读对照。直读对照提供原始消息日期，使用单次简洁问答提示；它不是官方仓库发布的基线实现。评判在被测回答结束后单独调用，gold 不进入被测助理。当前 judge 也用同一款模型，因此存在自评偏差；不能当作官方排行榜成绩。

`plan.json` 在首次模型调用前固定 ID、数据与代码哈希、模型、协议和上游评分版本。每题每条路径独立落盘，产品回答失败按错计，服务不可用及 judge 失败记 unresolved，不从分母删除。遇到 HTTP 401/402/403 熔断后续任务；等待已经在途的题目结算。中途可运行 report 查看进度；未完成或仍有 unresolved 时 accuracy=null，并给上下界。`--resume` 只接受相同计划、源码和模型配置，跳过已落盘记录，不自动重跑失败题；未正常退出留下的 profile 需要先人工核验，不覆盖现场。

`--recover-from OLD_RUN` 在新输出目录恢复额度中断：校验选题、数据、模型、原助理源码和依赖锁完全一致，允许记录 harness 修正。复用所有已知判定，包含真实模型失败；仅重做服务不可用的题，已有答案但 judge 不可用时只补判卷。旧目录保持原样，恢复来源和新旧评测代码哈希进入新计划。

报告的置信区间仅作描述；分层样本、oracle 简化和同模型评分限制泛化。原生路径用量来自持久化 usage 汇总，失败题未返回的用量可能缺失，因此已知 token 数不是计费账单。默认并发 4 只是评测调度，不改变助理本身的并发配置。

## 更正、遗忘的解释

LongMemEval 的 knowledge-update/abstention 与产品的显式删除语义不同。现有机制测试覆盖 revision 更正、遗忘墓碑及自动学习防复活；这不证明模型理解任意自然语言遗忘，也不证明隐私擦除。当前产品保留 canonical 原文和旧摘要，查询原历史仍可能找回旧内容。需要分别验收“活跃记忆已移除”和“所有历史无法再次回答”，不能将前者成绩宣传成后者。

## 实现范围

评测逻辑在 evaluation/；原装配根增加可选的 `now` 注入，默认仍为 Date.now。模型层另增加显式 OpenAI-compatible provider，并在单次调用观察中保留未知价格；doctor 可识别它的显式凭据变量。没有改动记忆规则、生产提示词、完成条件或数据库 schema。适配测试用独立进程验证角色保留、label 隔离、跨题记忆隔离、长上下文、失败保留和显式凭据要求。
