// InstallationCore stores on the runtime-neutral SQL port in workerd (Miniflare,
// no Cloudflare account); see tests/storage/workerd/installation-stores.scenarios.ts
// and gateway-split.md §4.2 (storage row). The domain modules must bundle for a
// runtime without node:* modules or Node globals: only their Node shells (the
// owner Worker entries, the read-only admission reader and the companion
// orchestration Worker) import node:sqlite, node:worker_threads or
// @opencraft/sqlite-node.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { isAbsoluteHostPath } from "../../packages/access-control/src/host-path.ts";
import {
  decodeBase64,
  encodeBase64,
  encodeBase64Url,
  hexToBytes,
  portableSha256Hex,
  randomToken,
  sha256Hex,
  timingSafeEqualBytes,
  utf8ByteLength,
  utf8Decode,
} from "../../packages/access-control/src/portable-crypto.ts";
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { INSTALLATION_STORE_SCENARIOS } from "./workerd/installation-stores.scenarios.ts";

const root = resolve(import.meta.dirname, "../..");
const NEUTRAL_DOMAINS = [
  // Workspace admission projection (actor-admission-reader.ts is its Node reader).
  "packages/access-control/src/workspace-actor-projection.ts",
  // Owner Worker domains (server-spaces.worker.ts and orchestration-runtime.worker.ts are their Node shells).
  "packages/access-control/src/server-spaces-domain.ts",
  "packages/access-control/src/orchestration-runtime-domain.ts",
  // Stores and services the installation assembly constructs over the owner's port.
  "packages/access-control/src/collaboration.ts",
  "packages/access-control/src/actors.ts",
  "packages/access-control/src/index.ts",
  "packages/access-control/src/thread-access.ts",
  "packages/access-control/src/actor-access.ts",
  "packages/access-control/src/identity-writes.ts",
  "packages/access-control/src/human-accounts.ts",
  "packages/access-control/src/account-management.ts",
  "packages/session-capabilities/src/binding-projection.ts",
  "apps/headless-server/src/server-information.mjs",
];

for (const entry of NEUTRAL_DOMAINS)
  test(`${entry} bundles without node:* modules, Buffer or the Node SQLite owner`, async () => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "import"],
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs);
    assert.deepEqual(
      inputs.filter(
        (input) =>
          input.startsWith("node:") ||
          input.includes("packages/sqlite-node/") ||
          input.endsWith("orchestration-runtime-store.ts") ||
          input.endsWith(".node.ts"),
      ),
      [],
    );
    // Comments are gone from the bundle; any remaining Buffer is a Node global dependency.
    assert.doesNotMatch(result.outputFiles[0]!.text, /\bBuffer\b/u);
  });

test("portable digests and encodings equal node:crypto and Buffer on random input", () => {
  let seed = 7;
  const next = (limit: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % limit);
  const randomBytes = (length: number) => Uint8Array.from({ length }, () => next(256));
  for (let round = 0; round < 400; round++) {
    const bytes = randomBytes(next(200));
    // Hide the runtime's Uint8Array#toBase64 to exercise the fallback encoder too.
    const plain = Object.assign(new Uint8Array(bytes), { toBase64: undefined });
    for (const view of [bytes, plain]) {
      assert.equal(encodeBase64(view), Buffer.from(bytes).toString("base64"));
      assert.equal(encodeBase64Url(view), Buffer.from(bytes).toString("base64url"));
    }
    const noisy = Array.from({ length: next(80) }, () => String.fromCharCode(next(130))).join("");
    assert.deepEqual(decodeBase64(noisy), new Uint8Array(Buffer.from(noisy, "base64")), JSON.stringify(noisy));
    const text = Array.from({ length: next(40) }, () =>
      String.fromCharCode(next(4) ? next(0x800) : 0xd700 + next(0x1000)),
    ).join("");
    assert.equal(utf8ByteLength(text), Buffer.byteLength(text), JSON.stringify(text));
    assert.equal(utf8Decode(new TextEncoder().encode(text)), Buffer.from(text).toString("utf8"));
    assert.equal(sha256Hex(text), createHash("sha256").update(text).digest("hex"));
    assert.equal(portableSha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"));
    const hex = Buffer.from(bytes).toString("hex") + (next(2) ? "zz" : "");
    assert.deepEqual(hexToBytes(hex), new Uint8Array(Buffer.from(hex, "hex")));
  }
  assert.equal(
    utf8Decode(Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d)),
    Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]).toString("utf8"),
  );
  assert.equal(timingSafeEqualBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2)), true);
  assert.equal(timingSafeEqualBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3)), false);
  assert.equal(timingSafeEqualBytes(Uint8Array.of(1), Uint8Array.of(1, 2)), false);
  assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/u);
  for (const path of ["/a", "a", "", "C:\\x", "\\\\srv\\x", "//x", "./a"])
    assert.equal(isAbsoluteHostPath(path), isAbsolute(path), JSON.stringify(path));
});

testScenariosOnMiniflare("installation-stores-workerd", INSTALLATION_STORE_SCENARIOS);
