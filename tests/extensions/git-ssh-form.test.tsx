import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { registerHooks } from "node:module";
import type { GitConnectionStatus, GitConnectionsSnapshot } from "../../plugins/assets/src/git/contract.js";
import type { GitConnectionController } from "../../plugins/assets/src/git/controller.js";
const styles = registerHooks({
  load(url, context, next) {
    return /\.(?:css|scss)$/u.test(new URL(url).pathname)
      ? { format: "module", source: "export default {};", shortCircuit: true }
      : next(url, context);
  },
});
const { SshConnectionForm } = await import("../../plugins/assets/src/git/ssh-form.js");
const { gitAssetProviders, githubAssetProvider } = await import("../../plugins/assets/src/git/client.js");
const { ServerAssetsAccount } = await import("../../plugins/assets/src/client.js");
styles.deregister();
(globalThis as { React?: typeof React }).React = React;

const host = "git.example.test",
  scope = "actor:human://fixture/one",
  provider = { host, auth: "ssh" as const, name: "Example Git" };
const empty: GitConnectionStatus = {
  revision: 0,
  configured: false,
  tokenConfigured: false,
  identity: null,
  sshAuth: null,
  signing: null,
};
const keyed: GitConnectionStatus = {
  ...empty,
  revision: 1,
  configured: true,
  identity: { username: "fixture", name: "Fixture", email: "fixture@example.test" },
  sshAuth: { generation: "g1", publicKey: "ssh-ed25519 AAAAsyntheticpublic", fingerprint: "SHA256:synthetic" },
};
function controller(
  row: GitConnectionStatus | null,
  extra: Partial<GitConnectionController> = {},
): GitConnectionController {
  const snapshot: GitConnectionsSnapshot | null = row ? { scope, hosts: { [host]: row } } : null;
  return {
    snapshot,
    busy: false,
    unauthorized: false,
    operationErrors: {},
    operationCodes: {},
    load: async () => true,
    getSnapshot: () => snapshot,
    clearHostErrors() {},
    ...extra,
  };
}
const render = (c: GitConnectionController) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" onError={() => {}}>
      <SshConnectionForm controller={c} provider={provider} />
    </IntlProvider>,
  );

test("SSH form: loading, no key, key ready, conflict and expired-account states", () => {
  const loading = render(controller(null));
  assert.match(loading, /Example Git connection/);
  assert.match(loading, /Loading…/);

  const none = render(controller(empty));
  assert.match(none, /Not added/);
  assert.match(none, /No SSH key yet/);
  assert.match(none, /Generate SSH key/);
  assert.match(none, /Enter the account, commit name and commit email first\./);
  assert.doesNotMatch(none, /Copy public key|Regenerate key|Delete key/);

  const ready = render(controller(keyed));
  assert.match(ready, /Added/);
  assert.match(ready, /Key generated\. Add the public key to your account on Example Git\./);
  assert.ok(ready.includes('value="ssh-ed25519 AAAAsyntheticpublic"'));
  assert.match(ready, /SHA256:synthetic/);
  assert.match(ready, /Copy public key/);
  assert.match(ready, /Regenerate key/);
  assert.match(ready, /Delete key/);
  assert.doesNotMatch(ready, /Generate SSH key/);

  const conflicted = render(
    controller(keyed, {
      operationErrors: { [host + ":credentials"]: "Changed elsewhere." },
      operationCodes: { [host + ":credentials"]: "conflict" },
    }),
  );
  assert.match(conflicted, /role="alert"[^>]*>Changed elsewhere\./);
  assert.match(conflicted, /Load latest/);

  // A failed read is reported once, in the form's own status slot beside the
  // conflict it follows; it is not appended as a second notice below the form.
  const readFailed = render(
    controller(keyed, {
      operationErrors: { read: "Read failed.", [host + ":credentials"]: "Changed elsewhere." },
      operationCodes: { [host + ":credentials"]: "conflict" },
    }),
  );
  assert.match(readFailed, /role="alert"[^>]*>Read failed\. Changed elsewhere\.</);
  assert.equal(readFailed.split("Read failed.").length, 2);
  assert.doesNotMatch(readFailed, /settings-control-notice/);

  const invalid = render(
    controller(keyed, {
      operationErrors: { [host + ":credentials"]: "token copy" },
      operationCodes: { [host + ":credentials"]: "invalid" },
    }),
  );
  assert.match(invalid, /Check the account, commit name and commit email\./);
  assert.doesNotMatch(invalid, /token copy/);

  assert.match(render(controller(keyed, { unauthorized: true })), /Account access has expired/);
});

test("catalog rows come from advertised provider metadata; unknown token hosts have no editor", () => {
  const rows = gitAssetProviders([
    { host: "github.com", auth: "token" },
    { host: "git.other.test", auth: "token" },
    provider,
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0], githubAssetProvider);
  assert.deepEqual(
    { id: rows[1]!.id, name: rows[1]!.name, host: rows[1]!.host, editor: rows[1]!.editor },
    { id: "git-ssh:" + host, name: "Example Git", host, editor: "git" },
  );
});

test("the account accepts provider metadata only for exactly the advertised hosts", async () => {
  const read = (body: unknown) => new ServerAssetsAccount(async () => Response.json(body));
  let account = read({ version: 1, scope, gitHosts: ["github.com"] });
  await account.refresh();
  assert.deepEqual(account.getGitProviders(), [{ host: "github.com", auth: "token" }]);
  account = read({
    version: 1,
    scope,
    gitHosts: ["github.com", host],
    gitProviders: [{ host: "github.com", auth: "token" }, provider],
  });
  await account.refresh();
  assert.deepEqual(account.getGitProviders(), [{ host: "github.com", auth: "token" }, provider]);
  for (const gitProviders of [[], [{ ...provider, host: "git.other.test" }], [{ ...provider, secret: "x" }]])
    await assert.rejects(read({ version: 1, scope, gitHosts: [host], gitProviders }).refresh(), /assets_unavailable/);
});
