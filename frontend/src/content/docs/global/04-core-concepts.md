# 核心概念

## 摘要

**LightVela 有五个核心概念：Hermes Agent 是云端实例；Bot 是其中的独立配置档案；每个 Bot 可配置模型、消息通道与技能，并拥有自己的人设、记忆和定时任务。同一 Bot 接入的通道共享其行为，不同 Bot 的设置不会自动共享。消息从通道进入后，目标 Bot 可调用技能与模型，再经原通道回复。**

---

LightVela 的五个核心概念是 Hermes Agent、Bot、模型、通道与技能。本页说明它们如何协作。

## 本页覆盖

- 五个概念之间的关系

- Hermes Agent 实例的特性

- 模型、通道、技能各自的定位与配置入口

- 一次完整对话的内部流程

---

## 概念关系

```text
Hermes Agent (cloud instance)
  └─ Bot profiles (main Bot and optional additional Bots)
       ├─ Primary model and optional fallbacks
       ├─ Connected channels
       └─ Skills, Soul, memory, scheduled tasks
```

| 概念 | 角色 | 说明 |
|---|---|---|
| Hermes Agent | 对话主体 | AI Agent 实例本身 |
| Bot | 独立配置档案 | 拥有自己的模型、通道、技能、人设、记忆和定时任务 |
| 模型 | 语言能力 | Hermes Agent 调用的大语言模型 |
| 通道 | 交互入口 | 用户与 Hermes Agent 对话的平台 |
| 技能 | 能力扩展 | Hermes Agent 可调用的附加能力包 |


---

## Hermes Agent

Hermes Agent 是 LightVela 中的 AI Agent 实例，创建一个 Hermes Agent 等同于在云端启动一个独立的 Agent 实例。

Hermes Agent 具有以下特性：

- **专属云端环境**：每个 Hermes Agent 运行在专属环境中，与其他实例资源隔离

- **持续记忆**：对话内容跨会话保存，Agent 响应时会综合历史上下文

- **持续在线**：7×24 小时运行，不依赖用户本地设备

当前启航套餐最多支持创建 1 个 Hermes Agent 实例。

---

## Bot

每个 Hermes Agent 有一个主 Bot，也可能按套餐配额与开放状态创建其他 Bot。多个 Bot 位于同一云端实例，但设置和数据相互独立。修改模型、通道、技能或记忆前先选中目标 Bot。详见[管理 Bots](./configuration/bots.md)。

---

## 模型（Models）

模型指驱动 Hermes Agent 思考与响应的大语言模型（LLM）。LightVela 不自训模型，而是由用户在管理台「模型」卡片中选择调用方式：

| 方式 | 计费模式 | API Key 来源 | 适用场景 |
|---|---|---|---|
| 模型 Coding Plan | 包月 | 服务商 | 高频使用 |
| 模型 API | 按量 | 服务商 | 低频或试用 |
| 自定义模型 | 取决于端点 | 用户自备 | 接入国外模型或 OpenAI 兼容端点 |

此外，启航套餐预置 100 体验积分，无需任何配置即可开箱对话；体验积分耗尽后再配置自有 API Key 也可以。

具体支持的模型列表、API Key 获取方式、选型建议等详见 [配置模型](./configuration/model.md)。

> 每个 Bot 同时使用一个主模型，也可以有其他已配置模型或回退模型；切换生效模型无需删除先前配置。详见[模型切换](./configuration/multiple-models.md)。

---

## 通道（Channels）

通道指用户与 Hermes Agent 进行对话的聊天平台入口。LightVela 当前支持以下通道：

| 通道 | 接入方式 | 适用场景 |
|---|---|---|
| WeChat | 扫码自动绑定 | 日常个人使用，适合国内用户 |
| Telegram | Bot Token 接入 | 个人或团队消息场景，配置简单，适合轻量自动化 |
| WhatsApp | WhatsApp 手机扫码授权 | 海外用户沟通、客户服务、通知提醒等场景 |
| Discord | Bot Token 接入 | 社群运营、开发者社区、游戏/兴趣群组互动 |
| Slack | Bot Token / App Token 接入 | 团队协作、工作区通知、频道内任务流转 |

在 **Channels** 的 **WeChat** 卡片点击 **+ Connect**，再用手机扫描二维码。

各通道的详细接入步骤见 [配置通道 - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md)。

> 💡 **多通道并存**
>
> 接入同一 Bot 的多个通道共享该 Bot 的人设与记忆；不同 Bot 的设置不会自动共享。

---

## 技能（Skills）

技能是 Hermes Agent 可调用的附加能力包，在基础对话之外扩展 Hermes Agent 处理具体任务的能力，例如自动整理待办、生成日报、浏览网页、图像生成等。

国际站的技能来自 [Skills.sh](https://skills.sh/) 与 [ClawHub](https://clawhub.ai/)。在管理台的 **Skills** 页面浏览来源，安装前先核对技能说明。

在管理台进入 **Skills**，搜索单个技能或浏览 **Skill Packages**，点击**安装**后到 **Installed** 核对结果。详见[配置技能](./configuration/skill.md)。

> ⚠️ **安装前的安全确认**
>
> 技能运行时具有调用 Hermes Agent 能力的权限，安装前请确认技能作者可信，优先选择下载量高、评价良好的技能。

---

## 交互流程

一次完整对话的内部流程如下：

1. 用户通过通道（如 WeChat）发送消息给 Hermes Agent

2. Hermes Agent 根据消息内容判断是否需要调用技能

3. 调用模型处理上下文并生成响应

4. 响应通过原通道返回至用户

---

## 下一步

- [配置总览](./05-configuration.md) — 管理台完整功能说明

- [快速开始](./02-quickstart.md) — 未创建 Hermes Agent 时的入门流程
