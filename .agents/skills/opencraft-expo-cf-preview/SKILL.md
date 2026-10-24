---
name: opencraft-expo-cf-preview
description: Start and verify an OpenCraft Expo Go preview through a Cloudflare Quick Tunnel when an iPhone cannot reach local Metro or Expo tunnel discovery is unreliable.
---

# OpenCraft Expo Cloudflare preview

Use this for a temporary development preview of this repository's `apps/workbench-expo`. Keep production deployment, Expo publication, account changes, and native signing outside this workflow.

1. Confirm the Expo workspace builds and the required Node/npm, `cloudflared`, and `curl` commands are available. Use the installed `cloudflared` binary; obtain it from Cloudflare's official release only if the task requires a preview and it is absent. For a physical iPhone, run `npx expo whoami` first: Expo Go and Expo CLI must be signed in to the same Expo account. If CLI is not signed in, ask the user to complete Expo's login in an interactive terminal or a browser on the CLI host; do not collect passwords or session tokens in chat. The Quick Tunnel link does not bypass this account check.
2. Start `cloudflared tunnel --url http://127.0.0.1:8081 --protocol http2 --no-autoupdate` in a persistent PTY and read the generated `https://…trycloudflare.com` origin from its output. Quick Tunnel URLs are temporary.
3. Start Metro in another persistent PTY from the OpenCraft root with `EXPO_PACKAGER_PROXY_URL=<HTTPS origin> npm run start --workspace @opencraft/workbench-expo -- --go --lan --no-dev --minify`. Use a different free port consistently in both commands if 8081 is occupied. Do not rely on the Expo Go project list or the ngrok tunnel.
4. Run `scripts/verify_preview.sh <HTTPS origin>` from this skill directory. It checks the external iOS manifest and bundle origin without downloading the bundle. Use `--full` only when diagnosing a concrete bundle failure. Inspect Metro logs if the lightweight check fails.
5. Give the user the complete `exps://` URL as plain text on its own line. For iOS, explicitly say to install [Expo Go from the US App Store](https://apps.apple.com/us/app/expo-go/id982107779), paste the URL into **Safari or another standard browser**, and allow the jump to Expo Go. An in-app chat browser may intercept the link. If Expo Go reports a CLI account mismatch, verify `npx expo whoami` and the phone's Expo Go account, then use **Try Again** after signing in; Expo CLI reads a new login on the next request. Restart Metro only if the CLI process cached a different signed-in account.

Keep both PTYs running while the user tests. If either exits, check its status and issue a fresh URL when the Cloudflare origin changes. The manifest check is a link check, not proof that iOS rendered the screen.

For ordinary JS/TS or style edits, keep the same Metro and Cloudflare Tunnel processes: Metro serves the updated bundle, and the `exps://` URL stays the same while the tunnel is alive. Reload the app in Expo Go and rerun the lightweight check before reporting the update; restart only the process that has stopped or needs a changed configuration or port. Native dependency changes still require a compatible app build, beyond a bundle reload.
