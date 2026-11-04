import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { terminalOwnerLocation } from '../../apps/local-agent-host/src/terminal-owner-runtime.js';
import { startTerminalPtyOwner } from '../../apps/local-agent-host/src/terminal-pty-owner.js';
import assert from "node:assert/strict";
import test from "node:test";
import { HostProcessService, TerminalCapacityError } from "../../apps/local-agent-host/src/process-service";
import { TERMINAL_RESOURCE_LIMITS } from "@opencraft/appserver-protocol";

const env = { snapshot(scope: any) { return {
  owner: JSON.stringify([scope.account, scope.hostId, scope.projectId]),
  apply: (values: any) => values, overlay: () => ({}),
}; } } as any;
const scope = (account: string, projectId = "project") => ({ account, hostId: "host", threadId: null, projectId });
const spawn = (id: string, command = ["/bin/bash", "--noprofile", "--norc"]) => ({
  processHandle: id, resourceOwnerId: "conversation", command, tty: true, cwd: "/tmp", size: { cols: 80, rows: 24 },
});
const list = (service: HostProcessService, owner?: any) => (service.dispatch("process/list", {}, owner) as any).processes as any[];
async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > until) throw new Error("PTY limit test timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test("account/Host active quota spans projects, isolates accounts and releases capacity only on exit", async () => {
  const service = new HostProcessService(env);
  try {
    for (let i = 0; i < TERMINAL_RESOURCE_LIMITS.activePerAccountHost; i++)
      service.dispatch("process/spawn", spawn(`a-${i}`), scope("a", i % 2 ? "other" : "project"));
    assert.throws(() => service.dispatch("process/spawn", spawn("over"), scope("a", "third")), TerminalCapacityError);
    service.dispatch("process/spawn", spawn("b"), scope("b"));
    assert.equal(list(service, scope("b")).length, 1);
    assert.equal(list(service, scope("a")).length + list(service, scope("a", "other")).length, TERMINAL_RESOURCE_LIMITS.activePerAccountHost);
    assert.throws(() => service.dispatch("process/attach", { processHandle: "a-0", afterSequence: 0 }, scope("b")), /not found/);
    assert.throws(() => service.dispatch("process/attach", { processHandle: "a-0", afterSequence: 0 }, scope("a", "other")), /not found/);
    const attached = service.dispatch("process/attach", { processHandle: "a-0", afterSequence: 0 }, scope("a")) as any;
    assert.equal(attached.context.resourceOwnerId, "conversation");
    assert.equal(attached.context.projectId, "project");
    assert.equal(attached.context.cwd, "/tmp");
    service.dispatch("process/kill", { processHandle: "a-0" }, scope("a"));
    await waitFor(() => list(service, scope("a")).find(p => p.processHandle === "a-0")?.phase === "exited");
    service.dispatch("process/spawn", spawn("replacement"), scope("a"));
    assert.equal([...list(service, scope("a")), ...list(service, scope("a", "other"))].filter(p => p.phase === "running").length, TERMINAL_RESOURCE_LIMITS.activePerAccountHost);
  } finally { service.close(); }
});

test("aggregate Host quota cannot be bypassed by changing accounts", () => {
  const service = new HostProcessService(env);
  try {
    for (let i = 0; i < TERMINAL_RESOURCE_LIMITS.activePerHost; i++)
      service.dispatch("process/spawn", spawn(`pty-${i}`), scope(`account-${Math.floor(i / TERMINAL_RESOURCE_LIMITS.activePerAccountHost)}`));
    assert.throws(() => service.dispatch("process/spawn", spawn("over"), scope("new-account")), TerminalCapacityError);
  } finally { service.close(); }
});

test("output replay and retained exit records remain bounded while live PTYs are never evicted", async () => {
  const service = new HostProcessService();
  try {
    service.dispatch("process/spawn", spawn("live"));
    service.dispatch("process/spawn", spawn("output", ["/bin/sh", "-c", "head -c 1800000 /dev/zero"]));
    await waitFor(() => list(service).find(p => p.processHandle === "output")?.phase === "exited");
    const result = service.dispatch("process/attach", { processHandle: "output", afterSequence: 0 }) as any;
    assert.equal(result.truncated, true);
    assert.ok(result.output.reduce((total: number, c: any) => total + c.deltaBase64.length, 0) <= TERMINAL_RESOURCE_LIMITS.outputBase64Bytes);
    for (let i = 0; i < TERMINAL_RESOURCE_LIMITS.retainedPerHost + 2; i++) {
      const id = `exit-${i}`;
      service.dispatch("process/spawn", spawn(id, ["/bin/sh", "-c", "exit 0"]));
      await waitFor(() => list(service).find(p => p.processHandle === id)?.phase === "exited");
    }
    assert.equal(list(service).length, TERMINAL_RESOURCE_LIMITS.retainedPerHost);
    assert.equal(list(service).find(p => p.processHandle === "live")?.phase, "running");
    service.dispatch("process/spawn", spawn("bad", ["/does-not-exist"]));
    await waitFor(() => list(service).find(p => p.processHandle === "bad")?.phase === "exited");
    assert.equal(list(service).filter(p => p.phase === "running").length, 1, "failed exec never consumes live capacity");
    assert.throws(() => service.dispatch("process/spawn", { ...spawn("invalid"), env: { VALUE: true } }), /environment/);
    assert.equal(list(service).some(p => p.processHandle === "invalid"), false);
  } finally { service.close(); }
});

test("execution transport reports capacity exhaustion without exposing unrelated authorization failures", async () => {
  const { ExecutionEnvironmentTransport } = await import('../../scripts/execution-environment-transport');
  const directory = await mkdtemp(join(tmpdir(), 'terminal-transport-'));
  const location = await terminalOwnerLocation(directory);
  const stop = await startTerminalPtyOwner(location.directory, location.endpoint);
  const disposers: Array<() => void> = [];
  let denied = false;
  const runtime = { ...env, directory, onClose: (dispose: () => void) => disposers.push(dispose), scope: () => {
    if (denied) throw new Error('private admission detail');
    return scope('transport-account');
  } } as any;
  const transport = new ExecutionEnvironmentTransport({ subscribeMessage: () => () => {}, close() {} } as any, runtime, 'host');
  const responses: any[] = [];
  const off = transport.subscribeMessage(frame => responses.push(JSON.parse(frame)));
  const send = (id: number) => transport.sendWithContext(JSON.stringify({ jsonrpc: '2.0', id, method: 'process/spawn', params: spawn(`rpc-${id}`) }), { sender: null });
  try {
    for (let i = 0; i < TERMINAL_RESOURCE_LIMITS.activePerAccountHost; i++) await send(i);
    await send(9999);
    assert.equal(responses.find(response => response.id === 9999)?.error.code, -32029);
    assert.match(responses.find(response => response.id === 9999)?.error.message, /Terminal limit reached/);
    denied = true;
    await send(10000);
    assert.equal(responses.find(response => response.id === 10000)?.error.message, 'Terminal unavailable for this account or project');
  } finally { off(); transport.close(); disposers.forEach(dispose => dispose()); await stop(); await rm(directory, { recursive: true, force: true }); await rm(dirname(location.endpoint), { recursive: true, force: true }); }
});
