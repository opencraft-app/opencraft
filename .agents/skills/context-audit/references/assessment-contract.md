# Repository Assessment 契约

Assessment 是 Agent 对目标仓库语义的结构化判断，不是脚本扫描结果的改名。当前契约版本为 `schema_version: 3`；脚本生成的 `--write-template` 是 Schema 和 observation ID 的机械真源；本文规定每个字段必须承载的语义。

Assessment、命令回执、报告和日志默认写到仓库外的本地目录或仓库已忽略路径，不进入 Git。

## 审计主体

- Agent：读正文、识别仓库责任面、确定分母、核对冲突，并为每个 observation 提交状态、理由、证据与局限。
- 发现器：只列候选指令、Owner 源、文档、Catalog、控制面、测试、Validator、链接和 Git 事实。候选命中不代表职责成立。
- 契约校验器：校验字段、路径、Git commit、回执 hash、claim 绑定和证据强度。
- 算分器：只从通过契约的 observations 确定性推导维度分、总分、证据等级和门禁。

## 仓库语义映射

首次评审先在 `repository.assessment_scope` 或其引用的本地说明中完成下列映射。每类都记录候选、选中项、作用范围、权威性、选择理由和冲突。

| 责任面 | 可接受的现有实现示例 | Agent 需核对 |
|---|---|---|
| 仓库与局部指令 | `AGENTS.md`、`CLAUDE.md`、`.github/copilot-instructions.md`、自有规则 | 继承范围、冲突优先级、安全边界、验证入口 |
| 组件/服务分母 | 构建单元、workspace、部署单元、Catalog | 哪些单元真正可独立负责、构建、部署或运行 |
| Owner | CODEOWNERS、Backstage/自有 Catalog、组织制度 | 责任是否现行、范围是否覆盖；Git 不可推断 Owner |
| 正式知识 | `docs/`、`handbook/`、ADR/RFC、仓内文档站源文件 | 唯一真源、来源、时效、与代码/配置/测试是否相符 |
| Agent 派生知识 | Context Pack、路由卡、索引、紧凑 Runbook | 是否更短、何时载入、是否回链正式真源 |
| 路由与控制面 | Router、Catalog、Schema、搜索/检索配置 | 入口、选择算法、权威、失效、排除和回归 |
| 可复用工作流 | Skill、命令、脚本、流程指南 | 触发、权限、停止条件和实际验证 |
| 生命周期与消费 | review_due、stale/retired、receipt/trace | 更新/退出机制与真实消费证据分开 |
| 评测隔离 | Gold/Dataset/结果/报告与 Router 排除 | 协议可复现，答案、评分和运行回执不进运行时 Context |

映射为空是有效发现；不应为了得分把一个目录同时声明为多个未实现的责任面。

## Observation

每个量表维度包含由当前脚本模板给出的 4 个 required observations，其中第 4 个是强证据槽。Observation ID 表示 [rubric.md](rubric.md) 中的概念要求，不表示固定路径。每项必须包含：

- `status`：`pass | partial | fail | unknown`。
- `rationale`：说明为什么这些仓库事实导致该状态，不重述状态名。
- `subject`：被评审的具体责任面、样本或路径范围，用于防止证据对象漂移。
- `evidence`：直接支持该 claim 的证据；一份回执不可无边界地复用于多个不同 claim。
- `limitations`：列出抽样边界、未覆盖路径、无法访问的外部源或证据时效。

状态语义：

| 状态 | 判定 |
|---|---|
| `pass` | 该 observation 要求在声明范围内完整成立，且证据强度达到量表要求 |
| `partial` | 已有真实实现，但覆盖、时效、可执行性或来源链存在具体缺口 |
| `fail` | 有直接证据证明缺失、冲突、失效、超预算或隔离失败 |
| `unknown` | 当前证据不足以判断；不当作 `fail`，也不能参与点分 |

强证据槽要求“某项关键行为可复现/可追溯”。该槽标为 `pass` 时，必须至少有一种脚本为该维度允许的 `validator | test | trace | owner_review` 强证据；只有文件、Git、普通 receipt 或 `model_effect` 时不能标 `pass`。

## 证据

每条证据都需 `kind`、`statement`、`proves` 和 `does_not_prove`，并且必须与 observation claim 直接相关。

| kind | 必需定位信息 | 边界 |
|---|---|---|
| `file` | 仓库内相对路径，并加 `line_start`/`line_end`、标题或结构化键定位 | 证明定位范围内的当前内容，不单独证明来源、时效或实际消费 |
| `git` | `path` + 最新包含完整路径内容的 40 位 commit | 算分时重新执行 `git log -1 -- <path>` 核对；不推断 Owner |
| `validator` / `test` | `command`、本地回执绝对路径、SHA-256、绑定 claim、输入文件 hash 与已命中的稳定输出 selector | 只证明命令实际检查的范围；通过不自动等于 observation `pass` |
| `owner_review` | 可定位的制度记录或受控回执 | 仅在用户已提供或明确授权确认时使用 |
| `receipt` / `trace` | 本地 artifact 绝对路径、SHA-256、仓库状态与 claim 绑定 | 只能证明记录范围内的真实消费或工作流 |
| `model_effect` | 隔离实验 artifact 的绝对路径和 SHA-256 | 仅作独立效果附录，不提高静态 observation 状态或分数 |

Validator/测试命令执行前，Agent 必须先阅读入口并确认无外部副作用，再用：

```bash
python3 .agents/skills/context-audit/scripts/audit_context.py \
  --repo . \
  --record-check <absolute-local-receipt.json> \
  --claim <observation-id> \
  --input <repository-relative-subject-evidence> \
  --expect '<stable-nonsensitive-output-fragment>' \
  -- <validator-or-test-command>
```

`--expect` 只选该检查可稳定复现的成功片段，不放 token、凭据、用户数据或其他敏感输出。回执只有在 selector 真实命中、命令绑定至少一个仓库输入文件且返回成功时，才能候选为 strong evidence。

`--input` 可重复，至少有一项必须与该 observation 的非工具 file/git 证据相交，确保检查绑定了被证明的仓库内容，而不只是绑定 Validator 自身。不得把手写 `exit_code`、普通 shell 输出摘要或未绑定 claim 的历史回执当作可执行证据。脚本会将 command、输入 hashes、stdout/stderr hashes、退出状态和仓库快照组成执行事实指纹；expect selector 不进入去重指纹。同一执行事实不得跨 observation claim 复用，即使更换 selector、重新执行或更换 receipt 路径也不例外。

Agent 的语义评审是本流程的信任根。脚本能验证路径、定位、Git、hash、快照、claim 与执行事实是否一致，但不能替代对正文含义的判断，也不能证明一个与 Assessment 串通的评审者没有编造 rationale。需要高保证时，应增加独立评审者复核，而不是把静态校验器描述成语义真值机。

## 画像、Finding 与 Action

`repository_profile.class` 只能是 `empty | underbuilt | overbuilt | managed`，必须附 `rationale` 和可核对 signals。画像用于选择建设策略，不参与算分。

Finding 应含严重级别、observation ID、影响范围、直接证据和可复现检查。Action 必须回链 Finding，给出顺序、验收和权限边界；它是规划，不代表已获得修改、归档、删除或外部写入授权。

## 进入点分的门禁

陌生仓首次运行只交付定性 Assessment。后续点分必须同时满足：

1. 使用 `schema_version: 3` 当前脚本模板，Assessment 绑定的仓库 HEAD 与 `worktree_fingerprint` 未在评审期间漂移。
2. 两套量表的 required observations 均已由 Agent 阅读并给出理由、证据和局限。
3. 要输出点分的量表内不存在 `unknown`；有 `unknown` 时只报状态和证据缺口。
4. 所有 Git 与本地 artifact 的路径、commit、hash 和 claim 绑定均通过脚本现场校验。

任一条不满足，`score` 保持 `null`，不以默认分、根据路径猜分或手工填分绕过。
