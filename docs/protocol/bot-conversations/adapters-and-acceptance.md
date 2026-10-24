# Bot Conversations V1: Adapters and acceptance

[Protocol index](../../appserver-bot-protocol-v1.md) · [Documentation index](../../README.md)

## 15. Hermes Desktop adapter mapping

The Hermes adapter implements the OpenCraft methods as follows:

| OpenCraft protocol | Hermes capability |
| --- | --- |
| `bot/list`, `bot/read` | `profiles.list`, `profiles.describe` |
| `bot/create`, `bot/update`, `bot/delete` | `profiles.create`, `profiles.configure`, profile deletion when supported |
| `bot/asset/read`, `bot/asset/write` | `profiles.get_asset`, `profiles.set_asset` |
| `bot/conversation/list` | `session.list` plus group repository records |
| `bot/conversation/create` | `session.create`; for groups create one hidden Session per Bot member |
| `bot/conversation/read` | REST/session history plus `session.resume`, reconciled behind one hydration barrier |
| `bot/conversation/update` | `session.title`; group membership is handled by the group coordinator |
| `bot/messages/list` | Hermes history page/cursor adapter |
| `bot/attachment/upload` | `image.attach_bytes`, `pdf.attach`, or `file.attach` |
| `bot/message/send` | attachment handles followed by `prompt.submit` |
| `bot/execution/cancel` | `session.interrupt` for the mapped execution/session |
| `bot/interaction/respond` | `approval.respond` or `clarify.respond` |
| `bot/config/*` | `profiles.describe/configure`, `model.options`, `mcp.catalog`, `skills.manage` |
| `bot/routine/*` | `cron.manage` |

Hermes private details must remain behind the adapter:

- enterprise-service/WebSocket tickets and Tencent instance identifiers
- Hermes runtime Session IDs and hidden group Session titles
- `profile.ui_meta`
- group watermarks, epochs, and relay bookkeeping
- `bot_relay.*` calls

Hermes Desktop itself does not provide an authoritative Bot-group abstraction.
For direct chat, Hermes Session history remains authoritative and the adapter
does not need a second message database. For group chat, the
`BotConversationService` backend owns the room log, membership, orchestration,
and hidden member-session mapping. While the backend temporarily runs in the
browser, IndexedDB may implement that authority, but it is explicitly a
single-browser implementation and not cross-device truth.

## 16. Cordis service contract

The Cordis service mirrors domain operations, not JSON strings:

```ts
interface BotConversationService {
  listBots(input: ListBotsInput): Promise<Page<BotDescriptor>>;
  readBot(botId: BotId): Promise<BotDescriptor>;

  listConversations(input: ListConversationsInput): Promise<Page<BotConversationDescriptor>>;
  createConversation(input: CreateConversationInput): Promise<CreateConversationReceipt>;
  readConversation(input: ReadConversationInput): Promise<BotConversationHydration>;
  updateConversation(input: UpdateConversationInput): Promise<BotConversationDescriptor>;
  archiveConversation(input: RevisionCommand): Promise<BotConversationDescriptor>;
  unarchiveConversation(input: RevisionCommand): Promise<BotConversationDescriptor>;
  deleteConversation(input: RevisionCommand): Promise<void>;

  listMessages(input: ListMessagesInput): Promise<Page<BotMessage>>;
  sendMessage(input: SendBotMessageInput): Promise<SendBotMessageReceipt>;
  cancelExecution(input: CancelBotExecutionInput): Promise<BotExecution>;
  respondToInteraction(input: RespondToBotInteractionInput): Promise<BotInteraction>;
  uploadAttachment(input: UploadBotAttachmentInput): Promise<BotAttachment>;

  subscribe(listener: (event: BotConversationEvent) => void): () => void;
}
```

`AppServerBotConversationClient` is one provider of this service. A local
in-process provider is allowed only if it enters through the same request
handler and codec; UI code must not detect which deployment form is active.

## 17. Acceptance invariants

An implementation is not V1-compliant until all of these pass:

1. Repeating `bot/message/send` with the same `clientMessageId` and payload
   produces one Message; a different payload produces an idempotency conflict.
2. An optimistic human Message and its receipt reconcile to one stable row.
3. `message/started`, all deltas, and `message/completed` retain one stable
   `messageId` and therefore one layout identity.
4. Duplicate `deltaSeq` is ignored; a gap triggers re-hydration.
5. Notifications received during `bot/conversation/read` are buffered and
   applied after its `liveCursor` without a second visible history tree.
6. A changed `epoch` triggers re-hydration.
7. Loading older messages prepends without changing the identity or measured
   geometry of existing messages.
8. Cancelling targets the requested `executionId`, including when several Bots
   execute concurrently.
9. Pending approvals and clarifications survive a page refresh through
   `bot/conversation/read`.
10. Stale Conversation revisions cannot overwrite newer membership.
11. Presence expiry removes activity animation without creating a Message.
12. The public protocol contains no `Turn`, Hermes Session, enterprise service, Electron,
    IndexedDB, React, or transport-provider types.

## 18. Deliberately deferred from V1

- Public journal replay (`bot/events/since`); V1 rehydrates on a sequence gap.
- Cross-Host group Conversations.
- Large multipart and signed attachment upload.
- End-to-end encrypted rooms.
- Federation and server-to-server Bot relay.
- Durable multi-device group authority while the temporary handler runs solely
  in a browser.

These can be added as negotiated extensions without changing the V1 command
words or entity identities.

Clients accept the exact former capability identifier for older Hosts when the
current identifier is absent. A present current declaration is authoritative; an
invalid current version never falls back to a valid older declaration. Generic
`bot/*` methods and conversation identities are unchanged.
