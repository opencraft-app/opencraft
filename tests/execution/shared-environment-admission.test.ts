import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountEnvironment } from "../../scripts/account-environment.js";
import { EmployeeGitVaultStore } from "../../scripts/employee-git-vault-store.js";
import { ExecutionEnvironmentRuntime } from "../../scripts/execution-environment.js";
import { ExecutionEnvironmentTransport } from "../../scripts/execution-environment-transport.js";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";

const context = (subject: string) => ({
  sender: null,
  executionPrincipal: { provider: "employee", subject },
  validUntil: Date.now() + 60_000,
});
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "shared-environment-"));
  const vault = new EmployeeGitVaultStore(directory),
    runtime = new ExecutionEnvironmentRuntime(directory, vault);
  const env = new AccountEnvironment(vault);
  for (const user of ["creator", "participant"])
    env.replace("employee:" + user, { projectId: null }, 0, [
      { name: "KEY", value: "synthetic-" + user, secret: true },
    ]);
  runtime.bindCreator(runtime.scope(context("creator"), "host", {}), "shared");
  const sent: any[] = [],
    replies: any[] = [];
  let failDelivery = false;
  const transport = new ExecutionEnvironmentTransport(
    {
      status: { state: "open" },
      async connect() {},
      async close() {},
      subscribeStatus() {
        return () => {};
      },
      subscribeMessage() {
        return () => {};
      },
      async send(frame: string) {
        if (failDelivery) throw Error("delivery unknown");
        sent.push(JSON.parse(frame));
      },
    },
    runtime,
    "host",
  );
  transport.subscribeMessage((frame) => replies.push(JSON.parse(frame)));
  t.after(async () => {
    await transport.close();
    runtime.close();
    vault.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    runtime,
    transport,
    sent,
    replies,
    failDelivery() {
      failDelivery = true;
    },
  };
}

test("an admitted shared participant sends using their own sealed environment without replacing the creator", async (t) => {
  const f = await fixture(t);
  for (const method of ["turn/start", "thread/queue/add", "thread/queue/start"]) {
    await f.transport.sendWithContext(
      JSON.stringify({
        id: method,
        method,
        params: { threadId: "shared", __opencraftEnvironment: "forged" },
        [LOGICAL_CLIENT_FIELD]: "participant-tab",
      }),
      context("participant"),
    );
    const request = f.sent.at(-1);
    const scope = f.runtime.open(request.params.__opencraftEnvironment, "host", method, request.params);
    assert.equal(scope.account, "employee:participant");
    assert.deepEqual(f.runtime.snapshot(scope).overlay(), { KEY: "synthetic-participant" });
    assert.equal(request[LOGICAL_CLIENT_FIELD], "participant-tab");
  }
  assert.deepEqual(f.runtime.creator("host", "shared"), { account: "employee:creator" });
  assert.equal(f.replies.length, 0);
  assert.equal(JSON.stringify(f.sent).includes("synthetic-"), false);
});

test("expired authority or missing owned-thread identity produces a correlated rejection before forwarding", async (t) => {
  const f = await fixture(t);
  for (const ctx of [
    { ...context("participant"), validUntil: 0 },
    { sender: null },
    {
      ...context("participant"),
      resourceOwner: {
        assertCurrent() {
          throw Error("synthetic private diagnostic");
        },
      },
    },
  ]) {
    const id = f.replies.length;
    await f.transport.sendWithContext(
      JSON.stringify({
        id,
        method: "thread/queue/add",
        params: { threadId: "shared" },
        [LOGICAL_CLIENT_FIELD]: "denied-tab",
      }),
      ctx as any,
    );
    const response = f.replies.at(-1);
    assert.equal(response.id, id);
    assert.equal(response[LOGICAL_CLIENT_FIELD], "denied-tab");
    assert.deepEqual(response.error.data, { notSubmitted: true, submissionOutcome: "rejected", retryable: false });
    assert.equal(response.result, undefined);
    assert.equal(JSON.stringify(response).includes("synthetic"), false);
  }
  assert.equal(f.sent.length, 0);
});

test("a failure after entering delivery retains unknown-outcome semantics", async (t) => {
  const f = await fixture(t);
  f.failDelivery();
  await assert.rejects(
    f.transport.sendWithContext(
      JSON.stringify({ id: 9, method: "thread/queue/add", params: { threadId: "shared" } }),
      context("creator"),
    ),
    /delivery unknown/,
  );
  assert.equal(f.replies.length, 0);
});

test("envelope preparation failures return known rejection without echoing the request", async (t) => {
  const f = await fixture(t);
  f.runtime.seal = () => {
    throw Error("synthetic-private-key diagnostic");
  };
  await f.transport.sendWithContext(
    JSON.stringify({
      id: "seal",
      method: "thread/queue/add",
      params: { threadId: "shared", input: "synthetic-private-input" },
    }),
    context("creator"),
  );
  assert.equal(f.sent.length, 0);
  assert.equal(f.replies[0].error.data.notSubmitted, true);
  assert.equal(JSON.stringify(f.replies).includes("synthetic-private"), false);
});
