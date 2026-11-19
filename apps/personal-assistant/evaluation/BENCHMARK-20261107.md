# 70 题 benchmark：额度耗尽，尚无总分

**后续状态：用户开启后付费后，已按原计划恢复并完成。最终结果见 [70 题完整结果](BENCHMARK-RESULTS-20261107.md)。下文保留首次额度中断时的现场记录。**

已实际启动 `deepseek-v4.1-flash-1017` 的 LongMemEval oracle 分层评测。运行中 TokenHub 返回 **HTTP 402 / 401008**，原文为“服务免费体验额度已耗尽，且未开启后付费，无法正常访问”。因此本轮未完成质量评分，`accuracy=null`；不能将服务拦截算成模型答错，也不能仅用成功回答报告准确率。

## 当前证据

| 原助理路径的 70 道题             | 数量 |
| -------------------------------- | ---: |
| 得到回答并完成判卷，judge 判正确 |    8 |
| 得到回答，judge 调用被额度阻断   |    1 |
| JSON 格式错误，未能形成问答结果  |    3 |
| 模型服务额度不足，无法完成回答   |   58 |

“模型直读完整历史”对照的 70 题均被额度阻断，尚无回答。上述数字不包含上一轮四道短题，也不与之拼接成分数。judge 与被测模型相同，已判正确的八题也只是同模型自动评分结果。

九份成功问答记录中，查询耗时中位数约 **2.60 秒**，历史索引耗时中位数约 **34.18 秒**；均不是完整样本统计。这九份记录汇总了 200 个原生模型调用观察、483,656 个 token，另有已完成 judge 的 1,787 个 token。失败过程的用量可能未返回，不能当作总计费量；价格未知。

三道格式失败分别为：`6b7dfb22`（偏好）、`09ba9854_abs`（拒答）、`gpt4_74aed68e`（时间）。错误为 JSON 引号/分隔符或未转义控制字符。它们作为真实产品输出失败保留，恢复评测时不能重跑后替换成成功结果。

## 已固定的评测设计

- 数据来自 [LongMemEval cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)，使用 oracle，仅含证据会话，不能代表 S/M 完整长历史成绩。
- 六个官方题型与单列拒答各 10 题，共 70 题、1,341 条历史消息。ID 哈希排序取样，种子 `opencraft-memory-20261107-v1`；不按历史长度选题，排除已看过的四道 pilot 题。
- 数据 SHA256：`821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c`。初次运行代码 SHA256：`217485d3260e297dd575ecae1628ced031f0e2d1bdb273f7929d67693212213f`。
- 评分模板读取自 [官方 evaluate_qa.py 固定版本](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/evaluation/evaluate_qa.py)，源码 SHA256 为 `ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251`。直接提取五种提示模板，未运行下载的 Python 脚本；判卷使用同一 DeepSeek，temperature=0、max_tokens=10，不是官方排行榜评分配置。
- 原助理路径复用其原生回放、学习提议/复核、摘要、查询与接待。每题独立进程和 profile，并发 4。标准答案、题型及证据标签留在 evaluator，不传给助理。
- 直读对照是自定义单次完整历史问答，不是官方发布基线。它带原始日期，temperature=0、max_tokens=4096；原助理保留默认提示和接待 1500 token 上限。两者不是仅替换记忆模块的严格消融实验。
- 本轮没有修复此前发现的日期投影缺口，没有在观察答案后修改助理逻辑，也没有部署产品。

## 额度事件与恢复

首版批量驱动缺少全局额度熔断，导致后续题目也生成了额度失败记录；原始记录全部保留。运行已退出，没有后台继续请求。事后仅修正评测设施：认证/额度错误熔断，不再启动后续题目；服务不可用留为 unresolved；支持在新目录恢复，同时验证助理源码、模型、选题和评分版本一致。原助理产品源码与依赖锁未改变。

恢复规则：8 份已评分答案与 3 份 JSON 失败原样复用；1 份已有答案仅补判卷；58 份额度失败重新在新 profile 回放；直读对照再执行。通过 `--recover-from` 记录旧计划哈希和新 harness 哈希，避免覆盖旧现场。恢复后的结果仍须注明发生过服务中断及评测设施修正。

需用户先在 [TokenHub 在线推理控制台](https://console.cloud.tencent.com/tokenhub/inference) 恢复此服务额度，例如补充可用额度或自行开启后付费。本轮没有修改计费设置。额度恢复后，在工作副本根目录执行：

```bash
node evaluation/benchmark.mjs \
  --dataset evaluation/runs/tokenhub-oracle70-20261107-v1/source-dataset.json \
  --output evaluation/runs/tokenhub-oracle70-20261107-recovered \
  --recover-from evaluation/runs/tokenhub-oracle70-20261107-v1 \
  --model-config ../.private/tokenhub-eval.json \
  --official-scorer evaluation/runs/tokenhub-oracle70-20261107-v1/official-evaluate_qa.py \
  --per-stratum 10 --concurrency 4 --timeout-ms 900000
node evaluation/benchmark-report.mjs evaluation/runs/tokenhub-oracle70-20261107-recovered
```

评测设施与既有适配器的聚焦测试 **16/16 通过**，包含分层选择、gold 隔离、失败分母、额度分类、熔断、恢复边界和原生 provider 传输。测试没有代替真实模型分数。

## 可复查产物

[固定计划](runs/tokenhub-oracle70-20261107-v1/plan.json)、[校正后的机器报告](runs/tokenhub-oracle70-20261107-v1/score.json)、[额度事件](runs/tokenhub-oracle70-20261107-v1/availability-incident.json)、[逐题原始记录](runs/tokenhub-oracle70-20261107-v1/records.json)、[已选参考数据](runs/tokenhub-oracle70-20261107-v1/selected-references.json)、[完整输入](runs/tokenhub-oracle70-20261107-v1/source-dataset.json)、[测试日志](runs/tokenhub-oracle70-20261107-v1/benchmark-tests.log)。运行目录另保存了初版源码快照、官方 scorer 与许可证，均无 API 密钥。校正前的不完整报告也另存保留，不能用其作质量结论。
