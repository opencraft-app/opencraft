// Standalone OLD-protocol client (protocolVersion=1, rendererId 'cutover-readonly', no attempt param) —
// the pre-2026-10-22 preflight behavior replica, used ONLY as the legacy negative control against v2 fixtures.
import { createRequire } from "node:module";
const require_ = createRequire(new URL("../../../package.json", import.meta.url)); // this checkout's pinned install
const WebSocket = require_("ws");
const url = process.env.PREFLIGHT_ENDPOINT ?? "ws://127.0.0.1/apphost";
const origin = new URL(url); const host = origin.host;
const ws = new WebSocket(url, { handshakeTimeout: 5000, origin: "http://" + host });
let stage = "connect";
const t0 = Date.now();
ws.on("open", () => { stage = "hello"; ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, rendererId: "cutover-readonly" })); });
ws.on("message", (raw) => { try { const f = JSON.parse(String(raw)); if (f?.type === "fatal") { stage = "protocol-fatal"; } } catch {} });
ws.on("close", () => { console.log(JSON.stringify({ legacyStage: stage, waitMs: Date.now() - t0, closeCodeSeen: true })); process.exit(0); });
ws.on("error", () => {});
setTimeout(() => { console.log(JSON.stringify({ legacyStage: "masked-timeout", waitMs: Date.now() - t0 })); process.exit(4); }, 10000);
