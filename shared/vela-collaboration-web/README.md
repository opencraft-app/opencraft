# Collaboration Web

Shared Human collaboration UI, account scopes and Tencent IM adapters used by the
OpenCraft Collaboration extension and the LightVela Web laboratory. The code is
extracted from the existing extension; `ref/velachat` stays an unchanged upstream
reference. Platform types and messaging contracts come from
`@lightvela/vela-chat-client-core`.

The embedding application owns authentication. Consumers supply a raw request
port; this package neither stores account tokens nor chooses an API environment.
Each scope owns its IM connection, directory, conversations and drafts. Dispose
the previous scope before connecting the next identity. Never share scopes across
accounts or API authorities.

`createCollaborationScope` provides the Web laboratory with the existing Server,
invitation, channel and private-chat capabilities. Computers, Tasks and Reminders
are not enabled. The OpenCraft extension keeps its own activation owner and
existing resource routing through compatibility exports.

The package ships TypeScript source. Frontend consumers must transpile it and
`@lightvela/vela-chat-client-core`, and load `styles.css` inside the lazy panel.

Regression tests remain at `opencraft/plugins/lightvela-collaboration/src` and
exercise the same exported services and adapters.
