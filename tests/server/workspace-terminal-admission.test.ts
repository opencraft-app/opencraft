import { fork } from "node:child_process";
import { once } from "node:events";
import { openTerminalAdmission } from "../../apps/local-agent-host/src/terminal-admission-owner.js";
import { connect } from "node:net";
import {
  readOwnerFrames,
  sendOwnerFrame,
  TERMINAL_OWNER_PROTOCOL,
} from "../../apps/local-agent-host/src/terminal-owner-wire.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableHostProcessService } from "../../apps/local-agent-host/src/durable-process-service.js";
import { startTerminalPtyOwner } from "../../apps/local-agent-host/src/terminal-pty-owner.js";
import { TerminalAdmissionStore } from "../../apps/local-agent-host/src/terminal-admission-store.js";
import { withRemoteTerminalAdmission } from "../../apps/headless-server/src/workspaces/terminal-admission.js";
import type { SandboxEnvironment, SandboxExit } from "@opencraft/sandbox";
const dimensions = { cols: 80, rows: 24 },
  scope = { account: "alice", hostId: "local-codex", threadId: "thread", projectId: null };
const command = { command: ["fixture"], cwd: "/workspace", env: {}, terminal: dimensions };
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "shared-terminal-admission-")),
    endpoint = join(directory, "owner.sock"),
    tokenFile = join(directory, "token");
  await writeFile(tokenFile, "synthetic-private-terminal-token-0123456789", { mode: 0o600 });
  let stop = await startTerminalPtyOwner(directory, endpoint, { token: "synthetic-private-terminal-token-0123456789" });
  const clients: DurableHostProcessService[] = [];
  const client = () => {
    const c = new DurableHostProcessService(directory, undefined, {
      endpoint,
      tokenFile,
      prepare: () => ({
        quotaOwner: "actor-host:alice",
        owner: "actor-host:alice",
        scope,
        env: { PATH: "/usr/bin:/bin" },
      }),
    });
    clients.push(c);
    return c;
  };
  t.after(async () => {
    for (const c of clients) c.close();
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    client,
    async restart() {
      for (const c of clients) c.close();
      await stop();
      stop = await startTerminalPtyOwner(directory, endpoint, { token: "synthetic-private-terminal-token-0123456789" });
    },
  };
}
function environment() {
  const children: { resolve(exit: SandboxExit): void }[] = [];
  let calls = 0,
    deleted = false,
    unknownSpawn = false;
  const sandbox: SandboxEnvironment = {
    resources: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 },
    capabilities: { terminal: true },
    spawn: async () => {
      calls++;
      if (unknownSpawn) throw Error("Synthetic unknown SDK spawn");
      let resolve!: (exit: SandboxExit) => void;
      const exited = new Promise<SandboxExit>((r) => (resolve = r));
      children.push({ resolve });
      return {
        kind: "terminal",
        id: "remote-" + calls,
        exited,
        writeStdin: async () => {},
        resize: async () => {},
        terminate: async () => {},
      };
    },
    close: async () => {
      deleted = true;
    },
  };
  return {
    sandbox,
    children,
    get calls() {
      return calls;
    },
    get deleted() {
      return deleted;
    },
    unknown() {
      unknownSpawn = true;
    },
  };
}
const local = (id: string) => ({
  processHandle: id,
  tty: true,
  command: ["/bin/bash", "--noprofile", "--norc"],
  cwd: "/tmp",
  size: dimensions,
});
async function exited(client: DurableHostProcessService, id: string) {
  for (let i = 0; i < 200; i++) {
    const value = (await client.dispatch("process/attach", { processHandle: id, afterSequence: 0 }, scope)) as {
      phase: string;
    };
    if (value.phase === "exited") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Real PTY did not exit");
}

test("existing Hands owner arbitrates local and multiple remote bindings under the same account quota; disconnect and kill ack do not refund", async (t) => {
  const f = await fixture(t),
    hands = f.client(),
    remote = f.client(),
    a = environment(),
    b = environment();
  const wa = withRemoteTerminalAdmission(a.sandbox, {
      port: remote,
      quotaOwner: "actor-host:alice",
      resource: "workspace-a:1",
      onCleanupUnconfirmed() {},
    }),
    wb = withRemoteTerminalAdmission(b.sandbox, {
      port: remote,
      quotaOwner: "actor-host:alice",
      resource: "workspace-b:1",
      onCleanupUnconfirmed() {},
    });
  await hands.dispatch("process/spawn", local("real-local"), scope);
  const child = await wa.environment.spawn(command);
  for (let i = 1; i < 8; i++) await wa.environment.spawn(command);
  for (let i = 0; i < 7; i++) await wb.environment.spawn(command);
  await assert.rejects(wb.environment.spawn(command), /limit reached/);
  assert.equal(a.calls, 8);
  assert.equal(b.calls, 7);
  remote.close();
  const replacement = f.client();
  await assert.rejects(replacement.dispatch("process/spawn", local("over-local"), scope), /limit reached/);
  await hands.dispatch("process/kill", { processHandle: "real-local" }, scope);
  await exited(hands, "real-local");
  const slot = await replacement.reserveTerminal("actor-host:alice", "late-binding", "one");
  await child.terminate();
  await assert.rejects(replacement.reserveTerminal("actor-host:alice", "late-binding", "two"), /limit reached/);
  // The original wrapper's observer is detached: close is not a release receipt.
  a.children[0]!.resolve({ code: 0 });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(replacement.reserveTerminal("actor-host:alice", "late-binding", "three"), /limit reached/);
  await replacement.releaseTerminal(slot, "not-created");
  wa.retire();
  wb.retire();
  await Promise.all([a.sandbox.close(), b.sandbox.close()]);
  await replacement.confirmTerminalResourceDestroyed("actor-host:alice", "workspace-a:1");
  await replacement.confirmTerminalResourceDestroyed("actor-host:alice", "workspace-b:1");
});

test("positive remote exit releases one slot, while uncertain spawn and reservations survive Hands replacement until exact resource destruction", async (t) => {
  const f = await fixture(t),
    hands = f.client(),
    a = environment();
  let uncertain = 0;
  const wrapper = withRemoteTerminalAdmission(a.sandbox, {
    port: hands,
    quotaOwner: "actor-host:alice",
    resource: "workspace-a:2:instance-a",
    onCleanupUnconfirmed() {
      uncertain++;
    },
  });
  for (let i = 0; i < 16; i++) await wrapper.environment.spawn(command);
  await assert.rejects(hands.dispatch("process/spawn", local("blocked"), scope), /limit reached/);
  a.children[0]!.resolve({ code: 0 });
  await new Promise((r) => setTimeout(r, 20));
  const nonce = await hands.reserveTerminal("actor-host:alice", "different-resource", "unknown");
  await hands.releaseTerminal(nonce, "exited");
  a.unknown();
  await assert.rejects(wrapper.environment.spawn(command), /unknown SDK/);
  assert.equal(a.calls, 17);
  await f.restart();
  const next = f.client();
  await assert.rejects(next.reserveTerminal("actor-host:alice", "fresh", "no-reset"), /limit reached/);
  await next.confirmTerminalResourceDestroyed("actor-host:alice", "workspace-a:1:instance-a");
  await assert.rejects(next.reserveTerminal("actor-host:alice", "fresh", "wrong-generation"), /limit reached/);
  await a.sandbox.close();
  assert.equal(a.deleted, true);
  await next.confirmTerminalResourceDestroyed("actor-host:alice", "workspace-a:2:instance-a");
  const fresh = await next.reserveTerminal("actor-host:alice", "fresh", "after-positive-proof");
  await next.releaseTerminal(fresh, "not-created");
  assert.equal(uncertain, 0);
});

test("the same owner enforces aggregate host capacity across account keys, with nonce-fenced stale release", async (t) => {
  const f = await fixture(t),
    c = f.client(),
    tokens: string[] = [];
  for (let account = 0; account < 4; account++)
    for (let i = 0; i < 16; i++)
      tokens.push(await c.reserveTerminal("account-" + account, "resource-" + account, "operation-" + i));
  await assert.rejects(c.reserveTerminal("fifth-account", "resource-five", "operation"), /limit reached/);
  const old = tokens[0]!;
  await c.releaseTerminal(old, "not-created");
  const current = await c.reserveTerminal("account-0", "resource-0", "operation-0");
  assert.notEqual(current, old);
  await c.releaseTerminal(old, "exited");
  await assert.rejects(c.reserveTerminal("fifth-account", "resource-five", "still-full"), /limit reached/);
  for (const token of [...tokens.slice(1), current]) await c.releaseTerminal(token, "not-created");
});

test("missing shared admission cannot fall back to a remote SDK terminal; nonterminal tools stay unchanged", async () => {
  const a = environment(),
    wrapper = withRemoteTerminalAdmission(a.sandbox, {
      quotaOwner: "actor",
      resource: "resource",
      onCleanupUnconfirmed() {},
    });
  assert.equal(wrapper.environment.capabilities.terminal, false);
  await assert.rejects(wrapper.environment.spawn(command), /admission unavailable/);
  assert.equal(a.calls, 0);
  await wrapper.environment.spawn({ ...command, terminal: undefined });
  assert.equal(a.calls, 1);
});

test("corrupt or non-private quota state fails closed without replacing the journal or retaining its owner lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "terminal-quota-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "terminal-admission.json");
  await writeFile(path, '{"version":999}', { mode: 0o600 });
  await assert.rejects(startTerminalPtyOwner(root, join(root, "owner.sock")), /Invalid terminal admission/);
  await assert.rejects(startTerminalPtyOwner(root, join(root, "owner.sock")), /Invalid terminal admission/);
  await assert.rejects(TerminalAdmissionStore.open(root), /Invalid terminal admission/);
  assert.equal(await readFile(path, "utf8"), '{"version":999}');
  await writeFile(path, JSON.stringify({ version: 1, reservations: [] }));
  await chmod(path, 0o644);
  await assert.rejects(startTerminalPtyOwner(root, join(root, "owner.sock")), /Invalid terminal admission/);
});

test("a lost private reserve acknowledgement remains charged across Hands replacement; no absence-based refund", async (t) => {
  const f = await fixture(t);
  await new Promise<void>((resolve, reject) => {
    const socket = connect(join(f.directory, "owner.sock"));
    socket.once("error", reject);
    socket.once("connect", () =>
      sendOwnerFrame(socket, {
        type: "attach",
        protocol: TERMINAL_OWNER_PROTOCOL,
        token: "synthetic-private-terminal-token-0123456789",
      }),
    );
    readOwnerFrames(socket, (message) => {
      if (message.type !== "attached") return;
      sendOwnerFrame(socket, {
        id: 1,
        method: "process/quotaReserve",
        params: { resource: "unknown-reserve-ack", operation: "once" },
        identity: { quotaOwner: "actor-host:alice", lifecycleAuthority: true },
      });
      socket.end();
      resolve();
    });
  });
  let committed = false;
  for (let i = 0; i < 100; i++) {
    try {
      const value = JSON.parse(await readFile(join(f.directory, "terminal-admission.json"), "utf8"));
      if (value.reservations.some((r: { resource: string }) => r.resource === "unknown-reserve-ack")) {
        committed = true;
        break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(committed, true);
  await f.restart();
  const c = f.client();
  for (let i = 0; i < 15; i++) await c.reserveTerminal("actor-host:alice", "other-binding", "known-" + i);
  await assert.rejects(c.reserveTerminal("actor-host:alice", "other-binding", "over"), /limit reached/);
});

test("resource revocation during asynchronous quota admission cannot launch a late remote PTY", async () => {
  const a = environment();
  let finish!: (token: string) => void,
    revoked = false,
    released = false;
  const wrapper = withRemoteTerminalAdmission(a.sandbox, {
    quotaOwner: "actor",
    resource: "bound:2",
    authorize: async () => {
      if (revoked) throw Error("Resource revoked");
    },
    port: {
      probeTerminalAdmission: async () => {},
      reserveTerminal: () => new Promise((r) => (finish = r)),
      releaseTerminal: async (_token, proof) => {
        assert.equal(proof, "not-created");
        released = true;
      },
      confirmTerminalResourceDestroyed: async () => {},
    },
    onCleanupUnconfirmed() {},
  });
  const work = wrapper.environment.spawn(command);
  revoked = true;
  finish("a".repeat(64));
  await assert.rejects(work, /Resource revoked/);
  assert.equal(a.calls, 0);
  assert.equal(released, true);
});

test(
  "a paused live Hands storage writer cannot expire; process death releases only its writer, not terminal reservations",
  { skip: process.platform !== "linux", timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-admission-kernel-"));
    const child = fork(new URL("../fixtures/terminal-admission-peer.ts", import.meta.url), [directory], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit");
        child.kill("SIGKILL");
        await stopped;
      }
      await rm(directory, { recursive: true, force: true });
    });
    const ready = await once(child, "message");
    assert.deepEqual(ready[0], { ready: true });
    child.kill("SIGSTOP");
    await assert.rejects(openTerminalAdmission(directory), /ownership|held|admission/);
    const stopped = once(child, "exit");
    child.kill("SIGKILL");
    await stopped;
    const next = await openTerminalAdmission(directory);
    try {
      await assert.rejects(next.reserve("remote", "actor-host:alice", "new-resource", "no-refund"), /limit reached/);
    } finally {
      await next.close();
    }
  },
);
