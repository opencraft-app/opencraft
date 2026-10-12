import {loadConfig} from './config.js';
import {buildApp} from './app.js';
const c=loadConfig();const {app}=await buildApp(c);
await app.listen({host:c.host,port:c.port});
console.log(`Vela identity service ready: http://${c.host}:${c.port}; SDKAppID=${c.appId}; demo=${c.demoMode}`);
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{void app.close().then(()=>process.exit(0))});
