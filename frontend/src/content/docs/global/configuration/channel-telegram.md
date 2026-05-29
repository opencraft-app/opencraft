# 配置通道 - Telegram

Telegram 通道采用 Bot Token 接入方式，适合快速将 Hermes 接入 Telegram 私聊或群组场景。

## 本页覆盖

- 使用手机 Telegram 扫码或打开链接授权

- 在 Telegram 中与 Hermes 进行对话


> 💡 **准备工作**
>
> -   一台装有 Telegram 的手机
>
> -   完成 [模型配置](./model.md)（或使用启航套餐预置的 100 体验积分）
>

---

## 操作步骤

### 1. 进入管理台

登录 LightVela，点击右上角「我的 Hermes」进入管理台，找到「通道」按键。

### 2. 选择 Telegram 通道

找到 Telegram 模块，点击「+连接」。

### 3. 打开「Telegram」

1. 打开你的 Telegram 应用

2. 搜索 @BotFather 并打开聊天窗

<img src="../images/telegram-botfather-2-global.jpg" alt="" width="360" />

3. 输入 `/start`

4. 输入 `/newbot`

5. 输入你的 agent 的名字：名字需独特，并结尾为 "bot"

6. 拷贝 HTTP API：

![](../images/telegram-botfather-3-global.jpg)

### 4. 复制 HTTP API 进「Telegram」

将 HTTP API Token 粘贴到 token 栏位中。

<img src="../images/telegram-botfather-4-global.png" alt="" width="360" />

> ⚠️ **请妥善保管你的 token**
>
> 请将 token 安全存储。任何获得该 token 的人都可以用它来控制你的机器人！

### 5. 与 Telegram 里新的机器人聊天

点击 BotFather 提供的链接，现在你就可以开始与它互动了。

![](../images/telegram-botfather-5-global.jpg)

进入该机器人的聊天界面，发送测试消息：

```
你好
```

几秒内收到 Hermes 回复。

<img src="../images/telegram-botfather-6-global.jpg" alt="" width="360" />

---

## 成功状态

- 管理台「已接入通道」列表中出现"Telegram"

- Telegram 联系人中可查找到对应机器人

- 发送消息后能收到 Hermes 回复


---

## 支持的消息类型

接入成功后，Telegram 机器人除了能够接收、回复基础文本信息外，还支持更多消息类型，详情如下：

| Telegram 机器人支持的消息类型 | 是否支持 |
|---|---|
| 接收文本信息 | ✅ 已支持 |
| 接收图片、视频 | ✅ 已支持 |
| 接收文件 | ✅ 已支持 |
| 回复文本信息 | ✅ 已支持 |
| 回复图片、视频 | ✅ 已支持 |
| 回复文件 | ✅ 已支持 |
| 主动发送消息（如定时发送提醒） | ✅ 已支持 |

> ℹ️ **实际处理能力取决于模型**
>
> 上表仅代表 Telegram 机器人在消息通道层面支持接收、回复的类型。能否实际完成处理图片、文件等任务，还取决于 Hermes 所接入的大语言模型是否具备对应的处理能力。

---

## 常见问题

| 现象 | 可能原因 | 处理方式 |
|---|---|---|
| BotFather 无法创建机器人 | 机器人名称或 username 不符合 Telegram 要求 | 确认机器人显示名称可自由填写，但 username 必须以 bot 结尾，例如 my_hermes_bot |
| BotFather 未返回 HTTP API Token | 创建流程未完成 | 回到 BotFather 对话，重新执行 `/newbot` 并按提示完成名称和 username 设置 |
| 粘贴 Token 后提示无效 | Token 复制不完整，或包含多余空格/换行 | 重新从 BotFather 复制完整 HTTP API Token，并粘贴到 token 栏位 |
| 点击接入后无响应 | 网络延迟或授权未完成 | 刷新管理台页面确认状态；若未接入成功则重新操作 |
| Telegram 中找不到机器人 | 未点击 BotFather 提供的机器人链接，或未开始对话 | 点击 BotFather 提供的链接，进入机器人页面后点击 Start |
| 发送消息后无回复 | 模型未配置、体验积分耗尽，或机器人尚未成功接入 | 检查「1. 模型」卡片的「当前模型」状态，并确认 Telegram 通道显示为已接入 |
| 机器人无法接收群消息 | Telegram 群组隐私模式限制 | 在 BotFather 中检查 Bot Settings，必要时关闭 Group Privacy，或在群内 @ 机器人发送消息 |
| 如何解除绑定 | — | 在「已接入通道」列表中删除该 Telegram 记录 |
| 同一个 Telegram Bot 能否接入多个 Hermes | 通常不建议，一个 Bot Token 应绑定一个 Hermes | 如需多个 Hermes，建议分别创建不同的 Telegram Bot |

---

## 通道说明

- **消息类型**：支持文本、图片、视频、文件、语音等多种类型，详见上方「支持的消息类型」

- **群聊支持**：当前不支持群聊，仅支持 1 对 1 对话

- **连接中断**：长时间无响应可能为授权被撤销，回管理台重新授权接入即可

---

## 下一步

- [配置通道 - WhatsApp](./configuration/channel-whatsapp.md) — 国际用户沟通、客户服务与通知提醒场景

- [配置通道 - Discord](./configuration/channel-discord.md) — 社群运营、开发者社区与兴趣群组互动

- [配置技能](./configuration/skill.md) — 扩展 Hermes 能力
