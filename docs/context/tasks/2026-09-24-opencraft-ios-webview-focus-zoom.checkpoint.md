## stage
Source, local Web build and authorized test-server deployment complete; iPhone WeChat/WeCom validation remains.

## verified
- Mobile viewport metadata now requests maximum scale 1 and disables user scaling.
- Coarse-pointer phone text fields and editable content have a 16px floor; desktop Composer stays 14px.
- Focused tests and Web release build pass; iPhone 17 simulator Safari focus keeps the page geometry stable.
- The fixture HTTP server and iPhone 17 simulator used for validation were stopped afterward.
- Native Linux build `20260924103545-79a7c75e1202` passed isolated archive smoke and ran on the 9.135.92.56 test server at that time. Direct and proxied HTML carried the viewport lock; WebUI and Codex AppHost smoke passed. Later preview releases superseded it.

## unverified
- WeChat and WeCom on a physical iPhone have not been tested.
- A second full-page iPhone Simulator pass was interrupted by the Mac lock screen; no visible result was obtained from that pass.

## discard
- Earlier Mac trackpad smart-zoom diagnosis; the user clarified the device is an iPhone running embedded Web browsers.

## restore
- Source: `opencraft/apps/workbench-web/index.html`, `opencraft/apps/workbench-web/src/styles/app.scss`, `opencraft/tests/typography-system.test.ts`.
- Formal design: `opencraft/docs/platform-architecture.md` and `docs/engineering/domains/agent-gateway-runtime.md`.
- The Linux service privilege change is documented by its own headless-server task pack; it is not part of this iOS UI fix.

## next_action
- Ask the user to reload the new build on iPhone WeChat and WeCom and check focus and pinch gestures; investigate only if one embedded browser still zooms unexpectedly.
