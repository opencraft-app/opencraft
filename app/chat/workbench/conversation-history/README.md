This folder owns `/chat` demo history loading policy.

It may decide when the demo should preload older `ConversationView` pages or show
a hydration gate. It must not own reusable chat rendering; that stays in
`packages/vela-chat-web`.
