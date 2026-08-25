# LightVela 文档站内容分类台账

本台账记录文档站各内容项在**国内站**与**国际站**的上线状态，由 `lv-docs` skill 在文档任务前后读写。

## 状态标记规范

每项格式为 `- 【CN <状态> | GLOBAL <状态>】标题`，状态取值：

| 状态 | 含义 |
| --- | --- |
| `✓` | 该区域文档已上线 |
| `待补` | 该区域可以写这篇文档，但尚未上线 |
| `N/A` | 该区域产品不支持此功能，不适用，不应写 |
| `待核实` | 无法从文档配置判断该区域产品是否支持，需向用户确认后再定 |

维护规则：

- 只有文档已完成、对应区域文件齐备（国际站需 `global/` 与 `en/` 都在）、且必要的 sidebar / slug / fumadocs 注册与校验通过后，才可将该区域标为 `✓`。
- 草稿、聊天内文案、未完成工作不得改变状态。
- 清单中没有对应项时，先让用户确认应归属的现有一级分类，文档完成后再新增。
- 判断某项在某区域是否已上线，必须同时查 `<REGION>_SIDEBAR`、`<REGION>_SLUG_TO_FILE` 与 `sync-fumadocs-content.mjs` 的 `cnDocs` / `globalDocs`，三者范围互不一致。

# 入门介绍

- 【CN ✓ | GLOBAL ✓】什么是 LightVela
- 【CN ✓ | GLOBAL ✓】快速开始
- 【CN ✓ | GLOBAL ✓】核心概念
- 【CN ✓ | GLOBAL ✓】LightVela 适合哪些用户？

# 账号、套餐与开通

- 【CN ✓ | GLOBAL N/A】账号与实名认证（国内专属，不进国际站）
- 【CN ✓ | GLOBAL ✓】LightVela 付费版本公告
- 【CN ✓ | GLOBAL ✓】套餐
- 【CN ✓ | GLOBAL ✓】模型积分
- 【CN ✓ | GLOBAL ✓】如何开通第一个 Hermes 实例？

# 功能与配置

- 【CN ✓ | GLOBAL ✓】配置总览
- 【CN ✓ | GLOBAL ✓】配置模型
- 【CN N/A | GLOBAL ✓】Telegram
- 【CN N/A | GLOBAL ✓】WhatsApp
- 【CN N/A | GLOBAL ✓】Discord
- 【CN ✓ | GLOBAL ✓】微信
- 【CN ✓ | GLOBAL ✓】QQ
- 【CN N/A | GLOBAL ✓】企业微信
- 【CN ✓ | GLOBAL ✓】飞书
- 【CN 待核实 | GLOBAL 待核实】Slack（配置不一致：`CN_SLUG_TO_FILE` 有映射但 `CN_SIDEBAR` 与 `cnDocs` 未暴露；`GLOBAL_SIDEBAR` 已暴露但 `GLOBAL_SLUG_TO_FILE` 无映射，需先修配置）
- 【CN ✓ | GLOBAL ✓】配置技能
- 【CN 待核实 | GLOBAL ✓】记忆管理
- 【CN 待核实 | GLOBAL ✓】自动化任务
- 【CN 待核实 | GLOBAL ✓】云存储
- 【CN 待核实 | GLOBAL ✓】聊天
- 【CN 待核实 | GLOBAL ✓】诊断
- 【CN ✓ | GLOBAL ✓】高级设置
- 【CN 待核实 | GLOBAL ✓】模型切换

# Hermes Agent 科普

- 【CN ✓ | GLOBAL ✓】Hermes Agent 与 OpenClaw 有什么不同？
- 【CN ✓ | GLOBAL ✓】Hermes Agent 为什么能“记住你”？拆解长期记忆系统的工作原理
- 【CN ✓ | GLOBAL ✓】为什么 Hermes Agent 要把记忆分成两类？USER.md 与 MEMORY.md 的职责
- 【CN ✓ | GLOBAL ✓】记忆不是越多越好：Hermes Agent 如何筛选、整理和更新长期记忆
- 【CN ✓ | GLOBAL ✓】Memory 不是 Skill：Hermes Agent 的事实记忆与程序性记忆有何不同？
- 【CN ✓ | GLOBAL ✓】Hermes Agent 的“大脑”可以替换吗？模型层与 Agent 层如何分工
- 【CN ✓ | GLOBAL ✓】一个 Agent 如何同时出现在多个聊天软件里？拆解消息网关机制
- 【CN ✓ | GLOBAL ✓】Hermes Agent 如何按时主动找你？拆解自动化调度与定时任务机制
- 【CN ✓ | GLOBAL ✓】切换模型会让 Agent“失忆”吗？模型、人格与记忆的解耦设计
- 【CN ✓ | GLOBAL ✓】Hermes Agent 的性格从哪里来？Persona、用户偏好与长期记忆如何共同作用
- 【CN ✓ | GLOBAL ✓】Hermes Agent 把文件放在哪里？工作目录、上下文文件与存储机制
- 【CN ✓ | GLOBAL ✓】Agent 为什么会越用越顺手？技能沉淀、自我改进与复用机制

# 使用场景

- 【CN 待补 | GLOBAL ✓】如何使用 LightVela 构建个人 AI 助手
- 【CN 待补 | GLOBAL ✓】如何将 AI Agent 接入即时通信平台
- 【CN N/A | GLOBAL ✓】如何在 Telegram 中配置一个具有独立人格的 Hermes Agent
- 【CN N/A | GLOBAL ✓】如何在 WhatsApp 中配置一个具有独立人格的 Hermes Agent
- 【CN 待补 | GLOBAL ✓】如何通过 SOUL.md 设定 IM Agent 的角色、性格与说话方式
- 【CN 待补 | GLOBAL ✓】如何通过 Skill 把 IM Agent 变成客服、社群助手或 AI 伴侣
- 【CN N/A | GLOBAL ✓】如何让一个 Agent 同时接入 Telegram 和 WhatsApp，并保持统一人格与长期记忆
- 【CN N/A | GLOBAL ✓】如何在 Telegram 群组中配置 AI 社群助手：入群欢迎、FAQ、摘要与提醒
- 【CN N/A | GLOBAL ✓】如何在 WhatsApp 中配置 24/7 AI 客服：人格、知识、技能与自动化
- 【CN 待补 | GLOBAL ✓】如何设计更像真人的 IM Agent：对话节奏、群体规范与长期社交记忆
- 【CN N/A | GLOBAL ✓】如何为 Telegram 和 WhatsApp Agent 设计安全边界：授权、群聊规则与敏感操作
- 【CN 待补 | GLOBAL ✓】如何使用 Hermes Agent 创建每日摘要
- 【CN 待补 | GLOBAL ✓】如何让 Hermes Agent 保持 24 小时在线
- 【CN 待补 | GLOBAL ✓】如何使用 Agent 管理长期记忆和个人知识

# 产品对比与选型

- 【CN ✓ | GLOBAL ✓】LightVela 与自托管 Agent 对比
- 【CN ✓ | GLOBAL ✓】LightVela 与 Hostinger 对比
- 【CN ✓ | GLOBAL ✓】LightVela 与 Manus 对比
- 【CN ✓ | GLOBAL ✓】LightVela 与 ChatGPT 对比
- 【CN ✓ | GLOBAL ✓】LightVela 与 Genspark 对比

# 安全、隐私与数据

- 【CN N/A | GLOBAL N/A】安全使用 LightVela（国际站分类与文章已于 2026-08 下线）

# 问题排查

- 【CN ✓ | GLOBAL 待补】常见问题 FAQ

# 支持

- 【CN ✓ | GLOBAL ✓】联系我们（国内站在 `CN_SLUG_TO_FILE` 有映射但 `cnDocs` 未注册，标题/描述可能不生效）
