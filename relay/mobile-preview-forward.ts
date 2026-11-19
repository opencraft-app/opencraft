import { request, type Server } from 'node:http';
/** Preserve the product's read-only preview handler beside its existing Metro owner. */
export function installMobilePreviewForward(server: Server, upstream: string) {
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Invalid mobile preview upstream');
  const listeners = server.listeners('request'); server.removeAllListeners('request');
  const allowed = new Set(['host','x-forwarded-proto','accept','accept-encoding','expo-platform','expo-protocol-version','expo-runtime-version','expo-expect-signature','expo-json-error']);
  server.on('request', (req, res) => {
    if (req.url !== '/mobile' && !req.url?.startsWith('/mobile/')) { for (const handler of listeners) handler.call(server, req, res); return; }
    const fail = () => { if (res.headersSent) res.destroy(); else {res.writeHead(503, {'cache-control':'no-store'});res.end();} };
    const remote = request(target, {method:req.method,path:req.url,headers:Object.fromEntries(Object.entries(req.headers).filter(([key])=>allowed.has(key)))}, incoming => {
      const headers={...incoming.headers};delete headers['set-cookie'];res.writeHead(incoming.statusCode??502,headers);incoming.on('error',fail);incoming.pipe(res);
    });
    remote.setTimeout(30_000,()=>remote.destroy());remote.on('error',fail);req.once('aborted',()=>remote.destroy());res.once('close',()=>remote.destroy());req.pipe(remote);
  });
}
