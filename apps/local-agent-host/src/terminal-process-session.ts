import { readFileSync, readdirSync } from 'node:fs';

export interface TerminalProcessSession { id: number; born: bigint | null }
interface ProcessStat { pid: number; state: string; session: number; born: bigint }
/** Trusted native I/O seam; never supplied through process RPC parameters. */
export interface TerminalSessionSystem {
  platform: string;
  stat(pid: number): ProcessStat | null;
  pids(): Iterable<number>;
  signal(pid: number, force: boolean): void;
}
function stat(pid: number): ProcessStat | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { pid, state: fields[0]!, session: Number(fields[3]), born: BigInt(fields[19]!) };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}
const nativeSystem: TerminalSessionSystem = {
  platform: process.platform, stat,
  pids: () => readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number),
  signal: (pid, force) => { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); },
};
/** node-pty establishes a separate POSIX session, but fork can return before
 * setsid runs. The fresh child PID is the future SID, not its inherited SID.
 * Capture its birth immediately; missing birth evidence must fail closed. */
export function terminalProcessSession(pid: number, system = nativeSystem): TerminalProcessSession | undefined {
  if (system.platform !== 'linux') return undefined;
  return { id: pid, born: system.stat(pid)?.born ?? null };
}
export function drainTerminalProcessSessions(sessions: readonly { session: TerminalProcessSession; force: boolean }[], system = nativeSystem): number {
  if (!sessions.length || system.platform !== 'linux') return 0;
  const owned = new Map(sessions.map(value => [value.session.id, value]));
  // A known replacement leader is not our session, regardless of descendant age.
  for (const [id, owner] of owned) {
    const leader = system.stat(id);
    if (owner.session.born !== null && leader && leader.born !== owner.session.born) owned.delete(id);
  }
  if (!owned.size) return 0;
  let remaining = 0;
  for (const pid of system.pids()) {
    const entry = system.stat(pid);
    if (!entry || entry.state === 'Z' || entry.state === 'X') continue;
    const owner = owned.get(entry.session);
    if (!owner) continue;
    // Unknown ownership cannot authorize a signal or a successful release.
    if (owner.session.born === null) { remaining++; continue; }
    if (entry.born < owner.session.born) continue;
    try { system.signal(entry.pid, owner.force); remaining++; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  return remaining;
}
