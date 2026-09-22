# 配置总览

## 摘要

**LightVela 的所有配置集中在「我的 Hermes」管理台，登录后点击右上角进入。管理台顶部是当前 Hermes Agent 下的 Bot 页签，下方由三个配置按键组成：模型（选择模型 Coding Plan 包月、模型 API 按量或自定义 OpenAI 兼容端点）、通道（各聊天平台的接入入口，部分扫码授权、部分需填 Token 或 AppID）、技能（安装可复用的能力扩展包）。除三项基础配置外，管理台还提供对话、定时任务、记忆管理、云存储、模型切换与诊断中心。三项配置完成后 Bot 即可在已接入的聊天通道中对话。**

---

LightVela 的所有配置集中在「我的 Hermes」管理台中，由三个配置按键组成：

1. 模型（Models）

2. 通道（Channels）

3. 技能（Skills）

本页介绍管理台的整体结构与各按键的功能，各模块的详细操作请参见对应子页。

## 本页覆盖

- 进入管理台的方式

- Bot 切换与当前 Bot 信息

- 三个配置按键的功能与配置入口

- 完成配置后的成功状态

- 管理 Bot、切换模型、接入多个通道等常用操作

---

## 进入管理台

登录后，点击页面右上角「我的 Hermes」进入管理台。顶部提供「返回首页」按钮。

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

## 三个配置按键

三个按键自左向右排列，建议按 1 → 2 → 3 的顺序配置。

### 1. 通道（Channels）

![](./images/4-2.webp)

**用途**：将 Hermes Agent 接入聊天平台，为用户提供对话入口。

**各通道接入方式**：

| 通道 | 接入方式 | 所需条件 |
|---|---|---|
| WeChat | 扫码授权 | 一台装有微信的手机 |
| Telegram | Bot Token 接入 | 通过 BotFather 创建 Telegram Bot，并获取 Bot Token |
| WhatsApp | WhatsApp Business API 接入 | 需要 Meta 开发者账号、WhatsApp Business Account，并完成 Cloud API 基础配置 |
| Discord | Bot Token 接入 | 在 Discord Developer Portal 创建 Application，添加 Bot，并邀请到服务器 |
| Slack | Bot Token / App Token 接入 | 创建 Slack App，开启 Socket Mode，并获取 Bot/App Token |
| QQ | AppID / AppSecret 接入 | 一个 QQ 账号；在 QQ 开放平台创建机器人并获取 AppID / AppSecret |
| 企业微信（WeCom） | 扫码授权 | 一台装有企业微信的手机 |
| 飞书（Lark） | 扫码授权 | 一台装有飞书的手机或已登录飞书的桌面端 |

**按键提供**：通道下拉、「授权接入」按钮、所选通道的介绍与「查看详情」链接、「已接入通道」列表。

详细操作请参见 [配置通道 - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md) / [QQ](./configuration/channel-qq.md) / [企业微信](./configuration/channel-wecom.md) / [飞书](./configuration/channel-feishu.md)。

---

### 2. 模型（Models）

![](./images/4-1.webp)

**用途**：为 Hermes Agent 配置大语言模型。启航套餐预置 100 体验积分，也可跳过此步骤直接使用，待积分耗尽后再配置。

**按键提供**：来源下拉（模型 Coding Plan / 模型 API / 自定义模型）、具体模型下拉、API Key 输入框、服务商介绍与获取 API Key 的外链、「当前模型」列表。

> ⚠️ **单模型生效**
>
> 当前版本每个 Hermes Agent 仅支持配置并生效一个模型，新的「添加为默认」将覆盖原有配置。

详细操作请参见 [配置模型](./configuration/model.md)。

---

### 3. 技能（Skills）

![](./images/4-3.webp)

**用途**：扩展 Hermes Agent 的能力，例如整理待办、生成日报、联网搜索等。

**按键提供**：技能名称搜索框、「安装技能」按钮、「前往 SkillHub」外链、「已安装技能」列表。安装前需先在 [SkillHub](https://skillhub.tencent.com) 确定目标技能的准确名称。

> ⚠️ **仅安装可信来源的技能**
>
> 技能运行时具有调用 Hermes Agent 能力的权限，请只安装可信来源的技能。

详细操作请参见 [配置技能](./configuration/skill.md)。

---

## 配置完成的状态

完成配置后，管理台应呈现以下状态：

- 「已接入通道」至少有一条记录（如「微信」）

- 「当前模型」可选配置；若使用启航积分则无需配置

- 「已安装技能」按需配置，可为空

满足「已接入通道」这一条件即可在对应聊天平台中查找机器人并发起对话，Hermes Agent 将通过默认模型或启航积分生成回复。

---

## 常用操作

### 切换模型

在「模型」按键重新选择来源与模型，填入 API Key 并点击「添加为默认」，新的配置将覆盖原有记录。切换模型不会影响对话记忆。

### 接入多个通道

在「通道」按键依次切换下拉选项并点击「授权接入」。接入同一个 Bot 的多个通道共享该 Bot 的记忆与行为。

### 管理多个 Bot

使用顶部页签切换 Bot。新建入口可用时，可以复制当前 Bot、复制主 Bot，或选择 Basic setup。继承与删除规则详见[管理 Bots](./configuration/bots.md)。

---

## 下一步

各模块的详细配置：

- [管理 Bots](./configuration/bots.md) — 创建、复制、切换、重命名和删除 Bot

- [配置模型](./configuration/model.md) — 模型来源、API Key 获取、选型建议

- [配置通道 - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md) / [QQ](./configuration/channel-qq.md) / [企业微信](./configuration/channel-wecom.md) / [飞书](./configuration/channel-feishu.md)

- [配置技能](./configuration/skill.md) — SkillHub 使用与技能安装

相关参考：

- [核心概念](./04-core-concepts.md)

- [快速开始](./02-quickstart.md)
