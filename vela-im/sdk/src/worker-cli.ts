import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {startWorker} from './worker.ts';

const env=process.env;
const apiURL=env.VELA_API_URL??'',token=env.VELA_IDENTITY_TOKEN??'';
if(!apiURL||!token){console.error('VELA_API_URL and VELA_IDENTITY_TOKEN are required');process.exit(64)}
const dir=env.VELA_WORKER_DIR||join(homedir(),'.vela-im',createHash('sha256').update(token).digest('hex').slice(0,16));
const parentPID=Number(env.VELA_WORKER_PARENT_PID)||undefined;
// lite-chat fires internal follow-up requests (e.g. group profile after being removed) without catching them.
process.on('unhandledRejection',reason=>console.error(new Date().toISOString(),'[vela-worker] SDK background error:',(reason as any)?.message??reason));
const worker=await startWorker({apiURL,token,dir,fileRoot:env.VELA_FILE_ROOT||undefined,parentPID});
for(const signal of ['SIGTERM','SIGINT','SIGHUP'] as const)process.on(signal,()=>{void worker.close().then(()=>process.exit(0))});
