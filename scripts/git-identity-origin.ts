import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readlink, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { readGitProcess, type GitExecutionIdentity, type GitPeer } from './git-identity-broker.js';

export interface NativeGitProcess {
  pid: number; startTicks: string; incarnation: string;
  threadEnvironment: 'CODEX_THREAD_ID' | 'OPENCRAFT_THREAD_ID';
}
export interface GitOriginLeaseReader {
  readonly originClock?: 'boot-monotonic-v1';
  resolveJobOrigin(input: { threadId: string; engineIncarnation: string; startedAtMs: number; uncertaintyMs: number; bootId?: string; startedAtBootMs?: number }):
    GitOriginLeaseResolution | Promise<GitOriginLeaseResolution>;
}
export type GitOriginLeaseResolution = { status: 'unknown' } | { status: 'active' | 'expired' | 'unowned'; lease: { principal: { provider: string; subject: string } | null; executionId: string } };
const verifiedExecutables = new WeakMap<DatabaseSync, Map<string, string>>();
const executableChecks = new WeakMap<DatabaseSync, Map<string, Promise<boolean>>>();
/** Resolve only the official persistent npm transport's unique direct child.
 * Keep the caller's attested incarnation: leases belong to the managed owner. */
export async function resolveGitCodexToolRoot(owner: NativeGitProcess): Promise<NativeGitProcess> {
  const args = (await readFile(`/proc/${owner.pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
  if (!args[1]?.endsWith('/@openai/codex/bin/codex.js') || args[2] !== 'app-server') return owner;
  const uid = (await stat(`/proc/${owner.pid}`)).uid;
  const children = (await readFile(`/proc/${owner.pid}/task/${owner.pid}/children`, 'utf8')).trim().split(/\s+/u).filter(Boolean);
  const matches = [];
  for (const child of children) {
    const native = await readGitProcess(Number(child));
    const childArgs = (await readFile(`/proc/${native.pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    if (native.parent === owner.pid && (await stat(`/proc/${native.pid}`)).uid === uid
      && JSON.stringify(childArgs.slice(1)) === JSON.stringify(args.slice(2))) matches.push(native);
  }
  if (matches.length !== 1 || (await readGitProcess(owner.pid)).startTicks !== owner.startTicks) throw new Error('Codex transport changed');
  const native = matches[0]!;
  const after = await readGitProcess(native.pid);
  if (after.startTicks !== native.startTicks || after.parent !== owner.pid) throw new Error('Codex native changed');
  return { ...owner, pid: native.pid, startTicks: native.startTicks };
}
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
      natives.push(await resolveGitCodexToolRoot({ pid: native.pid, startTicks: native.startTicks, incarnation: JSON.stringify([row.id, row.incarnation]), threadEnvironment: 'CODEX_THREAD_ID' }));
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
      // The locator must match metadata injected into the real native tool root,
      // not the wrapper's mutable environment. One native can host concurrent
      // Threads whose otherwise valid birth intervals overlap.
      const environment = (await readFile(`/proc/${job.pid}/environ`, 'utf8')).split('\0');
      const bindings = environment.filter(item => item.startsWith(`${found.threadEnvironment}=`));
      if (bindings.length !== 1 || bindings[0]!.slice(found.threadEnvironment.length + 1) !== threadId) return { status: 'unknown' };
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
      if (!afterNatives.some(native => native.pid === found!.pid && native.startTicks === found!.startTicks && native.incarnation === found!.incarnation && native.threadEnvironment === found!.threadEnvironment)
        || (await readGitProcess(peer.pid)).startTicks !== chain.at(-1)!.startTicks
        || (await readGitProcess(job.pid)).startTicks !== job.startTicks
        || (await readFile(`/proc/${job.pid}/environ`, 'utf8')).split('\0').filter(item => item.startsWith(`${found.threadEnvironment}=`)).join('\0') !== bindings[0]) return { status: 'unknown' };
      if (result.status === 'unknown' || result.status === 'expired' || result.status === 'unowned') return { status: result.status };
      const account = result.lease.principal && options.account(result.lease.principal);
      return account ? { status: 'active', account, executionId: result.lease.executionId } : { status: 'unknown' };
    } catch { return { status: 'unknown' }; }
  };
}
