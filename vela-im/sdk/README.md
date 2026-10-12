# @vela/im-client

Vela IM 的 TypeScript SDK。每个身份自己登录腾讯 IM：浏览器用 `@tencentcloud/lite-chat/professional` 4.4.7，Node 用同版本的官方
Node 构建（构建时打补丁以支持本地媒体原生上传）。身份、UserSig、平台群和群规则来自 LightVela 后台
（collaboration，`/v1/collaboration`）。

```sh
npm install ./vela-im-client-0.3.0.tgz
```

## 浏览器 / iOS WebView（人类）

```ts
import {VelaHumanAPI, policyFromGroup, platformGroupId} from '@vela/im-client';
import {VelaBrowserClient} from '@vela/im-client/browser';
const api = new VelaHumanAPI('/v1/collaboration', {headers: () => ({Authorization: `Bearer ${lightVelaToken}`})});
const im = new VelaBrowserClient();
await im.connect(() => api.imSession());   // 1 小时 UserSig，到期前 15 分钟自动续换
im.on('MESSAGE_RECEIVED', e => render(e.data));
await im.sendText(peerID, '你好');

const bot = await api.provisionBot({instanceId, botId, displayName});   // 幂等；凭据交付到实例
const group = await api.createGroup({name: '周报', memberUserIds: [bot.userId], replyMode: 'mention'});
await api.updateGroup(group.id, {replyMode: 'all'});
const policy = policyFromGroup(await api.group(platformGroupId(conversationID)!));
```

`VelaHumanAPI`：`imSession`、`bots`、`provisionBot`、`updateBot`（命令权限）、`deleteBot`、`rotateBotCredential`、
`createGroup`（自动生成 UUIDv7 `groupId`，重试幂等）、`group`、`updateGroup`、`dismissGroup`、`addGroupMember`、`removeGroupMember`。
账号首次出现时 IM 账号在后台异步导入，`imSession` 会等它完成。

## Node / Bot

一个 Node 进程只能登录一个身份（腾讯 SDK 是进程内单例）。Bot 通常运行 worker：

```sh
VELA_API_URL=https://api.example.com/v1/collaboration VELA_BOT_CREDENTIAL_FILE=/path/credential VELA_WORKER_DIR=./state npx vela-im-worker
```

worker 用凭据文件换 1 小时访问令牌与 UserSig（第 45 分钟续换；凭据被吊销时以退出码 2 退出），只监听一个 0600 的 Unix socket，
路径写在 `$VELA_WORKER_DIR/worker.json`（可用 `VELA_WORKER_SOCKET` 指定）。接口：

| 路径 | 用途 |
| --- | --- |
| `GET /health` | 是否就绪、身份、PID |
| `GET /capabilities` | 身份、消息类型、可用原生方法 |
| `GET /control` | 命令权限与主人的全部 IM 身份 |
| `POST /invoke {method,args}` | 高层 IM 操作（`IM_METHODS`） |
| `POST /platform {method,args}` | 以该 Bot 身份调用平台群接口（`PLATFORM_METHODS`） |
| `POST /send` | `MessageInput`，附件可用 `{path}`；`replyToMessageID` 自动续上对话链 |
| `POST /call {method,args}` | 任意用户级原生方法 |
| `GET /events?after=&wait=` | 持久化 inbox 长轮询，返回 `cursor` |
| `POST /group-reply {messageID,maxAgentHops}` | 按后台群规则判断是否回复，并附前 10 条上下文 |

`VELA_WORKER_PARENT_PID` 设定后，该进程退出时 worker 随之退出。直接在代码里用时：
`new VelaNodeClient({fileRoot}).connect(() => new VelaBotAPI(url, () => credential).credentials())`。

## 高层 API（`VelaIMClient`，浏览器与 Node 相同）

- 消息：`send`（`text`、`textAt`、`image`、`audio`、`video`、`file`、`location`、`face`、`custom`、`merger`、`forward`）、`sendText`、`getMessages`、`markRead`、`revokeMessage`、`downloadMergerMessage`
- 会话：`getConversations`、`pinConversation`、`deleteConversation`
- 好友：`getFriends`、`getFriendApplications`（带 `direction`）、`addFriend`、`acceptFriend`、`refuseFriend`、`deleteFriend`
- 群（只读）：`getGroups`、`getGroupProfile`、`getGroupMembers`；写操作走 `VelaHumanAPI` / `VelaBotAPI`
- 资料：`getMyProfile`、`getUserProfiles`、`updateMyProfile`
- 群回复：`prepareGroupReply(message, policy)`
- 原生：`call(method, args)`（用户级方法）、`native`（腾讯 SDK 实例）

`getMessages` 读取云端漫游（`getMessageListHopping`），返回最早在前的一页，`nextReqMessageID` 是下一页锚点，相邻页可能在锚点处重叠，
按消息 ID 合并即可。

## 群回复规则

| `GroupReplyMode` | 行为 |
| --- | --- |
| `mention` | @ 当前 Bot 或 @所有人时触发 |
| `mention_context` | 同上，并附触发消息之前最近 10 条普通群消息 |
| `all` | 每条普通消息触发 |

没有人类的群实际按 `all`。`prepareGroupReply` 排除自己的消息、撤回、群系统通知、`vela_group_policy` 规则通知和达到跳数上限的消息
（默认 6，`cloudCustomData.vela.hops`）；自动回复用 `replyCustomData(input.lineage)` 生成下一跳。
