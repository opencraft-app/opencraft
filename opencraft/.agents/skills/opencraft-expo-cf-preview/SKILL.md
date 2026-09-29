---
name: opencraft-expo-cf-preview
description: Start and verify an OpenCraft Expo Go preview through a Cloudflare Quick Tunnel when an iPhone cannot reach local Metro or Expo tunnel discovery is unreliable.
---

# OpenCraft Expo Cloudflare preview

Use this for a temporary development preview of this repository's `apps/workbench-expo`. Keep production deployment, Expo publication, account changes, and native signing outside this workflow.

1. Confirm the Expo workspace builds and the required Node/npm, `cloudflared`, and `curl` commands are available. Use the installed `cloudflared` binary; obtain it from Cloudflare's official release only if the task requires a preview and it is absent.
2. Start `cloudflared tunnel --url http://127.0.0.1:8081 --protocol http2 --no-autoupdate` in a persistent PTY and read the generated `https://…trycloudflare.com` origin from its output. Quick Tunnel URLs are temporary.
3. Start Metro in another persistent PTY from the OpenCraft root with `EXPO_PACKAGER_PROXY_URL=<HTTPS origin> npm run start --workspace @opencraft/workbench-expo -- --go --lan --no-dev --minify`. Use a different free port consistently in both commands if 8081 is occupied. Do not rely on the Expo Go project list or the ngrok tunnel.
4. Run `scripts/verify_preview.sh <HTTPS origin>` from this skill directory. It checks the external iOS manifest, the bundle URL and a complete bundle download. Inspect Metro logs if verification fails; do not send an unverified link.
5. Give the user the `exps://` form of the origin. For iOS, explicitly say to install [Expo Go from the US App Store](https://apps.apple.com/us/app/expo-go/id982107779), paste the `exps://` link into **Safari or another standard browser**, and allow the jump to Expo Go. An in-app chat browser may intercept the link.

Keep both PTYs running while the user tests. If either exits, check its status and issue a fresh URL when the Cloudflare origin changes. Ask for the device screen only after the external manifest and bundle pass; server checks alone cannot prove iOS rendering.

For ordinary JS/TS or style edits, keep the same Metro and Cloudflare Tunnel processes: Metro serves the updated bundle, and the `exps://` URL stays the same while the tunnel is alive. Reload the app in Expo Go and rerun `scripts/verify_preview.sh <HTTPS origin>` before reporting the update; restart only the process that has stopped or needs a changed configuration or port. Native dependency changes still require a compatible app build, beyond a bundle reload.
