---
name: context-audit
description: Use when 需要评测或建设任意代码仓库的上下文工程与文档系统，包括空仓、欠建设、过度建设和成熟仓。
---

# Repository Context Audit & Build

由 Agent 理解仓库语义并主审，脚本只负责发现候选、记录可复现证据、校验 Assessment 契约和确定性算分。先只读评测，再由用户决定是否建设。

本 Skill 按职责映射仓库现有组织方式。`AGENTS.md`、`CLAUDE.md`、其他 Agent 指令、CODEOWNERS、Backstage/自有 Catalog、内部文档站映射、现有 Validator 和测试都可作为候选实现；是否承担相应职责必须由 Agent 读取内容、范围、权威关系和 Git 来判断。

默认不调用模型 API、不运行真实效果实验。已有模型实验只能作独立效果证据，不改变本 Skill 的静态评分。

## 首次只读评测

首次进入陌生仓库只输出 Repository Assessment，不输出数值分。当前 Assessment 使用 `schema_version: 3`，每维 4 个 required observations；按以下次序执行：

1. 保护 dirty worktree；读取仓库指令和构建入口，用 `rg --files`、Git 只读命令和审计脚本的 discovery 输出收集候选文件。用 `--write-template <local-assessment.json>` 生成与当前 HEAD 和 `worktree_fingerprint` 绑定的本地模板。
2. 读取 [assessment-contract.md](references/assessment-contract.md)，建立仓库自身的服务边界、指令链、正式知识、Owner、Catalog、Agent 派生层、路由、工作流、生命周期、评测隔离和验证入口映射。
3. 对每个映射读正文并记录「选它的理由」「未决冲突」「证据」「能与不能证明」；无法判断时标 `unknown`，不从路径名推断语义。
   文件证据必须定位到可复核的行区间、标题或结构化键，不能只写一个文件名后把整份文件重复解释为所有结论。
4. Git 证据必须为具体 `path + 最新包含完整文件的 commit`；记录提交前用 `git log --follow` 和 `git show` 核对。Owner 以 CODEOWNERS、Catalog、团队制度或负责人确认为准，不由提交次数推断。
5. 专用 Validator/测试只是有范围的证据。执行前 Agent 先检查命令不含发布、生产、云资源或其他外部副作用，再强制通过审计包装器执行：

   ```bash
   python3 .agents/skills/context-audit/scripts/audit_context.py \
     --repo . \
     --record-check <local-receipt.json> \
     --claim <observation-id> \
     --input <repository-relative-subject-evidence> \
     --expect '<stable-nonsensitive-output-fragment>' \
     -- <validator-or-test-command>
   ```

   `--input` 可重复，至少包含一份该 observation 的非审计工具 file/git 证据；检查不能只读取并证明自己的 Validator 脚本。`--expect` 必须是该检查成功时会稳定输出、且不含敏感信息的片段。Assessment 必须引用回执的绝对路径与 SHA-256，不得自报 `exit_code`。回执只写到仓库外本地目录或已忽略路径。同一 command、输入 hash、输出 hash、退出状态与仓库快照组成的执行事实指纹只能支持一个 claim；`--expect` 负责断言结果，但不参与指纹去重，不能靠更换 selector、receipt 路径或 claim 名重复复用。
6. 为 `repository_profile`、维度 rationale、每个 observation 的 `status/subject/rationale/limitations` 写明判断，将 Assessment JSON 保存到仓库外本地目录或已忽略路径。维度 level、分数和证据等级由脚本根据实际证据组合推导，不由 Assessment 自报。
7. 向用户报告仓库画像、observation 状态（`pass/partial/fail/unknown`）、P0/P1/P2、证据空白和建设建议。

完成首次语义 Assessment 后，再进入“可评分性检查”。必须先满足 [rubric.md](references/rubric.md) 的点分门禁，才能让脚本从已核验 observations 推导维度等级并算分；否则只报告状态与证据覆盖，不伪造精确数字。

## 评分边界

必须完整阅读 [rubric.md](references/rubric.md)。两套量表不得相加、平均或互相代替；P0 不能被其他高分抵消。Agent 只提交 `pass/partial/fail/unknown` observation 及理由、对象、证据和局限；脚本按量表规则推导等级和分数。强证据槽 `pass` 必须有该维度允许的 Validator/Test/Trace/Owner Review；`model_effect` 仅作效果附录，不计静态分。脚本不得自动决定：

- 哪个目录是正式知识或 Agent 派生层；
- 某个文件是否权威、完整、有效或被实际消费；
- 谁是 Owner，哪些服务构成真实分母；
- 一个 Validator 通过能否覆盖整个维度。

23 条规则是通用原则参考，用于对照责任和风险；评分分母由 Assessment 模板的 required observations 确定。

## 用户确认后建设

用户明确选择建设后：

1. 创建 Goal，把首次 Assessment、P0/P1、三轮建设和最终门禁写入 Objective。
2. 阅读 [remediation-playbook.md](references/remediation-playbook.md)，按仓库画像选策略。
3. 每轮按“Assessment 更新 → 证据 → 规划 → 建设 → Git/回执验证 → 重新评审”执行：
   - Round 1：盘点、分类、去噪、Owner 和服务入口；
   - Round 2：正式知识、Agent 派生层、权威、路由、生命周期和评测隔离；
   - Round 3：压缩默认入口、治理重复/过期内容、补可执行证据和最终 TMR。
4. 每轮保护 dirty worktree。删除、归档、commit、push、MR、发布、生产或外部写入仍需相应授权。

## 目录与文件标准

建设前按需阅读：

- [repository-structure.md](references/repository-structure.md)：六类职责和可选的参考拓扑；
- [document-contracts.md](references/document-contracts.md)：各类文件应回答什么；
- [23-rules.md](references/23-rules.md)：23 条原则的理由、最低证据和适用边界；
- [industry-evidence.md](references/industry-evidence.md)：公开行业来源与可外推边界。

优先映射和复用现有体系，不复制第二套真源。小仓库只建真实需要的责任面；空目录和空模板不计为证据。

## 结果与检查

默认命令只输出不超过 80 行的 Markdown 摘要，避免把发现清单塞进 Agent 上下文。需要完整 JSON 时必须明确写到仓库外本地文件：

```bash
python3 .agents/skills/context-audit/scripts/audit_context.py \
  --repo . \
  --format json \
  --output <local-assessment-result.json>
```

按 [report-contract.md](references/report-contract.md) 输出本地 JSON、Markdown 或单文件 HTML TMR。报告必须区分候选发现、Agent 判断、Git 来源、Validator/测试回执、消费证据和独立模型效果。

完成前检查：

1. 契约与行为：Skill frontmatter、Assessment Schema、陌生布局、空仓、欠建设、过度建设和成熟仓。
2. 证据与评分：语义映射、Git path+commit、回执 hash、P0/P1、动态分母、评测隔离和算术。
3. 产物与表述：读回 Assessment/JSON/Markdown/HTML，检查敏感信息、本地保留、证据标签、链接、未完成能力和结论边界。

维护本 Skill 时使用 [behavioral-evaluation.md](references/behavioral-evaluation.md) 进行静态行为复核；这些不是模型效果实验。
