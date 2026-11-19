import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";
test("a configured native transport may retain its old provider callback URL without restoring legacy routes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "native-callback-"));
  await writeFile(join(root, "index.html"), "fixture");
  const configured = "/__opencraft_im/shadow-callback/wecom",
    calls = [];
  const server = await createWorkbenchWebServer({
    root,
    appServerTarget: null,
    getImService: () => ({
      async handleChannelCallback(req, res, path) {
        calls.push(path);
        if (path !== configured) return false;
        res.writeHead(202);
        res.end("native transport");
        return true;
      },
      async handle(req, res) {
        res.writeHead(404);
        res.end();
        return true;
      },
    }),
  });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const { port } = await server.listen({ host: "127.0.0.1", port: 0 });
  const origin = "http://127.0.0.1:" + port;
  assert.equal((await fetch(origin + configured, { method: "POST" })).status, 202);
  assert.deepEqual(calls, [configured]);
  assert.equal((await fetch(origin + "/__opencraft_im/shadow-history", { method: "POST" })).status, 404);
});
