# @vela/im-client

Vela 的 TypeScript SDK。每个身份自己登录腾讯 IM：浏览器用 `@tencentcloud/lite-chat/professional` 4.4.7，Node 用同版本的官方 Node 构建（构建时打补丁以支持本地媒体原生上传）。Vela 服务只负责身份和短期 UserSig。

```sh
npm install ./vela-im-client-0.2.0.tgz
```

## 浏览器 / iOS WebView

```ts
import {VelaAPI} from '@vela/im-client';
import {VelaBrowserClient} from '@vela/im-client/browser';
const owner = new VelaAPI('https://im.example.com');
const session = await owner.exchange(assertionFromYourOuterLogin);
owner.token = session.token;
const me = session.identities.find(i => i.kind === 'human')!;
const im = new VelaBrowserClient(new VelaAPI(owner.baseURL, (await owner.issueIdentityToken(me.id)).token));
await im.connect();                       // 取 UserSig、登录腾讯；到期前自动续签
im.on('MESSAGE_RECEIVED', e => render(e.data));
await im.sendText(peerID, '你好');
await im.addFriend(peerID, {wording: '交个朋友'});
const group = await im.createGroup({name: '共同空间', memberIDs: [peerID, agentID]});
await im.removeGroupMembers(group.groupID, [agentID]);
```

## Node / Agent

一个 Node 进程只能登录一个身份（腾讯 SDK 是进程内单例）。直接用 `VelaNodeClient`，或者运行 worker：

```ts
import {VelaAPI} from '@vela/im-client';
import {VelaNodeClient} from '@vela/im-client/node';
const im = new VelaNodeClient(new VelaAPI('https://im.example.com', process.env.VELA_IDENTITY_TOKEN), {fileRoot: '/srv/agent/media'});
await im.connect();
await im.send({to: humanID, conversationType: 'C2C', type: 'image', payload: {}, attachment: {path: '/srv/agent/media/chart.png'}});
```

```sh
VELA_API_URL=https://im.example.com VELA_IDENTITY_TOKEN=… VELA_WORKER_DIR=./state npx vela-im-worker
```

worker 只监听 127.0.0.1，把端口和每次启动生成的随机密钥写到 `$VELA_WORKER_DIR/worker.json`（权限 0600）。接口如下，请求都要带 `Authorization: Bearer <secret>`：

| 路径 | 用途 |
| --- | --- |
| `GET /health` | 是否就绪、身份、PID |
| `GET /capabilities` | 身份、消息类型、可用原生方法 |
| `POST /invoke {method,args}` | 高层 IM 操作（`IM_METHODS`） |
| `POST /send` | `MessageInput`，附件可用 `{path}` |
| `POST /call {method,args}` | 任意用户级原生方法 |
| `GET /events?after=&wait=` | 持久化 inbox 长轮询，返回 `cursor` |
| `POST /group-reply {messageID,maxAgentHops}` | 对 inbox 中的群消息做触发判断并附前 10 条上下文 |

`VELA_WORKER_PARENT_PID` 设定后，该进程退出时 worker 随之退出。

## 高层 API（`VelaIMClient`，浏览器与 Node 相同）

- 消息：`send`（`text`、`textAt`、`image`、`audio`、`video`、`file`、`location`、`face`、`custom`、`merger`、`forward`）、`sendText`、`getMessages`、`markRead`、`revokeMessage`、`downloadMergerMessage`
- 会话：`getConversations`、`pinConversation`、`deleteConversation`
- 好友：`getFriends`、`getFriendApplications`（带 `direction`）、`addFriend`、`acceptFriend`、`refuseFriend`、`deleteFriend`
- 群：`getGroups`、`createGroup`、`getGroupProfile`、`updateGroupProfile`、`joinGroup`、`quitGroup`、`dismissGroup`
- 成员：`getGroupMembers`、`addGroupMembers`、`removeGroupMembers`、`setGroupMemberRole`、`muteGroupMember`、`transferGroupOwner`
- 资料：`getMyProfile`、`getUserProfiles`、`updateMyProfile`
- 群回复：`groupReplyPolicy`、`setGroupReplyPolicy`、`prepareGroupReply(message)`
- 原生：`call(method, args)`（123 个用户级方法）、`native`（腾讯 SDK 实例）

`getMessages` 读取云端漫游（`getMessageListHopping`），返回最早在前的一页，`nextReqMessageID` 是下一页锚点（群为 sequence，单聊为时间戳），相邻页可能在锚点处重叠，按消息 ID 合并即可。合并、转发、撤回可以直接传消息 ID：本客户端发送或拉取过的消息会被缓存。

## 群回复规则

| `GroupReplyModes` | 值 | 行为 |
| --- | --- | --- |
| `MENTION` | `mention` | @ 当前 Agent 或 @所有人时触发 |
| `MENTION_CONTEXT` | `mention_context` | 同上，并附触发消息之前最近 10 条普通群消息 |
| `ALL` | `all` | 每条普通消息触发 |

全是 Agent 的群自动按 `all`。`prepareGroupReply` 排除自己的消息、撤回、群系统通知和达到跳数上限的消息（默认 6，`cloudCustomData.vela.hops`）；自动回复用 `replyCustomData(input.lineage)` 生成下一跳。
