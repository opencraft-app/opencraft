# vela-desktop-shell

Desktop-only shell components for Vela.

This package owns the window-level React shell: desktop sidebar chrome, traffic
light safe areas, drag regions, desktop sidebar material, resize behavior, and
desktop sidebar composition.

It does not start `velad`, fetch chat read models, or render conversation
content. Hosts provide sessions, callbacks, and a `DesktopHostBridge`
implementation.

## Boundary

`vela-desktop-shell` is not the cross-host workbench API.

- Desktop apps may use `VelaDesktopShell` and `SessionSidebar`.
- Web/cloud/mobile hosts should not use `VelaDesktopShell` or `SessionSidebar`.
- Web/cloud/mobile hosts should compose their own host layout and embed
  `SessionListSurface` from `vela-chat-web`.
- Chat content should be rendered through `ChatSurface` from `vela-chat-web`,
  not through this package.

The name rule is intentional: components in this package are desktop shell
components, not generic panels. Avoid adding generic names such as
`SessionPanel` here unless the component is genuinely safe to embed outside the
desktop shell.
