import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import { publishWorkbenchWeb } from "../scripts/publish-workbench-web.mjs";
import { createWorkbenchWebServer } from "../scripts/serve-workbench-web.mjs";

test("browser release builds use Rolldown minification without a second obfuscation pass", async () => {
  const packageSource = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const packageManifest = JSON.parse(packageSource);
  const viteSource = await readFile(
    new URL("../apps/workbench-web/vite.config.ts", import.meta.url),
    "utf8",
  );

  for (const scriptName of ["build:web:release", "build:lightvela-web:release", "build:electron:release"]) {
    const script = packageManifest.scripts[scriptName];
    assert.match(script, /OPENCRAFT_RELEASE_MINIFY=ultra/u);
    assert.doesNotMatch(script, /obfuscate-web-release|obfuscate-electron-host\.mjs browser/u);
  }
  assert.match(viteSource, /minify:\s*"oxc"/u);
  assert.match(viteSource, /maxIterations:\s*10/u);
  assert.match(viteSource, /toplevel:\s*true/u);
  assert.doesNotMatch(viteSource, /OPENCRAFT_RELEASE_OBFUSCATION|releaseObfuscation/u);
});

async function createFixture(root, buildId, assetName, assetSource) {
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, ".vite"), { recursive: true });
  await mkdir(join(root, "fonts"), { recursive: true });
  await writeFile(
    join(root, "index.html"),
    `<!doctype html><meta name="opencraft-build-id" content="${buildId}"><script type="module" src="/assets/${assetName}"></script>`,
  );
  await writeFile(
    join(root, "version.json"),
    `${JSON.stringify({ schemaVersion: 1, buildId, builtAt: "2026-09-01T00:00:00.000Z" })}\n`,
  );
  await writeFile(
    join(root, ".vite/manifest.json"),
    `${JSON.stringify({ "index.html": { file: `assets/${assetName}`, isEntry: true } })}\n`,
  );
  await writeFile(join(root, "assets", assetName), assetSource);
  await writeFile(join(root, "assets", `${assetName}.map`), "private source map");
  await writeFile(join(root, "fonts/openai-sans.woff2"), "font");
}

async function removeContents(path) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

test("publisher switches mutable pointers last and retains old hashed assets", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "opencraft-release-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const source = join(temporaryRoot, "dist");
  const target = join(temporaryRoot, "published");

  await createFixture(source, "build-one", "index-AAAA1111.js", "first");
  const first = await publishWorkbenchWeb({ source, target });
  assert.equal(first.previousBuildId, null);
  assert.equal(first.addedAssets, 1);

  await removeContents(source);
  await createFixture(source, "build-two", "index-BBBB2222.js", "second");
  const second = await publishWorkbenchWeb({ source, target });
  assert.equal(second.previousBuildId, "build-one");
  assert.equal(second.addedAssets, 1);

  assert.equal(await readFile(join(target, "assets/index-AAAA1111.js"), "utf8"), "first");
  assert.equal(await readFile(join(target, "assets/index-BBBB2222.js"), "utf8"), "second");
  await assert.rejects(readFile(join(target, "assets/index-BBBB2222.js.map")), /ENOENT/u);
  assert.match(await readFile(join(target, "index.html"), "utf8"), /build-two/u);
  assert.equal(JSON.parse(await readFile(join(target, "version.json"), "utf8")).buildId, "build-two");
  assert.equal(
    JSON.parse(await readFile(join(target, "releases/build-one/version.json"), "utf8")).buildId,
    "build-one",
  );
});

test("publisher refuses content mutation behind an existing asset hash", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "opencraft-collision-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const source = join(temporaryRoot, "dist");
  const target = join(temporaryRoot, "published");
  await createFixture(source, "build-one", "index-AAAA1111.js", "first");
  await publishWorkbenchWeb({ source, target });
  await writeFile(join(source, "assets/index-AAAA1111.js"), "mutated");
  await assert.rejects(
    publishWorkbenchWeb({ source, target }),
    /Immutable asset collision/u,
  );
});

test("static host applies release cache invariants and SPA fallback", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "opencraft-static-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await createFixture(temporaryRoot, "build-one", "index-AAAA1111.js", "console.log('ok')");
  const host = await createWorkbenchWebServer({ root: temporaryRoot });
  context.after(() => host.close());
  const address = await host.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;

  const indexResponse = await fetch(`${origin}/`);
  assert.equal(indexResponse.status, 200);
  assert.equal(indexResponse.headers.get("cache-control"), "no-store, max-age=0");

  const versionResponse = await fetch(`${origin}/version.json`);
  assert.equal(versionResponse.headers.get("cache-control"), "no-store, max-age=0");

  const assetResponse = await fetch(`${origin}/assets/index-AAAA1111.js`);
  assert.equal(assetResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const routeResponse = await fetch(`${origin}/threads/thread-1`, {
    headers: { accept: "text/html" },
  });
  assert.equal(routeResponse.status, 200);
  assert.match(await routeResponse.text(), /build-one/u);

  const namespacedViewResponse = await fetch(`${origin}/views/vela.bot-chat.view`, {
    headers: { accept: "text/html" },
  });
  assert.equal(namespacedViewResponse.status, 200);
  assert.match(await namespacedViewResponse.text(), /build-one/u);

  const sourceMapResponse = await fetch(`${origin}/assets/index-AAAA1111.js.map`);
  assert.equal(sourceMapResponse.status, 404);
});

test("static host can serve Electron assets without owning an AppServer", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "opencraft-static-only-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await createFixture(temporaryRoot, "build-one", "index-AAAA1111.js", "entry");
  const host = await createWorkbenchWebServer({
    root: temporaryRoot,
    appServerTarget: null,
  });
  context.after(() => host.close());
  const address = await host.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${origin}/__opencraft_health`).then((response) => response.json());
  assert.equal(health.appServerTarget, null);
  const appServerResponse = await fetch(`${origin}/appserver`);
  assert.equal(appServerResponse.status, 404);
});

test("static host bridges the same-origin AppServer WebSocket", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "opencraft-ws-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await createFixture(temporaryRoot, "build-one", "index-AAAA1111.js", "entry");

  const upstreamServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolvePromise) => upstreamServer.once("listening", resolvePromise));
  context.after(() => new Promise((resolvePromise) => upstreamServer.close(resolvePromise)));
  const upstreamAddress = upstreamServer.address();
  const observed = new Promise((resolvePromise) => {
    upstreamServer.once("connection", (socket, request) => {
      socket.once("message", (message) => {
        resolvePromise({
          message: message.toString(),
          user: request.headers["x-hypernode-user"],
          path: request.url,
        });
        socket.send("pong");
      });
    });
  });

  const host = await createWorkbenchWebServer({
    root: temporaryRoot,
    appServerTarget: `ws://127.0.0.1:${upstreamAddress.port}/rpc`,
    hyperNodeUser: "release-test-user",
  });
  const address = await host.listen({ host: "127.0.0.1", port: 0 });
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/appserver`);
  await new Promise((resolvePromise, reject) => {
    client.once("open", resolvePromise);
    client.once("error", reject);
  });
  client.send("ping");
  const reply = await new Promise((resolvePromise) => client.once("message", resolvePromise));
  assert.equal(reply.toString(), "pong");
  assert.deepEqual(await observed, {
    message: "ping",
    user: "release-test-user",
    path: "/rpc",
  });
  const clientClosed = new Promise((resolvePromise) => client.once("close", resolvePromise));
  client.close(1000, "test complete");
  await clientClosed;
  await host.close();
});
