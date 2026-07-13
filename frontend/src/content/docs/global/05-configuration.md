# 配置总览

LightVela 的所有配置集中在「我的 Hermes」管理台中，由三个配置按键组成：

1. 模型（Models）

2. 通道（Channels）

3. 技能（Skills）

本页介绍管理台的整体结构与各按键的功能，各模块的详细操作请参见对应子页。

## 本页覆盖

- 进入管理台的方式

- Hermes 实例信息按键

- 三个配置按键的功能与配置入口

- 完成配置后的成功状态

- 切换模型、接入多个通道、重建 Hermes 等常用操作

---

## 进入管理台

登录后，点击页面右上角「我的 Hermes」进入管理台。顶部提供「返回首页」按钮。

---

## Hermes 实例信息

管理台顶部为 Hermes 切换页签，每个页签代表一个 Hermes 实例（启航套餐仅支持 1 个），右侧「+ 创建」按钮在达到实例上限后不可用。

选中某个 Hermes 后，下方显示其基本信息：

- 头像

- 名字（点击名字或铅笔图标可修改，按 Enter 保存）

- 状态（● 运行中 / ● 未知）

- 创建时间

- 删除按钮（右侧垃圾桶图标）

> ⚠️ **删除为不可逆操作**
>
> 点击垃圾桶将永久删除该 Hermes 实例，包括所有对话记忆、已接入通道与已安装技能。启航套餐删除后若仍在配额内可重新创建。

---

## 三个配置按键

三个按键自左向右排列，建议按 1 → 2 → 3 的顺序配置。

### 1. 通道（Channels）

![](./images/4-2.webp)

**用途**：将 Hermes 接入聊天平台，为用户提供对话入口。

**各通道接入方式**：

| 通道 | 接入方式 | 所需条件 |
|---|---|---|
| Telegram | Bot Token 接入 | 通过 BotFather 创建 Telegram Bot，并获取 Bot Token |
| WhatsApp | WhatsApp Business API 接入 | 需要 Meta 开发者账号、WhatsApp Business Account，并完成 Cloud API 基础配置 |
| Discord | Bot Token 接入 | 在 Discord Developer Portal 创建 Application，添加 Bot，并邀请到服务器 |
| WeChat | 扫码授权 | 一台装有微信的手机 |
| QQ | AppID / AppSecret 接入 | 一个 QQ 账号；在 QQ 开放平台创建机器人并获取 AppID / AppSecret |
| 企业微信（WeCom） | 扫码授权 | 一台装有企业微信的手机 |
| 飞书（Lark） | 扫码授权 | 一台装有飞书的手机或已登录飞书的桌面端 |

**按键提供**：通道下拉、「授权接入」按钮、所选通道的介绍与「查看详情」链接、「已接入通道」列表。

详细操作请参见 [配置通道 - Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [WeChat](./configuration/channel-wechat.md) / [QQ](./configuration/channel-qq.md) / [企业微信](./configuration/channel-wecom.md) / [飞书](./configuration/channel-feishu.md)。

---

### 2. 模型（Models）

![](./images/4-1.webp)

**用途**：为 Hermes 配置大语言模型。启航套餐预置 100 体验积分，也可跳过此步骤直接使用，待积分耗尽后再配置。

**按键提供**：来源下拉（模型 Coding Plan / 模型 API / 自定义模型）、具体模型下拉、API Key 输入框、服务商介绍与获取 API Key 的外链、「当前模型」列表。

> ⚠️ **单模型生效**
>
> 当前版本每个 Hermes 仅支持配置并生效一个模型，新的「添加为默认」将覆盖原有配置。

详细操作请参见 [配置模型](./configuration/model.md)。

---

### 3. 技能（Skills）

![](./images/4-3.webp)

**用途**：扩展 Hermes 的能力，例如整理待办、生成日报、联网搜索等。

**按键提供**：技能名称搜索框、「安装技能」按钮、「前往 SkillHub」外链、「已安装技能」列表。安装前需先在 [SkillHub](https://skillhub.tencent.com) 确定目标技能的准确名称。

> ⚠️ **仅安装可信来源的技能**
>
> 技能运行时具有调用 Hermes 能力的权限，请只安装可信来源的技能。

详细操作请参见 [配置技能](./configuration/skill.md)。

---

## 配置完成的状态

完成配置后，管理台应呈现以下状态：

- 「已接入通道」至少有一条记录（如「微信」）

- 「当前模型」可选配置；若使用启航积分则无需配置

- 「已安装技能」按需配置，可为空

满足「已接入通道」这一条件即可在对应聊天平台中查找机器人并发起对话，Hermes 将通过默认模型或启航积分生成回复。

---

## 常用操作

### 切换模型

在「模型」按键重新选择来源与模型，填入 API Key 并点击「添加为默认」，新的配置将覆盖原有记录。切换模型不会影响对话记忆。

### 接入多个通道

在「通道」按键依次切换下拉选项并点击「授权接入」。多个通道指向同一 Hermes，共享记忆与 Agent 行为。

### 重建 Hermes

点击基本信息按键右侧的垃圾桶删除当前 Hermes，再点击「+ 创建 Hermes」重新创建。**所有对话记忆将丢失**。

---

## 下一步

各模块的详细配置：

- [配置模型](./configuration/model.md) — 模型来源、API Key 获取、选型建议

- [配置通道 - Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [WeChat](./configuration/channel-wechat.md) / [QQ](./configuration/channel-qq.md) / [企业微信](./configuration/channel-wecom.md) / [飞书](./configuration/channel-feishu.md)

- [配置技能](./configuration/skill.md) — SkillHub 使用与技能安装

相关参考：

- [核心概念](./04-core-concepts.md)

- [快速开始](./02-quickstart.md)
