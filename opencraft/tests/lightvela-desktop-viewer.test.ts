import assert from "node:assert/strict";
import test from "node:test";
import { createLightVelaDesktopViewerPort } from "../plugins/lightvela-platform/src/desktop";
import type { LightVelaDesktopBinding } from "../plugins/lightvela-platform/src/desktop";
import type { LightVelaAccountSnapshot } from "../plugins/lightvela-platform/src/account/lightvela-account-service";
import { LightVelaAccountService } from "../plugins/lightvela-platform/src/account/lightvela-account-service";

function fixture() {
  const binding: LightVelaDesktopBinding = { target: { conversationId: "conversation", serverId: "server",
    environmentId: "environment", principalId: "principal" }, region: "cn", instanceId: "instance",
    viewingAllowed: true, revision: "binding:1" };
  const resource = { resourceId: "instance", preparationGenerationId: "preparation" };
  let state = { session: { status: "authenticated", epoch: 1 }, region: "cn", authGeneration: 1,
    credentialScope: "scope", details: { profile: { id: "principal" } } } as LightVelaAccountSnapshot;
  let response: Record<string, unknown> = { version: 1, target: binding.target, ...resource,
    instanceId: binding.instanceId, bindingRevision: binding.revision, incarnation: "physical",
    attachmentId: "abcdefghijklmnop", ticket: "synthetic_ticket_abcdefghijklmnop", expiresAt: Date.now() + 30_000 };
  const calls: { path: string; method?: string; body?: BodyInit | null }[] = [];
  const account = { getSnapshot: () => state, async request<T>(path: string, init?: RequestInit): Promise<T> {
    calls.push({ path, method: init?.method, body: init?.body }); return response as T;
  } };
  const options = { account, attachmentsPath: "/desktop/attachments", connectUrl: "wss://broker.invalid/desktop/connect" };
  return { options, binding, resource, calls, account, port: () => createLightVelaDesktopViewerPort(options),
    response(patch: Record<string, unknown>) { response = { ...response, ...patch }; },
    identity(patch: Partial<LightVelaAccountSnapshot>) { state = { ...state, ...patch }; } };
}
test("viewer requests exact authorized binding and releases only its attachment", async () => {
  const f = fixture(); const attachment = await f.port().acquire(f.binding, f.resource, new AbortController().signal);
  assert.equal(attachment.incarnation, "physical");
  assert.deepEqual(JSON.parse(f.calls[0]!.body as string), { target: f.binding.target, instanceId: "instance",
    ...f.resource, bindingRevision: "binding:1" });
  attachment.release(); attachment.release();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1]!.method, "DELETE");
});
for (const patch of [{ incarnation: "" }, { bindingRevision: "wrong" }, { instanceId: "wrong" },
  { target: { conversationId: "another" } }, { preparationGenerationId: "physical" },
  { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 900_000 }, { ticket: "" }]) {
  test(`viewer rejects invalid ${Object.keys(patch)[0]} and retires the issued handle`, async () => {
    const f = fixture(); f.response(patch);
    await assert.rejects(f.port().acquire(f.binding, f.resource, new AbortController().signal));
    assert.equal(f.calls.at(-1)?.method, "DELETE");
  });
}
test("late acquisition after account change never releases using successor credentials", async () => {
  const f = fixture(); const request = f.account.request;
  f.account.request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await request<T>(path, init); f.identity({ authGeneration: 2 }); return response;
  };
  await assert.rejects(f.port().acquire(f.binding, f.resource, new AbortController().signal));
  assert.equal(f.calls.length, 1);
});
test("late acquisition after abort releases the original account's handle", async () => {
  const f = fixture(); const request = f.account.request, abort = new AbortController();
  f.account.request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await request<T>(path, init); if (init?.method === "POST") abort.abort(); return response;
  };
  await assert.rejects(f.port().acquire(f.binding, f.resource, abort.signal));
  assert.equal(f.calls.at(-1)?.method, "DELETE");
});
test("credentials cannot appear in a configured websocket endpoint", () => {
  const f = fixture();
  for (const connectUrl of ["ws://broker.invalid", "wss://user:password@broker.invalid", "wss://broker.invalid?ticket=value"]) {
    assert.throws(() => createLightVelaDesktopViewerPort({ ...f.options, connectUrl }));
  }
});

test("viewer consumes the real account service's OK/data envelope, including release", async t => {
  const f = fixture(), methods: string[] = [];
  const service = new LightVelaAccountService({ apiBase: "https://synthetic.invalid", fetchImpl: async (_url, init) => {
    methods.push(init?.method ?? "GET");
    let data: unknown = null;
    if (init?.method === "POST") {
      data = { ...JSON.parse(init.body as string), version: 1, attachmentId: "abcdefghijklmnop",
        ticket: "synthetic_ticket_abcdefghijklmnop", incarnation: "physical", expiresAt: Date.now() + 30_000 };
    }
    return new Response(JSON.stringify({ code: "OK", message: "success", data }), { status: 200 });
  } });
  t.after(() => service.dispose());
  const port = createLightVelaDesktopViewerPort({ ...f.options,
    account: { getSnapshot: f.account.getSnapshot, request: service.request.bind(service) } });
  const attachment = await port.acquire(f.binding, f.resource, new AbortController().signal);
  attachment.release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(methods, ["POST", "DELETE"]);
});
