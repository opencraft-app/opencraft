# 上下文评测 Runbook

## 前置条件

1. 新实验的两个组必须使用同一固定配置：CC Switch Provider `ccf642d4-1927-4769-a8f7-e2882c488455`、模型 `glm-5.3`、推理力度 `high`、Responses 协议。历史 low 结果只作既有证据保留，不得与新 high 结果混算。
2. 冻结数据集 commit，并在结果中记录。
3. 将 Query、Gold、patch 与评测 fixture 保持在索引语料之外。
4. 不得授予 Treatment 组额外工具或权限。

## Control 组

1. 从数据集 `base_commit` 开始。
2. 只加载该 commit 中可用的原始根 `AGENTS.md`、服务 `AGENTS.md`、OpenSpec 和 Skills。
3. 提供 `requirement_query`。
4. 要求 Agent 产出：
   - 改动文件计划；
   - 必需测试；
   - 实现方案；
   - 风险和 rollout 检查。
5. 记录 Token 使用量、墙钟时间、工具调用和输出。

## Treatment 组

1. 从相同的 `base_commit` 开始。
2. 加载新的上下文栈：
   - 精简根 `AGENTS.md`；
   - service `AGENTS.md`；
   - `.agents/context/context-routing.yaml`；
   - 路由命中的领域文件；
   - `Task Pack` 模板；
   - 路由命中的本地 Skill。
3. 提供相同的 `requirement_query`。
4. 要求同样的四类输出。
5. 记录相同指标。

## 评分

| 指标 | 定义 |
|---|---|
| Hit@5 | Agent 建议的前五个文件中至少有一个 Gold 改动文件 |
| Recall@5 | 建议前五个文件与 Gold 文件的交集，除以 Gold 文件数 |
| MRR | 建议文件列表中第一个 Gold 文件的倒数排名 |
| 测试选择 | 建议测试是否与 Gold 验证命令或测试文件重叠 |
| 语义正确性 | 计划是否满足需求且没有范围漂移 |
| 范围漂移 | Agent 是否建议不相关的服务或文件 |
| Token 成本 | 输入、输出、缓存命中和总 Token |
| 速度 | 墙钟时间和工具调用次数 |

## 输出模板

```json
{
  "run_id": "",
  "arm": "control|treatment",
  "model": "",
  "dataset_commit": "",
  "context_commit": "",
  "sample_id": "",
  "proposed_files": [],
  "proposed_tests": [],
  "semantic_correctness": "pass|partial|fail",
  "scope_drift": false,
  "metrics": {
    "hit_at_5": 0,
    "recall_at_5": 0.0,
    "mrr": 0.0,
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_hit_rate": 0.0,
    "wall_time_ms": 0,
    "tool_calls": 0
  },
  "evidence": ""
}
```

两个实验组使用本 Runbook 定义的同一任务指令和输出契约，只允许 Context 输入不同。

## 冻结版本与执行

- `freeze-manifest.json` 保留既有英文 V2 评测的上下文 hash，不得因中文化而覆盖。
- `freeze-manifest.zh-v2.json` 对应中文 V2 上下文；运行时必须显式选择，避免把新上下文误记为旧冻结版本。
- 冻结清单中的 `context_sha256` 必须与 runner 按当前允许文件集合计算的 hash 完全一致，否则立即停止。

Repository Documentation V3 固定模型实验示例：

```bash
python3 docs/context/evaluation/scripts/run_context_eval.py \
  --model glm-5.3 \
  --reasoning-effort high \
  --ccswitch-provider ccf642d4-1927-4769-a8f7-e2882c488455 \
  --ccswitch-db "$HOME/.cc-switch/cc-switch.db" \
  --freeze-manifest freeze-manifest.repo-doc-v3.json \
  --run-label repo-doc-v3-high
```

Runner 以只读方式读取 CC Switch SQLite，校验 Provider 名称、模型、`high` 和 `wire_api = "responses"`，然后为每个实验臂创建最小隔离 `CODEX_HOME`。API Key 只通过子进程的 `OPENAI_API_KEY` 环境变量注入，不写 `config.toml`、`auth.json`、日志或结果文件；未显式提供该 Provider 时，GLM 实验立即拒绝执行。

## 续跑状态

`repo-doc-v3-high-glm-5.3-high-results.jsonl` 当前包含 50 个唯一有效配对样本，固定 `glm-5.3 / high / Responses` 实验已完成。冻结 hash 为 `f3aac5efada64f654bf840642d2758f6b5b5be24b51b2f202bb4f5c7c94e421b`，完整结论见 [Repository Documentation V3 固定模型配对实验报告](repo-doc-v3-high-glm-5.3-high-report.md)。

V3 实验的 Recall 点估计下降且 95% CI 跨零，因此当前状态为 `PILOT`，不得宣称上下文提高了准确性。下一轮必须重新冻结新的 allowlist 和 hash，不得覆盖或续写本结果文件。

以下状态仅适用于历史 low 固定模型实验：

已记录的无效样本：

- `mono2-mr-293`
- `mono2-mr-900`
- `mono2-mr-2360`
- `mono2-mr-2359`
- `mono2-mr-2554`
- `mono2-mr-3144`

历史 low 固定模型运行没有下一个样本。后续实验应遵循 [next-iteration.md](next-iteration.md)，重新冻结上下文包，并使用独立留出子集；不得续写或覆盖历史结果文件。

按样本 ID 而非默认顺序续跑，避免意外重试已知超时案例。只有 Control 和 Treatment 都完成、且结果已追加至 `pilot-isolated-results.jsonl` 时，样本才有效。

## 报告

报告配对差值，而不仅是聚合平均值。包括：

- 总体平均值和中位数；
- 最差 10%；
- frontend、backend 和跨服务切片；
- small、medium 和 large 任务；
- 零结果与范围漂移案例；
- 固定模型稳定性和置信区间。
