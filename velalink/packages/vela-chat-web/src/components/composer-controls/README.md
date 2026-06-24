# components/composer-controls

Change here when the composer toolbar needs session capability controls such as model,
reasoning effort, permission mode, or provider features.

Do not:
- Fetch velad data here.
- Submit chat messages here.
- Encode provider-native RPC names.

Depends on:
- `vela-chat-client` wire types
- `styles`

Used by:
- `components/composer`
