import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { HermesTatTerminalService } from '../plugins/lightvela-hermes/src/hermes-appserver-bridge/tat-terminal';
import type { BotTerminalSession } from '../plugins/lightvela-hermes/src/domain/types';
import type { TencentTatSessionMultiplexer, TatPtyChannelHandlers } from '../plugins/lightvela-hermes/src/lib/tencent-tat-session-multiplexer';

test('non-interactive completion ignores PTY echo and accepts fragmented actual exit marker', { timeout: 2000 }, async () => {
  const terminal = new HermesTatTerminalService({
    createSession: async () => ({} as BotTerminalSession),
    createMultiplexer: () => ({
      close() {},
      async openPty(handlers: TatPtyChannelHandlers) {
        return { release() {}, resize() { return true; }, sendInput(input: string) {
          handlers.onOutput?.(input + '\n'); // Real interactive shells echo the submitted script.
          const result = execFileSync('/bin/sh', ['-c', input.trim()], { encoding: 'utf8' });
          for (const char of result) handlers.onOutput?.(char);
          return true;
        } };
      },
    } as unknown as TencentTatSessionMultiplexer),
  });
  let output = '';
  terminal.subscribeNotification(({ params }) => { output += atob(params.deltaBase64); });
  try {
    const result = await terminal.exec({ processId: 'regression', command: ['sh', '-c', 'printf "actual-output\\n"; exit 7'] });
    assert.equal(result.exitCode, 7);
    assert.match(output, /actual-output/);
  } finally { terminal.dispose(); }
});
