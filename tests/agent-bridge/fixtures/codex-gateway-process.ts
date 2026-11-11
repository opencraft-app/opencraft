import { CodexProviderBridge } from '../../../apps/opencraft-daemon/src/codex-provider-bridge.js';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
let legacyMessage: (raw: string) => void = () => {};
const legacy = { status: { state: 'open' as const }, async connect() {}, async close() {}, subscribeStatus() { return () => {}; },
  subscribeMessage(callback: (raw: string) => void) { legacyMessage = callback; return () => {}; },
  async send(raw: string) { const frame = JSON.parse(raw); if (frame.id !== undefined) legacyMessage(JSON.stringify({ id: frame.id, result: { capabilities: {} }, [LOGICAL_CLIENT_FIELD]: frame[LOGICAL_CLIENT_FIELD] })); },
};
const proxy = new CodexProviderBridge(legacy, JSON.parse(process.env.P2A_GATEWAY_CONFIG!));
proxy.subscribeMessage(raw => process.send?.(JSON.parse(raw)));
await proxy.connect();
process.on('message', async (message: any) => {
  if (message === 'close') { await proxy.close(); process.exit(0); }
  else await proxy.send(JSON.stringify({ ...message, [LOGICAL_CLIENT_FIELD]: 'gateway-client' }));
});
process.send?.({ ready: true, pid: process.pid });
