import { readFileSync, readdirSync } from 'node:fs';

export interface TerminalProcessSession { id: number; born: bigint }
function stat(pid: number) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { pid, state: fields[0], session: Number(fields[3]), born: BigInt(fields[19]!) };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}
/** node-pty establishes a separate POSIX session. Track it before the shell can
 * exit: background jobs may use different process groups in that same session. */
export function terminalProcessSession(pid: number): TerminalProcessSession | undefined {
  if (process.platform !== 'linux') return undefined;
  const entry = stat(pid);
  return entry?.session === pid ? { id: pid, born: entry.born } : undefined;
}
export function drainTerminalProcessSessions(sessions: readonly { session: TerminalProcessSession; force: boolean }[]): number {
  if (!sessions.length) return 0;
  const owned = new Map(sessions.map(value => [value.session.id, value]));
  let remaining = 0;
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const entry = stat(Number(name));
    if (!entry || entry.state === 'Z' || entry.state === 'X') continue;
    const owner = owned.get(entry.session);
    if (!owner || entry.born < owner.session.born) continue;
    try { process.kill(entry.pid, owner.force ? 'SIGKILL' : 'SIGTERM'); remaining++; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  return remaining;
}
