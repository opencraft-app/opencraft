# 配置通道 - Discord

Discord 通道采用 Bot 授权接入方式，适合将 Hermes 接入 Discord 服务器，在频道中提供问答、助手或社区互动能力。

## 本页覆盖

- 使用 Discord 打开邀请链接并完成授权

- 在 Discord 服务器或频道中与 Hermes 进行对话


> 💡 **准备工作**
>
> -   一个可登录 Discord 的账号
>
> -   一个可添加机器人的 Discord 服务器
>
> -   完成 [模型配置](./model.md)（或使用启航套餐预置的 100 体验积分）
>

---

## 操作步骤

### 1. 进入管理台

登录 LightVela，点击右上角「我的 Hermes」进入管理台，找到「通道」按键。

### 2. 选择 Discord 通道

找到 Discord 模块，点击「+连接」。

### 3. 打开 Discord 并前往 Developer Portal

选择你想加机器人的服务器，前往 [Developer Portal](https://discord.com/developers/home)：

1. 点击 Applications

![](../images/discord-1-global.png)

2. 点击右上角的 New Applications

3. 给你的 Application 起名

4. 为你的应用程序添加一个机器人，并生成一个机器人令牌。该令牌将用于验证 Hermes 与您的 Discord 服务器之间的连接。

![](../images/discord-2-global.png)

5. 把 Token 复制入 Discord 模块里。

![](../images/discord-3-global.png)

### 4. 前往 Developer Portal 里的 Bot 页面

在 Bot 页面下滑至 Privileged Gateway Intents，开启：

- **Message Content Intent**：必选，用于读取消息内容

- **Server Members Intent**：推荐，用于角色列表和名称匹配 ID

- **Presence Intent**：可选，仅用于状态更新

![](../images/discord-4-global.png)

勾选后，点击下方 Save Changes 保存。

### 5. 前往 Developer Portal 里的 OAuth2 页面

配置 Bot 权限：点击页面左侧 OAuth2，进入后选择 OAuth2 URL Generator。先配置 Scopes，建议按最小权限原则，优先勾选 `bot` 和 `applications.commands`。

![](../images/discord-5-global.png)

继续向下滑动配置 Bot Permissions，勾选：

- View Channels

- Send Messages

- Read Message History

- Embed Links

- Attach Files

- Add Reactions（可选）

![](../images/discord-6-global.png)

### 6. 复制并粘贴邀请链接

复制生成的 Invite Link，在浏览器中打开，并将 Bot 邀请到你的 Discord 服务器（需要服务器管理员权限）。点击 Continue 完成授权后，即可邀请 Bot 加入服务器。

![](../images/discord-7-global.png)

### 7. 与 Discord 里新的机器人聊天

现在你就可以开始与它互动了。进入该机器人的聊天界面，发送测试消息：

```
你好
```

![](../images/discord-chat-global.png)

几秒内收到 Hermes 回复。

---

## 成功状态

- 管理台「已接入通道」列表中出现"Discord"

- Discord 联系人中可查找到对应机器人

- 发送消息后能收到 Hermes 回复


---

## 支持的消息类型

接入成功后，Discord 机器人除了能够接收、回复基础文本信息外，还支持更多消息类型，详情如下：

| Discord 机器人支持的消息类型 | 是否支持 |
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
> 上表仅代表 Discord 机器人在消息通道层面支持接收、回复的类型。能否实际完成处理图片、文件等任务，还取决于 Hermes 所接入的大语言模型是否具备对应的处理能力。

---

## 常见问题

| 现象 | 可能原因 | 处理方式 |
|---|---|---|
| 无法创建 Discord Bot | 未进入 Discord Developer Portal，或应用创建流程未完成 | 进入 Discord Developer Portal，创建 Application 后再添加 Bot |
| 找不到 Bot Token | Token 未生成或未复制完整 | 在 Bot 页面点击 Reset Token / Copy Token，复制完整 Token 后粘贴到 token 栏位 |
| 粘贴 Token 后提示无效 | Token 复制不完整，或包含多余空格/换行 | 重新复制完整 Bot Token，并确认没有多余空格 |
| 无法邀请机器人到服务器 | OAuth2 URL 配置错误，或当前账号没有服务器管理权限 | 在 OAuth2 URL Generator 中勾选 bot 权限，并确认你拥有该服务器的管理权限 |
| 邀请后服务器中看不到机器人 | 邀请未完成，或机器人未上线 | 重新打开邀请链接确认授权成功；刷新 Discord 服务器成员列表 |
| 发送消息后无回复 | 模型未配置、体验积分耗尽，或 Discord 通道尚未成功接入 | 检查「1. 模型」卡片的「当前模型」状态，并确认 Discord 通道显示为已接入 |
| 机器人无法读取消息内容 | Message Content Intent 未开启 | 在 Discord Developer Portal 的 Bot 设置中开启 Message Content Intent |
| 机器人在频道中无权限回复 | 频道权限不足 | 确认机器人拥有查看频道、发送消息、读取消息历史等权限 |
| 机器人无法接收私信 | 私信权限或用户隐私设置限制 | 确认机器人允许接收私信，并检查用户的 Discord 隐私设置 |
| 如何解除绑定 | — | 在「已接入通道」列表中删除该 Discord 记录 |
| 同一个 Discord Bot 能否接入多个 Hermes | 通常不建议，一个 Bot Token 应绑定一个 Hermes | 如需多个 Hermes，建议分别创建不同的 Discord Bot |

---

## 通道说明

- **消息类型**：支持文本、图片、视频、文件、语音等多种类型，详见上方「支持的消息类型」

- **群聊支持**：当前不支持群聊，仅支持 1 对 1 对话

- **连接中断**：长时间无响应可能为授权被撤销，回管理台重新授权接入即可

---

## 下一步

- [配置技能](./configuration/skill.md) — 扩展 Hermes 能力
