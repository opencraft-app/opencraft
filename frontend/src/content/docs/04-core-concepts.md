# 核心概念

## 摘要

**LightVela 的使用涉及五个核心概念：Hermes Agent 是云端运行环境，一个实例可承载多个用途不同的 Bot；每个 Bot 可管理自己的模型、记忆、技能和通道设置。模型负责生成响应；通道是微信、QQ、企业微信、飞书、钉钉等聊天入口；技能从国内站 SkillHub 安装，用于扩展具体任务能力。一次对话由目标 Bot 接收消息、按需调用技能和模型，再经原通道返回。**

---

本页说明 Hermes Agent、Bot、模型、通道与技能的关系。具体操作见相应配置指南。

## 本页覆盖

- 五者之间的概念关系

- Hermes Agent 实例的特性

- Bot、模型、通道、技能各自的定位与配置入口

- 一次完整对话的内部流程

---

## 概念关系

```text
Hermes Agent（云端运行环境）
└── Bot（主 Bot 或其他 Bot）
    ├── 模型：生成响应
    ├── 通道：微信 / QQ / 企业微信 / 飞书 / 钉钉
    └── 技能：从 SkillHub 安装的任务能力
```

| 概念 | 角色 | 说明 |
|---|---|---|
| Hermes Agent | 云端环境 | 托管 Bot 和运行资源的实例 |
| Bot | 专用助手 | 在同一个实例内按用途分别管理设置 |
| 模型 | 语言能力 | 当前 Bot 调用的大语言模型 |
| 通道 | 交互入口 | 用户与目标 Bot 对话的平台 |
| 技能 | 能力扩展 | 目标 Bot 可调用的附加能力包 |

![](./images/20260424-114253-e6d5.webp)

---

## Hermes Agent

Hermes Agent 是 LightVela 中的 AI Agent 实例，创建一个 Hermes Agent 等同于在云端启动一个独立的 Agent 实例。

Hermes Agent 具有以下特性：

- **专属云端环境**：每个 Hermes Agent 运行在专属环境中，与其他实例资源隔离

- **持续记忆**：对话内容跨会话保存，Agent 响应时会综合历史上下文

- **持续在线**：7×24 小时运行，不依赖用户本地设备

套餐提供云端 Agent 运行环境；同一个实例可以承载多个用途不同的 Bot。当前订阅页展示的 Bot 数为启航系列最多 5 个、巡游系列最多 10 个，实际创建还取决于账号权益和多 Bot 功能开放状态。操作见[管理与切换 Bot](./configuration/bots-switching.md)。

## Bot

Bot 是同一个云端 Agent 环境里可切换的专用助手。你可以给不同 Bot 配置各自的记忆、技能、人设、定时任务和聊天通道；空白创建与复制已有 Bot 的继承范围不同，不能把“有多个 Bot”理解成所有设置自动共享。当前网页对话只支持主 Bot，其他 Bot 需通过各自已连接的聊天通道验证。具体创建、切换和继承规则见[管理与切换 Bot](./configuration/bots-switching.md)。

---

## 模型（Models）

模型指驱动 Hermes Agent 思考与响应的大语言模型（LLM）。LightVela 不自训模型，而是由用户在管理台「模型」卡片中选择调用方式：

| 方式 | 计费模式 | API Key 来源 | 适用场景 |
|---|---|---|---|
| 模型 Coding Plan | 包月 | 服务商 | 高频使用 |
| 模型 API | 按量 | 服务商 | 低频或试用 |
| 自定义模型 | 取决于端点 | 用户自备 | 接入国外模型或 OpenAI 兼容端点 |

此外，套餐会按月发放模型积分，无需任何配置即可开箱对话；积分额度因套餐而异，耗尽后再配置自有 API Key 也可以。

具体支持的模型列表、API Key 获取方式、选型建议等详见 [配置模型](./configuration/model.md)。

> ⚠️ **单模型生效**
>
> 一个 Agent 可以保存多个可用模型配置，但同一时间只有一个模型生效。切换方式见[模型切换](./configuration/multiple-models.md)。

---

## 通道（Channels）

通道指用户与 Hermes Agent 进行对话的聊天平台入口。LightVela 国内站当前支持五个通道：

| 通道 | 接入方式 | 适用场景 |
|---|---|---|
| 微信 | 扫码授权连接 | 日常个人使用 |
| QQ | 扫码，或填写 App ID / Secret | 需要一定配置能力的场景 |
| 企业微信 | 扫码授权连接 | 企业内部协作场景 |
| 飞书 | 扫码授权连接 | 办公场景，支持富文本消息 |
| 钉钉 | 扫码，或填写 Client ID / Secret | 企业办公与协作场景 |

微信、企业微信与飞书选择通道后点击「连接」生成二维码，使用手机扫码完成授权即可；QQ 与钉钉除扫码外，也可在对应开放平台创建应用后，把获得的凭证（QQ 为 App ID / Secret，钉钉为 Client ID / Secret）填回 LightVela。

各通道的详细接入步骤见 [微信](./configuration/channel-wechat.md) / [QQ](./configuration/channel-qq.md) / [企业微信](./configuration/channel-wecom.md) / [飞书](./configuration/channel-feishu.md) / [钉钉](./configuration/channel-dingtalk.md)。

> 💡 **多通道并存**
>
> 多个通道可同时接入同一个 Hermes Agent 实例，共享记忆与 Agent 行为。无论从哪个通道发送消息，对话对象均为同一 Hermes Agent。

---

## 技能（Skills）

技能是 Hermes Agent 可调用的附加能力包，在基础对话之外扩展 Hermes Agent 处理具体任务的能力，例如自动整理待办、生成日报、浏览网页、图像生成等。

所有技能均来自 [SkillHub](https://skillhub.tencent.com)——腾讯推出的独立技能市场。在 SkillHub 可以浏览已上架的技能，查看其功能说明与使用示例。

在管理台「3. 技能 (Skills)」卡片中输入 SkillHub 上记录的技能名称，点击「安装技能」即可完成安装；也可以直接通过对话让 Hermes Agent 代为安装或删除。详见 [配置技能](./configuration/skill.md)。

> ⚠️ **安装前的安全确认**
>
> 技能运行时具有调用 Hermes Agent 能力的权限，安装前请确认技能作者可信，优先选择下载量高、评价良好的技能。

---

## 交互流程

一次完整对话的内部流程如下：

1. 用户通过通道（如微信）发送消息给 Hermes Agent

2. Hermes Agent 根据消息内容判断是否需要调用技能

3. 调用模型处理上下文并生成响应

4. 响应通过原通道返回至用户

---

## 下一步

- [配置总览](./05-configuration.md) — 管理台完整功能说明

- [快速开始](./02-quickstart.md) — 未创建 Hermes Agent 时的入门流程
