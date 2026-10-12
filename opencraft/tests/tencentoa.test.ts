import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import WebSocket from "ws";
import { AppHostServer } from "@opencraft/app-host-server";
import { TencentOaServerPlugin } from "../plugins/tencentoa/src/server";
import { TencentOaController } from "../plugins/tencentoa/src/controller";
import { createWorkbenchWebServer } from "../scripts/serve-workbench-web.mjs";
import { Context } from "@deepseek-ai/cordis";
import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import { AuthenticationService, AUTHENTICATION_PROVIDER_CHANNEL } from "@opencraft/workbench-runtime";
import { createTencentOaExtension } from "../plugins/tencentoa/src/index";
import { TENCENTOA_PROVIDER_ID } from "../plugins/tencentoa/src/contract";
import { authenticationProviderAdapter } from "../apps/workbench-web/src/runtime/authentication-contributions";
import { PlatformAccountContributionRegistry } from "../apps/workbench-web/src/runtime/platform-account-contributions";
import { createTencentOaAccountContribution } from "../plugins/tencentoa/src/account";
import type { PlatformAccountContribution } from "@opencraft/extension-react";

function identityOnlyController(fetcher: typeof fetch, now?: () => number): TencentOaController {
  return new TencentOaController((async (url, options) => String(url).includes("/photo/")
    ? new Response("", { status: 404 }) : await fetcher(url, options)) as typeof fetch, now);
}

const token = Buffer.alloc(32, 97);
const now = Date.parse("2026-10-06T00:00:00Z");
function request(payload: unknown = { LoginName: "employee.one", StaffId: 123, Expiration: new Date(now + 60_000).toISOString(), open_id: "must-not-project" }, algorithm: unknown = { alg: "dir", enc: "A256GCM" }) {
  const protectedPart = Buffer.from(JSON.stringify(algorithm)).toString("base64url");
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", token, iv);
  cipher.setAAD(Buffer.from(protectedPart));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  const timestamp = String(now / 1000);
  const signature = createHash("sha256").update(timestamp + token.toString() + "sequence,,," + timestamp).digest("hex").toUpperCase();
  return { headers: { timestamp, signature, "x-rio-seq": "sequence", "x-tai-identity": [protectedPart, "", iv.toString("base64url"), encrypted.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".") } };
}
test("verified identity is minimal and request-local; close revokes recognition", () => {
  const plugin = new TencentOaServerPlugin(token, { now: () => now });
  assert.deepEqual(plugin.authenticate(request()), { loginName: "employee.one", staffId: "123", expiresAt: new Date(now + 60_000).toISOString() });
  assert.equal(plugin.authenticate(request({ loginname: "employee.two", staffid: 456, expiration: new Date(now + 60_000).toISOString() }))?.staffId, "456");
  assert.equal(plugin.authenticate(request())?.staffId, "123");
  plugin.close();
  assert.equal(plugin.authenticate(request()), null);
});
test("signature, timestamp, authenticated encryption and duplicate headers fail closed", () => {
  const plugin = new TencentOaServerPlugin(token, { now: () => now });
  for (const name of ["signature", "timestamp", "x-rio-seq", "x-tai-identity"] as const) {
    const value = request(); value.headers[name] += "x";
    assert.equal(plugin.authenticate(value), null, name);
  }
  assert.equal(plugin.authenticate({ ...request(), rawHeaders: ["TIMESTAMP", "1", "timestamp", "2"] }), null);
  const parts = request(); parts.headers["x-tai-identity"] = parts.headers["x-tai-identity"].slice(0, -2) + "AA";
  assert.equal(plugin.authenticate(parts), null);
  assert.equal(plugin.authenticate(request(undefined, { alg: "dir", enc: "A256GCM", zip: "DEF" })), null);
  assert.equal(plugin.authenticate(request(undefined, { alg: "dir", enc: "A256GCM", crit: [] })), null);
  assert.equal(new TencentOaServerPlugin(Buffer.alloc(32, 98), { now: () => now }).authenticate(request()), null);
  assert.equal(new TencentOaServerPlugin(token, { now: () => now + 181_000 }).authenticate(request()), null);
  plugin.close();
});
test("payload aliases, types and calendar dates are validated", () => {
  const plugin = new TencentOaServerPlugin(token, { now: () => now });
  const valid = { LoginName: "employee", StaffId: 1, Expiration: new Date(now + 60_000).toISOString() };
  for (const payload of [null, [], { ...valid, loginname: "other" }, { ...valid, StaffId: "1" }, { ...valid, StaffId: -1 }, { ...valid, LoginName: "<script>" }, { ...valid, Expiration: "2026-02-30T00:00:00Z" }, { ...valid, Expiration: new Date(now - 180_001).toISOString() }]) {
    assert.equal(plugin.authenticate(request(payload)), null);
  }
  assert.ok(plugin.authenticate(request({ ...valid, Expiration: new Date(now - 180_000).toISOString() })));
  plugin.close();
});
test("private token files reject shared permissions and symlinks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tencentoa-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "token");
  await writeFile(path, Buffer.concat([token, Buffer.from("\n")]), { mode: 0o600 });
  const plugin = await TencentOaServerPlugin.fromTokenFile(path); plugin.close();
  await chmod(path, 0o644);
  await assert.rejects(TencentOaServerPlugin.fromTokenFile(path));
  await chmod(path, 0o600);
  await symlink(path, join(directory, "link"));
  await assert.rejects(TencentOaServerPlugin.fromTokenFile(join(directory, "link")));
  await assert.rejects(TencentOaServerPlugin.fromTokenFile("relative"));
});
const response = (name: string) => new Response(JSON.stringify({ available: true, identity: { loginName: name, staffId: "123", expiresAt: new Date(Date.now() + 60_000).toISOString() } }));
test("late responses cannot overwrite a newer employee or resurrect disposed identity", async (t) => {
  const pending: Array<(value: Response) => void> = [];
  const controller = identityOnlyController((() => new Promise<Response>((resolve) => pending.push(resolve))) as typeof fetch);
  t.after(() => controller.dispose());
  const first = controller.refresh(), second = controller.refresh();
  pending[1]!(response("new.employee")); await second;
  pending[0]!(response("old.employee")); await first;
  assert.equal(controller.getSnapshot().identity?.loginName, "new.employee");
  const third = controller.refresh(); controller.dispose(); pending[2]!(response("late.employee")); await third;
  assert.equal(controller.getSession().status, "anonymous");
  assert.equal(controller.getSnapshot().identity, null);
});
test("unauthorized response revokes identity; unconfigured endpoint is unavailable", async (t) => {
  let next = response("employee");
  const controller = identityOnlyController((async () => next) as typeof fetch);
  t.after(() => controller.dispose());
  await controller.refresh(); assert.equal(controller.getSession().status, "authenticated");
  next = new Response(JSON.stringify({ available: true, identity: null }), { status: 401 });
  await controller.refresh(); assert.equal(controller.getSession().status, "anonymous");
  next = new Response("", { status: 404 });
  await controller.refresh(); assert.equal(controller.getSnapshot().available, false);
});
test("network errors preserve only unexpired verified projection", async (t) => {
  let clock = Date.now(), fail = false;
  const controller = identityOnlyController((async () => { if (fail) throw new Error("offline"); return response("employee"); }) as typeof fetch, () => clock);
  t.after(() => controller.dispose());
  await controller.refresh(); fail = true;
  await controller.refresh(); assert.equal(controller.getSnapshot().phase, "error"); assert.equal(controller.getSession().status, "authenticated");
  clock += 241_000;
  await controller.refresh(); assert.equal(controller.getSession().status, "anonymous");
});
test("cancelling sign-in fences its result", async (t) => {
  let resolve!: (value: Response) => void;
  const controller = identityOnlyController((() => new Promise<Response>((done) => { resolve = done; })) as typeof fetch);
  t.after(() => controller.dispose());
  const operation = controller.signIn(); await controller.cancelSignIn(); resolve(response("employee"));
  assert.deepEqual(await operation, { status: "cancelled" });
  assert.equal(controller.getSession().status, "anonymous");
});
test("real HTTP boundary exposes only verified identity and denies cross-site access", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tencentoa-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.html"), "<!doctype html>");
  const plugin = new TencentOaServerPlugin(token, { now: () => now });
  t.after(() => plugin.close());
  const web = await createWorkbenchWebServer({ root: directory, appServerTarget: null, tencentOaService: plugin });
  t.after(() => web.close());
  const address = await web.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`, endpoint = `${origin}/__opencraft_tencentoa/session`;
  const valid = await fetch(endpoint, { headers: request().headers });
  assert.equal(valid.status, 200); assert.equal(valid.headers.get("cache-control"), "private, no-store");
  const value = await valid.json();
  assert.deepEqual(Object.keys(value.identity).sort(), ["expiresAt", "loginName", "staffId"]);
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { headers: { ...request().headers, origin: "https://foreign.example" } })).status, 403);
  assert.equal((await fetch(endpoint, { headers: { ...request().headers, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await fetch(endpoint, { method: "POST", headers: request().headers })).status, 405);
  assert.equal((await fetch(`${endpoint}?token=not-accepted`, { headers: request().headers })).status, 404);
});
test("real extension activation owns provider and settings; unload withdraws both", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const document = new EventTarget();
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  t.after(() => { if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document"); });
  const context = new Context(); const auth = context.plugin(AuthenticationService); await auth;
  const accounts = new PlatformAccountContributionRegistry();
  const supervisor = new ExtensionSupervisor({ context, platform: "web", internalContributions: {
    [AUTHENTICATION_PROVIDER_CHANNEL]: authenticationProviderAdapter(context.authentication),
    platformViewRenderer: { prepare: () => ({ commit: () => () => {} }) },
    platformAccount: accounts.createAdapter(),
  } });
  t.after(async () => { await supervisor.dispose(); await auth.dispose(); });
  await supervisor.loadOptional("tencentoa.identity", async () => createTencentOaExtension(identityOnlyController((async () => response("employee")) as typeof fetch)));
  assert.equal(supervisor.getSnapshot().extensions[0]?.status, "active");
  assert.equal(context.authentication.getSession(TENCENTOA_PROVIDER_ID)?.status, "authenticated");
  assert.equal(supervisor.contributions.getSnapshot().settingsPages.length, 1);
  assert.equal(accounts.getSnapshot().contribution?.getSnapshot().name, "employee");
  await supervisor.dispose();
  assert.equal(context.authentication.getSession(TENCENTOA_PROVIDER_ID), null);
  assert.equal(supervisor.contributions.getSnapshot().settingsPages.length, 0);
  assert.equal(accounts.getSnapshot().contribution, null);
});
test("employee entrance follows verified identity and revocation, with no gateway logout or fixed login URL", async (t) => {
  let next = response("employee");
  const controller = identityOnlyController((async () => next) as typeof fetch);
  t.after(() => controller.dispose());
  const account = createTencentOaAccountContribution(controller);
  assert.equal(account.getSnapshot(), account.getSnapshot());
  await controller.refresh();
  assert.equal(account.getSnapshot().phase, "authenticated");
  assert.equal(account.getSnapshot().name, "employee");
  assert.equal(account.getSnapshot().planLabel, "员工身份");
  assert.equal(account.getSnapshot(), account.getSnapshot());
  assert.equal(account.signOut, undefined);
  assert.equal(account.signInViewId, undefined);
  assert.equal(account.signInOptions, undefined);
  next = new Response(JSON.stringify({ available: true, identity: null }), { status: 401 });
  await account.refresh();
  assert.equal(account.getSnapshot().phase, "anonymous");
  assert.equal(account.getSnapshot().name, null);
  assert.equal(account.getSnapshot().anonymousLabel, "员工身份");
});
test("employee footer precedence preserves independent product authority and restores it on unload", async (t) => {
  const registry = new PlatformAccountContributionRegistry(), adapter = registry.createAdapter();
  const owner = { extensionId: "product", activationId: "product:1", generation: 1 };
  const product: PlatformAccountContribution = {
    id: "product.account", viewId: "product.view",
    getSnapshot: () => ({ revision: 0, phase: "authenticated", name: "product.user", avatarUrl: null, planLabel: null, usageRemainingPercent: null, error: null }),
    subscribe: () => () => {}, refresh: async () => {}, signOut: async () => {},
  };
  const removeProduct = adapter.prepare(owner, product).commit();
  assert.throws(() => adapter.prepare({ ...owner, activationId: "duplicate" }, product), /already registered/u);
  const controller = identityOnlyController((async () => response("employee")) as typeof fetch);
  t.after(() => controller.dispose());
  await controller.refresh();
  const employee = createTencentOaAccountContribution(controller);
  const removeEmployee = adapter.prepare({ ...owner, extensionId: "tencentoa.identity", activationId: "employee:1" }, employee).commit();
  assert.equal(registry.getSnapshot().contribution, employee);
  assert.equal(product.getSnapshot().name, "product.user");
  removeEmployee();
  assert.equal(registry.getSnapshot().contribution, product);
  const removeReplacement = adapter.prepare({ ...owner, activationId: "employee:2" }, employee).commit();
  removeEmployee();
  assert.equal(registry.getSnapshot().contribution, employee);
  removeProduct();
  assert.equal(registry.getSnapshot().contribution, employee);
  removeReplacement();
  assert.equal(registry.getSnapshot().contribution, null);
  assert.throws(() => adapter.prepare(owner, { ...product, entrancePriority: NaN }), /invalid/u);
});
test("unconfigured plugin has no false identity capability or settings entry", async (t) => {
  const supervisor = new ExtensionSupervisor({ platform: "web", context: new Context() });
  t.after(() => supervisor.dispose());
  await supervisor.loadOptional("tencentoa.identity", async () => createTencentOaExtension(identityOnlyController((async () => new Response("", { status: 404 })) as typeof fetch)));
  assert.equal(supervisor.getSnapshot().extensions[0]?.status, "active");
  assert.equal(supervisor.contributions.getSnapshot().settingsPages.length, 0);
});

test("signed WebSocket handshakes bind separate server contexts even when renderers spoof the same ID", async t => {
  const directory = await mkdtemp(join(tmpdir(), "tencentoa-ws-"));
  await writeFile(join(directory, "index.html"), "<!doctype html>");
  const captures: Array<{ frame: string; context: unknown }> = [];
  const host = new AppHostServer({ logicalClientRouting: true, createTransport: () => ({
    status: { state: "open" }, connect: async () => {}, close: async () => {},
    send: async () => { throw new Error("Expected trusted context path"); },
    sendWithContext: async (frame, context) => { captures.push({ frame, context }); },
    subscribeMessage: () => () => {}, subscribeStatus: () => () => {},
  }) });
  const plugin = new TencentOaServerPlugin(token, { now: () => now });
  const web = await createWorkbenchWebServer({ root: directory, appServerTarget: null, appHostServer: host, tencentOaService: plugin });
  const address = await web.listen({ host: "127.0.0.1", port: 0 });
  const sockets: WebSocket[] = [];
  t.after(async () => { sockets.forEach(s => s.terminate()); await web.close(); await host.close(); plugin.close(); await rm(directory, { recursive: true, force: true }); });
  const wait = async (predicate: () => unknown) => {
    for (let attempt = 0; attempt < 100; attempt++) { const value = predicate(); if (value) return value; await new Promise(r => setTimeout(r, 10)); }
    throw new Error("WebSocket fixture timed out");
  };
  for (const loginName of ["employee.a", "employee.b", null]) {
    const signed = loginName ? request({ loginname: loginName, staffid: 123, expiration: new Date(Date.now() + 60_000).toISOString() }).headers : {};
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/apphost`, { headers: signed });
    sockets.push(socket); const frames: any[] = []; socket.on("message", raw => frames.push(JSON.parse(String(raw))));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, rendererId: "same-forged-renderer", sender: { loginName: "forged" } }));
    await wait(() => frames.find(f => f.type === "ready"));
    socket.send(JSON.stringify({ type: "host/connect", requestId: "connect", hostId: "local-codex", leaseId: "lease" }));
    const connected: any = await wait(() => frames.find(f => f.requestId === "connect"));
    const before = captures.length;
    socket.send(JSON.stringify({ type: "host/send", requestId: "send", hostId: "local-codex", leaseId: "lease", generation: connected.result.generation,
      frame: JSON.stringify({ id: 1, method: "turn/start", params: { sender: { loginName: "forged" } } }) }));
    await wait(() => captures.length > before);
    const context: any = captures.at(-1)!.context;
    assert.deepEqual(context.sender, loginName ? { kind: "employee", loginName } : null);
    assert.doesNotMatch(JSON.stringify(context), /staffId|signature|x-tai-identity|forged/);
  }
  const clientIds = captures.map(c => JSON.parse(c.frame).__opencraftClient);
  assert.equal(new Set(clientIds).size, 3);
});

test("employee photo proxy binds the target to verified identity and never forwards gateway credentials", async t => {
  const { createServer } = await import("node:http");
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  let unavailable = false;
  const service = new TencentOaServerPlugin(token, { now: () => now, fetcher: (async (url, options) => {
    calls.push({ url: String(url), options });
    return unavailable ? new Response("failure", { status: 503 }) : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  }) as typeof fetch });
  const server = createServer((req, res) => { service.handle(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { service.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const path = "/__opencraft_tencentoa/photo/100/employee.one.png";
  assert.equal((await fetch(origin + path)).status, 401); assert.equal(calls.length, 0);
  assert.equal((await fetch(origin + "/__opencraft_tencentoa/photo/100/employee.two.png", request())).status, 403); assert.equal(calls.length, 0);
  const photo = await fetch(origin + path, request());
  assert.equal(photo.status, 200); assert.equal(photo.headers.get("content-type"), "image/png");
  assert.match(photo.headers.get("cache-control")!, /no-store/);
  assert.equal(calls[0]!.url, "http://api-idc.sgw.woa.com/ebus/rhrc/photo/100/employee.one.png");
  assert.doesNotMatch(JSON.stringify(calls[0]!.options), /signature|x-tai|staffId/);
  assert.equal((await fetch(origin + "/__opencraft_tencentoa/photo/101/employee.one.png", request())).status, 404);
  unavailable = true; assert.equal((await fetch(origin + path, request())).status, 502);
  assert.equal((await fetch(origin + "/__opencraft_tencentoa/session", request())).status, 200);
});

test("avatar belongs to the employee plugin and a late former account photo cannot replace the current account", async t => {
  let name = "employee.one";
  let finishOld!: (response: Response) => void;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6G1sAAAAASUVORK5CYII=", "base64");
  const controller = new TencentOaController((async url => {
    if (String(url).includes("/photo/")) {
      if (String(url).includes("employee.one")) return await new Promise<Response>(resolve => { finishOld = resolve; });
      return new Response(png, { headers: { "content-type": "image/png" } });
    }
    return name ? response(name) : new Response(JSON.stringify({ available: true, identity: null }), { status: 401 });
  }) as typeof fetch);
  t.after(() => controller.dispose());
  const account = createTencentOaAccountContribution(controller);
  await controller.refresh(); assert.equal(account.getSnapshot().avatarUrl, null);
  name = "employee.two"; await controller.refresh();
  for (let i = 0; i < 100 && !account.getSnapshot().avatarUrl; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const avatar = account.getSnapshot().avatarUrl;
  assert.match(avatar!, /^blob:/); assert.equal(account.getSnapshot().name, "employee.two");
  finishOld(new Response(png, { headers: { "content-type": "image/png" } }));
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(account.getSnapshot().avatarUrl, avatar);
  name = ""; await controller.refresh();
  assert.equal(account.getSnapshot().avatarUrl, null);
});
