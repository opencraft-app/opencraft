---
description: Launch the product-ai PRD intake flow with /prd-start
argument-hint: "[PRODUCT=lightvela|lighthouse|generic] <需求描述|TAPD链接|Issue链接|会议纪要>"
---

Start the product-ai PRD intake flow.

Read and follow the `start-prd` skill defined below, then route to the appropriate product-line PRD skill in this repository.

Input:

$ARGUMENTS

When `PRODUCT` is provided, use it as the product-line hint. Otherwise choose the target PRD skill from the input and current repository context.

---

## Start PRD — 路由规则

按用户输入选择一个目标 Skill：

| 场景 | 目标 Skill |
| --- | --- |
| 明确提到 LightVela、Hermes、OpenClaw、SkillHub、MCP、Agent 控制台，或没有明确产品线但在 LightVela/mono2 上下文中 | `.agents/skills/product-skills/prd-creator/SKILL.md` |
| 明确提到 Lighthouse | 使用通用产品需求流程，参考 `.agents/skills/product-skills/prd-creator/SKILL.md` 并将产品线替换为 Lighthouse |
| 明确要求通用产品需求，不绑定具体产品线 | `.agents/skills/product-skills/prd-creator/SKILL.md`（去掉 LightVela 专属约束） |

如果产品线不清楚，优先按 LightVela 处理，但在需求澄清摘要里标记这是默认假设。

## 执行步骤

1. 读取目标 Skill 的完整 `SKILL.md`。
2. 按目标 Skill 的流程执行，不复制或改写目标 Skill 的规则。
3. 先输出需求澄清摘要，再产出 PRD 草稿或产品输入稿。
4. 如果涉及 TAPD，先输出 TAPD 写入计划；只有用户明确确认后，才创建或更新 TAPD。
5. 产品侧只创建或更新产品父需求，不创建前端、后端、QA 或研发子需求。
6. 输出研发交接建议时，清楚区分产品结论、默认假设、待确认问题和工程后续建议。

## 输出约定

默认输出：

- 需求澄清摘要
- PRD 草稿或产品输入稿
- 如需要，产品原型说明
- 如需要，TAPD 写入计划
- 研发交接建议

如果用户只给了很短的输入，先问一个会改变范围的关键问题；如果用户要求继续出稿，可以按默认假设继续，并在产物中标明假设。
