import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, symlink, unlink, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import WebSocket from "ws";
import { SshConnectionStore, hostKeyFingerprint, parseSshConnectionInput } from "../../apps/opencraft-daemon/src/ssh-connection-store.js";
import { SshManagement } from "../../apps/opencraft-daemon/src/ssh-management.js";
import { AppHostServer } from "@opencraft/app-host-server";
import { createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";

function key(host = "fixture.invalid") {
  const alg = Buffer.from("ssh-ed25519"), prefix = Buffer.alloc(4), size = Buffer.alloc(4);
  prefix.writeUInt32BE(alg.length); size.writeUInt32BE(32);
  return `${host} ssh-ed25519 ${Buffer.concat([prefix, alg, size, randomBytes(32)]).toString("base64")}`;
}
const input = { displayName: "Fixture", hostname: "fixture.invalid", port: 22, username: "fixture", enabled: true, workspaceBrowseRoots: ["/remote"], password: "synthetic-password-only" };

test("SSH config and encrypted credential survive restart, never return a secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-ssh-store-"));
  let store = new SshConnectionStore(directory);
  const row = store.save(null, 0, input, key());
  assert.equal(row.revision, 1);
  assert.equal("password" in row, false);
  assert.equal("authentication" in row, false);
  assert.equal(await (store.binding(row.serverId).connection.authentication as any).resolvePassword(), input.password);
  const db = new DatabaseSync(join(directory, "connections.sqlite"));
  const raw = db.prepare("SELECT config_json,credential FROM ssh_connections").get()!;
  assert.doesNotMatch(String(raw.config_json), /password/u);
  assert.equal(Buffer.from(raw.credential as Uint8Array).includes(Buffer.from(input.password)), false);
  db.close(); store.close();
  store = new SshConnectionStore(directory);
  assert.deepEqual(store.list(), [row]);
  assert.equal(await (store.binding(row.serverId).connection.authentication as any).resolvePassword(), input.password);
  store.close();
});

test("SSH CAS guards metadata plus secret; identity cannot silently change", async () => {
  const store = new SshConnectionStore(await mkdtemp(join(tmpdir(), "opencraft-ssh-cas-")));
  try {
    const row = store.save(null, 0, input, key());
    const oldBinding = store.binding(row.serverId);
    const edited = store.save(row.serverId, 1, { ...input, password: undefined, displayName: "Renamed" });
    assert.equal(edited.revision, 2);
    await assert.rejects((oldBinding.connection.authentication as any).resolvePassword(), /conflict/);
    assert.throws(() => store.save(row.serverId, 1, { ...input, password: "not-committed" }), /conflict/u);
    assert.equal(await (store.binding(row.serverId).connection.authentication as any).resolvePassword(), input.password);
    assert.throws(() => store.save(row.serverId, 2, { ...input, hostname: "other.invalid" }, key("other.invalid")), /invalid/u);
    assert.throws(() => store.remove(row.serverId, 1), /conflict/u);
    assert.equal(store.get(row.serverId).displayName, "Renamed");
    store.save(row.serverId, 2, { ...input, password: undefined, enabled: false });
    assert.throws(() => store.binding(row.serverId), /unavailable/u);
    store.remove(row.serverId, 3);
    assert.equal(store.list().length, 0);
  } finally { store.close(); }
});

test("SSH private storage rejects permissive directory and symlink key; unrecognized DB is preserved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-ssh-permissions-"));
  await chmod(directory, 0o755);
  assert.throws(() => new SshConnectionStore(directory), /Private SSH directory/u);
  await chmod(directory, 0o700);
  await symlink("/missing-fixture-key", join(directory, "credential.key"));
  assert.throws(() => new SshConnectionStore(directory));
  const other = await mkdtemp(join(tmpdir(), "opencraft-ssh-unknown-"));
  const db = new DatabaseSync(join(other, "connections.sqlite")); db.exec("CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES('retained')"); db.close();
  await chmod(join(other, "connections.sqlite"), 0o600);
  await writeFile(join(other, "credential.key"), randomBytes(32), { mode: 0o600 });
  assert.throws(() => new SshConnectionStore(other), /Unsupported SSH database baseline/u);
  const preserved = new DatabaseSync(join(other, "connections.sqlite")); assert.equal(preserved.prepare("SELECT value FROM foreign_data").get()!.value, "retained"); preserved.close();
});

test("untrusted/invalid configuration cannot enter the DB", async () => {
  const store = new SshConnectionStore(await mkdtemp(join(tmpdir(), "opencraft-ssh-validation-")));
  try {
    for (const edit of [{ ...input, hostname: "-oProxyCommand=bad" }, { ...input, port: 0 }, { ...input, password: "line\nbreak" }, { ...input, workspaceBrowseRoots: ["relative"] }, { ...input, arbitraryShell: "bad" }]) assert.throws(() => parseSshConnectionInput(edit));
    assert.throws(() => store.save(null, 0, input, key("other.invalid")), /trust/u);
    assert.throws(() => store.save(null, 0, input), /trust/u);
    assert.equal(store.list().length, 0);
  } finally { store.close(); }
});

test("migration history mismatch stops writes without deleting saved connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-ssh-history-"));
  const store = new SshConnectionStore(directory), row = store.save(null, 0, input, key()); store.close();
  const db = new DatabaseSync(join(directory, "connections.sqlite")); db.exec("UPDATE schema_migrations SET checksum='synthetic-mismatch'"); db.close();
  assert.throws(() => new SshConnectionStore(directory), /migration history/);
  const preserved = new DatabaseSync(join(directory, "connections.sqlite"));
  assert.equal(preserved.prepare("SELECT server_id FROM ssh_connections").get()!.server_id, row.serverId); preserved.close();
});

test("missing credential key stops recovery without generating a replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-ssh-key-recovery-"));
  const store = new SshConnectionStore(directory), row = store.save(null, 0, input, key()); store.close();
  const keyPath = join(directory, "credential.key"); await unlink(keyPath);
  assert.throws(() => new SshConnectionStore(directory)); await assert.rejects(access(keyPath));
  const preserved = new DatabaseSync(join(directory, "connections.sqlite"));
  assert.equal(preserved.prepare("SELECT server_id FROM ssh_connections").get()!.server_id, row.serverId); preserved.close();
});

async function fixture(context: any, sessionTtlMs?: number, publicAccess = false, beforeReset?: () => Promise<void>, beforeConnect?: () => Promise<void>, accessMode: "shared" | "access-key" = "access-key") {
  const root = await mkdtemp(join(tmpdir(), "opencraft-ssh-http-"));
  const calls: string[] = [], resets: string[] = [];
  const appHost = new AppHostServer({ physicalHostLifetime: "server", createTransport: host => {
    calls.push(host);
    return { status: { state: "open" as const }, async connect() {}, async send() {}, subscribeMessage() { return () => undefined; }, subscribeStatus() { return () => undefined; }, async close() {} };
  } });
  const hostKey = key();
  const management = new SshManagement({ directory: join(root, "private"), sessionTtlMs, publicAccess, ...(accessMode === "access-key" ? { accessMode } : {}),
    scanHostKey: async () => hostKey, resetConnection: async id => { resets.push(id); await beforeReset?.(); await appHost.resetHost(id); }, connectConnection: async (id, assertAdmission) => { await beforeConnect?.(); await appHost.ensureHostConnected(id, assertAdmission); }, connectionState: id => appHost.hostState(id) });
  const web = await createWorkbenchWebServer({ root, loopbackOnly: !publicAccess, appServerTarget: null, appHostServer: appHost, sshManagement: management, webSocketHeartbeatIntervalMs: 20, onAppHostDiagnostic: () => undefined });
  const address = await web.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  let cookie = "";
  const request = async (path: string, method = "GET", data?: unknown, foreignOrigin?: string) => {
    const response = await fetch(`${origin}/__opencraft_ssh/${path}`, { method, headers: { origin: foreignOrigin ?? origin, cookie, "content-type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(data ?? {}) }) });
    return { response, value: await response.json() as any };
  };
  const unlock = async () => {
    const data = accessMode === "access-key" ? { accessKey: await readFile(join(root, "private/access.key"), "utf8") } : {};
    const result = await request("session", "POST", data);
    assert.equal(result.response.status, 200);
    cookie = result.response.headers.get("set-cookie")!.split(";")[0]!;
    assert.match(result.response.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/u);
    return cookie;
  };
  const add = async () => {
    const trust = (await request("trust", "POST", { hostname: input.hostname, port: input.port })).value;
    assert.equal(trust.fingerprint, hostKeyFingerprint(hostKey));
    return (await request("connections", "POST", { revision: 0, input, ...trust })).value;
  };
  context.after(async () => { await web.close(); await appHost.close(); management.close(); });
  return { request, unlock, add, origin, management, calls, resets, root };
}

test("default shared admission needs no key but still requires an origin-bound session", async context => {
  const f = await fixture(context, undefined, false, undefined, undefined, "shared");
  assert.equal(f.management.accessMode, "shared");
  await assert.rejects(access(join(f.root, "private/access.key")), { code: "ENOENT" });
  assert.deepEqual((await f.request("session")).value, { available: true, authenticated: false, accessMode: "shared" });
  assert.equal((await f.request("connections")).response.status, 401);
  assert.equal((await f.request("session", "POST", {}, "https://foreign.invalid")).response.status, 403);
  const cookie = await f.unlock(); const row = await f.add();
  assert.equal((await f.request("session")).value.authenticated, true);
  assert.equal((await f.request("connections")).value[0].serverId, row.serverId);
  assert.equal((await f.request("connections", "GET", undefined, "https://foreign.invalid")).response.status, 403);
  await f.request("session", "DELETE");
  assert.equal((await f.request("connections")).response.status, 401);
  assert.notEqual(await f.unlock(), cookie);
  assert.equal((await f.request("connections")).value[0].fingerprint, row.fingerprint);
  assert.deepEqual(f.calls, [], "session renewal must not dial SSH");
});

test("shared expiry can renew without a key and restart preserves credentials but not sessions", async context => {
  const f = await fixture(context, 20, false, undefined, undefined, "shared");
  const cookie = await f.unlock();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await f.request("session")).value.authenticated, false);
  assert.notEqual(await f.unlock(), cookie);
  const directory = await mkdtemp(join(tmpdir(), "opencraft-shared-restart-"));
  const options = { directory, resetConnection: async () => {}, connectConnection: async () => {} };
  let management = new SshManagement(options);
  const row = management.store.save(null, 0, input, key()); management.close();
  management = new SshManagement(options);
  try {
    assert.deepEqual(management.store.list(), [row]);
    assert.equal(await (management.store.binding(row.serverId).connection.authentication as any).resolvePassword(), input.password);
    assert.equal(management.authorized({ headers: { host: "127.0.0.1", cookie } } as any), false);
    await assert.rejects(access(join(directory, "access.key")), { code: "ENOENT" });
  } finally { management.close(); }
});

for (const revokedBy of ["logout", "configuration"] as const) {
  test(`SSH connect rechecks ${revokedBy} at delayed physical admission`, async context => {
    let entered!: () => void; let release!: () => void;
    const enteredConnect = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(context, undefined, false, undefined, async () => { entered(); await gate; });
    await f.unlock(); const row = await f.add();
    const pending = f.request(`connections/${row.serverId}/connect`, "POST", { revision: row.revision });
    try {
      await enteredConnect;
      if (revokedBy === "logout") await f.request("session", "DELETE");
      else f.management.store.save(row.serverId, row.revision, { ...input, password: undefined, enabled: false });
    } finally { release(); }
    const result = await pending;
    assert.equal(result.response.status, revokedBy === "logout" ? 401 : 409);
    assert.deepEqual(f.calls, []);
  });
  test(`SSH reconnect rechecks ${revokedBy} after the close barrier before successor admission`, async context => {
    let entered!: () => void; let release!: () => void;
    const enteredReset = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(context, undefined, false, async () => { entered(); await gate; });
    await f.unlock(); const row = await f.add();
    const pending = f.request(`connections/${row.serverId}/reconnect`, "POST", { revision: row.revision });
    try {
      await enteredReset;
      if (revokedBy === "logout") await f.request("session", "DELETE");
      else f.management.store.save(row.serverId, row.revision, { ...input, password: undefined, enabled: false });
    } finally { release(); }
    const result = await pending;
    assert.equal(result.response.status, revokedBy === "logout" ? 401 : 409);
    assert.deepEqual(f.calls, [], "revoked admission must not construct a physical transport");
  });
}

test("absent SSH management is an explicit API 404, never the SPA fallback", async context => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-ssh-absent-"));
  await writeFile(join(root, "index.html"), "<html>synthetic SPA fallback</html>");
  const web = await createWorkbenchWebServer({ root, loopbackOnly: true, appServerTarget: null });
  context.after(() => web.close()); const address = await web.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${origin}/__opencraft_ssh/session`);
  assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: "missing" });
  assert.match(await (await fetch(`${origin}/settings/example`, { headers: { accept: "text/html" } })).text(), /synthetic SPA fallback/);
});

test("management requires server session, exact Origin, explicit fingerprint and CAS", async context => {
  const f = await fixture(context);
  assert.equal((await f.request("connections")).response.status, 401);
  assert.equal((await f.request("session", "POST", { accessKey: "wrong" })).response.status, 401);
  await f.unlock();
  assert.equal((await f.request("connections", "POST", { revision: 0, input })).response.status, 409);
  assert.equal((await f.request("trust", "POST", { hostname: input.hostname, port: 22 }, "https://foreign.invalid")).response.status, 403);
  const row = await f.add();
  assert.match(row.serverId, /^ssh:/u);
  const list = (await f.request("connections")).value;
  assert.equal(list[0].state, "idle");
  assert.equal("password" in list[0], false);
  assert.equal((await f.request(`connections/${row.serverId}/connect`, "POST", { revision: 0 })).response.status, 409);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.request(`connections/${row.serverId}/connect`, "POST", { revision: 1 })).response.status, 200);
  assert.equal((await f.request("connections")).value[0].state, "open");
  assert.deepEqual(f.calls, [row.serverId], "explicit connect does not require a chat target or Client lease");
  assert.equal((await f.request(`connections/${row.serverId}`, "PUT", { revision: 0, input })).response.status, 409);
  assert.equal((await f.request(`connections/${row.serverId}/reconnect`, "POST", { revision: 1 })).response.status, 200);
  assert.deepEqual(f.resets, [row.serverId]);
  assert.deepEqual(f.calls, [row.serverId, row.serverId], "reconnect establishes a successor, not only a reset");
  assert.equal((await f.request("connections")).value[0].state, "open");
});

test("anonymous AppHost cannot guess SSH ID; logout revokes an established remote socket", async context => {
  const f = await fixture(context);
  const cookie = await f.unlock(), row = await f.add();
  const anonymous = new WebSocket(`${f.origin.replace("http", "ws")}/apphost`, { origin: f.origin });
  context.after(() => anonymous.terminate()); await once(anonymous, "open");
  let reply = once(anonymous, "message"); anonymous.send(JSON.stringify({ type: "hello", rendererId: "pretend-admin", protocolVersion: 2 })); await reply;
  reply = once(anonymous, "message"); anonymous.send(JSON.stringify({ type: "host/connect", hostId: row.serverId, requestId: "blocked", leaseId: "lease" }));
  const denied = JSON.parse(String((await reply)[0])); assert.equal(denied.ok, false); assert.equal(f.calls.length, 0);
  const socket = new WebSocket(`${f.origin.replace("http", "ws")}/ssh-apphost`, { origin: f.origin, headers: { cookie } });
  context.after(() => socket.terminate()); await once(socket, "open");
  reply = once(socket, "message"); socket.send(JSON.stringify({ type: "hello", rendererId: "same-non-principal", protocolVersion: 2 })); await reply;
  const frames: any[] = []; socket.on("message", raw => frames.push(JSON.parse(String(raw))));
  socket.send(JSON.stringify({ type: "host/connect", hostId: row.serverId, requestId: "allowed", leaseId: "lease" }));
  while (!frames.some(frame => frame.requestId === "allowed")) await once(socket, "message");
  assert.equal(frames.find(frame => frame.requestId === "allowed").ok, true);
  assert.deepEqual(f.calls, [row.serverId]);
  const closed = once(socket, "close"); await f.request("session", "DELETE");
  assert.equal((await closed)[0], 1008);
  assert.equal((await f.request("connections")).response.status, 401);
});

test("session expiry closes an established remote socket and denies a new upgrade", async context => {
  const f = await fixture(context, 300);
  const cookie = await f.unlock();
  const socket = new WebSocket(`${f.origin.replace("http", "ws")}/ssh-apphost`, { origin: f.origin, headers: { cookie } });
  socket.on("error", () => undefined); context.after(() => socket.terminate());
  await once(socket, "open"); const closed = once(socket, "close");
  assert.equal((await closed)[0], 1008);
  const denied = new WebSocket(`${f.origin.replace("http", "ws")}/ssh-apphost`, { origin: f.origin, headers: { cookie } });
  denied.on("error", () => undefined); context.after(() => denied.terminate());
  const status = await new Promise<number>(resolve => denied.once("unexpected-response", (request, response) => { resolve(response.statusCode!); response.resume(); request.destroy(); }));
  assert.equal(status, 403); assert.deepEqual(f.calls, []);
});

test("trust challenge is session-scoped; logout during a slow body rejects persistence", async context => {
  const f = await fixture(context);
  await f.unlock();
  const trust = (await f.request("trust", "POST", { hostname: input.hostname, port: 22 })).value;
  const cookie = await f.unlock();
  assert.equal((await f.request("connections", "POST", { revision: 0, input, ...trust })).response.status, 409);
  const currentTrust = (await f.request("trust", "POST", { hostname: input.hostname, port: 22 })).value;
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  const encoded = JSON.stringify({ revision: 0, input, ...currentTrust });
  const request = Readable.from((async function* () { yield Buffer.from(encoded.slice(0, 1)); await gate; yield Buffer.from(encoded.slice(1)); })());
  Object.assign(request, { method: "POST", url: "/__opencraft_ssh/connections", headers: { origin: f.origin, host: new URL(f.origin).host, cookie, "content-type": "application/json" } });
  let status = 0;
  const processing = f.management.handle(request as any, { writeHead(code: number) { status = code; }, end() {} } as any);
  await f.request("session", "DELETE"); finish(); await processing;
  assert.equal(status, 401); assert.equal(f.management.store.list().length, 0);
});

test("fixed-origin public access remains strict and never trusts forwarded headers", async () => {
  assert.throws(() => new SshManagement({ directory: "/not-created", publicOrigin: "http://fixture.invalid", resetConnection: async () => undefined, connectConnection: async () => undefined }), /HTTPS/u);
  const management = new SshManagement({ directory: await mkdtemp(join(tmpdir(), "opencraft-ssh-origin-")), publicOrigin: "https://fixture.invalid", resetConnection: async () => undefined, connectConnection: async () => undefined });
  try {
    assert.equal(management.sameOrigin({ headers: { origin: "https://foreign.invalid", "x-forwarded-host": "fixture.invalid" } } as any, true), false);
    assert.equal(management.sameOrigin({ headers: { origin: "https://fixture.invalid" } } as any, true), true);
  } finally { management.close(); }
});

for (const accessMode of ["shared", "access-key"] as const) {
test(`flexible ${accessMode} admission binds each HTTP/WS session to its origin`, async context => {
  const f = await fixture(context, undefined, true, undefined, undefined, accessMode);
  assert.equal((await f.request("connections")).response.status, 401);
  if (accessMode === "access-key") assert.equal((await f.request("session", "POST", { accessKey: "wrong" }, "https://one.invalid")).response.status, 401);
  assert.equal((await f.request("session", "POST", {}, "null")).response.status, 403);
  assert.equal(f.management.sameOrigin({ headers: { origin: "https://one.invalid", "sec-fetch-site": "cross-site" } } as any, true), false);
  const data = accessMode === "access-key" ? { accessKey: await readFile(join(f.management.options.directory, "access.key"), "utf8") } : {};
  const url = `${f.origin}/__opencraft_ssh`;
  const login = async (origin: string) => {
    const response = await fetch(`${url}/session`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(data) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie")!, /; Secure/u);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  const one = await login("https://one.invalid"), two = await login("https://two.invalid");
  for (const [origin, cookie] of [["https://one.invalid", one], ["https://two.invalid", two]]) {
    assert.equal((await fetch(`${url}/connections`, { headers: { origin, cookie } })).status, 200);
    const socket = new WebSocket(`${f.origin.replace("http", "ws")}/ssh-apphost`, { origin, headers: { cookie } });
    await once(socket, "open"); socket.close(); await once(socket, "close");
  }
  assert.equal((await fetch(`${url}/connections`, { headers: { origin: "https://two.invalid", cookie: one } })).status, 401);
  assert.equal((await fetch(`${url}/connections`, { headers: { cookie: one } })).status, 200, "same-origin GET may omit Origin, while cookie remains HttpOnly/SameSite");
  const crossed = new WebSocket(`${f.origin.replace("http", "ws")}/ssh-apphost`, { origin: "https://two.invalid", headers: { cookie: one } });
  await once(crossed, "error");
  const plain = await f.request("session", "POST", data);
  assert.equal(plain.response.status, 200);
  assert.doesNotMatch(plain.response.headers.get("set-cookie")!, /; Secure/u, "explicit plain-HTTP access is usable, not silently pinned to HTTPS");
});
}

test("shared default preserves an existing key; explicit access file enables protection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-access-mode-"));
  const options = { directory, resetConnection: async () => {}, connectConnection: async () => {} };
  let management = new SshManagement({ ...options, accessMode: "access-key" }); management.close();
  const accessPath = join(directory, "access.key"), before = await readFile(accessPath);
  management = new SshManagement(options);
  try { assert.equal(management.accessMode, "shared"); assert.equal((await readFile(accessPath)).equals(before), true); }
  finally { management.close(); }
  management = new SshManagement({ ...options, accessFile: accessPath });
  try { assert.equal(management.accessMode, "access-key"); }
  finally { management.close(); }
});


test("repeat shared grants reuse capacity and HTTP/HTTPS cookies remain origin-bound", async context => {
  const f = await fixture(context, undefined, true, undefined, undefined, "shared");
  const grant = async (origin: string, cookie = "") => {
    const response = await fetch(`${f.origin}/__opencraft_ssh/session`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  const httpOrigin = "http://join.fixture.invalid", httpsOrigin = "https://join.fixture.invalid";
  const httpCookie = await grant(httpOrigin);
  assert.match(httpCookie, /^opencraft_ssh_session_http=/u);
  for (let i = 0; i < 70; i++) assert.equal(await grant(httpOrigin, httpCookie), httpCookie);
  const ambiguous = await fetch(`${f.origin}/__opencraft_ssh/session`, { headers: { cookie: httpCookie } });
  assert.deepEqual(await ambiguous.json(), { available: true, authenticated: true, accessMode: "shared", authenticatedOrigin: httpOrigin },
    "a referrer-free status read identifies the HTTP grant instead of implying it authorizes HTTPS");
  const denied = new WebSocket(`${f.origin.replace("http", "ws")}/ssh-apphost`, { origin: httpsOrigin, headers: { cookie: httpCookie } });
  await once(denied, "error");
  const httpsCookie = await grant(httpsOrigin, httpCookie);
  assert.match(httpsCookie, /^opencraft_ssh_session_https=/u);
  const cookies = `${httpCookie}; ${httpsCookie}`;
  for (const origin of [httpOrigin, httpsOrigin]) {
    const r = await fetch(`${f.origin}/__opencraft_ssh/session`, { headers: { cookie: cookies, referer: `${origin}/conversation` } });
    assert.deepEqual(await r.json(), { available: true, authenticated: true, accessMode: "shared", authenticatedOrigin: origin });
  }
  const wrong = await fetch(`${f.origin}/__opencraft_ssh/session`, { headers: { cookie: httpCookie, referer: `${httpsOrigin}/conversation` } });
  assert.equal((await wrong.json() as any).authenticated, false);
  for (const legacy of [httpCookie.replace("_http=", "="), "opencraft_ssh_session=stale"]) {
    const status = await fetch(`${f.origin}/__opencraft_ssh/session`, { headers: { cookie: `${legacy}; ${cookies}` } });
    assert.deepEqual(await status.json(), { available: true, authenticated: true, accessMode: "shared", authenticatedOrigin: httpsOrigin },
      "legacy cookies must not mask a valid current protocol grant when Referer is absent");
    assert.equal((await fetch(`${f.origin}/__opencraft_ssh/connections`, { headers: { cookie: `${legacy}; ${cookies}` } })).status, 200);
  }
  assert.equal(await grant(httpOrigin, cookies), httpCookie);
  assert.equal(await grant(httpsOrigin, cookies), httpsCookie);
  assert.deepEqual(f.calls, [], "grant renewal performs no SSH execution");
});


test("new conversation visibility persists in legacy JSON records without resetting an open connection", async context => {
  const f = await fixture(context);
  await f.unlock(); const row = await f.add();
  const before = f.management.store.binding(row.serverId);
  const result = await f.request(`connections/${row.serverId}`, "PUT", { revision: row.revision,
    input: { ...input, password: undefined, hideFromNewChat: true } });
  assert.equal(result.response.status, 200);
  assert.equal(result.value.hideFromNewChat, true);
  assert.deepEqual(f.resets, [], "display preference must leave the physical connection and existing executions alone");
  const views = (await f.request("connections")).value;
  assert.equal(views[0].hideFromNewChat, true);
  assert.equal(f.management.store.binding(row.serverId).descriptor.hideFromNewChat, true);
  // A legacy editor omits this field; its unrelated edit cannot erase the setting.
  const legacy = f.management.store.save(row.serverId, result.value.revision, { ...input, password: undefined, displayName: "renamed" });
  assert.equal(legacy.hideFromNewChat, true);
  assert.equal(await (f.management.store.binding(row.serverId).connection.authentication as any).resolvePassword(), input.password);
  assert.equal(before.descriptor.serverId, legacy.serverId);
  assert.throws(() => parseSshConnectionInput({ ...input, hideFromNewChat: "true" }));
  const unhidden = await f.request(`connections/${row.serverId}`, "PUT", { revision: legacy.revision,
    input: { ...input, password: undefined, displayName: "renamed", hideFromNewChat: false } });
  assert.equal(unhidden.value.hideFromNewChat, false);
  assert.deepEqual(f.resets, []);
});

test("new conversation visibility survives reopening pre-existing SSH storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-ssh-visibility-"));
  let store = new SshConnectionStore(directory);
  const row = store.save(null, 0, input, key());
  store.close();
  store = new SshConnectionStore(directory);
  assert.equal(store.get(row.serverId).hideFromNewChat, undefined);
  store.save(row.serverId, row.revision, { ...input, password: undefined, hideFromNewChat: true });
  store.close();
  store = new SshConnectionStore(directory);
  try {
    assert.equal(store.get(row.serverId).hideFromNewChat, true);
    assert.equal(await (store.binding(row.serverId).connection.authentication as any).resolvePassword(), input.password);
  } finally { store.close(); }
});
