import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";
import { createWorkbenchWebServer as createManagedWebServer } from "../../scripts/workbench-web-server.mjs";

for (const [name, createServer] of [["direct", createWorkbenchWebServer], ["managed", createManagedWebServer]]) {
test(`${name}: directory documents precede SPA fallback with HTML, HEAD and revalidation`, async t => {
  const root = await mkdtemp(join(tmpdir(), "standalone-doc-"));
  let server;
  t.after(async () => { await server?.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "probe"));
  await writeFile(join(root, "index.html"), "<!doctype html><html><head><title>Workbench</title></head><body></body></html>");
  await writeFile(join(root, "probe/index.html"), "<!doctype html><title>Independent probe</title>");
  server = await createServer({ root, appServerTarget: null });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  for (const pathname of ["/probe", "/probe/", "/probe/index.html", "/probe?mode=native"]) {
    const response = await fetch(origin + pathname, { headers: { accept: "text/html" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.match(await response.text(), /Independent probe/);
  }
  const head = await fetch(origin + "/probe", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get("content-length")) > 0);
  assert.equal(await head.text(), "");
  assert.match(await (await fetch(origin + "/missing", { headers: { accept: "text/html" } })).text(), /Workbench/);
  assert.equal((await fetch(origin + "/probe/missing.js")).status, 404);
  assert.equal((await fetch(origin + "/probe", { method: "POST" })).status, 405);
});
}

test("directory documents preserve admission and cannot shadow reserved API paths", async t => {
  const root = await mkdtemp(join(tmpdir(), "protected-doc-"));
  let server;
  t.after(async () => { await server?.close(); await rm(root, { recursive: true, force: true }); });
  for (const name of ["probe", "__opencraft_unknown"]) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "index.html"), "<!doctype html><title>Protected document</title>");
  }
  server = await createWorkbenchWebServer({ root, appServerTarget: null, identityService: {
    admissionStatus: request => request.headers["x-test-admitted"] === "yes" ? 204 : 401,
    connectionContext: () => ({ sender: null }), handle: () => false,
  } });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(origin + "/probe", { headers: { accept: "text/html" } })).status, 401);
  const headers = { "x-test-admitted": "yes", accept: "text/html" };
  assert.match(await (await fetch(origin + "/probe", { headers })).text(), /Protected document/);
  assert.equal((await fetch(origin + "/__opencraft_unknown", { headers })).status, 404);
});
