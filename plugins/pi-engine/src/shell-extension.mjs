export { default } from 'pi-interactive-shell/index.ts';
import { sessionManager } from 'pi-interactive-shell/session-manager.ts';
/** Read command output separately from the CLI's presentation and control hints. */
export function commandResult(sessionId) {
  const session = sessionManager.get(sessionId)?.session;
  if (!session) return undefined;
  let output = session.getRawStream({ stripAnsi: true });
  if (session.exited) output = output.replace(/\n\[Process exited with code -?\d+(?: \(signal: \d+\))?\]\n$/u, '');
  output = output.replace(/\r\n/gu, '\n');
  return { output: output.slice(-16384), truncated: output.length > 16384, exitCode: session.exitCode };
}
