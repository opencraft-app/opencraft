import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { createWorkbenchWebServer as worker } from "../../scripts/workbench-web-server.mjs";
import { createWorkbenchWebServer as web } from "../../scripts/serve-workbench-web.mjs";
import { createWorkbenchStaticServer as desktop } from "../../scripts/serve-workbench-static.mjs";

for (const [name, create] of [["managed worker", worker], ["Web", web], ["desktop", desktop]] as const) {
  test(`${name}: conditional static GET/HEAD, changed bytes and no-store documents`, async t => {
    const root = await mkdtemp(join(tmpdir(), "opencraft-http-cache-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<html><head></head><body>fixture</body></html>");
    await writeFile(join(root, "version.json"), '{}');
    await writeFile(join(root, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const source = Buffer.from("globalThis.fixture = 1;".repeat(100));
    await writeFile(join(root, "assets/main-ABC12345.js"), source);
    await writeFile(join(root, "assets/main-ABC12345.js.br"), brotliCompressSync(source));
    const server = await create({ root, appServerTarget: null });
    t.after(() => server.close());
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${address.port}`;
    for (const path of ["/icon.svg", "/assets/main-ABC12345.js"]) {
      const response = await fetch(url + path, { headers: { "accept-encoding": "br" } });
      const tag = response.headers.get("etag")!;
      await response.arrayBuffer();
      for (const method of ["GET", "HEAD"]) for (const condition of [tag, tag.replace(/^W\//, ''), `"other", ${tag}`, "*"]) {
        const cached = await fetch(url + path, { method, headers: { "if-none-match": condition, "accept-encoding": "br" } });
        assert.equal(cached.status, 304);
        assert.equal((await cached.arrayBuffer()).byteLength, 0);
        assert.equal(cached.headers.get("etag"), tag);
        assert.equal(cached.headers.get("cache-control"), response.headers.get("cache-control"));
        assert.equal(cached.headers.get("vary"), response.headers.get("vary"));
        assert.equal(cached.headers.get("content-length"), null);
      }
      const mismatch = await fetch(url + path, { headers: { "if-none-match": '"different"' } });
      assert.equal(mismatch.status, 200); await mismatch.arrayBuffer();
    }
    const before = await fetch(url + "/icon.svg"); const oldTag = before.headers.get("etag")!; await before.arrayBuffer();
    await writeFile(join(root, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>');
    const changed = await fetch(url + "/icon.svg", { headers: { "if-none-match": oldTag } });
    assert.equal(changed.status, 200); assert.notEqual(changed.headers.get("etag"), oldTag); await changed.arrayBuffer();
    for (const path of ["/", "/version.json"]) {
      const response = await fetch(url + path, { headers: { "if-none-match": "*" } });
      assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /no-store/); await response.arrayBuffer();
    }
  });
}
