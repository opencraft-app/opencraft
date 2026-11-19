import { createServer, request } from 'node:http';
import { chmod, lstat, mkdir, unlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { EmployeeCliKeys, CliKeyRequest } from './cli-keys';

/** A bounded Linux socket path, stable across aliases of the same data directory. */
export async function cliKeyOperatorDirectory(directory: string) {
  return join('/run','opencraft-cli-key-'+createHash('sha256').update(await realpath(directory)).digest('hex').slice(0,32));
}

/** Root-only local operations; the running SSH owner is the sole database writer. */
export async function startCliKeyOperator(directory: string, keys: EmployeeCliKeys) {
  if (process.getuid?.() !== 0) return { close: async () => {} };
  const root = await cliKeyOperatorDirectory(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077)) throw Error('unsafe_cli_operator_directory');
  const socket = join(root,'control.sock');
  // A live old handling generation keeps ownership until retired. Do not unlink its socket.
  try {
    const info = await lstat(socket);
    if (!info.isSocket() || info.uid !== 0) throw Error('unsafe_cli_operator_socket');
    const alive = await new Promise<boolean>((resolve,reject) => {
      const req = request({ socketPath: socket, path:'/health', timeout:1000 }, res => { res.resume();resolve(true); });
      req.on('error',(error:NodeJS.ErrnoException)=>['ECONNREFUSED','ENOENT'].includes(error.code??'')?resolve(false):reject(error)); req.on('timeout',()=>{resolve(true);req.destroy();}); req.end();
    });
    if (alive) throw Error('cli_operator_already_running');
    await unlink(socket);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const server = createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.method==='GET' && req.url==='/health'){res.end('{"ok":true}');return;}
    if(req.method!=='POST'||req.url!=='/cli-key'){res.writeHead(404);res.end('{}');return;}
    let body='';
    req.setTimeout(5000,()=>req.destroy());
    req.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>20000)req.destroy();});
    req.on('end',()=>{
      try {
        const input: unknown=JSON.parse(body);
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['action','employee','name','publicKey','keyId'].includes(k)))throw Error('invalid_request');
        res.end(JSON.stringify({ok:true,...keys.manage(input as CliKeyRequest,'local-root:uid=0')}));
      }catch(error){res.writeHead(400);res.end(JSON.stringify({error:error instanceof Error&&/^[a-z_]+$/u.test(error.message)?error.message:'invalid_request'}));}
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,()=>resolve());});
  await chmod(socket,0o600);
  return { close:()=>new Promise<void>((resolve,reject)=>server.close(error=>{if(error)reject(error);else resolve();})) };
}
