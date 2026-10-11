# 配置总览

## 摘要

**Agent 管理台侧栏分为「日常」与「探索」：「日常」包含对话、通道、技能与定时任务；模型、人设、记忆及诊断等设置在「探索」。修改配置前应先选中目标 Bot；在通道卡片接入聊天平台，配置模型或使用套餐积分，再按需安装来自 Skills.sh 或 ClawHub 的技能。人设、持久记忆、诊断中心与高级设置位于「探索」，云端存储从用户菜单进入。Bot 在线且有可用套餐模型积分或已配置模型时，可先在「日常 → 对话」直接聊天，无需先接入外部通道。**

---

Agent 管理台通过侧边栏的**日常**与**探索**分区组织对话与配置。先选择要配置的 Bot，再打开对应页面。本页说明入口与结果验证。

## 本页覆盖

- 进入管理台的方式

- Bot 切换与当前 Bot 信息

- Channels、Models、Skills 和 Cloud Storage 的入口

- 完成配置后的成功状态

- 管理 Bot、切换模型、接入多个通道等常用操作

---

## 进入管理台

登录后打开 [Agent 管理台](/agents/)，选择要配置的 Hermes Agent 与 Bot。

网页「对话」在「日常」中，外部通道可稍后按需接入。
---

## Bot 切换与当前 Bot 信息

桌面端使用左侧 Bot 头像列；窄屏使用顶部切换条。点击另一个头像即可切换，当前选中项会高亮。每个 Bot 都有独立的 Profile 与配置；套餐决定可创建的 Bot 总数，主 Bot 也计入数量。

- **首次创建**：先选外观、填写名字，点击「创建」，完成配置后点击「开始旅程」。
- **再次创建**：在头像列或切换条点击「新建 Bot」，默认空白创建；复制已有设置使用「高级 → 创建方式」或「管理 Bot → 复制 Bot」。
- **修改资料**：选中目标 Bot，打开「管理 Bot → 修改资料」。
- **换装**：点击当前 Bot 的头像，依次选颜色、形状与配饰；保存更新，关闭可退出未保存的编辑。

创建与继承规则详见[管理 Bots](./configuration/bots.md)。

![国际站中文 Bot 管理菜单、头像列与日常侧栏](../images/bots-switching-overview.webp)

> ⚠️ **删除为不可逆操作**
>
> 删除其他 Bot 会永久删除该 Bot 的 Profile 和数据；删除主 Bot 会删除整个 Hermes Agent 及其全部相关数据，并且必须先删除其他 Bot。

---

## 配置通道、模型与技能

### 通道（Channels）

在侧栏进入**日常 → 通道**。页面分别展示 Telegram、WhatsApp、Discord、Slack、WeChat、QQ、WeCom 和 Lark 卡片；在目标通道上点击 **+ 连接** 并按指南操作。WhatsApp、WeChat、WeCom、Lark 使用扫码授权；Telegram、Discord、Slack 使用凭据；QQ 可扫码或使用 App ID / Secret。扫码示例见 [WhatsApp 指南](./configuration/channel-whatsapp.md)。

### 模型（Models）

进入**探索 → 模型**查看当前模型或配置服务商。使用套餐模型积分无需填写自己的 API Key；需要时可以新增服务商。每个 Bot 同时使用一个主模型，也可能配置回退模型。详见[配置模型](./configuration/model.md)和[模型切换](./configuration/multiple-models.md)。

### 技能（Skills）

进入**日常 → 技能**搜索单个技能，或浏览来自 [Skills.sh](https://skills.sh/) 与 [ClawHub](https://clawhub.ai/) 的 **Skill Packages**。点击 **Install** 后在 **Installed** 中确认。详见[配置技能](./configuration/skill.md)。

## 配置完成的状态

最小可用状态是：选中正确的 Bot，Bot 在线，模型积分可用或已配置模型，并且网页「日常 → 对话」发送消息后能收到回复。

- **外部通道可选**：需要聊天软件时，先在通道页完成连接，再从相应平台发送测试消息。
- **技能可选**：按任务需要安装，在已安装列表中确认。
- **定时任务可选**：设置完成后核对执行时间、通知去向与实际结果。

外部通道尚未连接不影响网页对话；仅连接通道也不能替代 Bot 在线与可用模型这两个条件。

---

## 常用操作

- **切换模型**：选中目标 Bot 后进入**探索 → 模型**，选择已配置且可用的模型。Bot 记忆会保留；详见[模型切换](./configuration/multiple-models.md)。
- **接入多个通道**：在**日常 → 通道**中逐一点击目标卡片的 **+ 连接**。属于同一 Bot 的通道共享该 Bot 的人设与记忆。
- **管理 Bot**：修改配置前选中目标 Bot 头像；新建入口可用时，按[管理 Bots](./configuration/bots.md)中的复制与删除规则操作。
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
