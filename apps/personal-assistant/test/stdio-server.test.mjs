import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { profileFor } from "./helpers.mjs";
import { createStdioPeer } from "../src/adapters/local/stdio-peer.mjs";

function client(t, args = ["bin/assistant.mjs", "serve"]) {
  const child = spawn(process.execPath, args, {
    cwd: new URL("../", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const exit = once(child, "exit");
  const peer = createStdioPeer({
    input: child.stdout,
    output: child.stdin,
    handle: () => {
      throw Error("No platform authority");
    },
  });
  t.after(async () => {
    peer.close();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exit;
  });
  return { child, peer, exit };
}
test("public CLI stdio uses a separate process and restores the same local domain after EOF", async (t) => {
  const profile = profileFor(t, { telemetry: { enabled: false } });
  const first = client(t);
  const initialized = await first.peer.request("initialize", {
    protocolVersion: 1,
    profile: profile.path,
  });
  assert.equal(initialized.capabilities.observe, true);
  assert.deepEqual((await first.peer.request("observe", {})).value, {
    queued: 0,
    running: 0,
  });
  assert.equal(initialized.pid, first.child.pid);
  assert.notEqual(initialized.pid, process.pid);
  await assert.rejects(
    first.peer.request("initialize", {
      protocolVersion: 1,
      profile: profile.path,
    }),
  );
  const request = {
    op: "memory.set",
    id: "remember",
    params: { key: "city", value: "上海" },
  };
  await first.peer.request("dispatch", request);
  first.child.stdin.end();
  assert.equal((await first.exit)[0], 0);
  const second = client(t, ["src/runtime/assistant-server.mjs"]);
  await second.peer.request("initialize", {
    protocolVersion: 1,
    profile: profile.path,
  });
  const stored = await second.peer.request("dispatch", {
    op: "memory.list",
    params: {},
  });
  assert.match(JSON.stringify(stored), /上海/);
  await second.peer.request("shutdown");
  assert.equal((await second.exit)[0], 0);
});
test("invalid protocol cannot initialize; abrupt death rejects pending requests", async (t) => {
  const profile = profileFor(t, { telemetry: { enabled: false } }),
    c = client(t);
  await assert.rejects(
    c.peer.request("initialize", {
      protocolVersion: 99,
      profile: profile.path,
    }),
  );
  await c.peer.request("initialize", {
    protocolVersion: 1,
    profile: profile.path,
  });
  c.child.kill("SIGKILL");
  await c.exit;
  await assert.rejects(
    c.peer.request("dispatch", { op: "status", params: {} }),
  );
});
test("framing rejects oversized/malformed input and retires all pending work", async () => {
  for (const content of ["not-json\n", "x".repeat(129)]) {
    const input = new PassThrough(),
      output = new PassThrough();
    let closed = 0;
    const peer = createStdioPeer({
      input,
      output,
      maxBytes: 128,
      handle: () => {},
      onClose: () => closed++,
    });
    const waiting = peer.request("test");
    const rejected = assert.rejects(waiting, /closed/);
    input.write(content);
    await rejected;
    assert.equal(closed, 1);
    peer.close();
    assert.equal(closed, 1);
  }
});
test("bidirectional framing supports fragmented UTF-8, cancellation and late results", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let received;
  const peer = createStdioPeer({
    input,
    output,
    handle: (method, params) => {
      received = params;
      return {};
    },
  });
  const packet = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "read",
      params: { text: "你好" },
    }) + "\n",
  );
  for (const byte of packet) input.write(Buffer.from([byte]));
  await new Promise((r) => setImmediate(r));
  assert.equal(received.text, "你好");
  const abort = new AbortController();
  const pending = peer.request("wait", {}, { signal: abort.signal });
  const rejected = assert.rejects(pending, /aborted/);
  abort.abort();
  await rejected;
  input.write('{"jsonrpc":"2.0","id":1,"result":"late"}\n');
  peer.close();
});

test("owner process death closes its child and releases the durable profile lock", async (t) => {
  const { realpathSync, statSync } = await import("node:fs");
  const { acquireOwnerLock } = await import("@opencraft/sqlite-node/writer-lock");
  const { until } = await import("./helpers.mjs");
  const profile = profileFor(t, { telemetry: { enabled: false } });
  const server = new URL("../src/runtime/assistant-server.mjs", import.meta.url)
    .pathname;
  const peerModule = new URL(
    "../src/adapters/local/stdio-peer.mjs",
    import.meta.url,
  ).href;
  const parent = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {spawn} from 'node:child_process';
    import {createStdioPeer} from ${JSON.stringify(peerModule)};
    const child=spawn(process.execPath,[${JSON.stringify(server)}],{stdio:['pipe','pipe','ignore']});
    const peer=createStdioPeer({input:child.stdout,output:child.stdin,handle:()=>{throw Error('denied');}});
    await peer.request('initialize',{protocolVersion:1,profile:${JSON.stringify(profile.path)}});
    process.stdout.write('ready');
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  parent.stderr.resume();
  const exited = once(parent, "exit");
  t.after(async () => {
    if (parent.exitCode === null && parent.signalCode === null)
      parent.kill("SIGKILL");
    await exited;
  });
  const [ready] = await once(parent.stdout, "data");
  assert.equal(ready.toString(), "ready");
  const lock = `${realpathSync(profile.path)}.lock`;
  assert.equal(statSync(lock).isFile(), true);
  parent.kill("SIGKILL");
  await exited;
  // The kernel lock file stays; the child's exit is what frees it.
  await until(
    () =>
      acquireOwnerLock(lock).then(
        (release) => (release(), true),
        () => false,
      ),
    4500,
  );
  const replacement = client(t);
  await replacement.peer.request("initialize", {
    protocolVersion: 1,
    profile: profile.path,
  });
  await replacement.peer.request("shutdown");
  assert.equal((await replacement.exit)[0], 0);
});

test("shutdown closes intake before a pipelined initialize can start a runner", async (t) => {
  const profile = profileFor(t, { telemetry: { enabled: false } }),
    c = client(t);
  const stopped = c.peer.request("shutdown");
  const late = assert.rejects(
    c.peer.request("initialize", { protocolVersion: 1, profile: profile.path }),
  );
  await stopped;
  await late;
  assert.equal((await c.exit)[0], 0);
});

function connectedPeers(t, handle) {
  const a = new PassThrough(),
    b = new PassThrough(),
    frames = [];
  b.on("data", (chunk) => frames.push(chunk.toString()));
  const server = createStdioPeer({ input: a, output: b, handle });
  const client = createStdioPeer({
    input: b,
    output: a,
    handle() {
      throw Error("unused");
    },
  });
  t.after(() => {
    client.close();
    server.close();
    a.destroy();
    b.destroy();
  });
  return { client, frames };
}

for (const method of ["authorize", "threads/command"]) {
  for (const status of [400, 401, 403, 409, 429, 500, 503]) {
    test(`private platform ${method} preserves only terminal status ${status}, never raw error details`, async (t) => {
      const { client, frames } = connectedPeers(t, () => {
        throw Object.assign(Error("SYNTHETIC_PRIVATE_PROVIDER_TEXT"), {
          status,
          code: "SYNTHETIC_PRIVATE_CODE",
          data: { token: "SYNTHETIC_PRIVATE_TOKEN" },
        });
      });
      await assert.rejects(
        client.request("platform/opencraft/personal-assistant/" + method),
        (error) => {
          assert.equal(error.message, "Assistant operation unavailable");
          assert.equal(
            error.status,
            [400, 401, 403, 409].includes(status) ? status : undefined,
          );
          assert.equal(error.code, undefined);
          return true;
        },
      );
      assert.doesNotMatch(frames.join(""), /SYNTHETIC_PRIVATE/);
    });
  }
}
for (const original of [
  Object.assign(Error("private raw text"), {
    code: "assistant_thread_grant_revoked",
  }),
  Object.assign(Error("assistant_thread_turn_changed"), { code: -32000 }),
])
  test(`allowlisted symbolic platform failure survives IPC: ${original.code}`, async (t) => {
    const { client } = connectedPeers(t, () => {
      throw original;
    });
    await assert.rejects(
      client.request("platform/opencraft/personal-assistant/threads/command"),
      (e) => {
        assert.equal(
          e.status,
          original.code === "assistant_thread_grant_revoked" ? 403 : 409,
        );
        return true;
      },
    );
  });
test("unrelated methods and unrecognized symbolic errors retain generic unknown failure", async (t) => {
  const { client, frames } = connectedPeers(t, () => {
    throw Object.assign(
      Error("prefix assistant_thread_grant_revoked private"),
      { status: 403, code: "private" },
    );
  });
  await assert.rejects(client.request("platform/model"), (e) => {
    assert.equal(e.status, undefined);
    return true;
  });
  assert.doesNotMatch(frames.join(""), /private|grant_revoked/);
  const second = connectedPeers(t, () => {
    throw Object.assign(
      Error("prefix assistant_thread_grant_revoked private"),
      { code: -32000 },
    );
  });
  await assert.rejects(
    second.client.request(
      "platform/opencraft/personal-assistant/threads/command",
    ),
    (e) => {
      assert.equal(e.status, undefined);
      return true;
    },
  );
});

test("terminal Thread error classification crosses actual parent/child OS pipes", async (t) => {
  const peerModule = new URL(
    "../src/adapters/local/stdio-peer.mjs",
    import.meta.url,
  ).href;
  const code = `import {createStdioPeer} from ${JSON.stringify(peerModule)};
    createStdioPeer({input:process.stdin, output:process.stdout,
      handle(){throw Object.assign(Error('SYNTHETIC_PRIVATE_CHILD_ERROR'), {status:403});},
      onClose(){process.exit(0);}});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const exit = once(child, "exit");
  const peer = createStdioPeer({
    input: child.stdout,
    output: child.stdin,
    handle() {
      throw Error("unused");
    },
  });
  t.after(async () => {
    peer.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
  });
  await assert.rejects(
    peer.request("platform/opencraft/personal-assistant/threads/command"),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.message, "Assistant operation unavailable");
      return true;
    },
  );
});
