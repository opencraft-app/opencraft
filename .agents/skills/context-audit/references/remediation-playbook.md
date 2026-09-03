# 三轮上下文建设手册

## 总流程与授权边界

第一次运行只读审计：候选文件、Git 历史、现有 Validator/测试入口和未评分 Assessment 模板。Agent 先映射目标仓库自身的责任面，逐 observation 核对内容、证据与局限。陌生仓首次不给数值分；先给画像、定性状态、缺口和建设规划。只有用户明确选择建设后，才创建 Goal 并修改仓库。

每轮固定流程：

```text
Assessment 更新 → 核对证据 → 提出本轮规划 → 用户授权 → 建设
        → Git/命令回执验证 → 重新评审/可点分性检查 → 记录剩余边界
```

三轮专指仓库建设轮次；完成门禁只采用 Agent 已核对 Assessment、两套静态评分、Git、与 claim 绑定的 Validator/测试回执与 TMR。

## 仓库画像与策略

### `empty`

信号：没有仓库级入口、控制面和成体系文档。

策略：从真实代码边界生成最小入口和服务清单；只为当前存在的服务/Domain 建文档，不预创建空目录。优先确定 owner 和权威源。

### `underbuilt`

信号：有 README 或散落文档，但缺分层入口、责任、Catalog、Router、生命周期中的一部分。

策略：保留有价值正文，先归类和回链，再补缺失控制面。避免把所有散文直接搬进 Context。

### `overbuilt`

信号：入口超预算，文档大量重复/过期，或 Context 层成为正式知识的平行副本。

策略：先冻结新增，确定真源，做保留/合并/转链接/归档清单；缩短默认入口后再引入 Router。所有删除或归档必须先用 Git 和链接检查确认影响，且需要用户授权。

### `managed`

信号：入口、正式知识、派生层、控制面和 Skill 已出现。

策略：修 P0/P1、补覆盖和证据；不为了满分继续扩写。运行时 Trace、自动 compact 和记忆晋级按独立产品能力规划。

## Round 1：盘点、分类与责任

目标：建立可信的文档母集和服务边界，让每个现有服务有责任与最短入口。

1. 运行 `rg --files`、文档扫描和 `git status --short`，保护已有 dirty worktree。
2. 分类文档：canonical、product、work、generated、evaluation、archive、vendor、upstream、context；仓库可映射到等价类别。
3. 对重复页面确定唯一真源；其余先列迁移表，不直接删除。
4. 从构建/部署边界、Catalog、CODEOWNERS 和现有团队制度识别服务与 owner。
5. 为每个真实服务补齐 README、局部 AGENTS、Catalog 记录和 docs 索引。
6. 建立 `documentation-policy` 与机器可读的文档地图。

验收：文档母集可重扫；未分类为 0 或有登记理由；服务覆盖分母来自真实 Catalog，不写死数量；owner 有制度来源；链接无新增失效。

## Round 2：正式知识、派生层与控制面

目标：把完整工程知识与 Agent 紧凑消费接口分开，并建立可执行权威、路由和隔离。

1. 按现有需要建设 Architecture、Domain、Journey、Platform、Operations、Governance 与 ADR。
2. 只从正式知识派生 Domain、Service、Flow、Runbook Context；记录 source map 和 source hash。
3. 建立 Context Schema、Catalog、Router、Authority、Lifecycle、External Sources、Tool Contracts。
4. 为 Router 增加单域、跨域、精确路径、服务路径、无匹配和评测禁入 smoke case。
5. 建 Task/Checkpoint/Feedback/Candidate 契约。
6. 把 `evaluation/` 整层排除在运行时 Router、Catalog 和 Context 构建之外；版本化协议与本地模型输出、报告、运行回执分开保留。

验收：所有 active Context 通过 Schema；Catalog 覆盖率可计算；Router 必读零漏召回、禁入零污染；派生文件能回链真源；23 条规则如实区分 implemented/partial/design-only。

## Round 3：压缩、证据与交付

目标：以更小默认入口和更强证据完成 V1，而不是继续堆文档。

1. 测量根入口和所有祖先指令链，压缩重复内容并改为链接。
2. 对高频/高风险文档做 owner、时效和事实回链抽检。
3. 用 Git 确认关键文件来源、迁移前后差异和责任制度变更；未提交资产标明证据等级。
4. 按仓库实际风险补齐 Validator、单测、HTML/TMR 渲染和报告输出契约；不为了得分复制一套专用路径。
5. 更新所有 required observations，用 `--record-check --claim --expect` 实际执行安全的 Validator/测试，再由脚本推导两套评分。`--expect` 使用非敏感、稳定可复现的成功输出片段。逐项解释状态、分值理由、能证明与不能证明。
6. 做三轮最终检查：结构与测试、证据与评分、产物与表述。

验收：Assessment 契约和证据校验通过，两套评分分别 ≥85 且 P0=0；输出本地 JSON、Markdown、HTML/TMR；P2 能力保持明确边界；无敏感信息、失效链接和运行时评测污染。

## Goal 建议

用户确认建设后，可创建：

```text
完成目标仓库上下文工程 V1：基于首次只读 Assessment，按三轮建设修复 P0/P1，
建立可追溯的正式知识、Agent 派生层、控制面、Skill 与评测隔离；
以 Assessment 和回执可复现、两套评分分别达到 85 且 P0 为 0、TMR 可复现为完成条件。
```

Goal 不自动授权 commit、push、MR、发布、生产变更、外部服务写入或删除大量文档；这些动作仍需单独确认。

## 重新评分与停止条件

- 任一 P0：停止扩写，优先修契约、污染、路由失败或预算超限。
- 分数已通过且只剩 P2：交付 V1，运行时能力另立 Goal。
- 文档增加但默认入口、重复率或未分类上升：判定建设方向偏离，回到真源和分层。
- Git 历史不可用：相关 observations 标 `unknown` 或按当前文件局限标 `partial`；不能声称历史来源已验证。
- Validator 不存在：通用扫描只作发现/文件证据；Round 2/3 再按仓库实际风险决定是否建设专用 Validator，不因缺专用工具自动得分或扣分。
