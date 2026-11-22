import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const banner = { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" };

function hostKey() {
  const alg = Buffer.from("ssh-ed25519"),
    prefix = Buffer.alloc(4),
    size = Buffer.alloc(4);
  prefix.writeUInt32BE(alg.length);
  size.writeUInt32BE(32);
  return `fixture.invalid ssh-ed25519 ${Buffer.concat([prefix, alg, size, randomBytes(32)]).toString("base64")}`;
}

// Packaged servers bundle the caller; its owner Worker must sit beside it as
// ssh-connections-worker.mjs, or the server cannot open SSH storage.
test("a bundled SSH connections owner starts its packaged Worker beside the bundle", async () => {
  const output = await mkdtemp(join(tmpdir(), "ssh-owner-package-"));
  try {
    const options = { bundle: true, platform: "node", format: "esm", target: "node26", banner, logLevel: "silent" };
    await build({
      ...options,
      entryPoints: [join(root, "apps/opencraft-daemon/src/ssh-connections.worker.ts")],
      outfile: join(output, "ssh-connections-worker.mjs"),
    });
    await build({
      ...options,
      entryPoints: [join(root, "apps/opencraft-daemon/src/ssh-connections.ts")],
      outfile: join(output, "server.mjs"),
    });
    const { SshConnections } = await import(pathToFileURL(join(output, "server.mjs")).href);
    const connections = await SshConnections.open(join(output, "ssh"));
    try {
      const row = await connections.save(
        null,
        0,
        {
          displayName: "Fixture",
          hostname: "fixture.invalid",
          port: 22,
          username: "fixture",
          enabled: true,
          workspaceBrowseRoots: ["/remote"],
          password: "synthetic-password-only",
        },
        hostKey(),
      );
      assert.equal(
        await connections.binding(row.serverId).connection.authentication.resolvePassword(),
        "synthetic-password-only",
      );
    } finally {
      await connections.close();
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("web and headless release packaging both include the SSH connections worker", async () => {
  for (const name of ["package-web-server.mjs", "package-headless-linux.mjs"]) {
    const source = await readFile(join(root, "scripts", "packaging", name), "utf8");
    assert.match(source, /apps\/opencraft-daemon\/src\/ssh-connections\.worker\.ts/);
    assert.match(source, /ssh-connections-worker\.mjs/);
  }
});
