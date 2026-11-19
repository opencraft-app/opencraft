import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHandsIncarnation, watchHandsIncarnation } from "../../scripts/container-deployment/hands-incarnation.mjs";

test("Hands probe reads only a bounded owner identity and rejects an unavailable peer", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oc-incarnation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const endpoint = join(directory, "exec.sock"),
    id = "new-hands-owner-123456789";
  const server = createServer((socket) =>
    socket.once("data", (bytes) => {
      assert.deepEqual(JSON.parse(String(bytes)), { type: "probe", protocol: 1 });
      socket.end(JSON.stringify({ type: "healthy", protocol: 1, incarnation: id }) + "\n");
    }),
  );
  await new Promise((resolve) => server.listen(endpoint, resolve));
  assert.equal(await readHandsIncarnation(endpoint), id);
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(readHandsIncarnation(endpoint));
});

test("owner changes serialize replacement, outages do not restart Native, cancellation stops replacement", async () => {
  const controller = new AbortController();
  let n = 0;
  const replacements = [];
  await watchHandsIncarnation({
    initial: "owner-a",
    signal: controller.signal,
    intervalMs: 1,
    probe: async () => {
      n++;
      if (n === 1 || n === 3) throw Error("temporarily unavailable");
      if (n < 4) return "owner-a";
      if (n === 4 || n === 5) return "owner-b";
      controller.abort();
      return "owner-c";
    },
    replace: async (owner) => {
      replacements.push(owner);
    },
  });
  assert.deepEqual(replacements, ["owner-b"]);
});

test("replacement failure is propagated instead of repeatedly restarting a writer", async () => {
  const controller = new AbortController();
  let replacements = 0;
  await assert.rejects(
    watchHandsIncarnation({
      initial: "old",
      signal: controller.signal,
      intervalMs: 1,
      probe: async () => "new",
      replace: async () => {
        replacements++;
        throw Error("writer did not stop");
      },
    }),
    /writer did not stop/,
  );
  assert.equal(replacements, 1);
});
