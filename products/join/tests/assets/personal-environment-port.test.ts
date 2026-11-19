import assert from "node:assert/strict";
import test from "node:test";
import { createPersonalEnvironmentPort } from "../../plugins/tencentoa/src/environment-variables-port";
import type { TencentOaController } from "../../plugins/tencentoa/src/controller";

const document = (projectId: string | null = null) => ({
  projectId,
  revision: 3,
  variables: [{ name: "SERVICE_KEY", value: null, secret: true }],
  inherited: [],
  projects: [{ id: "p/a", name: "Project" }],
});
function fixture(fetcher: typeof fetch) {
  let staffId: string | null = "100",
    refreshed = 0;
  const controller = {
    getSnapshot: () => ({ identity: staffId ? { staffId } : null }),
    refresh: async () => {
      refreshed++;
    },
  } as unknown as TencentOaController;
  return {
    port: createPersonalEnvironmentPort(controller, fetcher, "tencentoa:100"),
    switch: () => {
      staffId = "200";
    },
    get refreshed() {
      return refreshed;
    },
  };
}
const signal = () => new AbortController().signal;
test("one personal ENV adapter preserves project scope, secret placeholders and CAS", async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  const f = fixture((async (url, options) => {
    requests.push({ url: String(url), options: options! });
    return Response.json(document("p/a"));
  }) as typeof fetch);
  const loaded = await f.port.load("p/a", signal());
  await f.port.save(loaded, loaded.variables, signal());
  assert.match(requests[0]!.url, /\?projectId=p%2Fa$/);
  assert.equal(requests[0]!.options.credentials, "same-origin");
  assert.equal(requests[0]!.options.cache, "no-store");
  assert.equal(
    (requests[1]!.options.headers as Record<string, string>)[
      "x-opencraft-account-scope"
    ],
    "tencentoa:100",
  );
  assert.deepEqual(JSON.parse(String(requests[1]!.options.body)), {
    projectId: "p/a",
    revision: 3,
    variables: loaded.variables,
  });
});
test("stale identity cannot start a write", async () => {
  let calls = 0;
  const f = fixture((async () => {
    calls++;
    return Response.json(document());
  }) as typeof fetch);
  f.switch();
  await assert.rejects(
    f.port.save(document(), [], signal()),
    /unauthenticated/,
  );
  assert.equal(calls, 0);
});
test("identity fence covers delayed response and JSON decoding", async () => {
  for (const duringBody of [false, true]) {
    let f: ReturnType<typeof fixture>;
    f = fixture((async () => {
      if (!duringBody) f.switch();
      return {
        ok: true,
        json: async () => {
          if (duringBody) f.switch();
          return document();
        },
      } as Response;
    }) as typeof fetch);
    await assert.rejects(f.port.load(null, signal()), /unauthenticated/);
  }
});
test("aborted requests never start and project mismatch is rejected", async () => {
  let calls = 0;
  const f = fixture((async () => {
    calls++;
    return Response.json(document("other"));
  }) as typeof fetch);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(f.port.load(null, abort.signal), { name: "AbortError" });
  assert.equal(calls, 0);
  await assert.rejects(f.port.load(null, signal()), /invalid/);
});
test("only known validation codes escape; unauthorized refreshes identity", async () => {
  for (const [status, code, expected] of [
    [409, "conflict", "conflict"],
    [400, "reserved", "reserved"],
    [400, "invalid", "invalid"],
    [503, "private internal detail", "unavailable"],
    [401, "unauthenticated", "unavailable"],
  ] as const) {
    const f = fixture((async () =>
      Response.json({ error: code }, { status })) as typeof fetch);
    await assert.rejects(f.port.load(null, signal()), new RegExp(expected));
    assert.equal(f.refreshed, status === 401 ? 1 : 0);
  }
});
