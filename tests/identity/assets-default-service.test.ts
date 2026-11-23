import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "@opencraft/access-control/actors";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { HumanAuth } from "@opencraft/access-control/human-auth";
import { MembershipStore, InstanceAccess } from "@opencraft/access-control";
import { HumanAccountManagement } from "@opencraft/access-control/account-management";
import { LocalAccountServerPlugin } from "../../plugins/local-account/src/server.js";
import { createNodePasswordHasher } from "../../plugins/local-account/src/password-hash-node.js";
import { LocalAccountApplication } from "../../plugins/local-account/src/application.js";
import { openAssetConfigurations } from "../../plugins/assets/src/server/worker.js";
import { githubApiFixture } from "../support/github-api-fixture.js";
import { openHumanAssets } from "../../plugins/local-account/src/assets-server.js";
import { createDesktopAccountHost } from "../../plugins/local-account/src/desktop.js";
import { createWorkbenchWebServer } from "../../apps/headless-server/src/serve-workbench-web.mjs";
import { createWorkbenchStaticServer } from "../../apps/headless-server/src/serve-workbench-static.mjs";
import { AuthBrowser } from "../support/human-auth-fixture.js";
const password = "Only-synthetic-fixture-password-42";
const credential = (revision = 0, extra = {}) => ({
  action: "save-credential",
  revision,
  name: "E2B",
  apiUrl: "https://api.e2b.dev",
  sandboxUrl: "https://e2b.dev",
  apiKey: "public-default-fixture-secret",
  ...extra,
});
async function fixture(t: test.TestContext, router = true, openStorage?: typeof openAssetConfigurations) {
  const root = await mkdtemp(join(tmpdir(), "default-assets-")),
    directory = join(root, "data");
  const storage = await openServerDatabase(directory),
    actors = new ActorStore(storage),
    accounts = new HumanAccounts(storage, actors);
  const provider = new LocalAccountServerPlugin(accounts.localAccountRepository, createNodePasswordHasher());
  accounts.registerLocalAccounts(provider);
  const members = new MembershipStore(storage),
    management = new HumanAccountManagement(storage, accounts, actors, members);
  const configuration = { origin: "", local: true, oidc: [] },
    auth = new HumanAuth(accounts, actors, configuration, () => "<title>Login</title>");
  const access = new InstanceAccess(members, [auth], actors),
    assets = await openHumanAssets({ directory, auth, access, actors, openStorage });
  const app = new LocalAccountApplication({ auth, management, setupToken: "A".repeat(43) });
  await writeFile(join(root, "index.html"), "<title>Assets integration</title>");
  let close: () => Promise<void>, origin: string;
  if (router) {
    const web = await createWorkbenchWebServer({
      root,
      appServerTarget: null,
      authService: auth,
      accessService: access,
      accountService: app,
      assetsService: assets,
    });
    const address = await web.listen({ host: "127.0.0.1", port: 0 });
    origin = `http://127.0.0.1:${address.port}`;
    close = () => web.close();
  } else {
    const server = createServer((req, res) => {
      void assets.handle(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    close = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
  }
  configuration.origin = origin;
  t.after(async () => {
    await close();
    await assets.close();
    app.close();
    management.close();
    auth.close();
    accounts.close();
    members.close();
    actors.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  let token: string, actorId: string;
  if (router) {
    const browser = new AuthBrowser(origin);
    assert.equal(
      (
        await browser.call("/__opencraft_account/setup", {
          proof: "A".repeat(43),
          mode: "web",
          username: "owner",
          password,
        })
      ).status,
      200,
    );
    token = browser.cookies.get("oc_human")!;
    actorId = (await (await browser.call("/__opencraft_account/status")).json()).actor.id;
  } else {
    const principal = await management.initialize({ mode: "web", username: "owner", password });
    const issued = accounts.issue(principal);
    token = issued.token;
    actorId = issued.login.context.actorId;
  }
  const scope = `actor:${actorId}`;
  const headers = {
    cookie: `oc_human=${token}`,
    "x-opencraft-account-scope": scope,
    origin,
    "content-type": "application/json",
  };
  const request = (path: string, body?: unknown) =>
    fetch(origin + path, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  return {
    root,
    directory,
    storage,
    accounts,
    actors,
    members,
    management,
    provider,
    auth,
    origin,
    scope,
    token,
    actorId,
    headers,
    request,
  };
}
test("default Headless router: real account setup/cookie membership reaches implemented encrypted configuration route", async (t) => {
  const f = await fixture(t);
  const capability = await f.request("/__opencraft_assets/status");
  assert.equal(capability.status, 200);
  assert.deepEqual(await capability.json(), { version: 1, scope: f.scope, gitHosts: ["github.com"] });
  const saved = await f.request("/__opencraft_assets/configurations", credential());
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.revision, 1);
  assert.equal(body.canManagePlatform, true);
  assert.ok(!JSON.stringify(body).includes("public-default-fixture-secret"));
  assert.equal((await f.request("/__opencraft_assets/configurations", credential())).status, 409);
  const stale = await fetch(f.origin + "/__opencraft_assets/configurations", {
    headers: { ...f.headers, "x-opencraft-account-scope": "actor:human://other/person" },
  });
  assert.equal(stale.status, 409);
  const bearer = await fetch(f.origin + "/__opencraft_assets/configurations", {
    headers: { ...f.headers, authorization: "Bearer not-a-human-login" },
  });
  assert.equal(bearer.status, 403);
  const bytes = await readFile(join(f.directory, "employee-git-vault.sqlite"));
  assert.ok(!bytes.includes(Buffer.from("public-default-fixture-secret")));
});
for (const mutation of ["logout", "password", "membership", "binding", "actor", "role"] as const)
  test(`real ${mutation} owner change withdraws an incomplete assets request before any write`, async (t) => {
    const f = await fixture(t, false);
    const body = JSON.stringify(credential(0, mutation === "role" ? { source: "platform" } : {}));
    const req = httpRequest(f.origin + "/__opencraft_assets/configurations", { method: "POST", headers: f.headers });
    const response = once(req, "response");
    req.write(body.slice(0, 10));
    // The first chunk flushes headers, then the server waits on the remaining JSON.
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (mutation === "logout") f.accounts.revoke(f.token);
    else if (mutation === "password") await f.provider.resetPassword("owner", password + "-new");
    else if (mutation === "actor") f.actors.setEnabled(f.actorId, false, "fixture");
    else if (mutation === "binding")
      f.members.set(
        { provider: "local", subject: f.accounts.authenticate(f.token)!.principal.subject },
        "member",
        false,
        "fixture",
      );
    else {
      // Another repository borrowing this owner must invalidate the same request.
      const other = new MembershipStore(f.storage);
      other.setActor(f.actorId, "member", mutation === "role", "fixture");
      other.close();
    }
    req.end(body.slice(10));
    const [res] = await response;
    assert.equal(res.statusCode, 403);
    res.resume();
    // Verify through the real encrypted domain after the network Worker drains.
    const { EmployeeGitVaultStore } = await import("@opencraft/execution-environment/employee-git-vault-store");
    const vault = await EmployeeGitVaultStore.open(f.directory);
    try {
      assert.equal(vault.readDocument(f.scope, "document-sandbox-configurations").revision, 0);
      assert.equal(
        vault.readDocument("platform:assistant-environments", "document-sandbox-configurations").revision,
        0,
      );
    } finally {
      vault.close();
    }
  });
test("default desktop host owns one assets service; native proof and actual cookie round-trip work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "desktop-assets-"));
  await writeFile(join(root, "index.html"), "<title>Desktop</title>");
  const host = await createDesktopAccountHost(join(root, "account"), () => "<title>Login</title>");
  const web = await createWorkbenchStaticServer({ root, accountService: host });
  const address = await web.listen({ host: "127.0.0.1", port: 0 }),
    origin = `http://127.0.0.1:${address.port}`;
  host.setOrigin(origin);
  t.after(async () => {
    await web.close();
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  const cookie = `oc_desktop_owner=${host.browserProof}; oc_human=${host.browserSessionToken}`;
  const status = await (await fetch(origin + "/__opencraft_assets/status", { headers: { cookie } })).json();
  assert.match(status.scope, /^actor:human:\/\//);
  assert.equal((await (await fetch(origin + "/__opencraft_assets/status")).json()).scope, null);
  const saved = await fetch(origin + "/__opencraft_assets/configurations", {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json", "x-opencraft-account-scope": status.scope },
    body: JSON.stringify(credential()),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);
});

test("a real role change through a borrowed repository invalidates an already-queued Worker operation", async (t) => {
  const f = await fixture(t, false);
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(f.directory, "employee-git-vault.sqlite");
  const lock = new DatabaseSync(path);
  try {
    lock.exec("BEGIN IMMEDIATE");
    const first = f.request("/__opencraft_assets/configurations", credential());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const queued = f.request("/__opencraft_assets/configurations", credential(0, { source: "platform" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const other = new MembershipStore(f.storage);
    other.setActor(f.actorId, "member", true, "fixture");
    other.close();
    lock.exec("ROLLBACK");
    assert.equal((await first).status, 403);
    assert.equal((await queued).status, 403);
    // The first operation entered domain execution before revocation; it may
    // finish, but the queued platform operation must never be admitted.
    const snapshot = await (await f.request("/__opencraft_assets/configurations")).json();
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.platformRevision, 0);
  } finally {
    if (lock.isTransaction) lock.exec("ROLLBACK");
    lock.close();
  }
});

const gitPath = "/__opencraft_assets/git-connections";
const gitInput = (revision = 0, extra = {}) => ({
  host: "github.com",
  action: "save",
  revision,
  username: "fixture",
  name: "Fixture",
  email: "fixture@example.test",
  token: "synthetic-github-api-token",
  ...extra,
});
async function gitFixture(t: test.TestContext) {
  const remote = await githubApiFixture();
  t.after(() => remote.close());
  const before = process.env.OPENCRAFT_TEST_GITHUB_ORIGIN;
  process.env.OPENCRAFT_TEST_GITHUB_ORIGIN = remote.origin;
  try {
    const f = await fixture(t, true, (directory) =>
      openAssetConfigurations(directory, {
        entry: new URL("../fixtures/assets-git-storage.worker.ts", import.meta.url),
      }),
    );
    return { ...f, remote };
  } finally {
    if (before === undefined) delete process.env.OPENCRAFT_TEST_GITHUB_ORIGIN;
    else process.env.OPENCRAFT_TEST_GITHUB_ORIGIN = before;
  }
}
test("real default login + HTTP + Worker: advertised GitHub verifies, signs, CAS-fences and projects metadata only", async (t) => {
  const f = await gitFixture(t);
  assert.deepEqual((await (await f.request("/__opencraft_assets/status")).json()).gitHosts, ["github.com"]);
  const response = await f.request(gitPath, gitInput());
  assert.equal(response.status, 200);
  const body = await response.json(),
    github = body.hosts["github.com"];
  assert.equal(body.scope, f.scope);
  assert.equal(github.revision, 2);
  assert.equal(github.signing.registration, "registered");
  assert.equal(github.identity.accountId, "42");
  assert.equal(github.tokenConfigured, true);
  assert.ok(!JSON.stringify(body).includes("synthetic-github-api-token"));
  assert.ok(!JSON.stringify(body).includes("privateKey"));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await f.request(gitPath, gitInput())).status, 409);
  const crossScope = await fetch(f.origin + gitPath, {
    headers: { ...f.headers, "x-opencraft-account-scope": "actor:other" },
  });
  assert.equal(crossScope.status, 409);
  const crossOrigin = await fetch(f.origin + gitPath, {
    method: "POST",
    headers: { ...f.headers, origin: "https://attacker.invalid" },
    body: JSON.stringify(gitInput(2)),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await f.request(gitPath, gitInput(2, { host: "git.woa.com" }))).status, 400);
  assert.equal(f.remote.calls.filter((c) => c.method === "POST").length, 1);
  assert.ok(
    !(await readFile(join(f.directory, "employee-git-vault.sqlite"))).includes(
      Buffer.from("synthetic-github-api-token"),
    ),
  );
  const cleared = await f.request(gitPath, { host: "github.com", action: "clear", revision: 2 });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).hosts["github.com"].configured, false);
  assert.equal(f.remote.keys.length, 1, "clearing the local connection cannot revoke remote keys");
});
for (const mutation of ["logout", "password", "membership", "actor", "role"] as const)
  test(`real ${mutation} revocation while GitHub verification is in flight cannot persist credentials`, async (t) => {
    const f = await gitFixture(t),
      pause = f.remote.pause("/user");
    const pending = f.request(gitPath, gitInput());
    try {
      await pause.entered;
      if (mutation === "logout") f.accounts.revoke(f.token);
      else if (mutation === "password") await f.provider.resetPassword("owner", password + "-new");
      else if (mutation === "actor") f.actors.setEnabled(f.actorId, false, "fixture");
      else {
        const other = new MembershipStore(f.storage);
        other.setActor(f.actorId, "member", mutation === "role", "fixture");
        other.close();
      }
      // Keep the revoked request in flight past one tick of the router's 500 ms
      // access watch; the answer must still be the assets fence's definite 403.
      await new Promise((resolve) => setTimeout(resolve, 600));
    } finally {
      pause.release();
    }
    assert.equal((await pending).status, 403);
    const { EmployeeGitVaultStore } = await import("@opencraft/execution-environment/employee-git-vault-store");
    const vault = await EmployeeGitVaultStore.open(f.directory);
    try {
      assert.equal(vault.read(f.scope, "github.com").revision, 0);
    } finally {
      vault.close();
    }
    assert.equal(f.remote.calls.length, 1, "no email/signing side effects after authority withdrawal");
  });
test("real HTTP + Worker: uncertain remote signing is retained and explicit retry reconciles without another POST", async (t) => {
  const f = await gitFixture(t);
  f.remote.setMode("unknown");
  const saved = await f.request(gitPath, gitInput());
  assert.equal(saved.status, 200);
  const first = await saved.json();
  assert.equal(first.hosts["github.com"].signing.registration, "pending");
  f.remote.setMode("registered");
  const retry = await f.request(gitPath, { host: "github.com", revision: 2, action: "register" });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).hosts["github.com"].signing.registration, "registered");
  assert.equal(f.remote.calls.filter((c) => c.method === "POST").length, 1);
});
