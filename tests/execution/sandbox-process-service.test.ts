import test from "node:test";
import assert from "node:assert/strict";
import type { SandboxCommand, SandboxOutput, SandboxProcess } from "@opencraft/sandbox";
import { SandboxProcessService } from "../../apps/local-agent-host/src/sandbox-process-service";
function fixture() {
  let emit!: (e: SandboxOutput) => void, finish!: (e: { code: number }) => void;
  let allowed = true,
    killed = 0,
    uncertain = 0;
  const writes: Buffer[] = [],
    sizes: unknown[] = [],
    commands: SandboxCommand[] = [];
  const child: Extract<SandboxProcess, { kind: "terminal" }> = {
    kind: "terminal",
    id: "vendor-not-exposed",
    exited: new Promise((r) => (finish = r)),
    async writeStdin(d) {
      writes.push(Buffer.from(d));
    },
    async resize(s) {
      sizes.push(s);
    },
    async terminate() {
      killed++;
      finish({ code: 0 });
    },
  };
  const options = {
    sandbox: {
      async spawn(c: SandboxCommand, out?: (e: SandboxOutput) => void) {
        commands.push(c);
        emit = out!;
        return child;
      },
    },
    cwd: "/workspace",
    context: { threadId: "thread-a", projectId: null, resourceOwnerId: "resource-a" },
    async authorize() {
      if (!allowed) throw Error("revoked");
    },
    onCleanupUnconfirmed() {
      uncertain++;
    },
  };
  const service = new SandboxProcessService(options);
  return {
    service,
    options,
    child,
    commands,
    writes,
    sizes,
    emit: (data: string) => emit({ stream: "stdout", data: Buffer.from(data) }),
    finish,
    deny: () => {
      allowed = false;
    },
    get killed() {
      return killed;
    },
    get uncertain() {
      return uncertain;
    },
  };
}
const request = {
  processHandle: "p1",
  tty: true,
  command: ["/bin/sh"],
  size: { cols: 80, rows: 24 },
  cwd: "/workspace",
};
test("existing process protocol routes only to bound sandbox and replays on attach", async () => {
  const f = fixture(),
    events: string[] = [];
  const detach = f.service.subscribe((m) => events.push(m));
  await f.service.request("process/spawn", request);
  assert.equal(f.commands[0].cwd, "/workspace");
  assert.deepEqual(f.commands[0].env, { TERM: "xterm-256color" });
  f.emit("hello");
  await f.service.request("process/writeStdin", {
    processHandle: "p1",
    deltaBase64: Buffer.from("资料").toString("base64"),
  });
  await f.service.request("process/resizePty", { processHandle: "p1", size: { cols: 100, rows: 50 } });
  assert.equal(f.writes[0].toString(), "资料");
  assert.deepEqual(f.sizes, [{ cols: 100, rows: 50 }]);
  detach();
  f.emit(" retained");
  const state: any = await f.service.request("process/attach", { processHandle: "p1", afterSequence: 0 });
  assert.equal(state.nextSequence, 2);
  assert.equal(state.context.threadId, "thread-a");
  assert.equal(
    state.output.map((c: any) => Buffer.from(c.deltaBase64, "base64").toString()).join(""),
    "hello retained",
  );
  assert.deepEqual(events, ["process/outputDelta"]);
  await f.service.close();
  assert.equal(f.killed, 1);
});
test("scope, cwd, payload and authorization fail closed before sandbox execution", async () => {
  const f = fixture();
  for (const extra of [
    { cwd: "/tmp" },
    { threadId: "thread-b" },
    { projectId: "foreign" },
    { resourceOwnerId: "foreign" },
    { env: { KEY: null } },
    { size: { cols: 0, rows: 20 } },
  ])
    await assert.rejects(f.service.request("process/spawn", { ...request, ...extra }));
  assert.equal(f.commands.length, 0);
  await f.service.request("process/spawn", request);
  await assert.rejects(f.service.request("process/spawn", request), /exists/);
  await assert.rejects(f.service.request("process/writeStdin", { processHandle: "p1", deltaBase64: "!!!" }));
  f.deny();
  await assert.rejects(f.service.request("process/list", {}), /revoked/);
  await assert.rejects(
    f.service.request("process/writeStdin", { processHandle: "p1", deltaBase64: "YQ==" }),
    /revoked/,
  );
  assert.equal(f.writes.length, 0);
  await f.service.close();
});
test("late spawn is reclaimed when binding closes; duplicate launch is reserved", async () => {
  const f = fixture();
  let resolve!: (p: SandboxProcess) => void, started!: () => void;
  const began = new Promise<void>((r) => (started = r));
  const service = new SandboxProcessService({
    ...f.options,
    sandbox: {
      async spawn() {
        started();
        return new Promise((r) => (resolve = r));
      },
    },
  });
  const pending = service.request("process/spawn", request);
  const rejected = assert.rejects(pending, /closed/);
  await began;
  await assert.rejects(service.request("process/spawn", request), /exists/);
  const closing = service.close();
  resolve(f.child);
  await rejected;
  await closing;
  assert.equal(f.killed, 1);
});
test("bounded output reports truncation and does not expose mutable replay records", async () => {
  const f = fixture();
  await f.service.request("process/spawn", request);
  f.emit("x".repeat(900000));
  const state: any = await f.service.request("process/attach", { processHandle: "p1", afterSequence: 0 });
  assert.equal(state.truncated, true);
  assert.ok(state.output.reduce((n: number, c: any) => n + c.deltaBase64.length, 0) <= 1024 * 1024);
  state.output[0].deltaBase64 = "bad";
  const next: any = await f.service.request("process/attach", { processHandle: "p1", afterSequence: 0 });
  assert.notEqual(next.output[0].deltaBase64, "bad");
  await f.service.close();
});
test("uncertain cleanup is surfaced, never silently successful", async () => {
  const f = fixture();
  f.child.terminate = async () => {
    throw Error("failed");
  };
  await f.service.request("process/spawn", request);
  await assert.rejects(f.service.close(), /unconfirmed/);
  assert.equal(f.uncertain, 1);
});
test("late launch cleanup uncertainty makes close reject", async () => {
  const f = fixture();
  let resolve!: (p: SandboxProcess) => void, started!: () => void;
  const began = new Promise<void>((r) => (started = r));
  f.child.terminate = async () => {
    throw Error("failed");
  };
  const service = new SandboxProcessService({
    ...f.options,
    sandbox: {
      async spawn() {
        started();
        return new Promise((r) => (resolve = r));
      },
    },
  });
  const pending = assert.rejects(service.request("process/spawn", request), /closed/);
  await began;
  const closed = assert.rejects(service.close(), /unconfirmed/);
  resolve(f.child);
  await pending;
  await closed;
  assert.ok(f.uncertain > 0);
});
test("output produced during spawn is not published if authority is revoked", async () => {
  const f = fixture();
  const events: unknown[] = [];
  const service = new SandboxProcessService({
    ...f.options,
    sandbox: {
      async spawn(_c, out) {
        out?.({ stream: "stdout", data: Buffer.from("private") });
        f.deny();
        return f.child;
      },
    },
  });
  service.subscribe((_m, p) => events.push(p));
  await assert.rejects(service.request("process/spawn", request), /revoked/);
  assert.deepEqual(events, []);
  assert.equal(f.killed, 1);
  await service.close();
});
test("Host ingress dispatch installs watch before replaying early spawn output", async () => {
  const f = fixture();
  let watched = false;
  const messages: string[] = [];
  const service = new SandboxProcessService({
    ...f.options,
    sandbox: {
      async spawn(_c, out) {
        out?.({ stream: "stdout", data: Buffer.from("early-prompt") });
        return f.child;
      },
    },
  });
  service.subscribe((_m, p: any) => {
    if (watched && p.deltaBase64) messages.push(Buffer.from(p.deltaBase64, "base64").toString());
  });
  await assert.rejects(service.dispatch("process/spawn", request, { threadId: "other", projectId: null }), /scope/);
  await service.dispatch(
    "process/spawn",
    request,
    { threadId: "thread-a", projectId: null },
    () => {},
    () => {
      watched = true;
    },
  );
  assert.deepEqual(messages, ["early-prompt"]);
  await service.close();
});
test("authority change after spawn acknowledgement reclaims only the new PTY", async () => {
  const f = fixture();
  let checks = 0;
  await assert.rejects(
    f.service.dispatch("process/spawn", request, { threadId: "thread-a", projectId: null }, () => {
      if (++checks > 1) throw Error("changed");
    }),
    /changed/,
  );
  assert.equal(f.killed, 1);
  await f.service.close();
});
