import { BridgeProtocolServer } from '../../../apps/claude-code-bridge/src/protocol-server.js';
import { FakeClaudeFactory, FakeClaudeNative } from './fake-claude-native.js';
import type { NativeStartOptions } from '../../../apps/claude-code-bridge/src/types.js';

/**
 * Test-only bridge process. It exercises the real protocol server and session
 * state machine with a scripted Agent SDK port; it never imports the SDK or
 * contacts a model. The first result arrives after the steer, so the bridge
 * must hold the logical turn for the steer's own result.
 */
class ScriptedFactory extends FakeClaudeFactory {
  override start(options: NativeStartOptions) {
    const native = super.start(options) as FakeClaudeNative;
    native.onPush = (push, index) => {
      const delay = index === 0 ? 300 : 60;
      setTimeout(() => {
        native.emit({
          type: 'assistant',
          uuid: `assistant-${index}-${push.uuid}`,
          message: { content: [{ type: 'text', text: `answer-${index}` }] },
        });
        native.emit({
          type: 'result',
          subtype: 'success',
          uuid: `result-${index}-${push.uuid}`,
          user_message_uuids: [push.uuid],
          queued_turn_count: 0,
          usage: { input_tokens: 10, output_tokens: 2 },
        });
      }, delay);
    };
    return native;
  }
}

const server = new BridgeProtocolServer({
  input: process.stdin,
  write: (data) => { process.stdout.write(data); },
  factory: new ScriptedFactory(),
  diagnostics: (message) => { process.stderr.write(`${message}\n`); },
});

void server.run().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`fake bridge failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
