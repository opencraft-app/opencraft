import { spawn } from 'node:child_process';
import type { SandboxBackend } from '@opencraft/sandbox';
/** Fake-provider test backend only; not installed/exported by the Host. */
export function localTestBackend(): SandboxBackend {
  return { id: 'test-process-group', async initialize() {}, async close() {}, async create(_identity, resources) {
    const groups: number[] = [];
    return { resources, capabilities: { terminal: false }, async spawn(command, output) {
      const child = spawn(command.command[0]!, command.command.slice(1), { cwd: command.cwd, env: { ...command.env }, detached: true, stdio: ['pipe','pipe','pipe'] });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      groups.push(child.pid!);
      child.stdout.on('data', data => output?.({ stream: 'stdout', data }));
      child.stderr.on('data', data => output?.({ stream: 'stderr', data }));
      const exited = new Promise<{ code: number | null }>(resolve => child.once('exit', code => resolve({ code })));
      const terminate = async () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } await exited; };
      return { id: String(child.pid), kind: 'process', exited, terminate,
        writeStdin: data => new Promise<void>((resolve, reject) => child.stdin.write(data, error => error ? reject(error) : resolve())),
        closeStdin: async () => { child.stdin.end(); } };
    }, async close() {
      for (const pid of groups) { try { process.kill(-pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } }
    } };
  } };
}
