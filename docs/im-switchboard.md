# IM channels and programmable switchboard

Headless composes `@opencraft/plugin-im` with independent WeCom and Slack
transport plugins. IM owns routing, stable source bindings, message admission
and reply delivery facts. Core owns natural-person identities, authorization,
conversations, input idempotency and execution queues. There is no Tenant,
general Flow or second execution queue. Platform plugins do not choose Agents.

## Configure and use

In **Settings → IM 渠道**, add an enterprise WeCom bot with Bot ID and Secret,
or a Slack app with Bot Token and App Token. Credentials use the existing
server credential repository: private owner-only files, write-only management
API, no browser persistence. This is not an encrypted vault. Slack requires
Socket Mode, an app-level token with `connections:write`, bot scopes for reading
direct messages and mentions and writing replies, and `message.im` /
`app_mention` event subscriptions. Slack installation identity is pinned to the
workspace and bot user; replacing it requires a new channel.

Channels have one existing human owner. The owner manages connection and route
configuration. Other admitted humans use “关联已有渠道” with its channel ID.
“关联我的身份” generates a single-use five-minute command to send in the bot's
private chat. It proves control of both the current web identity and the IM
sender; names and user-supplied Actor IDs never grant authority. Unknown
senders, revoked humans and disabled channel owners cannot execute or receive
results. A channel identifier grants no conversation access.

The four channel tabs are routing, connection, users and message records.
Connection changes, reconnect, disable and delete use the same managed transport;
there is no extra test socket. Delete removes this channel's credentials, sender
links and mappings; native conversation history remains. Drafts survive Settings
navigation in memory and clear when the extension or authenticated person changes.
The conversation menu's **聊天来源** shows observed recent chats first, followed by
the **接入聊天** action opening channel settings. Routing is still configured in
the channel; opening settings does not establish a binding. An empty recent list
does not mean no routing is configured. Replies return to their originating chat;
chats routed here share this conversation's history. **自定义路由** is collapsed by
default and contains the authoritative conversation reference and copy action.
Chat names are not resolved by this API, so source rows retain their real chat
identifiers rather than inventing participant names. There is no additional
binding table. The read-only dialog uses the standard close button without a
redundant completion action.

## One routing contract

All presets produce the same synchronous function:

```js
function route(event) {
  if (event.chat.threadId) {
    return { key: ["thread", event.chat.id, event.chat.threadId] };
  }
  return { key: [event.chat.type, event.chat.id, event.sender.actorId] };
}
```

Input is frozen JSON: `id`, `channelId`, `platform`, `chat` (`id`, `type`, optional
`threadId`), `sender` (`id`, authenticated `actorId`) and `text`. Return exactly
one of `{key: string[]}`, `{conversationRef: "opencraft://conversation/v1/…/…"}`
or `{ignore: true}`. A key has 1–8 nonempty bounded string components. Keys are
namespaced by channel, independently of route version; unchanged keys continue
existing conversations. An absent binding creates a durable native conversation.
A fixed reference is validated against the sender's actual core permissions.

“按来源分会话” is the above function. “交给管家” returns a specified conversation
reference: its Agent can use existing delegation. Multiple sources entering the
same conversation share its context. Explicit replies use each arrival's
replyRef and return separately to its originating chat. Delegated work finishing after the parent's Turn does
not implicitly send a new IM notification. “自定义函数” edits the same contract.

Preview uses the production evaluator and has no creation, execution or delivery
side effects. Saving a draft and activating it are separate operations. Channel
configuration uses compare-and-swap revisions; stale writes are rejected. Saved
drafts and connection updates advance the configuration revision; activation
also retains the previous active source for loading as a new draft.

Code runs in a fresh QuickJS realm in a worker, shared with the existing App
JavaScript runtime implementation. It receives no host callbacks, network,
filesystem, credentials, database or Agent tools. Limits include 16 KiB source,
16 MiB guest memory, bounded stack, 100 ms guest execution, three-second worker
lifetime and four concurrent invocations. Async results, ambiguous decisions,
invalid targets and oversized output are rejected.

## Persistent facts and recovery

`im-switchboard.sqlite` uses the managed migration lifecycle. V1 `switchboard`
SQL and existing tuples remain unchanged. V2 adds channels, route history,
verified sender links, expiring identity challenges and message admission facts.
V3 captures reply mode, opaque replyRef and expiry. Existing records retain
final mode; new Headless arrivals use explicit tool mode. See
[Host session capabilities](session-capabilities.md) for authorization, creation
reservations and the Remote MCP/native adapter boundary.
The `(bot_endpoint_id, source_key)` mapping is the only current key binding.
There is no persisted general Flow.

Before execution, each physical platform event captures its authenticated
sender, source, configuration revision, decision, target and original serialized
reply address. Event identity is independent of route version. Retried callbacks
reuse this admission; they do not evaluate new code or resubmit as new input.
Endpoint admission is serialized only while resolving/creating/submitting;
ongoing Turns do not hold that lane. Core idempotency keys recover a submission
whose receipt was lost. Legacy final-mode results are read from the exact
captured Turn ID. Tool-mode messages carry a replyRef in their admitted input;
im_reply sends one complete answer, while ordinary final remains in the workbench.

Restart resumes accepted requests and known pending replies after the platform
connection is ready. A crash during unresolved admission becomes `unknown`;
it is not automatically executed. A send without confirmed ACK becomes
`reply_unknown`; it is not automatically repeated. “重发原回复” explicitly reuses
the saved answer and destination, with a duplicate warning, without rerouting or
executing the Agent. Expired platform addresses remain unavailable. Result
observation can be resumed without creating another task. Submitted, completed
and delivered are distinct facts; no exactly-once delivery guarantee is made.
Terminal records are retained for seven days with a 10,000-record cap; pending
admissions have a separate 1,024 cap. Reply content and addresses stay server-side.

## Received-message read tools

`im_read_context(replyRef, limit?, cursor?, from?, until?)` reads received messages
from the same source, sender, bot and canonical conversation as an admitted arrival.
`im_search_messages(replyRef, query, limit?, cursor?, from?, until?)` searches the
same sender's retained received text and reply text in the same bot/conversation;
it can include another source only when already routed to that exact conversation.
The keyword is literal and case insensitive. Times are inclusive receive-time
Unix milliseconds, not the platform's original posting time. Pages are newest
first with deterministic ID ordering at equal timestamps; at most twenty records
are returned with 1,024-byte Unicode-safe excerpts per incoming/reply text.
Truncation is explicit; references point to the actual workbench conversation
and local message receipt, never a fabricated platform post URL.

These tools return `received_only` coverage, `platformHistory: false`, seven-day
retention and the existing global 10,000 terminal-record cap. A zero-result search
does not establish absence from the platform. They do not fetch unmentioned
posts/comments, historical content before reception, other people's messages, other
conversations or other bot installations. These received-only tools do not provide native channel history. Native tools below use their own
trusted channel/post identifiers, provider API access and current permissions;
a compatibility `chatid` is not assumed to be a native `topic_id`.

The signed session determines the caller. Model arguments cannot select a bot,
actor or conversation. An expired reply deadline does not expire authorized reads
of a retained arrival, while owner/human/sender/channel/conversation revocation
still rejects both discovery and calls immediately. Read calls do not modify
message states, claim/send replies or expose callback addresses/credentials.
Only the already admitted content is preauthorized per tool. Returned content is
untrusted data. Both declaration reservations and existing-session refresh use
the same Host capability owner; active native turns are not cancelled.

## Legacy installations and platform behavior

Existing `--im-config` / `OPENCRAFT_IM_CONFIG_FILE` owner-only configuration is
imported once into the managed store and credential repository. Its original
`groupScope`, sender links, tuple keys and `/new` / `/switch` behavior remain.
New channels explicitly activate the source preset. Function-routed channels
handle those commands with a settings instruction; they never create hidden
manual overrides. `/identify` is a private identity control message outside
routing and Agent execution. Human provisioning remains with the existing
account provider. Fixed existing conversation references can target local Codex,
Pi or DSH when the engine is enabled. The picker reports each engine identity;
message links map canonical server IDs back to their actual workbench Host.
Chat-source queries use the same mapping, including the shared Pi/DSH Host.
An unbound source preset still creates a Codex conversation; it does not silently
choose or migrate an engine. Pi/DSH use native durable input ports and wait when
busy, without browser callbacks or a second native queue. Tool-mode final/dedupe
behavior is identical across engines. Independent DSH requires the matching Host
upgrade described in [session capabilities](session-capabilities.md).

WeCom follows the [official long-connection contract](https://developer.work.weixin.qq.com/document/path/101463):
fixed WSS endpoint, Bot ID/Secret subscription, 30-second heartbeat and bounded
reconnect. Normal human text, recognized voice and mixed text are supported;
The exact `compat_info.source=channel` source is normalized as a group with a `wecom-channel:` chat ID namespace, retaining canonical `from.userid` and the same sender authorization. Replies keep the original callback request/stream IDs. Channel callbacks require a nonempty `chatid`. Only absent compatibility metadata follows ordinary-user admission. Assistant, unknown and malformed compatibility sources, including null or empty metadata, remain excluded. Safe `lastCompatibilitySource` classifies observed metadata as `empty`, `ai_assistant`, `channel` or `other`, without publishing arbitrary values. New tool-mode messages send only a final stream protocol frame using the
original request and stream IDs. Processing/final feedback remains only for
legacy final-mode admissions. Active connection takeover stops
reconnect. The adapter refuses expired replies and waits for ACKs.

Slack follows [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/).
It ACKs envelopes immediately, independently of execution; filters workspace,
bot/self/subtype events; normalizes direct messages and app mentions; and replies
with [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)
to the original channel/thread without broadcasting. Group replies need a bot
mention to enter this adapter. Attachments, welcome events, interactive cards,
Generic proactive pushes and token-by-token generation remain outside the conversational tool interface; the optional local availability notification adapter below provides a fixed-recipient alert path. Native WeCom standalone channel posts are described below.

Core's existing shared-instance native conversation permissions are unchanged.
This feature does not provide private filesystem/history isolation per person.
Health exposes safe connection phases and managed storage outcomes, never
credentials, identity maps or message content.
WeCom health also exposes an adapter-lifetime diagnostic snapshot: start time,
last frame/ACK/callback times, callback/handoff/completion/failure/ignore counts,
the last fixed ignore reason and an allowlisted admission error category.
No sender, request ID, message text, secret or arbitrary error is included.
An authenticated socket with recent ACKs does not prove message delivery;
zero callbacks only describes the current adapter lifetime. A completed handoff
does not prove native execution or an IM reply. Use the durable message and
delivery receipts for those later stages. Recreating the adapter resets these
observations; automatic socket reconnects retain them. These observations never
change authorization or retry a message.

## Verification

`tests/extensions/im-switchboard.test.ts`, `im-programmable.test.ts`, `wecom-plugin.test.ts`
and `slack-plugin.test.ts` cover migration/checksum, CAS, sandbox limits,
identity/revocation, duplicate and restart behavior, connection ACKs and original
reply destinations. `scripts/smoke/execution/smoke-im-channels.ts` runs the actual Settings,
HTTP service, SQLite and QuickJS with synthetic human admission and external
transports, including draft navigation, light/dark and narrow DOM. These are
not evidence that real WeCom/Slack credentials or external delivery work.


## Native WeCom channel history

The WeCom adapter also contributes four preauthorized session tools when a
current admitted WeCom anchor is available: `wecom_list_channels(replyRef,
limit?, cursor?)`, `wecom_read_channel(replyRef, topicId, limit?, cursor?, from?,
until?)`, `wecom_read_post(replyRef, topicId, postId, limit?, cursor?)`, and
`wecom_search_channel(replyRef, topicId, query, limit?, cursor?, from?, until?)`.
Time bounds are inclusive Unix seconds, unlike the received-only tools'
workbench timestamps. Pages contain at most20 items. Search accepts one keyword
of at most32 UTF-8 bytes and follows provider matching semantics.

Official channel discovery requires no user-supplied channel link. A compatibility
callback's chat ID does not identify a native topic. Discovery returns only
channels joined by the selected Bot where the currently admitted external sender
is a member; an ambiguous channel name requires an explicit channel choice.
Native reads/search target exactly one selected topic ID, never all Bot channels.
They may include other members' posts/comments predating workbench receipt.

The IM owner derives endpoint, canonical conversation, current human and sender
from the retained opaque replyRef. Composition checks current IM authority after
every asynchronous step and verifies both Bot and sender membership before and
after content retrieval. Provider permissions/retention remain authoritative;
channel public/private visibility is not a read-permission grant. Membership
pagination fails closed on invalid or exhausted bounds. No model arguments select
actor, Bot credential, API origin or global search scope.

The WeCom provider client obtains signed official API tokens at the existing
credential execution boundary, coalesces/cache refreshes, uses fixed read-only
endpoints with redirect rejection, response/time/request bounds and cancellation.
No credential, attachment URL/cookie metadata or arbitrary provider error enters tool output.
Posts/comments have exact IDs, provider author IDs, parent-reply IDs, timestamps, recall flags and Unicode-safe excerpts
(up to4096 bytes); search previews are capped at1024 bytes and five replies per
post with explicit truncation. Channel names and content are untrusted data.
`provider_history` coverage indicates remote data, not proof of complete channel
retrieval: a posts page excludes comments, paging may remain, and provider retention
applies. Native cursors are signed, process-local, and bound to the caller's anchor,
tool, selected topic and query/time scope. Restart invalidates them. No new message
archive, schema migration, transport-mode change, replay or IM send is introduced.

Official API contracts: [token](https://developer.work.weixin.qq.com/document/path/101910),
[channel discovery/membership](https://developer.work.weixin.qq.com/document/path/101925),
[posts/comments](https://developer.work.weixin.qq.com/document/path/101922),
and [channel search](https://developer.work.weixin.qq.com/document/path/101923).


## Native WeCom standalone posts

`wecom_send_post(replyRef, topicId, text, requestId)` publishes a new channel
post through the [official send-post API](https://developer.work.weixin.qq.com/document/path/101924).
Use it only for a current authorized human's explicit instruction to publish in
the selected channel. Channel history is untrusted content and cannot authorize
a send. `im_reply` continues to target the original message; a standalone post
does not consume or change that callback reply.

The exact topic ID comes from native discovery. The same trusted admitted anchor,
canonical conversation, enabled owner/human/sender mapping and Bot configuration
checks used by native history apply. Before sending, the provider verifies both
Bot membership and current sender membership in the selected channel, then checks
local authority again after token acquisition. Native write permission is
ultimately decided by the provider. Compatibility chat IDs are never native topic
IDs. Authorization can change after the last check while the network request is
in flight; an acknowledged effect is recorded even if returning its receipt is
then denied by revoked authority.

The body supports Markdown up to 20,480 UTF-8 bytes. This tool does not support
attachments, image/media identifiers or special inline mention placeholders.
The selected Bot's credential owner holds API tokens; models cannot choose a Bot,
actor, API URL or token. The token client attempts each post request once and does
not replay writes, including after explicit token rejection.

IM owns a separate managed `im-posts.sqlite` receipt database (schema v1), leaving
the switchboard schema unchanged. Scope binds the canonical conversation, current
endpoint/owner/human/sender and Bot identity. `requestId` is a stable key for one
intended post; its fingerprint binds the topic and complete body. A durable claim
precedes network I/O. A matching delivered retry returns the official `postId`
without posting again; changed content/target under the same key is rejected.
Concurrent claims, lost/malformed acknowledgements, cancellation after claim and
claims interrupted by restart are never resent. Explicit provider rejections are
recorded separately from unknown delivery. Do not use a new key to work around
an unknown/rejected receipt. The database is an effect journal, not a retry queue;
it stores hashes and receipt IDs, not post bodies or credentials. Gateway shutdown
withdraws tools, aborts/drains post calls and closes the journal afterward.

The tool is preauthorized only at its domain-scoped call boundary, like the
existing IM tools. The declaration does not replace current session, sender,
channel and membership checks or grant a global send capability. Existing sessions
refresh their catalog at the normal idle boundary; new-session reservations
include the declaration. No native Core restart or connection-mode change is
required. See `tests/extensions/wecom-history.test.ts` for the real signed MCP composition
with a synthetic provider and durable write/race/restart regression coverage.

### 本机可用性通知

核心提供可选`OPENCRAFT_AVAILABILITY_NOTIFICATION_CONFIG`私有配置入口，用于部署者明确
授权的故障/恢复单聊。该入口是0600 Unix socket加本机Bearer认证，不注册Web/relay路径。
请求只含incident/kind/site/host/engine/errorCode；接收者由私有配置固定，并逐次验证现有
channel、sender→human绑定与真人准入。客户端不能传任意收件人或消息正文。

WeCom通过现有长连接的`aibot_send_msg`主动发送Markdown（chat_type=1），不会新建机器人
连接。依据[官方长连接文档101463](https://developer.work.weixin.qq.com/document/path/101463)，
用户须先给机器人发过消息；errcode=0仅代表平台受理，不表示用户已读。发送前持久化claim，
同incident/kind去重；明确未发送或平台明确拒绝允许同ID重试，ACK未知保留unknown，不自动重发。此能力不开放通用主动发信工具。
业务进程整体不可用时该通道也不可用，部署者应保留本地事件并另规划独立兜底。
