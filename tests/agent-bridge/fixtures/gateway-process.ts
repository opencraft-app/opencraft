import { GatewayInbox } from '../../../apps/agent-bridge-host/src/index.js';
const inbox = new GatewayInbox(process.env.INBOX_DB!);
await inbox.storage.ready;
process.send?.({ ready: true });
process.on('message', async message => {
  if (message === 'pull') {
    try { const events = await inbox.pull(process.env.HOST_URL!, process.env.TEST_TOKEN!); process.send?.({ events }); }
    catch (error) { process.send?.({ error: String(error) }); }
  }
  if (message === 'close') { await inbox.close(); process.exit(0); }
});
