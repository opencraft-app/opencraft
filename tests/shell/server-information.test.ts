import assert from "node:assert/strict";
import test from "node:test";
import { ServerInformationController } from "../../apps/workbench-web/src/runtime/server-information";
const ok = (revision = 0, publicUrl = "", actorId = "admin-a", canManage = true) =>
  new Response(JSON.stringify({ revision, publicUrl, actorId, canManage }));
test("cached first paint carries server information only, never previous identity or admin permission", async () => {
  const key = "cache-test",
    a = new ServerInformationController(key, async () => ok(2, "https://entry.example") as any);
  await a.read();
  a.dispose();
  const b = new ServerInformationController(key, async () => {
    throw Error("offline");
  });
  assert.equal(b.getSnapshot().information?.publicUrl, "https://entry.example");
  assert.equal(b.getSnapshot().authority, null);
  await b.read();
  assert.equal(b.getSnapshot().information?.revision, 2);
  assert.equal(b.getSnapshot().authority, null);
  b.dispose();
});
test("writes bind expected actor/revision, keep ambiguous results fenced until explicit reload, and do not auto-retry", async () => {
  let calls = 0;
  const inputs: any[] = [],
    c = new ServerInformationController("save-test", async (_url, init) => {
      calls++;
      if (init?.method === "POST") {
        inputs.push(JSON.parse(init.body as string));
        throw Error("ACK lost");
      }
      return ok(calls > 2 ? 1 : 0, calls > 2 ? "https://saved.example" : "");
    });
  await c.read();
  assert.equal(await c.save("https://saved.example"), false);
  assert.deepEqual(inputs[0], { revision: 0, publicUrl: "https://saved.example", expectedActorId: "admin-a" });
  assert.equal(c.getSnapshot().mustReload, true);
  await c.save("https://another.example");
  assert.equal(calls, 2);
  await c.read();
  assert.equal(c.getSnapshot().information?.revision, 1);
  assert.equal(c.getSnapshot().mustReload, false);
  c.dispose();
});
test("account expiry clears shared configuration cache and write authority", async () => {
  let expired = false;
  const c = new ServerInformationController("expiry-test", async () =>
    expired ? new Response("{}", { status: 401 }) : ok(1, "https://entry.example"),
  );
  await c.read();
  expired = true;
  await c.read();
  assert.equal(c.getSnapshot().phase, "expired");
  assert.equal(c.getSnapshot().information, null);
  assert.equal(c.getSnapshot().authority, null);
  const d = new ServerInformationController("expiry-test");
  assert.equal(d.getSnapshot().information, null);
  c.dispose();
  d.dispose();
});
test("permission loss and account switching cannot reuse an earlier admin response", async () => {
  let mode = "admin";
  const c = new ServerInformationController("account-test", async () =>
    mode === "admin"
      ? ok()
      : new Response(JSON.stringify({ error: mode }), { status: mode === "administrator_required" ? 403 : 409 }),
  );
  await c.read();
  mode = "administrator_required";
  await c.save("https://entry.example");
  assert.equal(c.getSnapshot().authority, null);
  mode = "admin";
  await c.read();
  mode = "account_changed";
  await c.save("https://entry.example");
  assert.equal(c.getSnapshot().phase, "expired");
  c.dispose();
});
test("strict-effect release/retain does not dispose the live controller, while final release fences late reads", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const c = new ServerInformationController("strict-test", async () => {
    await gate;
    return ok();
  });
  const first = c.retain();
  const pending = c.read();
  first();
  const second = c.retain();
  await Promise.resolve();
  release();
  await pending;
  assert.equal(c.getSnapshot().phase, "ready");
  second();
  await Promise.resolve();
  assert.equal(await c.read(), false);
});
