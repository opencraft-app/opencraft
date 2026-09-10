import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { HermesTatTerminalService } from '../plugins/lightvela-hermes/src/hermes-appserver-bridge/tat-terminal';
import type { BotTerminalSession } from '../plugins/lightvela-hermes/src/domain/types';
import type { TencentTatSessionMultiplexer, TatPtyChannelHandlers } from '../plugins/lightvela-hermes/src/lib/tencent-tat-session-multiplexer';
import {
  HERMES_MEMORY_JSON_END,
  HERMES_MEMORY_JSON_START,
  parseHermesMemorySnapshot,
} from '../plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/agent-memory';

test('non-interactive completion strips PTY echo and streams only command output', { timeout: 2000 }, async () => {
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
  const chunks: string[] = [];
  terminal.subscribeNotification(({ params }) => { chunks.push(atob(params.deltaBase64)); });
  try {
    const result = await terminal.exec({ processId: 'regression', command: ['sh', '-c', 'printf "actual-output"; exit 7'] });
    assert.equal(result.exitCode, 7);
    assert.equal(chunks.join(''), 'actual-output');
    assert.ok(chunks.length > 1, 'fragmented PTY output remains streamed');
  } finally { terminal.dispose(); }
});

test('non-interactive completion does not expose protocol-looking text from the echoed command', { timeout: 2000 }, async () => {
  const terminal = new HermesTatTerminalService({
    createSession: async () => ({} as BotTerminalSession),
    createMultiplexer: () => ({
      close() {},
      async openPty(handlers: TatPtyChannelHandlers) {
        return { release() {}, resize() { return true; }, sendInput(input: string) {
          handlers.onOutput?.(input + '\r\n');
          const result = execFileSync('/bin/sh', ['-c', input.trim()], { encoding: 'utf8' });
          handlers.onOutput?.(result);
          return true;
        } };
      },
    } as unknown as TencentTatSessionMultiplexer),
  });
  let output = '';
  terminal.subscribeNotification(({ params }) => { output += atob(params.deltaBase64); });
  try {
    const payload = JSON.stringify({
      memoryCharLimit: 2200,
      userCharLimit: 1375,
      memoryChars: 9,
      userChars: 0,
      memoryText: 'line\nline',
      userText: '',
      usedFallbackLimits: false,
    });
    const result = await terminal.exec({
      processId: 'marker-regression',
      command: ['sh', '-c', `printf '%s\\n' '${HERMES_MEMORY_JSON_START}' '${payload}' '${HERMES_MEMORY_JSON_END}'`],
    });
    assert.equal(result.exitCode, 0);
    assert.equal(output, `${HERMES_MEMORY_JSON_START}\n${payload}\n${HERMES_MEMORY_JSON_END}\n`);
    assert.equal(output.indexOf(HERMES_MEMORY_JSON_START), output.lastIndexOf(HERMES_MEMORY_JSON_START));
    assert.equal(parseHermesMemorySnapshot(output).memoryText, 'line\nline');
  } finally { terminal.dispose(); }
});
