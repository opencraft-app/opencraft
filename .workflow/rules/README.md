# .workflow/rules/ — 项目规则目录

> 本目录存放项目级的 AI 编码规则与约束。
> AI 在动手前会按 `.workflow/project.yaml` 的 `context_loading.P1` 协议加载本目录下的规则文件。

---

## 一、目录用途

`.workflow/rules/` 是项目向 AI 表达"硬约束"的地方。所有以 `.md` 结尾的文件都会被 AI 视为项目级铁律。

不同类型的规则建议拆分文件：

```
.workflow/rules/
├── README.md              ← 本说明文件（AI 不需要加载，会自动跳过）
├── global.md              ← P0 短铁律（默认加载）
├── context-budget.md      ← P0 / AGENTS.md / 按需上下文预算规则
├── context-recovery.md    ← runtime summary / handoff / verification ledger
├── agent-dispatch.md      ← 调查型 sub-agent / 增量验证上下文预算
├── flow-cost.md           ← S/M/L 流程强度、review/archive 降本策略与模型分流（成本与模型分层）
├── terminal-output.md     ← 长终端输出治理规则
├── team-state.md          ← 多人 / 多 Agent 文件归属与共享状态边界
├── workflow-strict.md     ← 严格流程 / 进度沟通 / 路径 / 未归档细则（按需）
├── workflow-reporting.md  ← 用量审计 / JSON 鲁棒性（按需）
├── code-style.md          ← 代码风格（项目按需新增）
├── component-rules.md     ← 组件设计约束（项目按需新增）
├── styling-rules.md       ← 样式约束（项目按需新增）
├── data-flow.md           ← 数据流与状态管理约束（项目按需新增）
└── ...                    ← 按需新增
```

---

## 二、什么时候新增规则文件

满足以下任一条件就值得新增一个规则文件：

1. **AI 反复犯同一类错** —— 把"AI 会忘记"的事情写进规则
2. **团队约定与社区主流做法不同** —— 写下来防止 AI 套用通用最佳实践
3. **项目特有的技术约束** —— 比如"必须用某 UI 框架"、"必须走某网关"

---

## 三、能力提供的规则（v0.9.0+）

启用 `feai cap enable <id>` 后，capability 会自动向本目录追加专属规则文件。
当前版本支持的能力：

| Capability ID | 提供的规则文件 | 说明 |
|---|---|---|
| `figma-fidelity` | `figma-fidelity.md` | Figma 还原保真规则（数值精确、视觉回验、零编造） |
| `e2e-playwright` | `e2e-rules.md` | E2E 分工规则（Planner 写场景、implementation 实现、Reviewer 验证） |

> 通过 `feai cap disable <id>` 可以反向移除对应规则文件。
> capability 提供的规则文件**禁止手动重命名**，否则 disable 时无法识别。

---

## 四、规则编写建议

### 4.1 用 ID 化标号

每条规则给一个唯一 ID（例如 `CS1` / `F1` / `G1`），便于在代码评审、commit 消息、bug 单中引用：

```markdown
## CS1：单引号

所有 JS/TS 代码必须使用单引号，禁止双引号（除非字符串内含单引号）。
```

### 4.2 给反例

只写"应该怎么做"还不够，AI 容易凭直觉走偏。**给反例**最有效：

```markdown
✅ 正确：
const name = '张三';

❌ 错误：
const name = "张三";
```

### 4.3 标记优先级

如果规则之间存在冲突，明确标注哪条优先：

```markdown
> 本规则优先级高于一切"合理推测"——设计稿有的就用设计稿的，设计稿没有的不许编造。
```

---

## 五、与 AGENTS.md 的关系

- `AGENTS.md`：项目层面的 AI 角色定义、整体工作流、对话风格
- `.workflow/rules/*.md`：项目层面的硬约束、技术细节、可复用规则
- 二者都会被 AI 加载，但 `rules/` 通常是"细则"，`AGENTS.md` 是"宪法"

如果规则发生冲突，`AGENTS.md` 中的核心铁律 > `rules/` 中的项目规则。
