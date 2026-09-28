# 配置总览

## 摘要

**「我的 Hermes」管理台按使用、成长和管理等任务组织能力；首次使用先确认模型可用，再接入通道并发送测试消息。** 技能、人设、记忆和定时任务可按需逐步配置。具体入口可能随套餐、权限与功能开放状态变化，请以当前管理台展示为准。

## 从哪里开始

1. 进入「我的 Hermes」，选择要配置的 Bot。
2. 检查套餐内模型积分，或在[配置模型](./configuration/model.md)中添加自有模型；需要比较多个模型时参见[模型切换](./configuration/multiple-models.md)。
3. 在[配置通道](#连接聊天通道)中接入一个聊天软件，发送测试消息。
4. 需要进一步扩展能力时，再安装技能、设置人设或定时任务。

## 连接聊天通道

国内站文档覆盖五个接入入口。不同通道的授权要求以相应指南和管理台提示为准：

| 通道 | 基础接入方式 | 指南 |
|---|---|---|
| 微信 | 扫码授权 | [配置微信](./configuration/channel-wechat.md) |
| QQ | 扫码或 App ID / Secret | [配置 QQ](./configuration/channel-qq.md) |
| 企业微信 | 扫码授权 | [配置企业微信](./configuration/channel-wecom.md) |
| 飞书 | 扫码授权 | [配置飞书](./configuration/channel-feishu.md) |
| 钉钉 | 扫码或 Client ID / Secret | [配置钉钉](./configuration/channel-dingtalk.md) |

多个通道可以连接到同一个 Agent。连接成功后，先在目标聊天软件中发送简短消息验证。

## 管理台功能地图

| 使用目的 | 文档入口 |
|---|---|
| 设置模型或切换当前模型 | [配置模型](./configuration/model.md)、[模型切换](./configuration/multiple-models.md) |
| 扩展任务能力 | [配置技能](./configuration/skill.md) |
| 在网页中对话 | [对话](./configuration/agent-chat.md) |
| 定时执行与通知 | [定时任务](./configuration/automation.md) |
| 调整角色和长期上下文 | [人设](./configuration/personality.md)、[记忆管理](./configuration/memory.md) |
| 管理文件 | [云存储](./configuration/files.md) |
| 排查异常 | [诊断中心](./configuration/diagnostics.md) |
| 调整高级选项 | [高级设置](./configuration/advanced-settings.md) |
| 切换 Bot | [Bot 切换](./configuration/bots-switching.md) |
| 使用实验功能 | [DeepSeek Harness](./configuration/deepseek-harness.md)、[工作台](./configuration/workbench.md) |

模型入口在不同套餐下可能显示在侧栏「使用」分组或左下角账号菜单中。实验功能及新增 Bot 的可用性受账户、套餐和功能开放状态限制。

## 没有收到回复

先确认通道已连接、模型积分或自有模型额度可用，再用简单文本消息重试。仍无法回复时，到[诊断中心](./configuration/diagnostics.md)查看近期日志；常见问题也可在 [FAQ](./07-faq.md) 中查找。
