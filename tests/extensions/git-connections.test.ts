import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { GitConnections } from "../../plugins/assets/src/server/git-connections.js";
import { githubConnectionProvider } from "../../plugins/assets/src/server/github-provider.js";
import { parseGitConnections, mergeGitConnections } from "../../plugins/assets/src/git/contract.js";
const scope = "actor:human://fixture/one",
  token = "synthetic-provider-token-not-real";
const input = (revision = 0, extra = {}) => ({
  host: "github.com",
  action: "save",
  revision,
  username: "fixture",
  name: "Fixture User",
  email: "42+fixture@users.noreply.github.com",
  token,
  ...extra,
});
function remote() {
  let posts = 0,
    unknownPost = false,
    denied = false,
    emailsDenied = false;
  const keys: { id: number; key: string }[] = [],
    requests: { path: string; method: string }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    assert.equal(u.origin, "https://api.github.com");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("x-github-api-version"), "2026-03-10");
    requests.push({ path: u.pathname, method: init?.method ?? "GET" });
    if (u.pathname === "/user") return Response.json({ id: 42, login: "fixture" });
    if (u.pathname === "/user/emails")
      return emailsDenied
        ? new Response("{}", { status: 403 })
        : Response.json([{ email: "verified@example.test", verified: true }]);
    if (u.pathname === "/user/ssh_signing_keys") {
      if (denied) return new Response("{}", { status: 403 });
      if (init?.method === "POST") {
        posts++;
        const b = JSON.parse(String(init.body));
        keys.push({ id: posts, key: b.key });
        if (unknownPost) {
          unknownPost = false;
          throw Error("synthetic lost response");
        }
        return Response.json(keys.at(-1));
      }
      return Response.json(keys);
    }
    throw Error("Unexpected GitHub operation");
  };
  return {
    fetcher,
    requests,
    get posts() {
      return posts;
    },
    deny: () => {
      denied = true;
    },
    denyEmail: () => {
      emailsDenied = true;
    },
    losePost: () => {
      unknownPost = true;
    },
  };
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "git-connections-"));
  const vault = new EmployeeGitVaultStore(directory),
    upstream = remote(),
    store = new GitConnections(vault, [githubConnectionProvider(upstream.fetcher)]);
  t.after(async () => {
    vault.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, vault, upstream, store };
}
test("GitHub verification, encrypted persistence, metadata projection, signing reconciliation and clear retain the existing vault", async (t) => {
  const f = await fixture(t);
  let result = await f.store.update(scope, input(), () => {});
  assert.equal(result.hosts["github.com"]!.revision, 2);
  assert.equal(result.hosts["github.com"]!.signing!.registration, "registered");
  assert.equal(f.upstream.posts, 1);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes("privateKey"));
  assert.ok(!(await readFile(join(f.directory, "employee-git-vault.sqlite"))).includes(Buffer.from(token)));
  const key = result.hosts["github.com"]!.signing!.generation;
  result = await f.store.update(scope, input(2, { token: "rotated-synthetic-token" }), () => {});
  assert.equal(result.hosts["github.com"]!.signing!.generation, key);
  assert.equal(f.upstream.posts, 1);
  assert.equal(f.store.snapshot("actor:human://fixture/other").hosts["github.com"]!.configured, false);
  await assert.rejects(
    f.store.update(scope, input(), () => {}),
    { code: "conflict", status: 409 },
  );
  const before = f.upstream.requests.length;
  result = await f.store.update(scope, { host: "github.com", action: "clear", revision: 4 }, () => {});
  assert.equal(result.hosts["github.com"]!.configured, false);
  assert.equal(f.upstream.requests.length, before);
  assert.equal(f.vault.read(scope, "github.com").revision, 5);
});
test("mismatched account, unverified email, missing email permissions and arbitrary provider inputs cannot write", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.store.update(scope, input(0, { username: "other" }), () => {}),
    { code: "github_account_mismatch" },
  );
  await assert.rejects(
    f.store.update(scope, input(0, { email: "unverified@example.test" }), () => {}),
    { code: "github_email_unverified" },
  );
  f.upstream.denyEmail();
  await assert.rejects(
    f.store.update(scope, input(0, { email: "verified@example.test" }), () => {}),
    { code: "github_email_permission_required" },
  );
  for (const extra of [
    { host: "attacker.example" },
    { action: "read-private" },
    { url: "https://attacker.example" },
    { action: "clear", token: "forbidden-extra" },
  ])
    await assert.rejects(
      f.store.update(scope, input(0, extra), () => {}),
      { code: "invalid" },
    );
  assert.equal(f.vault.read(scope, "github.com").revision, 0);
});
test("manual signing registration is distinct from an unusable connection", async (t) => {
  const f = await fixture(t);
  f.upstream.deny();
  const result = await f.store.update(scope, input(), () => {});
  assert.equal(result.hosts["github.com"]!.configured, true);
  assert.equal(result.hosts["github.com"]!.signing!.registration, "manual_required");
  assert.equal(f.upstream.posts, 0);
});
test("an unknown remote signing POST is never replayed; an explicit retry reconciles by exact public key", async (t) => {
  const f = await fixture(t);
  f.upstream.losePost();
  let result = await f.store.update(scope, input(), () => {});
  assert.equal(result.hosts["github.com"]!.signing!.registration, "pending");
  assert.equal(f.upstream.posts, 1);
  result = await f.store.update(scope, { host: "github.com", action: "register", revision: 2 }, () => {});
  assert.equal(result.hosts["github.com"]!.signing!.registration, "registered");
  assert.equal(f.upstream.posts, 1);
});
test("late provider responses cannot resurrect a removed or rotated local generation", async (t) => {
  const f = await fixture(t);
  await f.store.update(scope, input(), () => {});
  let reads = 0;
  const provider = githubConnectionProvider(async (url, init) => {
    const result = await f.upstream.fetcher(url, init);
    if (String(url).includes("/ssh_signing_keys") && ++reads === 1) f.vault.write(scope, "github.com", 2, null);
    return result;
  });
  const store = new GitConnections(f.vault, [provider]);
  await assert.rejects(
    store.update(scope, { host: "github.com", action: "register", revision: 2 }, () => {}),
    { code: "conflict" },
  );
  assert.equal(f.vault.read(scope, "github.com").credential, null);
});
test("reauthorization after external verification prevents credential persistence", async (t) => {
  const f = await fixture(t);
  let admitted = true;
  const store = new GitConnections(f.vault, [
    githubConnectionProvider(async (url, init) => {
      const result = await f.upstream.fetcher(url, init);
      admitted = false;
      return result;
    }),
  ]);
  await assert.rejects(
    store.update(scope, input(), () => {
      if (!admitted) throw Error("revoked");
    }),
    /revoked/,
  );
  assert.equal(f.vault.read(scope, "github.com").revision, 0);
});
test("client metadata parsing rejects private fields and merges revisions monotonically", async (t) => {
  const f = await fixture(t);
  const before = f.store.snapshot(scope),
    saved = await f.store.update(scope, input(), () => {}),
    parsed = parseGitConnections(saved, scope, ["github.com"]);
  assert.equal(mergeGitConnections(parsed, before).hosts["github.com"]!.revision, 2);
  await assert.rejects(
    async () =>
      parseGitConnections({ ...saved, hosts: { "github.com": { ...saved.hosts["github.com"], token } } }, scope, [
        "github.com",
      ]),
    /invalid/,
  );
});
