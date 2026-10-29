import { startHeadlessServer } from '../../scripts/headless-application.mjs';
import { WebSocketTransport } from '../../packages/appserver-transport-websocket/src/index.ts';
import { WebSocket } from 'ws';
const config = JSON.parse(process.argv[2]);
try {
  const app = await startHeadlessServer({ ...config, createCodexTransport:()=>new WebSocketTransport({url:config.nativeUrl,createSocket:url=>new WebSocket(url)}),
    startAgentHost: async () => ({websocketUrl:config.nativeUrl,close:async()=>{}}) });
  process.send({url:app.url,pid:process.pid});
  process.once('SIGTERM',async()=>{try{await app.close({updateId:'test-update',buildId:'test-build'});process.exit(0);}catch{process.exit(1);}});
} catch (error) { process.send({error:error.message});process.exit(1); }
