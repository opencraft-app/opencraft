import assert from 'node:assert/strict';
import test from 'node:test';
import { AppHostServer } from '../../packages/app-host-server/src/index';
import { callConversationHost } from '../../scripts/conversation-execution.mjs';

for (const method of ['opencraft/orchestration/status', 'opencraft/orchestration/ack', 'opencraft/orchestration/create', 'thread/read']) {
  test(`Host shutdown retires pending ${method} without replay`, { timeout: 2000 }, async t => {
    const listeners = new Set<(frame: string) => void>();
    let submitted!: () => void;
    const admitted = new Promise<void>(resolve => { submitted = resolve; });
    let operations = 0;
    let lateReply = () => {};
    const host = new AppHostServer({
      logicalClientRouting: true, physicalHostLifetime: 'server',
      createTransport: () => ({
        status: { state: 'open' as const }, connect: async () => {}, close: async () => {},
        subscribeMessage(listener: (frame: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        subscribeStatus: () => () => {},
        async send(frame: string) {
          const value = JSON.parse(frame);
          if (value.id === undefined) return;
          const reply = () => { for (const listener of listeners) listener(JSON.stringify({
            id: value.id, result: {}, __opencraftClient: value.__opencraftClient,
          })); };
          if (value.method === 'initialize') reply();
          else { operations++; lateReply = reply; submitted(); }
        },
      }),
    });
    t.after(() => host.close());
    const pending = callConversationHost(host, { hostId: 'local-codex', threadId: 'child' }, 'durable-operation', method, {}, { sender: null });
    // Attach before shutdown: a synchronous Port close must also be handled.
    const rejected = assert.rejects(pending, /Actor Host closed/);
    await admitted;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => { await host.close(); await rejected; })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Port closure left service request pending')), 500); }),
      ]);
    } finally { clearTimeout(timer); }
    lateReply();
    assert.equal(operations, 1, 'shutdown must never resubmit a mutation with an unknown outcome');
    assert.equal(listeners.size, 0);
  });
}

for (const method of ['prepare','create']) for (const code of [400,403,409,502,503,-32081]) {
  test(`orchestration ${method} preserves rejection or uncertain creation ${code} without retry or error-text disclosure`, async t => {
    const listeners=new Set<(frame:string)=>void>();let operations=0;
    const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createTransport:()=>({
      status:{state:'open' as const},connect:async()=>{},close:async()=>{},
      subscribeMessage(listener:(frame:string)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},subscribeStatus:()=>()=>{},
      async send(frame:string){const m=JSON.parse(frame);if(m.id===undefined)return;
        if(m.method!=='initialize')operations++;
        for(const listener of listeners)listener(JSON.stringify({id:m.id,...(m.method==='initialize'?{result:{}}:{error:{code,message:'PRIVATE_NATIVE_MESSAGE'}}),__opencraftClient:m.__opencraftClient}));},
    })});t.after(()=>host.close());
    await assert.rejects(callConversationHost(host,{hostId:'local-codex',threadId:'source'},'diagnostic-operation','opencraft/orchestration/'+method,{}, {sender:null}),
      (error:any)=>{assert.equal(error.code,code);assert.equal(error.status,method!=='create'&&code>=400&&code<=599?code:undefined);assert.doesNotMatch(error.message,/PRIVATE_NATIVE_MESSAGE/);return true;});
    assert.equal(operations,1);
  });
}
