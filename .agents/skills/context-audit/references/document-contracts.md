# 文件内容契约

目录解决“放在哪里”，文件契约解决“里面写什么”。所有模板都应按仓库规模裁剪；空标题和复制粘贴正文不计为建设证据。

## 正式文档通用头信息

运行时 Context 必须有机器可读元数据；正式工程文档至少应能从 Catalog 或页面自身解析以下字段：

```yaml
id: stable-unique-id
type: architecture|domain|journey|service|runbook|decision|task|feedback
scope: 适用系统、服务或目录
owner: 制度认可的团队或责任角色
authority: canonical|derived|external
source_of_truth:
  - path/or/url
status: draft|active|stale|retired
reviewed_at: YYYY-MM-DD
review_due: YYYY-MM-DD
revision: semver-or-git-revision
precedence: team|project|domain|service|task
derived: true|false
```

为什么需要：稳定 ID 支持 Catalog/Trace；scope 防止越界；owner 和复查日期支持生命周期；authority/source 防止平行真相；precedence 解决冲突；revision/source hash 支持可复现。

## 根 `AGENTS.md`

```markdown
# 仓库 Agent 入口

## 仓库身份
一句话职责、主要目录、正式文档入口。

## P0 边界
安全、外部写入、生产、提交发布、验证边界。

## Context 加载
路由命令；must_read/deferred/fallback 算法；评测排除。

## 冲突与权威
源码、测试、生成契约、配置、正式文档、派生摘要的优先级。

## 验证
仓库级 lint/test/validator 入口。
```

禁止：把所有服务规则复制进根入口；把临时任务状态写成永久规则；将愿景能力描述为已实现。

## 服务 `README.md`

必须回答：

1. 服务负责什么、不负责什么。
2. 主要代码、配置、API/事件和测试入口。
3. 本地开发、构建和最小验证命令。
4. 上游、下游和高风险边界。
5. 正式服务文档索引与 owner 来源。

## 服务 `AGENTS.md`

只记录该路径的局部增量：必须阅读的服务文档、高风险操作、生成文件规则、局部 lint/type/test。若根规则已说明，不重复。

## Service Catalog 记录

```yaml
name: service-a
path: service-a/
owner: platform-team
domain: agent-runtime
lifecycle: production
description: 一句话边界
docs:
  readme: service-a/README.md
  index: service-a/docs/README.md
  context: docs/context/project/services/service-a.md
depends_on: [service-b]
provides: [api-or-event]
```

Owner 必须来自 CODEOWNERS、组织 Catalog 或负责人确认。`git blame` 只能定位变更出处。

## Architecture / Domain / Journey

- Architecture：系统边界、组件、依赖方向、同步/异步数据流、故障边界、关键契约和图的文字说明。
- Domain：术语、稳定不变量、状态机、数据所有权、服务边界、跨域接口、禁止假设。
- Journey：触发条件、逐步链路、每步 owner/服务、关键数据、失败与补偿、观测点、验收入口。

三者避免混写：Architecture 描述结构，Domain 描述语义，Journey 描述端到端时序。

## Runbook

```markdown
# 操作名称
## 适用条件与禁止条件
## 前置权限和只读检查
## 分步操作
## 每步预期结果
## 失败停止条件与恢复
## 验证
## Owner 与复查日期
```

命令不得包含 secret；生产、删除、发布等动作必须把授权边界写在步骤前。

## ADR

包含状态、日期、背景、决策、被比较方案、理由、后果、回滚/替换条件和关联证据。ADR 记录当时为什么决定，不承担持续更新的运行手册。

## Context Pack

Context Pack 必须短于其事实源，至少包含：适用范围、触发词/路径/符号、`must_read`、deferred、关键不变量、权威回链、owner、复查日期、revision。可重取细节只给入口，不复制全文。

## Task Pack 与 Checkpoint

Task Pack：`goal`、`non_goals`、acceptance、scope、risk、validation、`context_receipt`、evidence、handoff。

Checkpoint：stage、verified、unverified、discard、restore、next_action。压缩和交接只保留恢复任务所需的最小状态，不复制完整聊天。

## Feedback 与 Candidate

Feedback 保存有效失败：触发条件、影响、实际证据、根因、修复文件、回归命令、关闭条件。Candidate 保存待晋级经验：来源、范围、owner、过期时间、接受/拒绝记录。未经确认不得自动晋级为 active。

## Catalog 记录

每个运行时 Context 至少记录：稳定 ID、URI、owner、status、reviewed/review_due、revision、precedence、derived、source URI、source hash。Catalog 应由 Validator 构建或核对，禁止手工改数量来提高分数。

## 评测资产保留契约

- 可入库：Dataset、Gold、冻结清单、来源记录、Schema、脚本和运行说明，用于复现协议与输入。
- 只留本地或受控制品系统：模型输出、`*-results.jsonl`、评分、报告、审计、日志和运行回执。
- 凭据：只允许通过受控环境变量或秘密管理系统注入，不写入配置、结果、日志、报告或命令示例。
- 隔离：无论是否入库，整个评测层都必须从 Router、Catalog 和运行时 Context 构建中排除。

## 内容质量检查

逐文或抽样检查以下问题：

- 关键事实能否回到源码、测试、生成契约、配置或受控外部源。
- 时间敏感字段是否有复查日期和失效策略。
- 相对链接是否存在，外部链接是否标明适用版本。
- 是否与另一个“正式”页面重复；若重复，确定唯一真源并改为链接。
- 示例和命令是否仍可运行；未运行必须明确边界。
