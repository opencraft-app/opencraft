import assert from "node:assert/strict";
import test from "node:test";
import { NotificationDestinationsController } from "../../apps/workbench-web/src/runtime/notification-destinations";
const configuration = { actorId: "human-a", enabled: true, hosts: ["local-codex"], destinations: [], imTargets: [] };
const messages = { completed: "Complete", failed: "Failed", interrupted: "Stopped", body: "Return", test: "Test" };
const flush = () => new Promise((resolve) => setImmediate(resolve));
test("sign out fences late configuration and mutation responses", async () => {
  let resolve!: (response: Response) => void;
  const owner = new NotificationDestinationsController(
    (() => new Promise<Response>((r) => (resolve = r))) as typeof fetch,
  );
  owner.configure("en-US", messages);
  owner.reset();
  resolve(Response.json(configuration));
  await flush();
  assert.equal(owner.getSnapshot().configuration, null);
  owner.dispose();
});
test("configuration writes bind the expected human, preserve on failure and clear after account change", async () => {
  const calls: any[] = [];
  let status = 200;
  const owner = new NotificationDestinationsController((async (_input, init) => {
    if (!init?.body) return Response.json(configuration);
    calls.push(JSON.parse(String(init.body)));
    return status === 200
      ? Response.json({ ...configuration, enabled: false })
      : Response.json({ error: "failure" }, { status });
  }) as typeof fetch);
  owner.configure("en-US", messages);
  await flush();
  await owner.operation("master", { enabled: false });
  assert.equal(calls[0].expectedActorId, "human-a");
  assert.equal(owner.getSnapshot().configuration?.enabled, false);
  status = 500;
  await assert.rejects(owner.operation("master", { enabled: true }));
  assert.equal(owner.getSnapshot().configuration?.enabled, false);
  assert.equal(owner.getSnapshot().busy, null);
  status = 409;
  await assert.rejects(owner.operation("master", { enabled: true }));
  assert.equal(owner.getSnapshot().configuration, null);
  owner.dispose();
});

test("notification failures classify safe reasons, including old servers and non-JSON proxies", async () => {
  const cases: [number, unknown, string][] = [
    [400, { error: "invalid_destination" }, "address"],
    [400, { error: "invalid_target" }, "im"],
    [400, { error: "device_limit" }, "limit"],
    [401, {}, "account"],
    [409, {}, "account"],
    [403, { error: "same_origin_json_required" }, "forbidden"],
    [404, { error: "not_found" }, "missing"],
    [404, {}, "unavailable"],
    [429, {}, "rate"],
    [503, { error: "notification_storage_unavailable" }, "storage"],
    [502, { error: "notification_delivery_failed" }, "delivery"],
    [400, { error: "push_operation_failed" }, "unknown"],
    [500, { error: "https://secret.example/private-token" }, "unknown"],
    [502, "<html>proxy error</html>", "unknown"],
  ];
  for (const [status, body, reason] of cases) {
    const owner = new NotificationDestinationsController((async (_input, init) =>
      !init?.body
        ? Response.json(configuration)
        : typeof body === "string"
          ? new Response(body, { status })
          : Response.json(body, { status })) as typeof fetch);
    owner.configure("en-US", messages);
    await flush();
    await assert.rejects(
      owner.operation("save"),
      (error: any) => error.reason === reason && !error.message.includes("private-token"),
    );
    assert.equal(owner.getSnapshot().busy, null);
    owner.dispose();
  }
  const owner = new NotificationDestinationsController((async (_input, init) => {
    if (init?.body) throw new TypeError("Failed to fetch");
    return Response.json(configuration);
  }) as typeof fetch);
  owner.configure("en-US", messages);
  await flush();
  await assert.rejects(owner.operation("save"), (error: any) => error.reason === "network");
  owner.dispose();
});

test("malformed destination and host data never enters the ready state", async () => {
  for (const malformed of [
    { ...configuration, hosts: [null] },
    { ...configuration, destinations: [null] },
    { ...configuration, destinations: [{ id: "x", kind: "webhook", label: "x", enabled: "yes", authorized: true }] },
    { ...configuration, imTargets: [{ channelId: "channel", senderId: 17, label: "account" }] },
  ]) {
    const owner = new NotificationDestinationsController((async () => Response.json(malformed)) as typeof fetch);
    owner.configure("en-US", messages);
    await flush();
    assert.equal(owner.getSnapshot().phase, "error");
    assert.equal(owner.getSnapshot().configuration, null);
    owner.dispose();
  }
});
