# OpenCraft AppServer Bot Conversations Protocol V1

This is the Bot Conversations V1 protocol index. Normative ownership, fields, methods, examples and acceptance requirements are maintained in the topic pages below. The implementation baseline and deferred scope remain explicit in their corresponding sections.

| Topic | Scope |
| --- | --- |
| [Ownership and wire](protocol/bot-conversations/ownership-and-wire.md) | Ownership, JSON-RPC framing, capability negotiation, shared types and errors |
| [Core methods](protocol/bot-conversations/core-methods.md) | Bot/conversation requests, messages, execution, interactions and attachments |
| [Notifications and hydration](protocol/bot-conversations/notifications-and-hydration.md) | Event ordering, notification shapes and hydration barriers |
| [Optional methods](protocol/bot-conversations/optional-methods.md) | Negotiated Bot management, assets, configuration and routines |
| [Direct-message example](protocol/bot-conversations/direct-message-example.md) | Complete send, receipt, execution, presence and streaming exchange |
| [Adapters and acceptance](protocol/bot-conversations/adapters-and-acceptance.md) | Hermes mapping, Cordis service, acceptance invariants and deferred scope |

## Section index

Earlier section permalinks remain available and link to the corresponding specification body.

### Ownership and wire

- <a id="1-ownership-boundaries"></a>[1. Ownership boundaries](protocol/bot-conversations/ownership-and-wire.md#1-ownership-boundaries)
- <a id="2-websocket-framing"></a>[2. WebSocket framing](protocol/bot-conversations/ownership-and-wire.md#2-websocket-framing)
- <a id="21-request"></a>[2.1 Request](protocol/bot-conversations/ownership-and-wire.md#21-request)
- <a id="22-success-response"></a>[2.2 Success response](protocol/bot-conversations/ownership-and-wire.md#22-success-response)
- <a id="23-error-response"></a>[2.3 Error response](protocol/bot-conversations/ownership-and-wire.md#23-error-response)
- <a id="24-notification"></a>[2.4 Notification](protocol/bot-conversations/ownership-and-wire.md#24-notification)
- <a id="25-wire-rules"></a>[2.5 Wire rules](protocol/bot-conversations/ownership-and-wire.md#25-wire-rules)
- <a id="3-capability-negotiation"></a>[3. Capability negotiation](protocol/bot-conversations/ownership-and-wire.md#3-capability-negotiation)
- <a id="4-shared-value-types"></a>[4. Shared value types](protocol/bot-conversations/ownership-and-wire.md#4-shared-value-types)
- <a id="13-error-codes"></a>[13. Error codes](protocol/bot-conversations/ownership-and-wire.md#13-error-codes)

### Core methods

- <a id="5-core-request-methods"></a>[5. Core request methods](protocol/bot-conversations/core-methods.md#5-core-request-methods)
- <a id="51-botlist"></a>[5.1 `bot/list`](protocol/bot-conversations/core-methods.md#51-botlist)
- <a id="52-botread"></a>[5.2 `bot/read`](protocol/bot-conversations/core-methods.md#52-botread)
- <a id="53-botconversationlist"></a>[5.3 `bot/conversation/list`](protocol/bot-conversations/core-methods.md#53-botconversationlist)
- <a id="54-botconversationcreate"></a>[5.4 `bot/conversation/create`](protocol/bot-conversations/core-methods.md#54-botconversationcreate)
- <a id="55-botconversationread"></a>[5.5 `bot/conversation/read`](protocol/bot-conversations/core-methods.md#55-botconversationread)
- <a id="56-botconversationupdate"></a>[5.6 `bot/conversation/update`](protocol/bot-conversations/core-methods.md#56-botconversationupdate)
- <a id="57-botconversationarchive"></a>[5.7 `bot/conversation/archive`](protocol/bot-conversations/core-methods.md#57-botconversationarchive)
- <a id="58-botconversationunarchive"></a>[5.8 `bot/conversation/unarchive`](protocol/bot-conversations/core-methods.md#58-botconversationunarchive)
- <a id="59-botconversationdelete"></a>[5.9 `bot/conversation/delete`](protocol/bot-conversations/core-methods.md#59-botconversationdelete)
- <a id="510-botmessageslist"></a>[5.10 `bot/messages/list`](protocol/bot-conversations/core-methods.md#510-botmessageslist)
- <a id="511-botmessagesend"></a>[5.11 `bot/message/send`](protocol/bot-conversations/core-methods.md#511-botmessagesend)
- <a id="512-botexecutioncancel"></a>[5.12 `bot/execution/cancel`](protocol/bot-conversations/core-methods.md#512-botexecutioncancel)
- <a id="513-botinteractionrespond"></a>[5.13 `bot/interaction/respond`](protocol/bot-conversations/core-methods.md#513-botinteractionrespond)
- <a id="514-botattachmentupload"></a>[5.14 `bot/attachment/upload`](protocol/bot-conversations/core-methods.md#514-botattachmentupload)
- <a id="6-interaction-type"></a>[6. Interaction type](protocol/bot-conversations/core-methods.md#6-interaction-type)

### Notifications and hydration

- <a id="7-server-notifications"></a>[7. Server notifications](protocol/bot-conversations/notifications-and-hydration.md#7-server-notifications)
- <a id="71-conversation-scoped-ordering"></a>[7.1 Conversation-scoped ordering](protocol/bot-conversations/notifications-and-hydration.md#71-conversation-scoped-ordering)
- <a id="72-botmessagestarted"></a>[7.2 `bot/message/started`](protocol/bot-conversations/notifications-and-hydration.md#72-botmessagestarted)
- <a id="73-botmessagedelta"></a>[7.3 `bot/message/delta`](protocol/bot-conversations/notifications-and-hydration.md#73-botmessagedelta)
- <a id="74-botmessagecompleted"></a>[7.4 `bot/message/completed`](protocol/bot-conversations/notifications-and-hydration.md#74-botmessagecompleted)
- <a id="75-botexecutionupdated"></a>[7.5 `bot/execution/updated`](protocol/bot-conversations/notifications-and-hydration.md#75-botexecutionupdated)
- <a id="76-botpresenceupdated"></a>[7.6 `bot/presence/updated`](protocol/bot-conversations/notifications-and-hydration.md#76-botpresenceupdated)
- <a id="77-other-notification-shapes"></a>[7.7 Other notification shapes](protocol/bot-conversations/notifications-and-hydration.md#77-other-notification-shapes)
- <a id="8-hydration-and-live-event-barrier"></a>[8. Hydration and live-event barrier](protocol/bot-conversations/notifications-and-hydration.md#8-hydration-and-live-event-barrier)

### Optional methods

- <a id="9-optional-bot-management-methods"></a>[9. Optional Bot management methods](protocol/bot-conversations/optional-methods.md#9-optional-bot-management-methods)
- <a id="10-optional-bot-asset-methods"></a>[10. Optional Bot asset methods](protocol/bot-conversations/optional-methods.md#10-optional-bot-asset-methods)
- <a id="11-optional-configuration-methods"></a>[11. Optional configuration methods](protocol/bot-conversations/optional-methods.md#11-optional-configuration-methods)
- <a id="12-optional-routine-methods"></a>[12. Optional routine methods](protocol/bot-conversations/optional-methods.md#12-optional-routine-methods)

### Direct-message example

- <a id="14-complete-direct-message-wire-example"></a>[14. Complete direct-message wire example](protocol/bot-conversations/direct-message-example.md#14-complete-direct-message-wire-example)
- <a id="141-send"></a>[14.1 Send](protocol/bot-conversations/direct-message-example.md#141-send)
- <a id="142-receipt"></a>[14.2 Receipt](protocol/bot-conversations/direct-message-example.md#142-receipt)
- <a id="143-execution-starts"></a>[14.3 Execution starts](protocol/bot-conversations/direct-message-example.md#143-execution-starts)
- <a id="144-presence-changes"></a>[14.4 Presence changes](protocol/bot-conversations/direct-message-example.md#144-presence-changes)
- <a id="145-stream-starts-and-advances"></a>[14.5 Stream starts and advances](protocol/bot-conversations/direct-message-example.md#145-stream-starts-and-advances)
- <a id="146-completion"></a>[14.6 Completion](protocol/bot-conversations/direct-message-example.md#146-completion)

### Adapters and acceptance

- <a id="15-hermes-desktop-adapter-mapping"></a>[15. Hermes Desktop adapter mapping](protocol/bot-conversations/adapters-and-acceptance.md#15-hermes-desktop-adapter-mapping)
- <a id="16-cordis-service-contract"></a>[16. Cordis service contract](protocol/bot-conversations/adapters-and-acceptance.md#16-cordis-service-contract)
- <a id="17-acceptance-invariants"></a>[17. Acceptance invariants](protocol/bot-conversations/adapters-and-acceptance.md#17-acceptance-invariants)
- <a id="18-deliberately-deferred-from-v1"></a>[18. Deliberately deferred from V1](protocol/bot-conversations/adapters-and-acceptance.md#18-deliberately-deferred-from-v1)
