import test from "node:test";
import assert from "node:assert/strict";
import { createSandboxAssistantProvider } from "../../apps/personal-assistant/src/runtime/sandbox-environment-provider.mjs";
const resources = { cpuMillis: 8000, memoryBytes: 16 * 1024 ** 3 };
const access = (
  botId = "bot-a",
  owner = "owner",
  serverId = "deployment",
  epoch = "one",
) => ({
  binding: {
    serverId,
    botId,
    assignmentId: "assignment-" + botId,
    owner: { kind: "human", id: owner },
  },
  epoch,
  expiresAt: Date.now() + 60000,
});
async function fixture() {
  const starts: any[] = [],
    ids: any[] = [],
    cwds: string[] = [];
  const provider = await createSandboxAssistantProvider({
    backendId: "e2b",
    persistentWorkspaces: true,
    templates: [
      { id: "base", name: "Base", resources, workspaceRoot: "/workspace" },
    ],
    capacity: { cpuMillis: 32000, memoryBytes: 64 * 1024 ** 3 },
    createBackend: (_, callbacks) => ({
      id: "e2b",
      async initialize() {},
      async close() {},
      async create(identity) {
        ids.push(await callbacks.workspaceId(identity));
        return {
          resources,
          capabilities: { terminal: false },
          async close() {},
          async spawn(command) {
            cwds.push(command.cwd);
            return {
              kind: "process",
              id: "fixture",
              exited: Promise.resolve({ code: 0 }),
              async writeStdin() {},
              async closeStdin() {},
              async terminate() {},
            };
          },
        };
      },
    }),
    spawnLocal: ((opts: any) => {
      starts.push(opts);
      return {
        ready: Promise.resolve(),
        failed: () => false,
        close: async () => {},
      };
    }) as any,
  });
  async function start(a: any) {
    const handle = await provider.spawn(
      { kind: "sandbox", backendId: "e2b", templateId: "base" },
      {
        directory: "/tmp/fixture-only",
        profileOptions: {},
        request: async () => a,
      },
    );
    const request = starts.at(-1).request;
    return {
      handle,
      async run() {
        return request("environment/run", {
          argv: ["true"],
          workId: "w",
          callId: "c",
        });
      },
    };
  }
  return { provider, start, ids, cwds };
}
test("workspace stable across lease epochs and provider restart; Bot, owner, deployment isolated", async () => {
  const f = await fixture();
  let a = await f.start(access());
  assert.equal((await a.run()).state, "completed");
  const id = f.ids.at(-1);
  assert.match(id, /^ws-[a-f0-9]{32}$/);
  assert.equal(f.cwds.at(-1), "/workspace");
  await assert.rejects(
    f.start(access("bot-a", "owner", "deployment", "two")),
    /Prior workspace/,
  );
  await a.handle.close();
  a = await f.start(access("bot-a", "owner", "deployment", "two"));
  await a.run();
  assert.equal(f.ids.at(-1), id);
  await a.handle.close();
  for (const grant of [
    access("bot-b"),
    access("bot-a", "other"),
    access("bot-a", "owner", "another-deployment"),
  ]) {
    const b = await f.start(grant);
    await b.run();
    assert.notEqual(f.ids.at(-1), id);
    await b.handle.close();
  }
  assert.equal(new Set(f.ids).size, 4);
  await f.provider.close();
  const second = await fixture();
  a = await second.start(
    access("bot-a", "owner", "deployment", "after-restart"),
  );
  await a.run();
  assert.equal(second.ids[0], id);
  await second.provider.close();
});
test("authorization revocation cannot resolve or allocate a persistent workspace", async () => {
  const f = await fixture();
  const grant = access();
  const a = await f.start(grant);
  grant.epoch = "revoked";
  await assert.rejects(a.run());
  assert.equal(f.ids.length, 0);
  await f.provider.close();
});
