import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AccountModelSelection } from "@opencraft/workbench-runtime";
import { accountModelDefaultsHttp } from "../../apps/headless-server/src/account-model-defaults-http.ts";
import { PlatformAccountContributionRegistry } from "../../apps/workbench-web/src/runtime/platform-account-contributions";
import { ServerAccountModelDefaults } from "../../apps/workbench-web/src/runtime/server-account-model-defaults";
import { useAccountModelDefaults } from "../../apps/workbench-web/src/runtime/use-account-model-defaults";
import { serveNodeHttpExchange } from "@opencraft/http-exchange/node";

/** The real route over an in-memory owner; the signed-in Actor comes from a fixture header. */
async function server(t: test.TestContext) {
  const records = new Map<string, { revision: number; selection: unknown }>();
  const handler = accountModelDefaultsHttp(
    {
      async readAccountModelDefaults(actorId, hostId) {
        return records.get(JSON.stringify([actorId, hostId])) ?? { revision: 0, selection: null };
      },
      async compareAndSetAccountModelDefaults(actorId, hostId, revision, selection) {
        const key = JSON.stringify([actorId, hostId]),
          current = records.get(key) ?? { revision: 0, selection: null };
        if (current.revision !== revision) return { updated: false, record: current };
        const next = { revision: revision + 1, selection };
        records.set(key, next);
        return { updated: true, record: next };
      },
    },
    (request) => {
      const actor = request.headers["x-fixture-actor"];
      return typeof actor === "string" ? { actorId: actor, origin: null } : { denied: 401 };
    },
  );
  const http = createServer((request, response) => {
    void serveNodeHttpExchange(request, response, handler);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => {
    http.close();
  });
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const fetcherFor =
    (actor: string | null): typeof fetch =>
    (input, init) =>
      fetch(base + String(input), {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          origin: base,
          ...(actor ? { "x-fixture-actor": actor } : {}),
        },
      });
  return { records, fetcherFor };
}

type Hook = ReturnType<typeof useAccountModelDefaults>;

async function mount(accounts: PlatformAccountContributionRegistry, source: ServerAccountModelDefaults | null) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const latest: { value: Hook | null } = { value: null };
  function Probe() {
    latest.value = useAccountModelDefaults(accounts, "host", true, source);
    return null;
  }
  const client = new QueryClient();
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  const settle = async (done: (hook: Hook) => boolean) => {
    for (let attempt = 0; attempt < 200 && !done(latest.value!); attempt++)
      await React.act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(done(latest.value!), true);
    return latest.value!;
  };
  return {
    settle,
    hook: () => latest.value!,
    async unmount() {
      await React.act(async () => root.unmount());
      client.clear();
      dom.window.close();
      Object.assign(globalThis, {
        window: previous.window,
        document: previous.document,
        IS_REACT_ACT_ENVIRONMENT: previous.act,
      });
    },
  };
}

test("without an account contribution the core login port remembers and reads back the selection", async (t) => {
  const { records, fetcherFor } = await server(t);
  const source = await ServerAccountModelDefaults.discover(fetcherFor("human://person"));
  assert.ok(source);
  assert.equal(source.getScope(), "human://person");
  const first = await mount(new PlatformAccountContributionRegistry(), source);
  try {
    const empty = await first.settle((hook) => !hook.isPending);
    assert.equal(empty.authoritative, true);
    assert.equal(empty.selection, null);
    const choice: AccountModelSelection = { model: "provider/model", effort: "high", serviceTier: null };
    await React.act(async () => first.hook().remember(choice, "host"));
    const saved = await first.settle((hook) => hook.selection?.model === "provider/model");
    assert.deepEqual(saved.selection, choice);
    assert.equal(saved.error, null);
    assert.deepEqual(records.get(JSON.stringify(["human://person", "host"])), { revision: 1, selection: choice });
  } finally {
    await first.unmount();
  }

  // Another device of the same person reads the same record from the server.
  const other = await mount(
    new PlatformAccountContributionRegistry(),
    (await ServerAccountModelDefaults.discover(fetcherFor("human://person")))!,
  );
  try {
    assert.deepEqual((await other.settle((hook) => hook.selection !== undefined && !hook.isPending)).selection, {
      model: "provider/model",
      effort: "high",
      serviceTier: null,
    });
  } finally {
    await other.unmount();
  }

  // Signed-out visitors keep installation memory. A product account contribution without its own
  // model defaults port still uses the core login port; one with a port keeps its own authority.
  assert.equal(await ServerAccountModelDefaults.discover(fetcherFor(null)), undefined);
  const accounts = new PlatformAccountContributionRegistry();
  accounts
    .createAdapter()
    .prepare({} as never, {
      id: "product.account",
      viewId: "product.account.view",
      refresh: async () => undefined,
      subscribe: () => () => undefined,
      getSnapshot: () => ({
        revision: 1,
        phase: "authenticated",
        readStateScope: "product-scope",
        name: null,
        avatarUrl: null,
        planLabel: null,
        usageRemainingPercent: null,
        error: null,
      }),
    })
    .commit();
  const product = await mount(accounts, source);
  try {
    const hook = await product.settle((value) => !value.isPending);
    assert.equal(hook.authoritative, true, "a contribution without modelDefaults falls back to the core port");
  } finally {
    await product.unmount();
  }
  const owned = new PlatformAccountContributionRegistry();
  const reads: string[] = [];
  owned
    .createAdapter()
    .prepare({} as never, {
      id: "product.account.owned",
      viewId: "product.account.owned.view",
      refresh: async () => undefined,
      subscribe: () => () => undefined,
      getSnapshot: () => ({
        revision: 1,
        phase: "authenticated",
        readStateScope: "product-scope",
        name: null,
        avatarUrl: null,
        planLabel: null,
        usageRemainingPercent: null,
        error: null,
      }),
      modelDefaults: {
        async read(scope: string, host: string) {
          reads.push(scope + "|" + host);
          return { revision: 0, selection: null };
        },
        async write() {
          throw Error("not used");
        },
      },
    })
    .commit();
  const productOwned = await mount(owned, source);
  try {
    const hook = await productOwned.settle((value) => !value.isPending);
    assert.equal(hook.authoritative, true);
    assert.ok(
      reads.length > 0 && reads.every((entry) => entry.startsWith("product-scope|")),
      "the product port stays the authority",
    );
  } finally {
    await productOwned.unmount();
  }
});
