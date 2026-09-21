# 通用行为评测契约

维护 `context-audit` 时用临时仓库复核下列决策行为。测试只使用仓库文件、Git、本地 Validator/测试和本地回执；不调用模型 API，不把产物写入目标仓库。

## 场景一：陌生布局的成熟仓

- 输入：使用 `CLAUDE.md`、`handbook/`、Backstage Catalog、自有路由器和非 `.agents/` 验证器，目录名与参考拓扑不同。
- 首次必须观察：只输出 discovery 和 `schema_version: 3` 未评分 Assessment；模板绑定 HEAD/`worktree_fingerprint`；两套 `score=null`；不因路径不同扣分。
- Agent 完成后必须观察：现有资产按责任面映射；每维固定 4 个 observations，每个有 subject/rationale/evidence/limitations；才由脚本推导分数。
- 失败信号：用文件名猜权威、因缺 `docs/context/` 直接扣分，或 discovery 阶段就输出数值。

## 场景二：空仓或欠建设仓

- 输入：无 Agent 入口、无控制面、无 Git 历史，或只有零散 README。
- 必须观察：画像为 `empty`/`underbuilt` 且有理由；证据等级 `Unknown/C`；未核对 observation 为 `unknown`；TMR 显示“未评测”或“未通过”。
- 决策边界：先给定性规划，用户确认后才创建 Goal 和修改文件；不创建空目录换分。

## 场景三：过度建设仓

- 输入：默认指令链臃肿、文档重复、多个平行真源、大量无路由内容。
- 必须观察：Agent 通过正文和 Git 判断冲突，画像为 `overbuilt`；对应 observations 为 `partial/fail`；根入口或权威冲突进入 P0/P1。
- 决策边界：先确定真源和迁移影响；没有删除/归档授权只输出清单；Git 提交次数不推断 Owner。

## 场景四：有专用 Validator 的成熟仓

- 输入：短入口、正式知识、Agent 消费接口、控制面、工作流、Validator 和评测隔离均存在。
- 必须观察：Agent 先阅读 Validator 入口并判断无外部副作用；通过 `--record-check --claim --expect` 执行，`--expect` 是非敏感稳定成功片段；Assessment 引用回执绝对路径和 SHA-256。
- 证据边界：回执的 repo/HEAD/`worktree_fingerprint`/claim/命令/输入 hashes/输出 hashes/expect selector 必须校验；同一执行事实指纹即使更换 selector 或 receipt 也不得跨 claim 复用；强证据槽 `pass` 必须有该维度允许的 Validator/Test/Trace/Owner Review；`model_effect` 不参与静态分。
- 结论边界：即使静态分数通过，正文时效、消费 Trace、自动 compact 和模型效果仍按实际证据报告。

## 每次修改后的三轮检查

1. 契约与执行：Skill frontmatter、Assessment 模板/Schema、四类仓型、TMR 的未评测/未通过/通过状态。
2. 证据与评分：Observation 算术、`unknown -> score=null`、P0 门禁、Git path+commit、claim 回执、动态分母、Gold 隔离和行业证据回链。
3. 最终产物：读回本地 Assessment、JSON、Markdown 和 HTML，确认关键字段、敏感信息、本地保留、链接、当前结论和未完成能力。

任一行为不符合，先增加能稳定复现它的静态/契约测试，再修改 Skill 或实现。
