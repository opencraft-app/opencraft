import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHostFileSystem } from "../../apps/headless-server/src/host-filesystem.ts";
import { createHostFileSystemPluginSource } from "../../apps/headless-server/src/host-filesystem-plugin-source.mjs";
import { loadRuntimePlugins } from "../../packages/runtime-plugin-host/host.mjs";
import { hash, installRuntimePlugin } from "../../packages/runtime-plugin-host/store.mjs";

const authority = {
  authenticate: () => ({ provider: "fixture", subject: "owner", expiresAt: Date.now() + 60_000 }),
  admissionStatus: () => 204,
};
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "plugin-host-files-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function packageFixture(root: string) {
  const output = join(root, "package");
  await mkdir(output);
  const bytes = 'export async function activate(){return {handle(_q,r){r.end("from-host-files");},close(){}};}';
  await writeFile(join(output, "entry.mjs"), bytes);
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "fixture.host-files",
      version: "1.0.0",
      hostApi: 1,
      nodeMajor: 26,
      sourceRevision: "a".repeat(40),
      roles: { gateway: { entry: "entry.mjs", routes: [{ path: "/__fixture_host_files", methods: ["GET"] }] } },
      files: [{ path: "entry.mjs", size: Buffer.byteLength(bytes), sha256: hash(bytes) }],
    }),
  );
  const directory = join(root, "platform"),
    remote = join(root, "remote");
  const selection = await installRuntimePlugin(output, directory, { enable: true });
  await installRuntimePlugin(output, remote, { enable: true });
  // The platform store keeps only the selection; bytes come from the file owner.
  await rm(join(directory, "packages"), { recursive: true });
  await rm(output, { recursive: true });
  return { directory, remote, selection, cacheDirectory: join(root, "cache") };
}
async function serve(host: any, run: (url: string) => Promise<void>) {
  const server = createServer((q, r) => {
    if (!host.handle(q, r)) {
      r.statusCode = 404;
      r.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const at = server.address();
  assert(at && typeof at === "object");
  try {
    await run(`http://127.0.0.1:${at.port}/__fixture_host_files`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
/** A file owner that answers every `fs/readFile` with the given base64 text. */
async function fakeOwner(root: string, dataBase64: () => unknown) {
  const directory = join(root, "owner");
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  const endpoint = join(directory, "files.sock"),
    tokenFile = join(directory, "files.token");
  await writeFile(tokenFile, "b".repeat(64), { mode: 0o600 });
  const server = createServer((_q, r) => {
    r.setHeader("content-type", "application/json");
    r.end(JSON.stringify({ result: { dataBase64: dataBase64() } }));
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  return {
    endpoint,
    tokenFile,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("platform reads plugin bytes through the real Hands file RPC, without a shared plugin path", async () =>
  fixture(async (root) => {
    const p = await packageFixture(root);
    const owner = join(root, "owner");
    const endpoint = join(owner, "files.sock"),
      tokenFile = join(owner, "files.token");
    const files = await startHostFileSystem({ endpoint, tokenFile });
    const host = await loadRuntimePlugins({
      directory: p.directory,
      cacheDirectory: p.cacheDirectory,
      role: "gateway",
      authority,
      packageSource: createHostFileSystemPluginSource({ root: p.remote, endpoint, tokenFile }),
    });
    try {
      assert.equal(host.selected.length, 1);
      await assert.rejects(access(join(p.directory, "packages")));
      await serve(host, async (url) => assert.equal(await (await fetch(url)).text(), "from-host-files"));
      // A later change to the remote bytes cannot reach the active snapshot.
      const remoteEntry = join(p.remote, "packages", p.selection.id, p.selection.revision, "entry.mjs");
      await writeFile(remoteEntry, 'throw Error("mutated remote");');
      await serve(host, async (url) => assert.equal(await (await fetch(url)).text(), "from-host-files"));
      // The next activation re-verifies the digest and skips the mutated package.
      const next = await loadRuntimePlugins({
        directory: p.directory,
        cacheDirectory: join(root, "next-cache"),
        role: "gateway",
        authority,
        packageSource: createHostFileSystemPluginSource({ root: p.remote, endpoint, tokenFile }),
        onDiagnostic: () => {},
      });
      try {
        assert.equal(next.selected.length, 0);
        assert.equal(next.skipped[0].reason, "verification_failed");
      } finally {
        await next.close();
      }
    } finally {
      await host.close();
      await files.close();
    }
  }));

test("oversized, malformed or non-canonical RPC payloads are rejected before use", async () =>
  fixture(async (root) => {
    let payload: unknown = "";
    const owner = await fakeOwner(root, () => payload);
    const source = createHostFileSystemPluginSource({
      root: join(root, "remote"),
      endpoint: owner.endpoint,
      tokenFile: owner.tokenFile,
    });
    const selection = { id: "fixture.host-files", revision: "c".repeat(64) };
    try {
      for (const [value, message] of [
        [Buffer.alloc(300 * 1024).toString("base64"), /exceeds its budget/],
        [42, /exceeds its budget/],
        ["not base64!", /Invalid plugin source bytes/],
        ["YQ", /Invalid plugin source bytes/],
        // Canonical bytes pass the adapter and still meet the source's digest check.
        [Buffer.from("{}").toString("base64"), /digest mismatch/],
      ] as const) {
        payload = value;
        await assert.rejects(source.readPackage(selection, {}), message);
      }
    } finally {
      source.close();
      await owner.close();
    }
  }));

test("an invalid source root fails construction", () => {
  assert.throws(() =>
    createHostFileSystemPluginSource({ root: "/", endpoint: "/tmp/files.sock", tokenFile: "/tmp/files.token" }),
  );
  assert.throws(() =>
    createHostFileSystemPluginSource({ root: "relative", endpoint: "/tmp/files.sock", tokenFile: "/tmp/files.token" }),
  );
});
