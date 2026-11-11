/** Lifecycle hook: inject requested steps; the Host verifies native SQLite separately. */
import { request } from 'node:http';
const socketPath = process.env.AGY_ACP_STEER_IPC;
const event = process.argv[2] === 'post' ? 'post' : 'pre';
let output: unknown = {};
try {
  if (socketPath) {
    let body = '';
    for await (const chunk of process.stdin) { body += chunk; if (Buffer.byteLength(body)>16384) throw Error('oversize'); }
    const result = await new Promise<any>((resolve,reject) => {
      const req = request({ socketPath, method:'POST', path:`/claim?event=${event}`,
        headers:{'content-type':'application/json','x-agy-acp-owner':process.env.AGY_ACP_STEER_OWNER ?? ''} }, res => {
        let data = ''; res.on('data',chunk => { data += chunk; if (Buffer.byteLength(data)>512*1024) req.destroy(Error('oversize')); });
        res.on('error',reject); res.on('end',() => {
          try { if (res.statusCode !== 200) throw Error('rejected'); resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      req.on('error',reject); req.setTimeout(2000,()=>req.destroy(Error('timeout'))); req.end(body);
    });
    const injectSteps = (Array.isArray(result.messages) ? result.messages : [])
      .filter((m: any) => typeof m.text === 'string').map((m: any) => ({userMessage:m.text}));
    if (injectSteps.length) output = {injectSteps,...(event === 'post' ? {terminationBehavior:'force_continue'} : {})};
  }
} catch { /* no hook output is ever a delivery receipt */ }
process.stdout.write(JSON.stringify(output)+'\n');
