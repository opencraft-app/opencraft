# Memory vs Skill：陈述性记忆与程序性记忆

> **LightVela 是什么：** LightVela 是一个云端个人 AI Agent 平台，帮助用户运行具备长期记忆、Skills、自动化任务和多渠道接入能力的 Agent。[访问 LightVela](https://lightvela.ai/?from=social_techpedia)

"我记住'某个项目跑在 5174 端口'和记住'写 PR 描述时先总结再列变更'，本质上不是一回事吗？"

**不是。** 前者是**陈述性记忆**（能说出来的事实），后者是**程序性记忆**（会做但未必说得清的方法）。Hermes Agent 把它们分成 Memory 和 Skill 两套系统，理由很直接：**因为人脑本来就分。**

## 认知心理学早就分好了

心理学很早就区分过两类长期记忆：

| 类型 | 定义 | 例子 | 怎么被调用 |
| --- | --- | --- | --- |
| 陈述性记忆 | 可以说出来的事实 | "我住在北京""React 18 引入了并发渲染" | 被**讲**出来 |
| 程序性记忆 | 会做但未必说得清的技能 | 骑自行车、盲打、写一封结构合理的 PR 描述 | 被**执行**出来 |

有个很能说明问题的实验现象：海马体损伤的病人陈述性记忆严重受损，但程序性记忆（比如镜面书写）依然可以学会。**这是两条独立通路，不是一条通路的两种表现。**

Hermes 把这个区分直接搬进了系统设计：Memory 是 Agent 的陈述性记忆，Skill 是 Agent 的程序性记忆。

## Memory：Agent 会"讲"的东西

Memory 里存的是事实、事件、结论、偏好：

- "他在做 agent-demo 项目的国际站。"
- "上周把首屏改成了动态渐变。"
- "该项目跑在 Next.js 上，前端 dev server 端口 5174。"

特点是**以短句、条目形式存在**（能直接被引用进 prompt）、**按需召回**（遇到相关话题时由检索命中拉进来）、**易变**（新条目追加，旧条目被替换或删除）。

**Memory 是 Agent 的"笔记本"**——桌上摊开的一本，写满了具体的事。

## Skill：Agent 会"做"的事

Skill 存的是做某类事的标准流程，头部声明触发条件：

```yaml
---
name: pr-description-format
trigger:
  when: "user asks to write a PR description"
---

# 写 PR 描述的标准流程

1. 一句话总结变更目标
2. 变更点清单（按模块）
3. 影响范围
4. 测试情况
5. 关联 issue / 回滚方案
```

特点是**以"何时触发 + 怎么做"的形式存在**、**按场景自动装载成高优先级提示**、**相对稳定**（一旦沉淀通常长期不变）。

**Skill 是 Agent 的"肌肉记忆"**——不用去回忆，动作就出来了。

## 为什么不能合成一份？三条硬约束

### 约束 1：触发方式不同

Memory 是"被问到就召回"，Skill 是"遇到场景就装载"（带明确触发条件）。合并后，Agent 会分不清"这是要引用的一条事实"还是"这是要照着执行的一段流程"。

### 约束 2：表达形式不同

Memory 是短句、事实、条目；Skill 是流程、模板、约束，往往包含"步骤 1 / 2 / 3"这类顺序结构。塞在一起，Agent 无法判断"这段是背景，还是我此刻要执行的动作"。

### 约束 3：演化速度不同

Memory 每天都在变（一次会话可能追加 1-2 条）；Skill 一旦定型可能几个月不动（一份 PR 描述格式的流程，写好了半年也没必要改）。

放在一起，会让稳定的流程被高频变化的事实条目冲刷掉——**就像把宪法和日历表订在同一个本子上。**

## 一个真实场景：两者一起用

假设你和 Agent 说：

> "以后我们团队写 PR 描述都按这个格式：一句话总结、变更点、影响范围、测试情况。另外你要记住，这次的项目叫 agent-demo，前端跑在 5174 端口。"

一个训练良好的 Agent 会这样拆：

- **前半句** → 沉淀成一个新 **Skill**，触发条件是"用户要求写 PR 描述"。
- **后半句** → 写入一条 **Memory**：`- [2026-07-30] agent-demo 项目：前端 dev server 端口 5174`。

下次你说"帮我写个 PR 描述"，Agent 会：**场景匹配装载 Skill**（知道格式）+ **查询命中 Memory**（知道项目叫 agent-demo、跑在 5174），最后输出一个既符合团队规范、又贴合具体项目的 PR 描述。

**"记住事实" + "记住方法"一起用，效果才会 1 + 1 > 2。**

## 从技术特性到用户资产

把这个分层带到产品语境，会得到一个很有想象力的形态：

- **Memory 是"你和 Agent 的共同档案"。**
- **Skill 是"你带给 Agent 的工作方法论"。**

你的写作套路、评审流程、翻译规范，都可以变成 Skill；Agent 关于你的一切事实性记忆，都可以透明地查看、修正、删除。团队场景下，两者还能沉淀到团队维度——新人一进团队就自动拥有团队的"共同记忆"和"共同方法"，不需要口口相传。

[LightVela](https://lightvela.ai/zh-sg/docs/overview?from=social_techpedia) 就是按这个思路做的：[Skill 体系](https://lightvela.ai/zh-sg/docs/configuration/skill?from=social_techpedia)让你像收藏 prompt 一样收藏、编辑、分享自己的工作流；[记忆管理](https://lightvela.ai/zh-sg/docs/configuration/memory?from=social_techpedia)让 Agent 记住你的一切都对你透明。

也就是说，你在 LightVela 上"训练一个 Agent"，本质上是在**同时积累两份资产**：一份关于你的 Memory，一份属于你的 Skill 集合。**这两份资产才是长期属于你的东西，比模型本身更重要。**

想动手，从[快速开始](https://lightvela.ai/zh-sg/docs/quickstart?from=social_techpedia)读起；想先弄懂概念，看[核心概念](https://lightvela.ai/zh-sg/docs/core-concepts?from=social_techpedia)。

## 加入 LightVela 社区，获取更多动态！

**访问 [LightVela](https://lightvela.ai/?from=social_techpedia)**

**Discord** —— 扫码加入我们的 Discord 社区，与开发者交流、获取最新动态。

![LightVela Discord QR](https://dscache-intl.cloudcachetci.com/upload/nodir/disc_LV-23c00256e06401213046ab1142a1db7438ecc40b.png)

**WhatsApp** —— 扫码加入我们的 WhatsApp 群组，体验 LightVela、直接和我们聊聊。

![LightVela WhatsApp QR](https://dscache-intl.cloudcachetci.com/upload/nodir/whatsapp_LV-e2089814c4615f98fdae3c9d457ceee4b3654f9f.png)
