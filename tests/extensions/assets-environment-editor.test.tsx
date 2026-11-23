import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { registerHooks } from "node:module";
const styles = registerHooks({
  load(url, context, next) {
    return /\.(?:css|scss)$/u.test(new URL(url).pathname)
      ? { format: "module", source: "export default {};", shortCircuit: true }
      : next(url, context);
  },
});
const { createAssetEnvironmentPort, createAssetVariablesEditor } =
  await import("../../plugins/assets/src/environment.js");
const { ServerAssetsAccount } = await import("../../plugins/assets/src/client.js");
styles.deregister();
(globalThis as { React?: typeof React }).React = React;

const scope = "actor:human://fixture/one";
function account(initial: string | null = scope) {
  let current = initial,
    refreshes = 0;
  return {
    subscribe: () => () => {},
    getScope: () => current,
    refresh() {
      refreshes++;
    },
    set(next: string | null) {
      current = next;
    },
    get refreshes() {
      return refreshes;
    },
  };
}
const document = (projectId: string | null = null) => ({
  projectId,
  revision: 3,
  variables: [{ name: "TOKEN", value: null, secret: true }],
  inherited: [],
  projects: [{ id: "p1", name: "Alpha" }],
});

test("the default Assets ENV editor renders the shared Settings editor with translated defaults, without a request", () => {
  const calls: unknown[] = [];
  const Editor = createAssetVariablesEditor(async (...args: Parameters<typeof fetch>) => {
    calls.push(args);
    return Response.json(document());
  }, account());
  const html = renderToStaticMarkup(
    <IntlProvider locale="en" onError={() => {}}>
      <Editor scope={scope} onStateChange={() => {}} />
    </IntlProvider>,
  );
  for (const text of ["Personal variables", "All my projects", "Add variable", "Loading…"])
    assert.ok(html.includes(text), text);
  assert.equal(calls.length, 0, "rendering never reads values; the effect does");
  const translated = renderToStaticMarkup(
    <IntlProvider locale="zh-CN" messages={{ "assets.env.title": "个人变量" }} onError={() => {}}>
      <Editor scope={scope} onStateChange={() => {}} />
    </IntlProvider>,
  );
  assert.ok(translated.includes("个人变量"));
});

test("the ENV port is fenced to its account scope and maps only stable error codes", async () => {
  const owner = account();
  const requests: { url: string; init: RequestInit }[] = [];
  let reply: () => Response = () => Response.json(document("p1"));
  const port = createAssetEnvironmentPort(
    async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return reply();
    },
    owner,
    scope,
  );
  const signal = new AbortController().signal;
  assert.equal((await port.load("p1", signal)).projectId, "p1");
  assert.equal(requests[0]!.url, "/__opencraft_assets/environment?projectId=p1");
  assert.equal((requests[0]!.init.headers as Record<string, string>)["x-opencraft-account-scope"], scope);
  reply = () => Response.json(document());
  await port.save(document(), [{ name: "TOKEN", value: null, secret: true }], signal);
  assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), {
    projectId: null,
    revision: 3,
    variables: [{ name: "TOKEN", value: null, secret: true }],
  });
  // A response for another project is never shown in this one.
  reply = () => Response.json(document("p2"));
  await assert.rejects(port.load("p1", signal), /invalid/);
  reply = () => Response.json({ error: "conflict" }, { status: 409 });
  await assert.rejects(port.save(document(), [], signal), /conflict/);
  reply = () => Response.json({ error: "internal detail" }, { status: 503 });
  await assert.rejects(port.load(null, signal), /^Error: unavailable$/);
  reply = () => Response.json({ error: "unauthenticated" }, { status: 401 });
  await assert.rejects(port.load(null, signal), /unavailable/);
  assert.equal(owner.refreshes, 1);
  // After an account change the old editor neither sends nor accepts a response.
  owner.set("actor:human://fixture/two");
  const before = requests.length;
  await assert.rejects(port.load(null, signal), /unauthenticated/);
  assert.equal(requests.length, before);
});

test("the status route advertises personal ENV; anything but true is refused", async () => {
  const advertised = new ServerAssetsAccount(async () => Response.json({ version: 1, scope, environment: true }));
  await advertised.refresh();
  assert.equal(advertised.getEnvironment(), true);
  const absent = new ServerAssetsAccount(async () => Response.json({ version: 1, scope }));
  await absent.refresh();
  assert.equal(absent.getEnvironment(), false);
  const malformed = new ServerAssetsAccount(async () => Response.json({ version: 1, scope, environment: "yes" }));
  await assert.rejects(malformed.refresh());
});
