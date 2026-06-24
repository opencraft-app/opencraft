# vela-chat-web

React DOM renderer for `ChatRenderModel`.

This package owns visual components and CSS modules only. It does not fetch data, parse OpenAPI wire fields, or build semantic surface state.

## Embeddable surfaces

`vela-chat-web` is the React DOM surface layer, not a desktop shell.

The intended cross-host entry points are feature surfaces such as:

- `ChatSurface`
- `SessionListSurface`

Host apps own layout around these surfaces. A web/cloud/mobile host should bring
its own sidebar, top bar, auth shell, safe-area behavior, and settings page.
Desktop-only chrome such as `VelaDesktopShell`, `SessionSidebar`, traffic
lights, drag regions, and `apps/vela-desktop-electron/src/style.css` must stay
outside this package.
