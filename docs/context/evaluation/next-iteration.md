# 下一轮上下文迭代

## 目标

让仓库上下文成为 AI 编码的必要依赖，而不只是存在于磁盘上的文件。

## 启动条件

当前冻结的 50 样本实验已完成。归档分支并获得评审确认后，再启动本轮迭代。

## 待解决问题

1. 50 次 Treatment 运行中仅 23 次引用 `docs/context`。
2. 根 `AGENTS.md` 的链接只是建议性的，可能被跳过。
3. 许多运行实际上是带有未使用文件的 Control 运行，使 Treatment 效果被稀释。
4. 当前数据集以前端为主，未充分检验外部云、billing 或跨服务知识。

## 改动

### 1. 强制上下文消费

更新根 `AGENTS.md`，要求 Agent 在代码规划前必须：

1. 读取 `docs/context/README.md`；
2. 读取 `context-routing.yaml`；
3. 只选择路由命中的领域或项目文档；
4. 记录实际消费了哪些上下文文件。

不得将其变成全仓库审计；指令应简短且具强制性。

### 2. 添加紧凑上下文摘要

直接向根 `AGENTS.md` 或任务 prompt 添加一段简短、高信号摘要：

- 仓库地图；
- 任务类型路由表；
- 外部知识领域；
- 当前任务上下文路径；
- 验证要求。

即使模型未跟随链接，这也能提供可用地图。

### 3. 添加消费预检

扩展评测 runner：

1. 每次 Treatment 运行后，检查日志中的 `docs/context`；
2. 若不存在，标记样本为 `context_not_consumed`；
3. 要么以显式上下文注入重跑，要么将其排除在 Treatment 效果结论之外。

这可避免将“我们添加了上下文”混同为“模型使用了上下文”。

### 4. 扩展外部知识

为无法仅从源代码恢复的知识添加或完善上下文：

- Tencent Cloud API 契约；
- billing 与 Pass 权益规则；
- Cloud API 错误码和限制；
- CAM 与安全边界；
- 区域特定行为；
- 外部服务 SLA 与 quota。

优先使用简洁且带来源链接的文档，而非长篇叙述性指南。

### 5. 改进 Skill 治理

当前实验完成后：

1. 将 `context-audit` 加入 `docs/context/skills/inventory.md`；
2. 为每个 Skill 分配 owner；
3. 拆分超过 500 行的 Skill；
4. 移除或归档重复能力；
5. 保持触发描述足够具体，避免意外激活。

### 6. 重新冻结并重新评测

1. 冻结新的上下文包。
2. 扩大规模前先运行留出子集。
3. 对比：
   - context consumption rate;
   - Recall@5;
   - MRR;
   - token usage;
   - wall time;
   - tool calls;
   - context-not-consumed rate.
4. 仅在消费率提高且质量未回归时声称有改善。

## 成功标准

- 上下文消费率从 23/50 升至至少 70%。
- Treatment Recall@5 提升且不增加 Token 用量。
- 明确报告未消费上下文的比例。
- 外部云与 billing Query 有专用路由。
- Skill 清单保持完整且已分配 owner。
