# 仓库上下文评测（Repository Context Evaluation）

## 目标

衡量仓库级 Context Engineering 是否改善真实 AI 编码结果，而不是只衡量检索系统在隔离环境中的得分。

## 数据集

- 来源：2026 年 `wisp/mono2` 中已合并的真实 MR。
- Query：从 MR 标题或 `需求描述` / `背景` 节提取并净化后的需求意图。
- 原始 MR 描述：仅以 `raw_description` 保留溯源信息，绝不作为 Agent Query。
- Gold：合并 commit 的改动文件与验证证据。
- 最小规模：50 个样本。
- 候选池：96 个 MR 满足基础 Query 与合并 SHA 要求。
- 排除仅发布、生成子树和超大改动后的合格池：69 个 MR。
- 当前数据集：[candidates.jsonl](candidates.jsonl) 含 56 条选中记录——初始 50 条加上 6 条无效尝试的替换项。
- 固定模型最终报告（本地产物）：`final-report.md`。
- 历史 22 样本中期报告（本地产物）：`pilot-report.md`。
- 三个代表性案例（本地产物）：`case-studies.md`。
- 上下文消费审计（本地产物）：`context-consumption-audit.md`。
- 下一轮迭代计划：[next-iteration.md](next-iteration.md)。
- 上下文审计 Skill：[context-audit](../../../.agents/skills/context-audit/SKILL.md)。
- 仅上下文诊断结果（本地产物）：`context-only-results.jsonl`。

数据集、冻结清单、来源记录、Schema、脚本和运行说明属于可复现协议，可进入版本控制。`runs/`、`*-results.jsonl`、`execution-events.jsonl`、实验报告、审计、案例和实验汇总 HTML 属于本地派生产物，由仓库 `.gitignore` 统一排除；需要复盘时在本机保存或重新生成。

每个样本必须包含：

```text
id
mr_iid
requirement_query
base_commit
merge_commit
changed_files
required_tests
verification_evidence
source_branch
target_branch
service_labels
risk_labels
size_label
created_at
```

## 抽样配额

| 维度 | 目标 |
|---|---|
| 主服务 | frontend 30、ctl 7、trade 2、cloudladdergateway 2、gateway-dashboard 2、other 7 |
| 规模 | small 20、medium 21、large 9 |
| 时间 | 分布于 2026 年 4 月至 8 月 |

## 实验分组

| 分组 | 上下文 |
|---|---|
| Control | 现有根 `AGENTS.md`、服务 `AGENTS.md`、OpenSpec 与 Skills |
| Treatment | 精简根入口、`docs/context/` 路由、领域事实、任务模板与 Skill 清单 |

两组必须使用相同的模型、工具、prompt、超时、base commit、Gold 和预算。Treatment 可以加载不同上下文内容，但不得获得更多工具权限。

## 指标

| 层级 | 指标 |
|---|---|
| 检索 | Hit@5、Recall@5、MRR、零结果率 |
| 交付 | 改动文件重叠度、必需测试选择、语义正确性、范围漂移 |
| 效率 | 输入 Token、输出 Token、缓存命中率、墙钟时间、工具调用 |
| 安全 | 密钥暴露、未授权外部操作、过期事实使用、范围扩张 |

## 模型对比

既有完整数据集报告固定为 `glm-5.3`、low 推理力度，属于不可改写的历史实验口径。新实验固定使用 CC Switch Provider `ccf642d4-1927-4769-a8f7-e2882c488455`、`glm-5.3`、high 推理力度与 Responses 协议，并使用新的 `run-label` 和冻结清单，禁止与历史 low 结果混算。成功要求 Treatment 在同一固定配置下提升或保持质量与效率，且每个报告样本都必须是有效的 Control/Treatment 配对运行。

## 硬性门禁

- Query、Gold、patch 和评测 fixture 必须位于索引语料之外。
- `raw_description`、改动文件、测试和验证证据均为 Gold 侧数据，在 Agent 产出计划前不得展示。
- Control 上下文不得使用未来 MR 内容。
- 没有配对运行时，不得声称因果改善。
- 除平均值外，还须报告最差案例与服务切片。
- 评测资产中绝不存储凭据或原始敏感日志。
- 模型输出、报告、审计和运行回执仅保存在本地，不提交到 Git；Provider 凭据只允许通过受控环境变量注入。

## 执行文件

- 本文“每个样本必须包含”定义数据集样本契约。
- [output-plan.schema.json](output-plan.schema.json)：两组共用的模型计划输出契约。
- [runbook.md](runbook.md)：两组共用指令、执行与评分流程。
