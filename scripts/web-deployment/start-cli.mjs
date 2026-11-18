#!/usr/bin/env node
// This installed dispatcher deliberately keeps the conversation CLI separate.
const args=process.argv.slice(2);
if(!process.env.OPENCRAFT_THREAD_CLI_CONNECTION&&(!args.length||args[0]==='start')) {
  const {localStartOptions,startLocalService}=await import('./local-start.mjs');
  const {fileURLToPath}=await import('node:url');
  try {
    if(args.includes('--help')||args.includes('-h')){console.log('Usage: opencraft start [--data-dir PATH] [--port PORT] [--no-open]');process.exit(0);}
    const options=localStartOptions(args.length?args.slice(1):[]);
    console.log('[opencraft] Starting the local service. The first start prepares a retained runtime and may take a moment.');
    let service,stopping=false;
    const stop=()=>{if(stopping)return;stopping=true;void ready.then(async()=>{await service?.close();process.exitCode=0;}).catch(()=>{process.exitCode=1;});};
    // Keep signal listeners until the async storage/Agent drain completes.
    // Signal-exit dependencies must not re-emit a signal while cleanup awaits.
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
    const ready=startLocalService({...options,releaseRoot:fileURLToPath(new URL('..',import.meta.url))});
    service=await ready;
    if(stopping){await service.close();}else{
      console.log(`[opencraft] Client: ${service.url}`);
      console.log(`[opencraft] Data: ${service.dataDirectory}`);
      console.log(`[opencraft] Update management key file: ${service.adminKeyPath}`);
      console.log('[opencraft] Updates are checked on the server. Open Settings > Website updates to install a new version.');
      if(!service.browserOpened)console.log('[opencraft] Open the client address in your browser.');
    }
  }catch(error){console.error(`[opencraft] ${error.message}`);process.exitCode=1;}
}else{
  if(!process.env.OPENCRAFT_THREAD_CLI_CONNECTION&&(args.includes('--help')||args.includes('-h')))console.log('Start local service and open the client: opencraft start [--data-dir PATH] [--port PORT] [--no-open]\n');
  const {main}=await import('./opencraft-cli.mjs');await main(args);
}
