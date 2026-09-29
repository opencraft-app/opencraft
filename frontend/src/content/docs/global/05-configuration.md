# 配置总览

## 摘要

**Agent 管理台在侧边栏分别提供 Channels、Models、Skills 和 Scheduled Tasks 页面。修改配置前应先选中目标 Bot；在通道卡片接入聊天平台，配置模型或使用套餐积分，再按需安装来自 Skills.sh 或 ClawHub 的技能。Soul、Memory、Diagnostics、Advanced Settings 和 Labs 分别位于其他分区；Cloud Storage 从用户菜单进入。**

---

Agent 管理台通过侧边栏的 **Channels**、**Models**、**Skills** 和 **Scheduled Tasks** 页面组织常用配置。先选择要配置的 Bot，再打开对应页面。本页说明入口与结果验证。

## 本页覆盖

- 进入管理台的方式

- Bot 切换与当前 Bot 信息

- Channels、Models、Skills 和 Cloud Storage 的入口

- 完成配置后的成功状态

- 管理 Bot、切换模型、接入多个通道等常用操作

---

## 进入管理台

登录后打开 [Agent 管理台](/agents/overview/)，选择要配置的 Hermes Agent 与 Bot。

---

## Bot 切换与当前 Bot 信息

管理台顶部为当前 Hermes Agent 下的 Bot 页签。第一个页签是主 Bot，其他页签分别对应独立的 Bot Profile。套餐决定可创建的 Bot 总数，主 Bot 也计入数量。国际站分阶段开放期间，新建入口默认不显示。创建方式与继承规则详见[管理 Bots](./configuration/bots.md)。

选中某个 Bot 后，下方显示其基本信息：

- 头像

- 名字（点击名字或铅笔图标可修改，按 Enter 保存）

- 状态（● 运行中 / ● 未知）

- 创建时间

- 删除按钮（右侧垃圾桶图标）

> ⚠️ **删除为不可逆操作**
>
> 删除其他 Bot 会永久删除该 Bot 的 Profile 和数据；删除主 Bot 会删除整个 Hermes Agent 及其全部相关数据，并且必须先删除其他 Bot。

---

## 配置通道、模型与技能

### 通道（Channels）

在 Agent 侧边栏进入 **Channels**。页面分别展示 Telegram、WhatsApp、Discord、Slack、WeChat、QQ、WeCom 和 Lark 卡片；在目标通道上点击 **+ Connect** 并按指南操作。WhatsApp、WeChat、WeCom、Lark 使用扫码授权；Telegram、Discord、Slack 使用凭据；QQ 可扫码或使用 App ID / Secret。扫码示例见 [WhatsApp 指南](./configuration/channel-whatsapp.md)。

### 模型（Models）

进入 **Models** 查看当前模型或配置服务商。使用套餐模型积分无需填写自己的 API Key；需要时可以新增服务商。每个 Bot 同时使用一个主模型，也可能配置回退模型。详见[配置模型](./configuration/model.md)和[模型切换](./configuration/multiple-models.md)。

### 技能（Skills）

进入 **Skills** 搜索单个技能，或浏览来自 [Skills.sh](https://skills.sh/) 与 [ClawHub](https://clawhub.ai/) 的 **Skill Packages**。点击 **Install** 后在 **Installed** 中确认。详见[配置技能](./configuration/skill.md)。

## 配置完成的状态

完成配置后，管理台应呈现以下状态：

- 「已接入通道」至少有一条记录（如「微信」）

- 「当前模型」可选配置；若使用启航积分则无需配置

- 「已安装技能」按需配置，可为空

满足「已接入通道」这一条件即可在对应聊天平台中查找机器人并发起对话，Hermes Agent 将通过默认模型或启航积分生成回复。

---

## 常用操作

- **切换模型**：选中目标 Bot 后进入 **Models**，选择已配置且可用的模型。Bot 记忆会保留；详见[模型切换](./configuration/multiple-models.md)。
- **接入多个通道**：在 **Channels** 中逐一点击目标卡片的 **+ Connect**。属于同一 Bot 的通道共享该 Bot 的人设与记忆。
- **管理 Bot**：修改配置前选中 Bot 页签；新建入口可用时，按[管理 Bots](./configuration/bots.md)中的复制与删除规则操作。
- **打开云存储**：从用户菜单进入 **Cloud Storage**，而不是在 Agent 侧边栏中寻找。

---

## 下一步

各模块的详细配置：

- [管理 Bots](./configuration/bots.md) — 创建、复制、切换、重命名和删除 Bot

- [配置模型](./configuration/model.md) — 模型来源、API Key 获取、选型建议

- [配置通道 - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md) / [QQ](./configuration/channel-qq.md) / [企业微信](./configuration/channel-wecom.md) / [飞书](./configuration/channel-feishu.md)

- [配置技能](./configuration/skill.md) — Skills.sh / ClawHub 使用与技能安装

相关参考：

- [核心概念](./04-core-concepts.md)

- [快速开始](./02-quickstart.md)
