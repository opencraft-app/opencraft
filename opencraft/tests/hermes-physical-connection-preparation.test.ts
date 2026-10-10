import assert from "node:assert/strict";
import test from "node:test";
import { HermesPhysicalConnectionPreparation, type HermesPhysicalConnectionBinding } from "../plugins/lightvela-hermes/src/transport/hermes-physical-connection-preparation";
import { LightVelaHermesTransport } from "../plugins/lightvela-hermes/src/transport/lightvela-hermes-transport";
import { TencentTatSessionMultiplexer } from "../plugins/lightvela-hermes/src/lib/tencent-tat-session-multiplexer";

const binding: HermesPhysicalConnectionBinding = { accountId: "user-1", instanceId: "ins-1", region: "cn", apiBase: "https://api.example" };
const bootstrap = { poolId: "pool", sessionId: "session", region: "ap-shanghai", instanceId: "ins-cloud", ownerUin: "1", loginUin: "2", appId: 1, wsUrl: "wss://tat.example/ws", cols: 80, rows: 24 };
class TatSocket {
  static instances: TatSocket[] = [];
  readyState = WebSocket.CONNECTING;
  binaryType: BinaryType = "arraybuffer";
  sent: Array<{ Type: string; Data: Record<string, unknown> }> = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor() {
    TatSocket.instances.push(this);
    queueMicrotask(() => { if (this.readyState !== WebSocket.CONNECTING) return; this.readyState = WebSocket.OPEN; this.onopen?.(new Event("open")); });
  }
  send(data: string) { if (typeof data === "string") this.sent.push(JSON.parse(data)); }
  close() { this.readyState = WebSocket.CLOSED; }
  remoteClose() { this.close(); this.onclose?.({ code: 1006, reason: "lost", wasClean: false } as CloseEvent); }
}
const WebSocketImpl = TatSocket as unknown as typeof WebSocket;
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 5));
function preparation(options: Partial<ConstructorParameters<typeof HermesPhysicalConnectionPreparation>[0]> = {}) {
  return new HermesPhysicalConnectionPreparation({ ...binding, WebSocketImpl, assertAuthority: () => {}, createSession: async () => bootstrap, ...options });
}

test("physical and health configuration belong to the owner, not borrowed mutable options", async () => {
  const options = { ...binding, WebSocketImpl, assertAuthority: () => {}, createSession: async () => bootstrap };
  const owner = new HermesPhysicalConnectionPreparation(options);
  options.accountId = "replaced";
  assert.equal(owner.matches(binding), true);
  const adopted = await owner.claim(binding, undefined, {});
  assert.ok(adopted);
  adopted.proxy.close();

  const healthOptions = Object.freeze({ WebSocketImpl, connectDelayMs: 0 });
  const proxy = new TencentTatSessionMultiplexer(bootstrap, healthOptions);
  await proxy.connect();
  try {
    assert.doesNotThrow(() => proxy.configureIdleKeepalive({ idleKeepaliveIntervalMs: 0 }));
    assert.equal("idleKeepaliveIntervalMs" in healthOptions, false);
  } finally {
    proxy.close();
  }
});

test("preparation starts the physical handshake, never PTY/proxy/RPC, and transfers exactly once", async () => {
  TatSocket.instances = [];
  let sessions = 0;
  const owner = preparation({ createSession: async () => { sessions++; return bootstrap; } });
  await flush();
  assert.equal(sessions, 1);
  assert.equal(TatSocket.instances.length, 1);
  const adopted = await owner.claim(binding, undefined, {});
  assert.ok(adopted);
  assert.deepEqual(TatSocket.instances[0]!.sent.map(frame => frame.Type), ["SessionAuth"]);
  owner.dispose();
  assert.equal(TatSocket.instances[0]!.readyState, WebSocket.OPEN, "old owner cannot retire an adopted resource");
  assert.equal(await owner.claim(binding, undefined, {}), null);
  adopted.proxy.close();
  assert.equal(TatSocket.instances[0]!.readyState, WebSocket.CLOSED);
});

test("wrong account, region, instance or API origin cannot claim another owner's resource", async () => {
  const owner = preparation();
  for (const wrong of [{ accountId: "other" }, { region: "intl" as const }, { instanceId: "other" }, { apiBase: "https://other.example" }]) {
    assert.equal(await owner.claim({ ...binding, ...wrong }, undefined, {}), null);
  }
  const adopted = await owner.claim({ ...binding, apiBase: "https://api.example/" }, undefined, {});
  assert.ok(adopted);
  adopted.proxy.close();
});

test("retirement aborts session creation and discards a late result before opening a socket", async () => {
  TatSocket.instances = [];
  let release!: (value: typeof bootstrap) => void;
  let signal!: AbortSignal;
  const owner = preparation({ createSession: value => { signal = value; return new Promise(resolve => { release = resolve; }); } });
  const claiming = owner.claim(binding, undefined, {});
  owner.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(await claiming, null);
  release(bootstrap);
  await flush();
  assert.equal(TatSocket.instances.length, 0);
});

test("session replacement fences a late claim and closes the prepared socket", async () => {
  TatSocket.instances = [];
  let current = true;
  const owner = preparation({ assertAuthority: () => { if (!current) throw new Error("retired"); } });
  await flush();
  current = false;
  assert.equal(await owner.claim(binding, undefined, {}), null);
  assert.equal(TatSocket.instances[0]!.readyState, WebSocket.CLOSED);
});

test("an aborted formal adoption cannot retain a preparation or block on an unresponsive request", async () => {
  const owner = preparation({ createSession: () => new Promise(() => {}) });
  const controller = new AbortController();
  const claiming = owner.claim(binding, controller.signal, {});
  controller.abort();
  assert.equal(await claiming, null);
});

test("unclaimed preparation expires and closes its socket without ever starting a PTY", async () => {
  TatSocket.instances = [];
  const owner = preparation({ timeoutMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(await owner.claim(binding, undefined, {}), null);
  assert.equal(TatSocket.instances[0]!.readyState, WebSocket.CLOSED);
  assert.deepEqual(TatSocket.instances[0]!.sent.map(frame => frame.Type), ["SessionAuth"]);
});

test("failed creation is an optional miss; a fresh owner can retry independently", async () => {
  const failed = preparation({ createSession: async () => { throw new Error("503"); } });
  assert.equal(await failed.claim(binding, undefined, {}), null);
  const replacement = preparation();
  const adopted = await replacement.claim(binding, undefined, {});
  assert.ok(adopted);
  adopted.proxy.close();
});

test("a prepared socket lost before claim is never handed to a formal Host", async () => {
  TatSocket.instances = [];
  const owner = preparation();
  await flush();
  TatSocket.instances[0]!.remoteClose();
  assert.equal(await owner.claim(binding, undefined, {}), null);
});

test("real transport falls back to ordinary session creation after optional preparation failure", async () => {
  const owner = preparation({ createSession: async () => { throw new Error("optional preparation failed"); } });
  assert.equal(await owner.claim(binding, undefined, {}), null);
  let revalidated = 0;
  const requests: string[] = [];
  const transport = new LightVelaHermesTransport({
    physicalConnection: owner, physicalBinding: binding, WebSocketImpl, connectTimeoutMs: 1500,
    account: {
      getSnapshot: () => ({ phase: "authenticated", activeBotId: "ins-1", authGeneration: 1, credentialScope: "user-1" }),
      subscribe: () => () => {},
      resolveActiveBot: async () => { revalidated++; return { instanceId: "ins-1", status: "running", name: "Main", createdAt: "2026-10-05" }; },
      request: async path => { requests.push(path); throw new Error("ordinary session reached"); },
    },
  });
  try {
    await assert.rejects(transport.connect(), /ordinary session reached/u);
    assert.equal(revalidated, 1);
    assert.deepEqual(requests, ["/v1/instances/ins-1/tat/session"]);
  } finally {
    await transport.close();
  }
});

test("real transport adopts one physical connection, revalidates the instance, then starts Dashboard", async () => {
  TatSocket.instances = [];
  let preparedSessions = 0;
  const owner = preparation({ createSession: async () => { preparedSessions++; return bootstrap; } });
  await flush();
  assert.deepEqual(TatSocket.instances[0]!.sent.map(frame => frame.Type), ["SessionAuth"]);
  let revalidated = 0;
  const transport = new LightVelaHermesTransport({
    physicalConnection: owner, physicalBinding: binding, WebSocketImpl, profile: "sales", connectTimeoutMs: 1500,
    account: {
      getSnapshot: () => ({ phase: "authenticated", activeBotId: "ins-1", authGeneration: 1, credentialScope: "user-1" }),
      subscribe: () => () => {},
      resolveActiveBot: async () => { revalidated++; return { instanceId: "ins-1", status: "running", name: "Main", createdAt: "2026-10-05" }; },
      request: async () => { throw new Error("adoption must not request a second TAT session"); },
    },
  });
  const connected = transport.connect();
  // External TAT stops before replying to PtyStart. The genuine transport must
  // have reached Dashboard only after formal adoption, on the original socket.
  for (let attempt = 0; attempt < 100 && !TatSocket.instances[0]!.sent.some(frame => frame.Type === "PtyStart"); attempt++) await flush();
  assert.equal(revalidated, 1);
  assert.equal(preparedSessions, 1);
  assert.equal(TatSocket.instances.length, 1);
  assert.ok(TatSocket.instances[0]!.sent.some(frame => frame.Type === "PtyStart"));
  const rejected = assert.rejects(connected, /abort|closed|timeout/iu);
  await transport.close();
  await rejected;
  assert.equal(TatSocket.instances[0]!.readyState, WebSocket.CLOSED);
});
