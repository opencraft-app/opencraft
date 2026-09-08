# 配置通道 - Slack

## 摘要

**Slack 通道采用 Bot Token 与 App Token 接入，适合把 Hermes Agent 接入团队频道、私信和定时任务通知场景：先在 Slack 应用管理后台创建应用、配置权限并获取这两个 Token，再填入 LightVela 管理台的「通道」完成接入。准备工作是一个有权限安装应用的 Slack 工作区，以及完成模型配置（或直接使用套餐按月提供的模型积分）。两个 Token 都属于敏感凭证，请勿公开分享；接入后 Agent 在 Slack 中与其他通道共享同一份人格与长期记忆。**

---

Slack 通道采用 Bot Token 和 App Token 接入方式，适合将 Hermes Agent 接入团队频道、私信和定时任务通知场景。

## 本页覆盖

- 创建 Slack App，并配置 Socket Mode、权限和事件

- 在 LightVela 中绑定 Slack Bot Token 和 App Token

- 在 Slack 频道和私信中与 Hermes Agent 对话

> 💡 **准备工作**
>
> - 已有一个 Hermes Agent，并已完成 [模型配置](./model.md)
>
> - 已有 Slack workspace，并且当前 Slack 账号可以创建和安装 App
>
> - 如果 workspace 要求管理员审批 App，请先联系管理员
>
> - 准备安全的位置临时保存两个 Token
>
> Bot Token 与 App Token 都是敏感凭据。如果 Token 泄露，请立即在 Slack 中撤销并重新生成。

---

## 操作步骤

### 1. 打开 LightVela 的 Slack 通道入口

登录 LightVela 国际站，进入 **My Hermes → Channel**，找到 **Slack** 卡片并点击 **+ Connect**。稍后需要填写两个 Token：

- **Slack Bot Token**：以 `xoxb-` 开头。
- **Slack App Token**：以 `xapp-` 开头。

### 2. 创建 Slack App

1. 打开 [Slack API Apps](https://api.slack.com/apps) 并登录。
2. 点击 **Create New App**。

![在 Slack API Apps 页面创建新 App](../images/slack-create-app.png)

3. 选择 **From scratch**。

![选择 From scratch 创建 Slack App](../images/slack-create-from-scratch.png)

4. 输入 App 名称，例如 `Hermes Agent`。
5. 选择 Hermes Agent 要接入的 workspace，然后点击 **Create App**。

![填写 Slack App 名称并选择 workspace](../images/slack-select-workspace.png)

如果列表中没有目标 workspace，请确认当前 Slack 账号已加入该 workspace，并拥有创建 App 的权限。

### 3. 创建 App Token

App Token 用于通过 Socket Mode 建立 WebSocket 连接，必须包含 `connections:write` scope。

1. 在 Slack App 左侧进入 **Settings → Basic Information**。

![打开 Slack App 的 Basic Information](../images/slack-basic-information.png)

2. 向下找到 **App-Level Tokens**，点击 **Generate Token and Scopes**。

![在 App-Level Tokens 中生成 Token](../images/slack-generate-app-token.png)

3. 输入便于识别的 Token 名称，例如 `HermesSocket`。
4. 点击 **Add Scope**。

![为 App Token 添加 scope](../images/slack-add-connection-scope.png)

5. 搜索并选择 `connections:write`。

![选择 connections write scope](../images/slack-select-connections-write.png)

6. 确认 scope 已添加，点击 **Generate**。

![生成带 connections write 的 App Token](../images/slack-generate-token.png)

7. 复制生成的 `xapp-...` Token，并保存在安全位置。复制后点击 **Done**。

![复制 Slack App Token](../images/slack-copy-app-token.png)

不要把 App Token 填到 Bot Token 字段，也不要使用 Client Secret 或 Signing Secret 代替它。

### 4. 配置 Socket Mode、权限和事件

#### 4.1 开启 Socket Mode

1. 在左侧进入 **Settings → Socket Mode**。
2. 打开 **Enable Socket Mode**。

![开启 Slack Socket Mode](../images/slack-enable-socket-mode.png)

Socket Mode 通过 WebSocket 向 Hermes Agent 发送 Slack 事件。使用此接入方式时，不需要配置 Event Subscriptions 的 Request URL，也不需要配置 OAuth Redirect URL。

#### 4.2 添加 Bot Token Scopes

1. 进入 **Features → OAuth & Permissions**。
2. 向下找到 **Scopes → Bot Token Scopes**。
3. 点击 **Add an OAuth Scope**。

![在 OAuth Permissions 中添加 Bot scope](../images/slack-add-oauth-scope.png)

按使用场景添加以下权限：

| Scope | 是否必需 | 用途 |
|---|---|---|
| `app_mentions:read` | 频道场景必需 | 接收频道中 @ Bot 的消息 |
| `channels:read` | 公开频道必需 | 读取公开频道基本信息 |
| `channels:history` | 公开频道必需 | 读取 Bot 已加入的公开频道消息 |
| `chat:write` | 必需 | 以 Bot 身份发送回复 |
| `im:read` | 私信场景必需 | 读取私信会话信息 |
| `im:history` | 私信场景必需 | 读取发送给 Bot 的私信 |
| `im:write` | 私信场景必需 | 创建或管理私信会话 |
| `groups:read` | 私有频道可选 | 读取私有频道基本信息 |
| `groups:history` | 私有频道可选 | 读取 Bot 已加入的私有频道消息 |

![核对 Slack Bot Token Scopes](../images/slack-bot-token-scopes.png)

仅在需要使用私有频道时添加两个 `groups:*` scopes。Bot 仍需被邀请进入目标频道后才能接收频道消息。

#### 4.3 开启 App Home 私信入口

如果用户需要直接给 Hermes Agent 发私信：

1. 进入 **Features → App Home**。
2. 向下找到 **Show Tabs**。
3. 打开 **Messages Tab**。
4. 打开允许用户从 Messages Tab 发送消息的选项。

如果只计划在频道中 @ Bot，可以跳过这一小节，也不需要 `im:*` scopes 和 `message.im` 事件。

#### 4.4 订阅 Bot 事件

1. 进入 **Features → Event Subscriptions**。
2. 打开 **Enable Events**。
3. 在 **Subscribe to bot events** 下点击 **Add Bot User Event**。
4. 添加 `app_mention`，用于接收频道中的 @ 提及。
5. 如果需要私信，再添加 `message.im`。
6. 点击 **Save Changes**。

![配置 Slack Bot 事件订阅](../images/slack-event-subscriptions.png)

> 安装 App 后如果修改了 scopes 或事件，请回到 **OAuth & Permissions**，点击 **Reinstall to Workspace**。重新安装后，新权限才会生效。

### 5. 安装 App 并复制 Bot Token

1. 回到 **Features → OAuth & Permissions**。
2. 点击 **Install to Workspace**。如果 App 已安装，点击 **Reinstall to Workspace**。

![将 Slack App 安装到 workspace](../images/slack-install-workspace.png)

3. 检查请求的权限，点击 **Allow**。

![授权 Slack App 请求的权限](../images/slack-authorize-workspace.png)

4. Slack 返回 **OAuth & Permissions** 后，找到 **OAuth Tokens for Your Workspace**。
5. 复制以 `xoxb-` 开头的 **Bot User OAuth Token**。

![复制 Slack Bot User OAuth Token](../images/slack-copy-bot-token.png)

不要使用 Signing Secret、Client Secret、Verification Token 或以 `xoxp-` 开头的 User OAuth Token。LightVela 只需要一个 `xapp-...` App Token 和一个 `xoxb-...` Bot Token。

### 6. 在 LightVela 绑定 Slack

1. 返回 **My Hermes → Channel → Slack**。
2. 将 `xoxb-...` 填入 **Slack Bot Token**。
3. 将 `xapp-...` 填入 **Slack App Token**。
4. 确认两个 Token 未填反，然后提交连接。
5. 等待 Slack 卡片显示为已接入。

### 7. 在 Slack 中测试 Hermes Agent

#### 7.1 测试频道提及

1. 打开要使用 Hermes Agent 的 Slack 频道。
2. 邀请 App 加入频道：

```text
/invite @Hermes Agent
```

3. 发送一条带 @ 提及的消息：

```text
@Hermes Agent 请总结这个频道今天讨论的重点。
```

Bot 只有在加入频道后，才能接收该频道中的消息。

#### 7.2 测试私信

1. 在 Slack 左侧 **Apps** 区域打开刚创建的 App。
2. 进入 **Messages** 标签。
3. 发送一条简短消息，例如 `你好`。

![在 Slack App Home 中测试私信](../images/slack-direct-message-test.png)

---

## 成功状态

配置成功后，应同时满足：

- LightVela 的 Slack 卡片显示为已接入。
- Slack App 已安装到目标 workspace。
- 在已加入的频道中 @ Bot 后，Hermes Agent 可以回复。
- 开启 App Home 和 IM 权限后，Hermes Agent 可以回复私信。

---

## 支持的消息类型

接入成功后，Slack 通道支持以下消息场景：

| Slack 通道支持的消息类型 | 是否支持 |
|---|---|
| 接收频道中的 @ 提及文本 | ✅ 已支持 |
| 接收 App Home 私信文本 | ✅ 已支持 |
| 回复频道和私信文本 | ✅ 已支持 |
| 主动发送消息（如定时任务通知） | ✅ 已支持 |

> ℹ️ **实际处理能力取决于模型**
>
> 上表仅代表 Slack 通道层面的消息能力。Hermes Agent 能否完成总结、翻译等任务，还取决于当前接入模型和已安装技能的能力。

---

## 常见问题

| 问题 | 可能原因 | 处理方式 |
|---|---|---|
| App Token 无效 | Token 类型错误，或缺少 `connections:write` | 在 **Basic Information → App-Level Tokens** 重新生成 `xapp-...` Token |
| Bot Token 无效 | 使用了 User OAuth Token 或其他凭据 | 在 **OAuth & Permissions** 复制 `xoxb-...` Bot User OAuth Token |
| Event Subscriptions 要求 Request URL | Socket Mode 尚未开启 | 先开启 **Settings → Socket Mode**，再返回事件订阅页面 |
| 收不到频道 @ 消息 | App 未加入频道、缺 scope 或未订阅事件 | 邀请 App，补齐频道 scopes 和 `app_mention`，然后重新安装 App |
| 收不到私信 | Messages Tab 未开启、缺 IM scope 或未订阅事件 | 开启 Messages Tab，补齐 `im:*` 和 `message.im`，然后重新安装 App |
| 新权限没有生效 | 修改权限后没有重新安装 | 在 **OAuth & Permissions** 点击 **Reinstall to Workspace** |
| 已接入但没有回复 | 模型不可用、额度不足或 Agent 状态异常 | 检查 [配置模型](./model.md)、实例状态与可用额度 |

---

## 下一步

- [配置通道 - Telegram](./channel-telegram.md) — 适合个人对话和群组通知

- [配置通道 - WhatsApp](./channel-whatsapp.md) — 国际用户沟通与客户服务

- [配置通道 - Discord](./channel-discord.md) — 社群运营与开发者社区

- [配置定时任务](./automation.md) — 定时向 Slack 推送提醒和任务结果

- [配置技能](./skill.md) — 扩展 Hermes Agent 能力
