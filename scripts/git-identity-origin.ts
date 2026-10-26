import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readlink, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { readGitProcess, type GitExecutionIdentity, type GitPeer } from './git-identity-broker.js';

export interface NativeGitProcess { pid: number; startTicks: string; incarnation: string }
export interface GitOriginLeaseReader {
  readonly originClock?: 'boot-monotonic-v1';
  resolveJobOrigin(input: { threadId: string; engineIncarnation: string; startedAtMs: number; uncertaintyMs: number; bootId?: string; startedAtBootMs?: number }):
    GitOriginLeaseResolution | Promise<GitOriginLeaseResolution>;
}
export type GitOriginLeaseResolution = { status: 'unknown' } | { status: 'active' | 'expired' | 'unowned'; lease: { principal: { provider: string; subject: string } | null; executionId: string } };
const verifiedExecutables = new WeakMap<DatabaseSync, Map<string, string>>();
const executableChecks = new WeakMap<DatabaseSync, Map<string, Promise<boolean>>>();
/** Read existing owner records. This reader never locks, migrates, or invents a generation. */
export async function readCodexGitNatives(registry: DatabaseSync): Promise<NativeGitProcess[]> {
  let cache = verifiedExecutables.get(registry);
  if (!cache) { cache = new Map(); verifiedExecutables.set(registry, cache); }
  let pending = executableChecks.get(registry);
  if (!pending) { pending = new Map(); executableChecks.set(registry, pending); }
  const rows = registry.prepare(`SELECT g.id,g.incarnation,g.definition,m.value FROM generations g
    JOIN routing_metadata m ON m.key='runtime:'||g.id WHERE g.state IN ('active','draining','ready')`).all();
  const natives: NativeGitProcess[] = [];
  for (const row of rows) {
    const identity = JSON.parse(String(row.value)), definition = JSON.parse(String(row.definition));
    if (!Number.isSafeInteger(identity.nativePid) || !Number.isSafeInteger(identity.ownerPid)) continue;
    try {
      const native = await readGitProcess(identity.nativePid), owner = await readGitProcess(identity.ownerPid);
      const uid = (await stat(`/proc/${native.pid}`)).uid;
      if (native.startTicks !== identity.nativeStart || owner.startTicks !== identity.ownerStart || native.parent !== owner.pid
        || uid !== (definition.executionUid ?? process.getuid?.()) || await readlink(`/proc/${native.pid}/exe`) !== definition.executable) continue;
      const file = await stat(`/proc/${native.pid}/exe`, { bigint: true });
      const stamp = JSON.stringify([identity.nativePid, identity.nativeStart, definition.executable, identity.cliSha256, String(file.ino), String(file.size), String(file.mtimeNs), String(file.ctimeNs)]);
      if (cache.get(String(row.id)) !== stamp) {
        let check = pending.get(stamp);
        if (!check) {
          check = readFile(`/proc/${native.pid}/exe`).then(bytes => createHash('sha256').update(bytes).digest('hex') === identity.cliSha256).catch(() => false);
          pending.set(stamp, check);
        }
        const valid = await check; pending.delete(stamp);
        if (!valid) continue;
        cache.set(String(row.id), stamp);
      }
      natives.push({ pid: native.pid, startTicks: native.startTicks, incarnation: JSON.stringify([row.id, row.incarnation]) });
    } catch { /* A retired/restarted process cannot authorize a new job. */ }
  }
  return natives;
}

export function createGitOriginResolver(options: {
  natives(threadId: string): Promise<readonly NativeGitProcess[]>; reader: GitOriginLeaseReader;
  account(principal: { provider: string; subject: string }): string | null;
}) {
  let clockTicks: Promise<number> | undefined;
  return async (peer: GitPeer, threadId: string): Promise<GitExecutionIdentity> => {
    if (peer.uid !== process.getuid?.() || options.reader.originClock !== 'boot-monotonic-v1') return { status: 'unknown' };
    try {
      const natives = await options.natives(threadId), chain: Array<Awaited<ReturnType<typeof readGitProcess>>> = [];
      let pid = peer.pid, found: NativeGitProcess | undefined;
      for (let i = 0; i < 128 && pid > 1; i++) {
        const process = await readGitProcess(pid); chain.push(process);
        found = natives.find(native => native.pid === pid && native.startTicks === process.startTicks);
        if (found) break;
        pid = process.parent;
      }
      if (!found || chain.length < 2) return { status: 'unknown' };
      chain.pop(); chain.reverse();
      // Long-lived code-mode/MCP bridges are transport owners, not command births.
      let job = chain[0]!;
      for (let i = 0; i < chain.length - 1; i++) {
        const process = chain[i]!, exe = basename(await readlink(`/proc/${process.pid}/exe`));
        const args = (await readFile(`/proc/${process.pid}/cmdline`, 'utf8')).split('\0');
        const bridge = exe === 'codex-code-mode-host' || (exe.startsWith('python') && args.includes('agent.transports.hermes_tools_mcp_server'));
        if (!bridge) { job = process; break; }
        job = chain[i + 1]!;
      }
      clockTicks ??= promisify(execFile)('getconf', ['CLK_TCK']).then(result => {
        const value = Number(result.stdout.trim()); if (!Number.isFinite(value) || value < 1) throw new Error(); return value;
      });
      const hz = await clockTicks, before = performance.now(), uptime = Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0]), after = performance.now();
      const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), startedAtBootMs = Number(job.startTicks) * 1000 / hz;
      if (!/^[0-9a-f-]{36}$/u.test(bootId) || !Number.isFinite(startedAtBootMs)) return { status: 'unknown' };
      const startedAtMs = Date.now() - uptime * 1000 + startedAtBootMs;
      const uncertaintyMs = 10 + 1000 / hz + (after - before) / 2;
      const result = await options.reader.resolveJobOrigin({ threadId, engineIncarnation: found.incarnation, startedAtMs, uncertaintyMs, bootId, startedAtBootMs });
      const afterNatives = await options.natives(threadId);
      if (!afterNatives.some(native => native.pid === found!.pid && native.startTicks === found!.startTicks && native.incarnation === found!.incarnation)
        || (await readGitProcess(peer.pid)).startTicks !== chain.at(-1)!.startTicks) return { status: 'unknown' };
      if (result.status === 'unknown' || result.status === 'expired' || result.status === 'unowned') return { status: result.status };
      const account = result.lease.principal && options.account(result.lease.principal);
      return account ? { status: 'active', account, executionId: result.lease.executionId } : { status: 'unknown' };
    } catch { return { status: 'unknown' }; }
  };
}
