

## 摘要

**Memory 和 Skill 都是长期记忆，但性质完全不同：Memory 是"陈述性记忆"（Declarative Memory），存事实、事件、结论、偏好，形态是短句/条目，被 query 命中就召回（`MEMORY.md` + `memories/`）；Skill 是"程序性记忆"（Procedural Memory），存"遇到 X 场景该怎么做"的 SOP，形态是带触发条件的 YAML + 流程，场景匹配时高优先级装载（`skills/` 目录 + `SKILL.md`）。两者不能合并的三条硬约束是：触发方式不同（query 命中 vs 场景匹配）、表达形式不同（条目 vs 步骤流程）、演化速度不同（Memory 每天变、Skill 几个月不动）。一个"两条腿走路"的 Agent，才既懂你、又有方法。**

---

## 引子：为什么这两个概念老被搞混

如果说 Hermes Agent 有一个特别容易被误解的设计，那大概就是它把 **Memory** 和 **Skill** 明确分成了两件事。

很多人的第一反应是三个疑问：

- **"这俩不都是长期记忆吗？为什么要分？"**
- **"都是 Markdown，直接塞一起不行吗？"**
- **"我记住'agent-demo 前端使用本地开发端口'和记住'写 PR 描述时先总结再列变更'，本质上不是一回事吗？"**

答案很短：**因为人脑本来就分。**

---

## 一、认知心理学里就分好了：陈述性 vs 程序性

心理学早就区分过两类长期记忆：

| 类型 | 定义 | 例子 | 调用方式 |
|---|---|---|---|
| **陈述性记忆**（Declarative） | 可以说出来的事实 | "我住在北京"、"React 18 引入了并发渲染" | 被**讲**出来 |
| **程序性记忆**（Procedural） | 会做但未必说得清楚的技能 | 骑自行车、盲打、写一封结构合理的 PR 描述 | 被**执行**出来 |

这两类记忆的**存储方式、调用方式、更新方式都不同**：陈述性记忆可以被"讲出来"（言语通道），程序性记忆更多是被"执行出来"（动作通道）。心理学实验里，海马体损伤的病人陈述性记忆严重受损，但程序性记忆（比如镜面书写）依然可以学会——**这是两条独立的通路，不是一条通路的两种表现**。

Hermes Agent 直接把这个区分搬进了系统设计：

- **Memory（`memories/`、`MEMORY.md`）**：Agent 的陈述性记忆。
- **Skill（`skills/`）**：Agent 的程序性记忆。

---

## 二、Memory：Agent 会"讲"的东西

Memory 系统里存的是**事实、事件、结论、偏好**：

- "Jasmin 在做 agent-demo 项目的国际站。"
- "上周把 hero 区改成了动态渐变。"
- "该项目跑在 Next.js 上，前端 dev server 使用本地开发端口。"

它的特点：

- **陈述性**：以短句、条目形式存在，能直接被引用进 prompt。
- **按需召回**：Agent 遇到相关话题时，由 FTS5 命中把匹配的条目拉进来。
- **易变**：新条目会追加，旧条目会被 `replace` 或 `remove`。

**你可以把 Memory 想成 Agent 的"笔记本"**——桌上摊开的一本，写满了具体的事。

---

## 三、Skill：Agent 会"做"的事

Skill 存的是**做某类事的标准流程**。Hermes 里一个典型 Skill 通常是一份 `SKILL.md`，头部带 YAML frontmatter 声明触发条件与配套工具集：

```yaml
---
name: pr-description-format
trigger:
  when: "user asks to write a PR description"
fallback_for_toolsets: [git, code-review]
---

# 写 PR 描述的标准流程

1. 一句话总结变更目标
2. 变更点清单（按模块）
3. 影响范围
4. 测试情况
5. 关联 issue / rollback plan
```

它的特点：

- **程序性**：以"何时触发 + 怎么做"的形式存在，接近一段可复用的 SOP。
- **按场景触发**：Agent 识别到匹配场景时，Skill 会被**自动装载成高优先级 prompt**，指导本次行动。
- **相对稳定**：Skill 一旦沉淀，通常长期不变；变的是 Memory 里绑定它的场景与素材。

**你可以把 Skill 想成 Agent 的"肌肉记忆"**——不用去"回忆"，动作就出来了。

Hermes 用户还可以通过 `/learn` 命令让 Agent 把当前会话里"值得沉淀成 Skill 的一段流程"提炼成新的 `SKILL.md`——就像师傅口传给徒弟。

---

## 四、"为什么不合成一份？"—— 三条硬约束

有人会想："都是 Markdown，都是长期记忆，直接塞一起不行吗？"

不行，理由和《为什么 Hermes Agent 要把记忆分成两类？USER.md 与 MEMORY.md 的职责》里 `USER.md` / `MEMORY.md` 不能合并的三条约束类似，但更强一些：

### 理由 1：触发方式不同

- Memory 是"**被 query 命中就召回**"（FTS5 + 语义摘要）。
- Skill 是"**被场景匹配就装载**"，通常带触发条件（`trigger.when: "user asks to write a PR description"`）。

合并之后，Agent 会分不清"是要引用一条事实"还是"是要按照一段流程去做"。

### 理由 2：表达形式不同

- Memory 是**短句、事实、条目**（"[2026-07-30] agent-demo 前端本地开发端口"）。
- Skill 是**流程、模板、约束**，往往包含 YAML frontmatter + "步骤 1 / 2 / 3"这类顺序结构。

塞在一起，Agent 无法判断"这段话是背景，还是我此刻要照着执行"。

### 理由 3：演化速度不同

- **Memory 每天都在变**（一次会话可能追加 1-2 条）。
- **Skill 一旦定型可能几个月不动**（一份 PR 描述格式的 SOP，写好了半年也没必要改）。

放在一起会让"稳定的 SOP"被高频变化的事实条目冲刷掉——就像把宪法和日历表订在同一本子上。

---

## 五、一个真实场景：`/learn` + Memory 一起用

假设你和 Agent 说：

> "以后我们团队写 PR 描述都按这个格式：一句话总结、变更点、影响范围、测试情况。另外你要记住，这次的项目叫 agent-demo，前端使用本地开发端口。"

一个训练良好的 Hermes Agent 应该这样处理：

- **前半句** → 走 `/learn` 分支，写入一个新的 **Skill**：`pr-description-format.md`，触发条件是 `user asks to write a PR description`。
- **后半句** → 走 `add` 原子操作，写入一条 **Memory**：`- [2026-07-30] agent-demo 项目：前端 dev server 使用本地开发端口`。

下次你说"帮我写个 PR 描述"，Agent 会：

1. **场景匹配 Skill**：装载 `pr-description-format.md` 到高优先级 prompt。
2. **query 命中 Memory**：知道当前项目叫 agent-demo，使用本地开发端口。
3. **二者结合**：输出一个既符合团队规范、又贴合具体项目的 PR 描述。

**"记住事实" + "记住流程" 一起用，效果才会 1 + 1 > 2。**

---

## 六、Skill Bundle 与 fallback_for_toolsets

Hermes 还给 Skill 加了两层组织能力：

- **Skill Bundle**：把相关 Skill 打包成一组，比如"发布流水线"这个 bundle 里可能有 `pre-release-checklist`、`changelog-format`、`deploy-rollback` 三份 Skill，可以整体启用/停用/分享。
- **`fallback_for_toolsets`**：Skill 可以声明"当调用某个工具集失败时兜底"。例如 `git` 工具集报错时，触发一份"手动 rebase 修复步骤"的 Skill。

这两个能力让 Skill 从"单点 SOP"变成"可组合的工作方法论"——**用户带给 Agent 的一整套工作方式**，都能沉淀成可分享的资产。

---

## 七、这不是新概念，但很少被真正落地

事实记忆 + 程序性记忆的分层，其实 AI 圈很早就在谈。但真正在工程上做出来，并且让**用户可以看到、可以编辑、可以复用**，Hermes 是走得比较靠前的一个——它把每一层都对应到了具体的目录、字段、命令：

| 能力 | Memory 系 | Skill 系 |
|---|---|---|
| 主存目录 | `~/.hermes/memories/` | `~/.hermes/skills/` |
| 提示层入口 | `MEMORY.md`、`USER.md` | 场景匹配后按需装载 `SKILL.md` |
| 沉淀命令 | `add / replace / remove`（Agent 自动 + `/memory pending` 审批） | `/learn`（Agent 自动 + `/skills pending` 审批） |
| 组织形式 | 条目 + FTS5 全文索引 | 单份 SOP + Bundle + `fallback_for_toolsets` |
| 演化节奏 | 每天变 | 几个月不动 |

如果我们把这个分层带到产品语境，就会得到一个非常有想象力的形态：

- **Memory 是"你和 Agent 的共同档案"**。
- **Skill 是"你带给 Agent 的工作方法论"**。

这两样东西加起来，Agent 才真正成为一个"**懂你 + 有方法**"的搭档，而不是一个记性还行的聊天机器人。

---

## 八、LightVela：把 Memory 和 Skill 都做成"用户资产"

Hermes 已经把 Memory / Skill 分层做到了工程可用，但它仍然是**给开发者的 Markdown**。LightVela 的思路，是把这一层从"技术特性"抬升为"用户资产"：

- **个人 Skill 库**：用户可以像收藏 prompt 一样收藏、编辑、分享自己的 Skill（工作流），并绑定触发场景。你的写作套路、评审 SOP、翻译规范，都可以变成 Skill。
- **个人 Memory 库**：Agent 关于你的一切事实性记忆都对你透明，可以查看、修正、删除，无需去改 `~/.hermes/MEMORY.md`。
- **团队级复用**：Skill 和 Memory 都支持团队维度沉淀——新人一进团队，就自动拥有团队的"共同记忆"和"共同方法"，而不需要靠口口相传。
- **最短路径**：如果你被"两条腿走路"这套模型打动，但不想自己去搞 Ollama、SSH、systemd、`~/.hermes/` 备份，LightVela 是把这套模型直接产品化后端给你的最短路径。

也就是说，你在 LightVela 上"训练一个 Agent"，本质上是在**同时积累两份资产**：一份是关于你的 Memory，一份是你的 Skill 集合。**这两份资产才是长期属于你的东西，比模型本身更重要。**

---

## 小结

- Memory ≠ Skill。前者是**陈述性记忆**（能被讲出来的事实），后者是**程序性记忆**（会做的方法）。
- 分开设计的三条硬约束：**触发方式不同 / 表达形式不同 / 演化速度不同**。
- 一个成熟的 Agent 一定要"两条腿走路"——记事实，也记方法。
- LightVela 把这两类都做成用户资产，让"训练自己的 Agent"从一句口号变成能长期积累的产品体验。

---

## 结语

下一代 Agent 的护城河，不在模型有多大，而在它是否真的"**认识你**"（Memory），并且"**有方法**"（Skill）——而这两者能不能长期稳定跑起来，最终归结为它是不是**一直活着**。这正是 LightVela 存在的意义。

