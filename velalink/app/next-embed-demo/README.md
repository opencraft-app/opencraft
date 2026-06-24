# Next Embed Demo

This route demonstrates how a normal Next.js host page embeds Vela Chat without depending on the `/chat` debug workbench or the Electron desktop shell.

Open it with:

```text
/next-embed-demo?session_id=<session_id>
```

The demo page owns the surrounding shell. `VelaNextChat` owns only the session controller and the embedded ChatUI.
