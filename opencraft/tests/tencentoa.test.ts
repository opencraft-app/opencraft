import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TencentOaServerPlugin } from "../plugins/tencentoa/src/server";
import { TencentOaController } from "../plugins/tencentoa/src/controller";
import { createWorkbenchWebServer } from "../scripts/serve-workbench-web.mjs";
import { parseHeadlessArguments } from "../scripts/headless-server.mjs";
import { Context } from "@deepseek-ai/cordis";
import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import { AuthenticationService, AUTHENTICATION_PROVIDER_CHANNEL } from "@opencraft/workbench-runtime";
import { createTencentOaExtension } from "../plugins/tencentoa/src/index";
import { TENCENTOA_PROVIDER_ID } from "../plugins/tencentoa/src/contract";
import { authenticationProviderAdapter } from "../apps/workbench-web/src/runtime/authentication-contributions";

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
  const controller = new TencentOaController((() => new Promise<Response>((resolve) => pending.push(resolve))) as typeof fetch);
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
  const controller = new TencentOaController((async () => next) as typeof fetch);
  t.after(() => controller.dispose());
  await controller.refresh(); assert.equal(controller.getSession().status, "authenticated");
  next = new Response(JSON.stringify({ available: true, identity: null }), { status: 401 });
  await controller.refresh(); assert.equal(controller.getSession().status, "anonymous");
  next = new Response("", { status: 404 });
  await controller.refresh(); assert.equal(controller.getSnapshot().available, false);
});
test("network errors preserve only unexpired verified projection", async (t) => {
  let clock = Date.now(), fail = false;
  const controller = new TencentOaController((async () => { if (fail) throw new Error("offline"); return response("employee"); }) as typeof fetch, () => clock);
  t.after(() => controller.dispose());
  await controller.refresh(); fail = true;
  await controller.refresh(); assert.equal(controller.getSnapshot().phase, "error"); assert.equal(controller.getSession().status, "authenticated");
  clock += 241_000;
  await controller.refresh(); assert.equal(controller.getSession().status, "anonymous");
});
test("cancelling sign-in fences its result", async (t) => {
  let resolve!: (value: Response) => void;
  const controller = new TencentOaController((() => new Promise<Response>((done) => { resolve = done; })) as typeof fetch);
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
  assert.equal(parseHeadlessArguments(["--tencentoa-token-file", "/private/token"]).tencentOaTokenFile, "/private/token");
  assert.throws(() => parseHeadlessArguments(["--tencentoa-token-file", "relative"]));
});
test("real extension activation owns provider and settings; unload withdraws both", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const document = new EventTarget();
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  t.after(() => { if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document"); });
  const context = new Context(); const auth = context.plugin(AuthenticationService); await auth;
  const supervisor = new ExtensionSupervisor({ context, platform: "web", internalContributions: {
    [AUTHENTICATION_PROVIDER_CHANNEL]: authenticationProviderAdapter(context.authentication),
    platformViewRenderer: { prepare: () => ({ commit: () => () => {} }) },
  } });
  t.after(async () => { await supervisor.dispose(); await auth.dispose(); });
  await supervisor.loadOptional("tencentoa.identity", async () => createTencentOaExtension(new TencentOaController((async () => response("employee")) as typeof fetch)));
  assert.equal(supervisor.getSnapshot().extensions[0]?.status, "active");
  assert.equal(context.authentication.getSession(TENCENTOA_PROVIDER_ID)?.status, "authenticated");
  assert.equal(supervisor.contributions.getSnapshot().settingsPages.length, 1);
  await supervisor.dispose();
  assert.equal(context.authentication.getSession(TENCENTOA_PROVIDER_ID), null);
  assert.equal(supervisor.contributions.getSnapshot().settingsPages.length, 0);
});
test("unconfigured plugin has no false identity capability or settings entry", async (t) => {
  const supervisor = new ExtensionSupervisor({ platform: "web", context: new Context() });
  t.after(() => supervisor.dispose());
  await supervisor.loadOptional("tencentoa.identity", async () => createTencentOaExtension(new TencentOaController((async () => new Response("", { status: 404 })) as typeof fetch)));
  assert.equal(supervisor.getSnapshot().extensions[0]?.status, "active");
  assert.equal(supervisor.contributions.getSnapshot().settingsPages.length, 0);
});
