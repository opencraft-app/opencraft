import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostFileDownloads } from "../../apps/opencraft-daemon/src/host-file-downloads.js";
import { createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";

async function fixture(t: test.TestContext, options: { remote?: boolean; spawnSsh?: (args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-file-download-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>test</title>");
  const service = new HostFileDownloads(hostId => {
    if (hostId !== (options.remote ? "ssh:fixture" : "local-codex")) throw new Error("Unknown Host");
    return options.remote ? { hostname: "fixture", port: 22, username: "fixture", knownHostsFile: join(directory, "known_hosts"), authentication: { kind: "agent" as const } } : "local";
  }, options.spawnSsh);
  let allowed = true;
  const server = createServer((request, response) => {
    if (request.url === "/probe") { response.end("ready"); return; }
    void service.handle(request, response, () => allowed);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { directory, service, origin, revoke() { allowed = false; }, url(path: string, hostId = options.remote ? "ssh:fixture" : "local-codex") {
    return `${origin}/__opencraft_files?${new URLSearchParams({ hostId, path })}`;
  } };
}

test("64MiB original downloads stream unchanged while the control endpoint remains responsive", async t => {
  const f = await fixture(t), path = join(f.directory, "原件.pptx"), block = Buffer.alloc(1024 * 1024, 137), expected = createHash("sha256");
  const file = await open(path, "w");
  try { for (let n = 0; n < 64; n++) { await file.write(block); expected.update(block); } } finally { await file.close(); }
  const head = await fetch(f.url(path), { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(64 * 1024 * 1024));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const response = await fetch(f.url(path)), actual = createHash("sha256");
  assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition")!, /attachment; filename\*=UTF-8''%/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  let bytes = 0, probes = 0;
  for await (const chunk of response.body!) {
    actual.update(chunk); bytes += chunk.length;
    if (++probes <= 4) assert.equal(await (await fetch(f.origin + "/probe")).text(), "ready");
  }
  assert.equal(bytes, 64 * 1024 * 1024); assert.equal(actual.digest("hex"), expected.digest("hex")); assert.ok(probes >= 4);
});

test("SSH download uses a separate trusted process and treats shell punctuation as a literal filename", async t => {
  const calls: string[][] = [];
  const f = await fixture(t, { remote: true, spawnSsh(args) {
    calls.push([...args]);
    return spawn("sh", ["-c", args.at(-1)!], { cwd: f.directory, stdio: ["pipe", "pipe", "pipe"] });
  } });
  const path = join(f.directory, "deck ' $(touch marker);.pptx"), bytes = Buffer.from("\0\n\r\xff\u4e2d\u6587", "utf8");
  await writeFile(path, bytes);
  const head = await fetch(f.url(path), { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(bytes.length));
  const response = await fetch(f.url(path)); assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(calls.length, 2); assert.ok(calls[0]!.includes("StrictHostKeyChecking=yes"));
  assert.ok(calls[0]!.includes("ClearAllForwardings=yes")); assert.equal(calls[0]!.at(-1)!.includes("exec cat"), false);
  await assert.rejects(readFile(join(f.directory, "marker")));
});

test("invalid paths, unknown Hosts and denied access never become local file reads", async t => {
  const f = await fixture(t), path = join(f.directory, "file.pptx"); await writeFile(path, "original");
  assert.equal((await fetch(f.url("relative.pptx"))).status, 400);
  assert.equal((await fetch(f.url(path, "other-host"))).status, 502);
  assert.equal((await fetch(f.url(f.directory))).status, 502);
  assert.equal((await fetch(f.url(path), { method: "POST" })).status, 405);
  f.revoke(); assert.equal((await fetch(f.url(path))).status, 403);
});

test("aborting an SSH download releases its process and permits a subsequent download", async t => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const f = await fixture(t, { remote: true, spawnSsh() {
    const child = spawn(process.execPath, ["-e", "process.stdout.write('100000000\\n');setInterval(()=>process.stdout.write(Buffer.alloc(1024)),10)"], { stdio: ["pipe", "pipe", "pipe"] });
    children.push(child); return child;
  } });
  const controller = new AbortController(), response = await fetch(f.url("/slow.pptx"), { signal: controller.signal });
  assert.equal(response.status, 200); await response.body!.getReader().read();
  const closed = new Promise<void>(resolve => children[0]!.once("close", () => resolve()));
  controller.abort(); await closed;
  assert.equal(await (await fetch(f.origin + "/probe")).text(), "ready");
  const next = await fetch(f.url("/slow.pptx"), { method: "HEAD" }); assert.equal(next.status, 200);
});

test("access revocation terminates an admitted SSH download", async t => {
  let child: ChildProcessWithoutNullStreams | undefined;
  const f = await fixture(t, { remote: true, spawnSsh() {
    return child = spawn(process.execPath, ["-e", "process.stdout.write('100000000\\n');setInterval(()=>process.stdout.write(Buffer.alloc(1024)),10)"], { stdio: ["pipe", "pipe", "pipe"] });
  } });
  const response = await fetch(f.url("/slow.pptx"));
  const closed = new Promise<void>(resolve => child!.once("close", () => resolve()));
  f.revoke(); await assert.rejects(response.arrayBuffer()); await closed;
});

test("the real gateway retains same-origin, instance, Actor and SSH admission on the binary route", async t => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-file-admission-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.html"), "<!doctype html>"); const path = join(directory, "deck.pptx"); await writeFile(path, "original");
  let instance = 204, actor = 204, ssh = false, opens = 0;
  const downloads = new HostFileDownloads(() => { opens++; return "local"; });
  const gateway = await createWorkbenchWebServer({ root: directory, appServerTarget: null, fileDownloads: downloads,
    identityService: { admissionStatus: () => instance, connectionContext: () => ({ sender: null }), handle: () => false },
    actorService: { isSessionRequest: () => false, legacyAdmissionStatus: () => actor },
    sshManagement: { authorized: () => ssh, onRevocation: () => () => {} } });
  const address = await gateway.listen({ host: "127.0.0.1", port: 0 }), origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { downloads.close(); await gateway.close(); });
  const url = (hostId: string) => `${origin}/__opencraft_files?${new URLSearchParams({ hostId, path })}`;
  const head = (hostId = "local-codex", extra = {}) => fetch(url(hostId), { method: "HEAD", headers: { Origin: origin, ...extra } });
  assert.equal((await head()).status, 200); assert.equal(opens, 1);
  assert.equal((await head("local-codex", { Origin: "https://untrusted.invalid" })).status, 403);
  instance = 403; assert.equal((await head()).status, 403); instance = 204;
  actor = 403; assert.equal((await head()).status, 403); actor = 204;
  assert.equal((await head("ssh:fixture")).status, 403); assert.equal(opens, 1);
  ssh = true; assert.equal((await head("ssh:fixture")).status, 200);
});
