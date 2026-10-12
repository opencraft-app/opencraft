import {startWorker} from './worker.ts';

const env=process.env;
const apiURL=env.VELA_API_URL??'',credentialFile=env.VELA_BOT_CREDENTIAL_FILE??'',dir=env.VELA_WORKER_DIR??'';
if(!apiURL||!credentialFile||!dir){console.error('VELA_API_URL, VELA_BOT_CREDENTIAL_FILE and VELA_WORKER_DIR are required');process.exit(64)}
const parentPID=Number(env.VELA_WORKER_PARENT_PID)||undefined;
// lite-chat fires internal follow-up requests (e.g. group profile after being removed) without catching them.
process.on('unhandledRejection',reason=>console.error(new Date().toISOString(),'[vela-worker] SDK background error:',(reason as any)?.message??reason));
const worker=await startWorker({
 apiURL,credentialFile,dir,socketPath:env.VELA_WORKER_SOCKET||undefined,fileRoot:env.VELA_FILE_ROOT||undefined,parentPID,
});
for(const signal of ['SIGTERM','SIGINT','SIGHUP'] as const)process.on(signal,()=>{void worker.close().then(()=>process.exit(0))});
