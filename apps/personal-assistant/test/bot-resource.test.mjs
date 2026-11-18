import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionBotProfile } from "../src/adapters/local/bot-profile.mjs";
import { loadProfile, initProfile } from "../src/adapters/local/profile.mjs";
import {
  codexSessionRoot,
  piSessionPath,
  executionWorkspace,
} from "../src/adapters/local/profile-layout.mjs";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { LocalRunner } from "../src/runtime/local-runner.mjs";
import { SqliteUnitOfWork } from "../src/adapters/sqlite/database.mjs";
const binding = {
  serverId: "server-one",
  botId: "bot-one",
  assignmentId: "assignment-one",
  owner: { kind: "human", id: "human-one" },
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bot-resource-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("Bot private memory is flat, durable across conversations, and cannot impersonate shared spaces", (t) => {
  const root = fixture(t),
    profile = provisionBotProfile(root, binding);
  let domain = createLocalDomain(profile);
  try {
    domain.app.dispatch({
      op: "memory.set",
      id: "remember",
      params: { key: "preference", value: "喜欢茶", expectedRevision: 0 },
    });
    assert.ok(existsSync(join(profile.path, "memory/profile.md")));
    assert.equal(existsSync(join(profile.path, "memory-space")), false);
    assert.equal(existsSync(join(profile.path, "agents")), false);
    assert.match(
      readFileSync(join(profile.path, "memory/profile.md"), "utf8"),
      /喜欢茶/,
    );
    const before = domain.app.memory.list();
    domain.app.dispatch({
      op: "conversation.create",
      id: "another",
      params: {},
    });
    assert.deepEqual(domain.app.memory.list(), before);
    assert.throws(
      () =>
        domain.app.dispatch({
          op: "memory.set",
          id: "shared",
          params: {
            key: "shared",
            value: "secret",
            expectedRevision: 0,
            scope: "user",
          },
        }),
      /scope|private/,
    );
  } finally {
    domain.uow.close();
  }
  domain = createLocalDomain(loadProfile(profile.path));
  try {
    assert.ok(domain.app.memory.list().some((m) => m.value === "喜欢茶"));
  } finally {
    domain.uow.close();
  }
});
test("stable binding rejects owner/server/assignment changes and unsafe paths", (t) => {
  const root = fixture(t),
    profile = provisionBotProfile(root, binding);
  const domain = createLocalDomain(profile);
  domain.uow.close();
  for (const change of [
    { serverId: "another" },
    { assignmentId: "new-assignment" },
    { owner: { kind: "human", id: "another" } },
  ])
    assert.throws(
      () => provisionBotProfile(root, { ...binding, ...change }),
      /binding/,
    );
  assert.throws(
    () => provisionBotProfile(root, { ...binding, botId: "../escape" }),
    /ID/,
  );
  assert.throws(
    () =>
      provisionBotProfile(
        root,
        { ...binding, botId: "second" },
        { memoryRoot: "/tmp" },
      ),
    /host-owned/,
  );
  const config = JSON.parse(
    readFileSync(join(profile.path, "profile.json"), "utf8"),
  );
  config.botBinding.assignmentId = "changed";
  writeFileSync(join(profile.path, "profile.json"), JSON.stringify(config));
  assert.throws(() => createLocalDomain(loadProfile(profile.path)), /identity/);
  const other = join(root, "elsewhere");
  mkdirSync(other);
  symlinkSync(other, join(root, "bots", "link"));
  assert.throws(
    () => provisionBotProfile(root, { ...binding, botId: "link" }),
    /symlink/,
  );
});
test("execution cleanup never contains the persistent engine root; legacy bindings retain original paths", (t) => {
  const root = fixture(t),
    profile = provisionBotProfile(root, binding),
    session = codexSessionRoot(profile, "native-root");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "checkpoint"), "saved");
  const workspace = executionWorkspace(profile, "execution-one");
  mkdirSync(workspace, { recursive: true });
  rmSync(workspace, { recursive: true });
  assert.equal(readFileSync(join(session, "checkpoint"), "utf8"), "saved");
  assert.ok(piSessionPath(profile, "work-one").includes("/engines/pi/"));
  const legacy = initProfile(join(root, "legacy"), "local:owner");
  assert.ok(
    codexSessionRoot(legacy, "native-root").includes("/executions/codex/"),
  );
});
test("takeover fences the retired writer before SQLite or Markdown changes", (t) => {
  const root = fixture(t),
    profile = provisionBotProfile(root, binding),
    old = createLocalDomain(profile, null, { claimWriter: true });
  const next = new SqliteUnitOfWork(profile);
  next.claimWriter();
  try {
    assert.throws(
      () =>
        old.app.dispatch({
          op: "memory.set",
          id: "late",
          params: {
            key: "late",
            value: "must not commit",
            expectedRevision: 0,
          },
        }),
      /writer retired/,
    );
    assert.equal(existsSync(join(profile.path, "memory/profile.md")), false);
  } finally {
    old.uow.close();
    next.close();
  }
});
test("Bot runs through the real local runner, closes, and retains identity on reopen", async (t) => {
  const root = fixture(t),
    profile = provisionBotProfile(root, binding, {
      telemetry: { enabled: false },
    });
  await assert.rejects(LocalRunner.open(profile), /Host authority/);
  const overrides = {
    platformChannelPort: {
      async authorize() {
        return { binding, epoch: "one", expiresAt: Date.now() + 60000 };
      },
      async request() {
        throw Error("unexpected channel request");
      },
    },
  };
  let runner = await LocalRunner.open(profile, overrides);
  await runner.close();
  runner = await LocalRunner.open(loadProfile(profile.path), overrides);
  try {
    assert.equal(runner.app.assistant.id, binding.botId);
  } finally {
    await runner.close();
  }
});

test("platform history stays native, authorization is checked around await, and search is bounded", async (t) => {
  const { PlatformChannels } = await import(
    "../src/application/platform-channels.mjs"
  );
  const calls = [];
  let epoch = "one",
    now = 100;
  const port = {
    async authorize() {
      return { binding, epoch, expiresAt: 200 };
    },
    async request(b, method, params) {
      calls.push({ b, method, params });
      return { messages: [{ messageId: "native-id", text: "native body" }] };
    },
  };
  const channels = new PlatformChannels(binding, port, { now: () => now });
  const result = await channels.search("group:one", {
    query: "budget",
    limit: 10,
  });
  assert.equal(result.messages[0].messageId, "native-id");
  assert.equal(calls[0].method, "opencraft/personal-assistant/groups/search");
  assert.deepEqual(channels.reference("group:one", "native-id"), {
    serverId: binding.serverId,
    channelId: "group:one",
    messageId: "native-id",
  });
  assert.throws(
    () => channels.search("group:one", { query: "budget", limit: 1000 }),
    /bounded/,
  );
  port.request = async () => {
    epoch = "two";
    return { messages: ["must not escape"] };
  };
  await assert.rejects(channels.history("group:one"), /changed/);
  now = 201;
  await assert.rejects(channels.list(), /expired/);
});

test("hosted Bot dispatch exposes native channels and revocation blocks all further local commits", async (t) => {
  const root = fixture(t),
    profile = provisionBotProfile(root, binding, {
      telemetry: { enabled: false },
    });
  let epoch = "one";
  const calls = [];
  const port = {
    async authorize() {
      return { binding, epoch, expiresAt: Date.now() + 5000 };
    },
    async request(b, method, p) {
      calls.push({ method, p });
      return { groups: [{ id: "native-group" }] };
    },
  };
  const runner = await LocalRunner.open(profile, { platformChannelPort: port });
  try {
    assert.deepEqual(
      await runner.dispatch({ op: "channels.list", params: {} }),
      { groups: [{ id: "native-group" }] },
    );
    assert.equal(calls.length, 1);
    epoch = "two";
    await assert.rejects(
      runner.dispatch({
        op: "memory.set",
        id: "revoked",
        params: { key: "no", value: "no", expectedRevision: 0 },
      }),
      /retired/,
    );
    await assert.rejects(
      runner.dispatch({ op: "status", params: {} }),
      /retired/,
    );
  } finally {
    await runner.close();
  }
});

test("authority shutdown releases a provider that ignores cancellation and rejects late leases", async () => {
  const { BotAuthority } = await import("../src/runtime/bot-authority.mjs");
  let resolve;
  const authority = new BotAuthority(binding, {
    authorize: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  const pending = authority.refresh();
  const rejected = assert.rejects(pending);
  await authority.close();
  await rejected;
  resolve({ binding, epoch: "late", expiresAt: Date.now() + 10000 });
  await Promise.resolve();
  assert.throws(() => authority.assertCurrent(), /unavailable|retired/);
});

test("retired writer cannot dispatch an already selected message or run another pump phase", async () => {
  const { MessageDispatcher } = await import(
    "../src/runtime/message-dispatcher.mjs"
  );
  let delivered = false,
    current = true;
  const guard = () => {
    if (!current) throw Error("retired");
  };
  const dispatcher = new MessageDispatcher(
    {
      pending: () => [{ id: "one" }],
      accepted() {
        assert.fail("retired receipt");
      },
      failed() {
        guard();
      },
    },
    {
      deliver() {
        delivered = true;
      },
    },
    () => {},
    guard,
  );
  dispatcher.tick();
  current = false;
  await dispatcher.close();
  assert.equal(delivered, false);
  const runner = new LocalRunner({});
  runner.uow = { assertWriter: guard };
  runner.fileEvents = {
    tick() {
      assert.fail("retired pump");
    },
  };
  assert.doesNotThrow(() => runner.pump());
  assert.match(runner.healthError, /retired/);
});

test("Bot managed engine and database paths reject symlink substitution before opening", (t) => {
  const root = fixture(t),
    profile = provisionBotProfile(root, binding);
  const outside = join(root, "outside");
  mkdirSync(outside);
  rmSync(join(profile.path, "engines"), { recursive: true });
  symlinkSync(outside, join(profile.path, "engines"));
  assert.throws(() => loadProfile(profile.path), /symlink/);
  assert.equal(existsSync(join(outside, "codex")), false);
  rmSync(join(profile.path, "engines"));
  symlinkSync(
    join(outside, "database"),
    join(profile.path, "assistant.sqlite"),
  );
  assert.throws(() => loadProfile(profile.path), /symlink/);
});

test("authority expiration inside a transaction rolls back staged memory before commit", (t) => {
  const root = fixture(t),
    profile = provisionBotProfile(root, binding);
  let valid = true;
  const domain = createLocalDomain(profile, null, {
    claimWriter: true,
    assertAuthority() {
      if (!valid) throw Error("expired");
    },
  });
  t.after(() => domain.uow.close());
  assert.throws(
    () =>
      domain.uow.transaction(() => {
        domain.app.dispatch({
          op: "memory.set",
          id: "expires",
          params: {
            key: "temp",
            value: "must not remain",
            expectedRevision: 0,
          },
        });
        valid = false;
      }),
    /expired/,
  );
  valid = true;
  assert.deepEqual(domain.app.memory.list(), []);
  assert.equal(existsSync(join(profile.path, "memory/profile.md")), false);
});

test("closing a hosted runner releases an unresponsive native history request", async (t) => {
  const root = fixture(t),
    profile = provisionBotProfile(root, binding);
  const started = Promise.withResolvers();
  const runner = await LocalRunner.open(profile, {
    platformChannelPort: {
      async authorize() {
        return { binding, epoch: "one", expiresAt: Date.now() + 60000 };
      },
      request() {
        started.resolve();
        return new Promise(() => {});
      },
    },
  });
  t.after(() => runner.close());
  const request = runner.dispatch({
    op: "channels.list",
    id: "list",
    params: {},
  });
  const rejected = assert.rejects(request);
  await started.promise;
  await runner.close();
  await rejected;
});

test("hosted channel results and authorization failures cross the real Unix socket", async (t) => {
  const { request } = await import("../src/adapters/local/unix-socket.mjs");
  const root = fixture(t),
    profile = provisionBotProfile(root, binding);
  let allowed = true;
  const runner = await LocalRunner.open(profile, {
    platformChannelPort: {
      async authorize() {
        if (!allowed) throw Error("access revoked");
        return { binding, epoch: "one", expiresAt: Date.now() + 60000 };
      },
      async request(_binding, method, params) {
        assert.equal(method, "opencraft/personal-assistant/groups/search");
        assert.equal(params.query, "hello");
        return {
          messages: [{ messageId: "native-message" }],
          hasEarlier: false,
        };
      },
    },
  });
  t.after(() => runner.close());
  const result = await request(profile, {
    op: "channels.search",
    id: "search",
    params: { channelId: "native", query: "hello" },
  });
  assert.equal(result.messages[0].messageId, "native-message");
  const status = await request(profile, {
    op: "status",
    id: "status",
    params: {},
  });
  assert.ok(status && Object.keys(status).length > 0);
  allowed = false;
  await assert.rejects(
    request(profile, { op: "channels.list", id: "revoked", params: {} }),
    /revoked/,
  );
});
