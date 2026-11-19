# Conversations without resetting the assistant

`conversation.create` creates a durable conversation under the same assistant.
The operation uses the ordinary InputInbox transaction: the caller's request ID
is the idempotency key; retrying it returns the original conversation ID. It does
not replace the legacy main conversation, erase history, cancel work, rotate
identity, change resource grants, or reset Markdown memory / learning jobs.
No schema migration is required: the existing conversation table already owns
conversation identities and assistant membership.

The client owns its selected conversation. Send `params.conversationId` on `say`,
`conversation`, `history.search`, `work.overview`, `conversation.context` and
`.retry`, `messages.list`, `message.*`, or `goal.create`. Omitting it retains the
legacy main-conversation behavior. There is deliberately no server-wide mutable
“current conversation”: two clients can address different conversations safely.
`conversation.list` provides ID-ordered pages (`after`, `limit` 1..50).

```sh
node bin/assistant.mjs conversation-new --profile DIR --id stable-new-request
node bin/assistant.mjs say --profile DIR --conversation ID --text 'Hello'
node bin/assistant.mjs conversation --profile DIR --conversation ID
node bin/assistant.mjs conversations --profile DIR
```

ConversationHistory owns creation, membership and canonical messages. InputInbox
owns receipts. Reception captures the conversation in the admitted turn and its
query grant. Context checkpoints use that turn's immutable conversation and
anchor. Work requests capture their origin; later reports return there, including
when other conversations were created while the work ran. Goal extensions inherit
the existing members' conversation. Execution history queries only use linked
conversations. Message payloads, reply targets and interactions are checked in
the original conversation; outbox dispatch processes each stored destination.

Memory remains assistant/user/project scoped under its existing grants; creating
a conversation is not a memory isolation or erasure operation. Work/goal/routine
management by explicit ID remains assistant-wide. Global attention reminders,
standalone routines and event-trigger notifications retain their existing main
conversation routing; this interface does not redefine automation destinations.
There is no archive/delete/switch-all-clients operation and no new remote identity
or multi-human authorization mechanism.

Verification: `test/conversation-lifecycle.test.mjs` covers durable/idempotent
creation, restart, memory retention, queued and late work, report/delivery origin,
message and summary isolation, goal extensions and real CLI/socket use. The
π-Bench bridge maps each official `/new` to this public operation in the same
profile. Its tool environment and native trace integration remain incomplete;
passing conversation tests is not a public benchmark quality score.

Creation returns after its database transaction. It preserves pending memory
learning but does not wait for extraction/review to finish: a new turn can start
before the preceding conversation's automatic facts have been committed. Clients
must not treat the create receipt as a memory-flush or task-completion barrier.
