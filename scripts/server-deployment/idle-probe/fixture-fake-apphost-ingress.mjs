// Fake AppHost ingress (r2) — sends the REAL AppHostToRenderer envelope:
//   client->server: {type:"host/send", requestId:"send<id>", hostId, leaseId, generation, frame:<json-string>}
//   server ACK:     {type:"response", requestId:"send<id>", ok:[true|false], error?}
//   server result:  {type:"host/frame", hostId, generation, leaseId, frame:<json-string>} with {id, result|error}
// ACK is sent FIRST, the native result is DELAYED (settle order matters). Scenarios via argv[2]:
//   idle | active | unknown-status | missing-status | malformed-list | rpc-error | send-ack-fail |
//   foreign-lease | close-after-hello | fatal-always
// ws resolved from this candidate's .deps root (own-lock pinned ws@8.22.0).
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
const require_ = createRequire(new URL("../../../package.json", import.meta.url)); // this checkout's pinned install
const { WebSocketServer } = require_("ws");

const SCENARIO = process.argv[2] ?? "idle";
const PORT = Number(process.env.FIXTURE_PORT ?? 0);
const server = createServer((req, res) => { res.writeHead(404); res.end(); });
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const delay = (ms) => new Promise((ok) => setTimeout(ok, ms));

// anomalies live on the SECOND loaded thread: an implementation that only reads the first must fail
function statusFor(i) {
  if (SCENARIO === "active") return i === 1 ? "active" : "idle";
  if (SCENARIO === "unknown-status") return i === 1 ? "weird-custom" : "idle";
  if (SCENARIO === "missing-status") return i === 1 ? undefined : "idle";
  return "idle";
}
const LIST = ["thread-1", "thread-2"];

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  if (u.pathname !== "/apphost") { socket.destroy(); return; }
  const attemptParam = u.searchParams.get("attempt");
  const connectionId = attemptParam && uuidPattern.test(attemptParam) ? attemptParam : randomUUID();
  wss.handleUpgrade(req, socket, head, (client) => {
    let ready = false, generation = 1, lease = null;
    if (SCENARIO === "close-after-hello") { /* handled at hello */ }
    client.on("message", async (raw) => {
      let f; try { f = JSON.parse(String(raw)); } catch { return; }
      if (SCENARIO === "fatal-always") {
        client.send(JSON.stringify({ type: "fatal", error: { code: "APP_HOST_PROTOCOL_MISMATCH", message: "fixture-forced" } }));
        client.close(1008); return;
      }
      if (f.type === "hello") {
        if (SCENARIO === "close-after-hello") { client.close(1002); return; }
        if (ready) return;
        if (f.protocolVersion !== 2) {
          client.send(JSON.stringify({ type: "fatal", error: { code: "APP_HOST_PROTOCOL_MISMATCH", message: "Client and server versions are incompatible." } }));
          client.close(1008); return;
        }
        ready = true;
        client.send(JSON.stringify({ type: "ready", protocolVersion: SCENARIO === "ready-v1" ? 1 : 2 }));
        return;
      }
      if (f.type === "host/connect") {
        if (!ready) { client.close(1008); return; }
        if (typeof f.leaseId === "string" && f.leaseId) lease = f.leaseId; // echo the client's lease in later host/frame envelopes
        client.send(JSON.stringify({ type: "response", requestId: f.requestId ?? "connect", ok: true, result: { generation } }));
        return;
      }
      if (f.type === "host/disconnect") { client.send(JSON.stringify({ type: "response", requestId: f.requestId ?? "disconnect", ok: true, result: null })); return; }
      if (f.type === "host/send" && typeof f.frame === "string") {
        let inner; try { inner = JSON.parse(f.frame); } catch { return; }
        const ack = (ok, error) => client.send(JSON.stringify({ type: "response", requestId: f.requestId, ok, ...(error ? { error } : {}) }));
        if (!ready || typeof f.leaseId !== "string" || !f.leaseId || f.hostId !== "local-codex" || f.generation !== generation) return ack(false, { code: -32000, message: "bad host frame" });
        if (SCENARIO === "send-ack-fail") return ack(false, { code: -32001, message: "forced send failure" });
        ack(true); // success ACK first; result arrives LATER in the real envelope
        await delay(25);
        // per-field negative envelopes: exactly ONE field wrong/absent per scenario
        let envGen = generation, envLease = lease, hostId = "local-codex";
        if (SCENARIO === "foreign-lease") envLease = "foreign-lease-id";           // lease wrong, all else correct
        if (SCENARIO === "foreign-generation") envGen = generation + 1;            // generation wrong, all else correct
        if (SCENARIO === "missing-lease") envLease = undefined;                    // lease absent, all else correct
        if (SCENARIO === "foreign-host") hostId = "other-host";                    // owner wrong, all else correct
        const post = (payload, extra = {}) => client.send(JSON.stringify({
          type: "host/frame", hostId, generation: envGen,
          ...(envLease !== undefined ? { leaseId: envLease } : {}),
          frame: JSON.stringify({ id: inner.id, ...extra, ...payload }),
        }));
        if (inner.method === "initialize") return post({ result: { capabilities: {} } });
        if (SCENARIO === "rpc-error") return post({ error: { code: -32002, message: "forced rpc failure" } });
        if (inner.method === "thread/loaded/list") return SCENARIO === "malformed-list" ? post({ result: { data: "not-an-array" } }) : post({ result: { data: LIST } });
        if (inner.method === "thread/read") { const i = inner.params?.threadId === "thread-1" ? 0 : 1; return post({ result: { thread: { id: inner.params?.threadId, status: statusFor(i) } } }); }
        return post({ error: { code: -32601, message: "unexpected method" } });
      }
    });
  });
});
server.listen(PORT, "127.0.0.1", () => console.log("FIXTURE_PORT=" + server.address().port));
