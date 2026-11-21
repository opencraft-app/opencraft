import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketGateway, request } from "../src/adapters/local/unix-socket.mjs";

test("profile socket beyond Linux sun_path stays in the profile and serves requests", async (t) => {
  if (process.platform !== "linux") {
    t.skip("Linux sun_path addressing only");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "pa-socket-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profilePath = join(root, "server", "bots", "x".repeat(96));
  mkdirSync(profilePath, { recursive: true, mode: 0o700 });
  const profile = { socket: join(profilePath, "runner.sock") };
  assert.ok(Buffer.byteLength(profile.socket) > 107);
  const gateway = new UnixSocketGateway(profile.socket, async (message) => ({
    echoed: message.value,
  }));
  await gateway.open();
  try {
    const stat = lstatSync(profile.socket);
    assert.equal(stat.isSocket(), true);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.deepEqual(await request(profile, { value: "first" }), {
      echoed: "first",
    });
    assert.deepEqual(await request(profile, { value: "second" }), {
      echoed: "second",
    });
  } finally {
    await gateway.close();
  }
  assert.equal(existsSync(profile.socket), false);
  await assert.rejects(request(profile, { value: "closed" }));
});
