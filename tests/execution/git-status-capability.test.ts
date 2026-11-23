import test from "node:test";
import assert from "node:assert/strict";
import { SessionCapabilities, type CapabilityExecutionContext } from "../../packages/session-capabilities/src/index.js";
import type { GitExecutionLocator } from "../../packages/execution-environment/src/git-execution.js";
import type { HumanGitStatus } from "../../packages/execution-environment/src/human-git-execution.js";
import { createGitStatusCapability, GIT_STATUS_TOOL } from "../../apps/headless-server/src/git-status-capability.js";

const signal = () => new AbortController().signal;
const actor = { id: "human://local/alice", generation: 2, bindings: [] };
const lease = {
  inputId: "input-1",
  executionId: "execution-1",
  generation: 4,
  turnId: "turn-1",
  incarnation: "native-1",
};
const verified: CapabilityExecutionContext = { host: { id: "opencraft-server", engine: "dsh" }, actor, lease };
const session = { serverId: "server", threadId: "thread", execution: { inputId: "input-1" } };
const bound: HumanGitStatus = {
  account: `actor:${actor.id}`,
  executionId: lease.executionId,
  leaseGeneration: lease.generation,
  hosts: [
    { host: "github.com", bound: true, transport: "ssh", signing: true, username: "alice" },
    { host: "git.example.test", bound: false, transport: null, signing: false, username: null },
  ],
};

function fixture(context: CapabilityExecutionContext | undefined, status: HumanGitStatus | null = bound) {
  const service = new SessionCapabilities(),
    locators: GitExecutionLocator[] = [];
  let current = context;
  service.resolveContext(async () => current);
  service.register(
    createGitStatusCapability({
      async status(locator) {
        locators.push(locator);
        return status;
      },
    }),
  );
  return {
    service,
    locators,
    set(next: CapabilityExecutionContext | undefined) {
      current = next;
    },
  };
}

test("a verified run with an active lease sees non-secret binding state for its own lease", async () => {
  const f = fixture(verified);
  await f.service.refresh(session);
  const tools = f.service.tools(session);
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.approval]),
    [[GIT_STATUS_TOOL, "preauthorized"]],
  );
  assert.deepEqual(tools[0]!.inputSchema, { type: "object", properties: {}, additionalProperties: false });
  const result = await f.service.call(session, GIT_STATUS_TOOL, {}, signal());
  assert.equal(result.success, true);
  const value = JSON.parse((result.contentItems[0] as { text: string }).text);
  assert.deepEqual(value, {
    available: true,
    hosts: bound.hosts,
  });
  assert.equal(JSON.stringify(value).includes("actor:"), false, "the account key stays inside the owner");
  assert.deepEqual(f.locators, [{ hostId: "opencraft-server", threadId: "thread", inputId: "input-1" }]);
});

test("unbound hosts report available=false rather than failing", async () => {
  const f = fixture(verified, { ...bound, hosts: [bound.hosts[1]!] });
  const result = await f.service.call(session, GIT_STATUS_TOOL, {}, signal());
  assert.deepEqual(JSON.parse((result.contentItems[0] as { text: string }).text), {
    available: false,
    hosts: [bound.hosts[1]],
  });
});

test("missing context, Actor or lease, or an unsupported Host, fails closed", async () => {
  for (const context of [
    undefined,
    { host: verified.host },
    { host: verified.host, actor },
    { host: { id: "remote-host", engine: "codex" }, actor, lease },
  ] as (CapabilityExecutionContext | undefined)[]) {
    const f = fixture(context);
    await f.service.refresh(session);
    assert.deepEqual(f.service.tools(session), []);
    await assert.rejects(f.service.call(session, GIT_STATUS_TOOL, {}, signal()), /not authorized/);
    assert.equal(f.locators.length, 0);
  }
});

test("calls re-resolve context: a lease that ended after listing is rejected", async () => {
  const f = fixture(verified);
  await f.service.refresh(session);
  assert.equal(f.service.tools(session).length, 1);
  f.set({ host: verified.host, actor });
  await assert.rejects(f.service.call(session, GIT_STATUS_TOOL, {}, signal()), /not authorized/);
  assert.equal(f.locators.length, 0);
});

test("owner answers for another Actor, execution or lease generation are rejected", async () => {
  for (const status of [
    null,
    { ...bound, account: "actor:human://local/bob" },
    { ...bound, executionId: "execution-2" },
    { ...bound, leaseGeneration: lease.generation + 1 },
  ]) {
    const f = fixture(verified, status);
    await assert.rejects(f.service.call(session, GIT_STATUS_TOOL, {}, signal()), /git_status_unavailable/);
  }
});

test("arguments cannot select anything and an aborted call is not dispatched", async () => {
  const f = fixture(verified);
  for (const args of [{ threadId: "other" }, [], null, "x"])
    await assert.rejects(f.service.call(session, GIT_STATUS_TOOL, args, signal()), /invalid_git_status_request/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.service.call(session, GIT_STATUS_TOOL, {}, controller.signal));
  assert.equal(f.locators.length, 0);
});
