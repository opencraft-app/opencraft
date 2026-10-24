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
`compat_info` identities are excluded. New tool-mode messages send only a final stream protocol frame using the
original request and stream IDs. Processing/final feedback remains only for
legacy final-mode admissions. Active connection takeover stops
reconnect. The adapter refuses expired replies and waits for ACKs.

Slack follows [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/).
It ACKs envelopes immediately, independently of execution; filters workspace,
bot/self/subtype events; normalizes direct messages and app mentions; and replies
with [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)
to the original channel/thread without broadcasting. Group replies need a bot
mention to enter this adapter. Attachments, welcome events, interactive cards,
proactive pushes and token-by-token generation are outside this implementation.

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
delivery receipts for those later stages. Reconnecting creates a new snapshot;
these observations never change authorization or retry a message.

## Verification

`tests/extensions/im-switchboard.test.ts`, `im-programmable.test.ts`, `wecom-plugin.test.ts`
and `slack-plugin.test.ts` cover migration/checksum, CAS, sandbox limits,
identity/revocation, duplicate and restart behavior, connection ACKs and original
reply destinations. `scripts/smoke/execution/smoke-im-channels.ts` runs the actual Settings,
HTTP service, SQLite and QuickJS with synthetic human admission and external
transports, including draft navigation, light/dark and narrow DOM. These are
not evidence that real WeCom/Slack credentials or external delivery work.
