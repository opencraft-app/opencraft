# 通用仓库上下文与文档目录标准

本标准规定职责，不规定全局目录名。若仓库已有 `handbook/`、`architecture/`、`catalog/` 或 RFC 体系，Agent 先读取其内容、权威性和 Git，再映射到“正式知识、服务共置、Agent 派生、控制面、工作流、评测隔离”六类责任面。现有资产承担了相应职责就直接复用；建设的目标是补齐责任、消除多套真相和建立证据链。

## 可选参考拓扑

```text
repo/
├── AGENTS.md                         # 仓库级短入口：硬边界、路由算法、验证命令
├── README.md                         # 人类入口：项目用途、启动方式、正式文档入口
├── CODEOWNERS / catalog.*            # 责任映射；以团队制度为准
├── service-a/
│   ├── README.md                     # 服务身份、边界、本地开发、文档索引
│   ├── AGENTS.md                     # 仅写相对根入口的局部增量规则
│   ├── catalog-info.yaml             # owner、domain、生命周期、依赖和文档入口
│   ├── docs/
│   │   ├── README.md                 # 服务文档导航和权威说明
│   │   ├── architecture.md           # 组件、数据流、依赖、边界
│   │   ├── contracts.md              # API、事件、配置、数据契约入口
│   │   ├── operations.md             # 可观测性、告警、故障与恢复入口
│   │   ├── decisions/ADR-*.md         # 服务局部决策
│   │   └── runbooks/*.md             # 可执行操作步骤
│   └── src/ tests/ ...               # 源码与测试
├── docs/
│   ├── engineering/                  # 面向人的跨服务正式工程知识
│   └── context/                      # 面向 Agent 的紧凑派生层
├── .agents/
│   ├── context/                      # Schema、Router、Catalog 契约、权威和生命周期
│   └── skills/                       # 可复用、有边界的工作流
└── evaluation/                       # 版本化协议与本地派生产物；整层运行时禁入
```

`evaluation/` 也可以放在 `docs/context/evaluation/`，但 Router 必须整目录排除，Catalog 必须标记为非运行时，Validator 必须有污染门禁。位置可变，隔离语义不可变。

## 根目录文件

### `AGENTS.md`

只保留五类内容：仓库身份、P0 安全边界、按需加载算法、冲突权威、验证命令。目标上限 8 KiB；任一根到局部入口的祖先链目标上限 16 KiB。

为什么：入口会被大量任务自动继承。把百科全书放在入口会让无关任务为重复背景付出 Token，并让最近、最相关的局部规则被稀释。

不得放入：完整架构说明、所有服务手册、历史聊天、临时任务状态、Gold 或模型答案。

### `README.md`

面向人类回答：仓库做什么、如何开始、主要目录、正式文档从哪里进入、如何验证。它可以比 `AGENTS.md` 更具解释性，但不应复制详细专题正文。

### `CODEOWNERS` / Service Catalog

保存责任制度认可的 owner。Git 历史可以验证谁在何时修改了文件，不能以提交次数推断当前 owner。

## 服务目录：代码与局部知识共置

每个可独立负责、构建、部署或运行的服务，至少具备以下四件套：

1. `README.md`：服务职责、非职责、主要入口、依赖、本地开发和文档索引。
2. `AGENTS.md`：只写该服务相对于根规则的增量；包含高风险边界、最近规则、测试命令。
3. `catalog-info.yaml` 或等价记录：`name`、`owner`、`domain`、`lifecycle`、源码和文档位置、上游/下游。
4. `docs/README.md`：列出架构、契约、操作、决策、Runbook，并注明各自权威来源。

为什么共置：服务代码与责任、局部规则和操作知识通常同生命周期变更。共置让代码评审能同时看到文档差异，并缩短 Agent 从路径到正确上下文的距离。

## `docs/engineering/`：跨服务正式工程知识

```text
docs/engineering/
├── README.md                         # 总入口、层级解释、权威关系
├── architecture/
│   ├── system-overview.md            # 系统边界、外部参与者、关键能力
│   ├── service-topology.md           # 服务关系、同步/异步边、依赖方向
│   └── authority-and-contracts.md    # 源码/API/配置/文档冲突优先级
├── catalog/
│   ├── services.yaml                 # 服务、owner、domain、路径、文档入口
│   └── owners.yaml                   # 团队或责任组的制度映射
├── domains/<domain>.md               # 稳定业务边界、术语、数据和不变量
├── journeys/<journey>.md             # 跨服务用户/请求/交付链路
├── platform/<topic>.md               # 共享平台、基础设施和通用能力
├── operations/<topic>.md             # 跨服务发布、可观测、应急与恢复
├── governance/
│   ├── documentation-policy.md       # 分类、owner、时效、生命周期和链接规则
│   └── documentation-map.yaml        # 全仓文档母集、类别、排除和扫描边界
└── decisions/ADR-*.md                # 跨服务重要决策、替代方案和后果
```

各子目录回答不同问题：

- `architecture/` 回答“系统如何组成、边界在哪里”。
- `catalog/` 回答“谁负责什么、入口在哪里”。
- `domains/` 回答“一个业务域有哪些稳定语义和不变量”。
- `journeys/` 回答“一条端到端链路如何跨服务流动”。
- `platform/` 回答“哪些共享能力被多个服务依赖”。
- `operations/` 回答“如何发布、观察、处置和恢复”。
- `governance/` 回答“文档如何分类、复查、失效和退出”。
- `decisions/` 回答“为什么作出影响多个边界的决定”。

同一事实只允许一个正式真源。其他页面使用链接、摘要和 `source_of_truth` 回链，不复制长期正文。

## `docs/context/`：Agent 紧凑派生层

```text
docs/context/
├── INDEX.md                           # 可浏览索引；不替代 Router
├── domains/<domain>.md                # 从正式 Domain 文档派生的任务导航
├── project/
│   ├── repository-map.md              # 目录、技术栈、入口的紧凑地图
│   ├── service-boundaries.md          # 服务职责和禁止跨越的边界
│   ├── external-knowledge-boundaries.md
│   ├── services/<service>.md          # 服务路由卡；回链服务共置文档
│   └── adjacency/*.md                 # 测试、配置、生成物、部署邻居卡
├── flows/<flow>.md                    # 跨域任务的最短必读链
├── runbooks/<topic>.md                # Agent 可执行的有界操作导航
├── tasks/                             # 目标、验收、receipt、Checkpoint
├── feedback/                          # 有效失败、根因、修复与回归
├── candidates/                        # 待确认的记忆/规则候选
├── decisions/                         # Context 控制面自身的 ADR
├── .context/
│   ├── catalog.jsonl                  # 每份运行时 Context 的治理记录
│   └── source-map.yaml                # 派生文件到正式真源的映射
└── evaluation/                        # 若放在此处，必须整目录运行时禁入
```

派生 Context 的内容应短、原子、任务导向：适用范围、何时加载、必须读取、延迟读取、权威回链、owner、revision、复查日期、禁区。它不承担面向人的完整教学，也不覆盖源码和测试。

## `.agents/context/`：控制面

| 文件 | 应包含什么 | 为什么独立于正文 |
|---|---|---|
| `context-pack.schema.json` | Context 元数据、层级、状态、来源、过期字段 | 让结构可被机器校验 |
| `context-routing.yaml` | Pack、触发词、路径、符号、`must_read`、deferred、排除项 | 把发现逻辑集中并可回归 |
| `authority-policy.yaml` | 冲突优先级、外部权威、运行时能力声明边界 | 防止摘要覆盖事实源 |
| `lifecycle.yaml` | candidate、pilot、active、stale、retired 的进入退出门禁 | 防止记忆无限堆积 |
| `external-sources.yaml` | URL/系统、owner、版本、有效期、失效策略 | 管理仓库外事实 |
| `tool-contracts.yaml` | 路由、校验、审计、搜索的输入输出和失败策略 | 稳定工具前缀与错误处理 |
| `route-smoke-cases.json` | Query、预期 Pack、禁止 Pack | 给 Router 可执行回归 |
| `scripts/` | Catalog 构建、Validator、审计辅助 | 规则必须有执行入口 |
| `tests/` | Schema、路由、隔离、预算、链接回归 | 防止结构悄然漂移 |

## `.agents/skills/`：可复用工作流

一个 Skill 是“何时触发、按什么顺序做、边界在哪里”的工作流，不是仓库百科。标准结构：

```text
.agents/skills/<skill>/
├── SKILL.md                           # 简短入口、触发、流程、边界
├── references/                       # 按需读取的规范和证据
├── scripts/                          # 可重复执行的确定性动作
├── tests/                             # 脚本与输出契约测试
└── agents/openai.yaml                # UI 元数据，可选
```

## `evaluation/`：评测隔离层

版本控制只保存可复现协议：Dataset、Gold、冻结清单、来源记录、Schema、脚本和运行说明。模型答案、逐样本结果、评分、审计、报告、日志与运行回执默认保存在仓库外本地目录或仓库已忽略路径；需要集中留存时进入受控制品系统，不混入运行时 Context 或 Skill 安装包。Provider 凭据只通过受控环境注入，不序列化到任何评测资产。

Router、Catalog 和运行时 Context 构建器必须显式排除整个评测层；只有专用评测流程可以读取其协议和本地产物。

为什么：版本化协议保证可复现，派生产物本地化减少仓库噪声和敏感运行信息扩散；答案或评分一旦进入 Treatment 上下文，准确率就不再能代表真实任务能力。隔离既是实验有效性的硬门禁，也是日常 Agent 的安全边界。

## 允许的裁剪

- 单服务小仓可以把 `docs/engineering/` 简化为 `docs/architecture.md`、`docs/operations.md` 和 `docs/decisions/`。
- 没有运行时 Router 的初建仓，先建立根入口、服务四件套和正式知识；控制面在第二轮加入。
- 已有 Backstage Catalog、CODEOWNERS、ADR 或内部文档站时，复用现有真源，只增加链接、派生和校验。
- 文档极少的仓库不应为了目录完整度创建空文件；评分看职责证据，不看装饰性目录数量。
