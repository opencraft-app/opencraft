import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {join,resolve,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir,readFile} from 'node:fs/promises';
import {atomicJson} from '../full-upgrade/durable.mjs';
import {createManagedWebServer} from './server.mjs';
import {assertLocalServiceRuntime} from './local-service-profile.mjs';
import {connectRelay} from '../../plugins/relay-connect/src/server.ts';
import {createLocalIngress} from '../../packages/hub-network/src/local-ingress.ts';
import {MACHINE_ENROLLMENT_PATHS} from '../../packages/relay-protocol/src/index.ts';

export function localStartOptions(argv,env=process.env,home=homedir()) {
  const options={dataDirectory:resolve(env.OPENCRAFT_HOME||join(home,'.opencraft')),port:Number(env.OPENCRAFT_WEB_PORT||10000),open:true};
  const seen=new Set();
  for(let i=0;i<argv.length;i++) {
    const flag=argv[i];if(seen.has(flag))throw new Error('Do not repeat startup options');seen.add(flag);
    if(flag==='--no-open')options.open=false;
    else if(flag==='--data-dir'||flag==='--port') {
      const value=argv[++i];if(!value||value.startsWith('--'))throw new Error('Startup option needs a value');
      if(flag==='--data-dir')options.dataDirectory=resolve(value);else if(/^\d+$/u.test(value))options.port=Number(value);else throw new Error('Invalid port');
    } else throw new Error('Use start [--data-dir PATH] [--port PORT] [--no-open]');
  }
  if(!Number.isSafeInteger(options.port)||options.port<0||options.port>65535)throw new Error('Invalid port');
  return options;
}
export async function openLocalClient(url,platform=process.platform,run=promisify(execFile)) {
  const target=new URL(url);if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.username||target.password)throw new Error('Invalid local client URL');
  if(platform==='darwin')await run('/usr/bin/open',[target.href],{timeout:10000});
  else if(platform==='win32')await run('rundll32.exe',['url.dll,FileProtocolHandler',target.href],{timeout:10000,windowsHide:true});
  else await run('xdg-open',[target.href],{timeout:10000});
}

/** Only the pinned, committed release supplies code. All mutable data belongs
 * to the stable product home and the existing Host/storage owners. */
export async function startLocalService({releaseRoot,dataDirectory,port=10000,open=true,env=process.env},
  {loadRuntime=async root=>import(pathToFileURL(join(root,'execution/local-agent-host.mjs')).href),createWebServer=createManagedWebServer,openClient=openLocalClient}={}) {
  const data=resolve(dataDirectory),state=join(data,'web');
  const initial=resolve(releaseRoot),inside=relative(initial,data);
  if(!inside||!inside.startsWith('..'+sep)&&inside!=='..'&&!inside.startsWith(sep))throw new Error('Keep service data outside the installed program');
  const manifest=JSON.parse(await readFile(join(initial,'package.json'),'utf8'));
  if(manifest.opencraftLocalService?.schemaVersion!==1)throw new Error('This package contains the website only. Install the complete local-service distribution.');
  assertLocalServiceRuntime(manifest);
  let host,releaseStorage,activeRoot,app,closing,machineRelay,relayIngress;
  const owner={
    async start(release) {
      const pinPath=join(state,'local-runtime.json');
      let pin;
      try{pin=JSON.parse(await readFile(pinPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('Local runtime pin is unreadable; preserve the existing data and inspect it.');}
      const runtimeRoot=pin?pin.releaseRoot:release.releaseRoot;
      if(typeof runtimeRoot!=='string'||!resolve(runtimeRoot).startsWith(join(state,'releases')+sep))throw new Error('Invalid retained local runtime');
      const installed=JSON.parse(await readFile(join(runtimeRoot,'package.json'),'utf8'));
      assertLocalServiceRuntime(installed);
      if(typeof installed.version!=='string'||typeof installed.opencraftWeb?.buildId!=='string'
        ||pin&&(pin.schemaVersion!==1||pin.version!==installed.version||pin.buildId!==installed.opencraftWeb.buildId))throw new Error('Retained local runtime identity changed');
      const runtime=await loadRuntime(runtimeRoot);
      await mkdir(data,{recursive:true,mode:0o700});
      releaseStorage=await runtime.acquireLocalAgentStorageOwner(data);
      if(!pin){
        await mkdir(state,{recursive:true,mode:0o700});
        await atomicJson(pinPath,{schemaVersion:1,releaseRoot:runtimeRoot,version:installed.version,buildId:installed.opencraftWeb.buildId});
      }
      const workspace=join(data,'workspaces');await mkdir(workspace,{recursive:true});
      let relayConfig;
      try {
        const input=JSON.parse(await readFile(join(data,'machine-relay.json'),'utf8'));
        if(input&&input.schemaVersion===1&&typeof input.origin==='string'&&new URL(input.origin).protocol==='https:'&&new URL(input.origin).origin===input.origin&&typeof input.credential==='string'&&/^[A-Za-z0-9_-]{43}$/u.test(input.credential)){
          relayConfig=input;
        }
      } catch(error) {if(error.code!=='ENOENT')throw error;}
      host=await runtime.startLocalAgentHost({
        ...(relayConfig?{personalMachines:{enrollmentOrigin:relayConfig.origin,enrollmentCa:relayConfig.ca,archive:join(runtimeRoot,'README.md'),digest:'0'.repeat(64),installer:join(runtimeRoot,'README.md')}} : {}),
        dataDirectory:data,modelStorageDirectory:join(data,'models'),runtimeDirectory:runtimeRoot,projectlessWorkspaceDirectory:workspace,
        dshExecutable:join(runtimeRoot,'local-runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'),
        dshCapabilityPlugin:join(runtimeRoot,'execution/dsh-capability-plugin.mjs'),
        connectedAgentAssets:{proxy:join(runtimeRoot,'runtime/codebuddy-ide/acp-proxy.mjs'),extension:join(runtimeRoot,'runtime/codebuddy-ide/bridge.vsix')}});
      if(relayConfig){
        relayIngress=createLocalIngress(()=>({port:Number(new URL(host.websocketUrl).port),origin:relayConfig.origin}),MACHINE_ENROLLMENT_PATHS);
        machineRelay=connectRelay({relay:relayConfig.origin,credential:relayConfig.credential,ca:relayConfig.ca,machineGateway:true,acceptStream:stream=>relayIngress.accept(stream)});
      }
      activeRoot=runtimeRoot;return host.websocketUrl;
    },
    referencedRoots(){return activeRoot?[activeRoot]:[];},
  };
  const close=()=>closing??=(async()=>{
    machineRelay?.close();relayIngress?.close();
    let failure;try{await app?.close();}catch(error){failure=error;}
    // Do not release the storage claim when Host cleanup is unconfirmed.
    await host?.close();await releaseStorage?.();if(failure)throw failure;
  })();
  try {
    app=await createWebServer({initialRelease:initial,stateDirectory:state,appServerOwner:owner,
      registry:env.OPENCRAFT_NPM_REGISTRY,channel:env.OPENCRAFT_UPDATE_CHANNEL??manifest.opencraftLocalService.updateChannel??`local-${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}`,userconfig:env.OPENCRAFT_NPM_USERCONFIG,
      ...(env.OPENCRAFT_UPDATE_CHECK_INTERVAL_MS===undefined?{}:{updateCheckIntervalMs:Number(env.OPENCRAFT_UPDATE_CHECK_INTERVAL_MS)})});
    const address=await app.listen({host:'127.0.0.1',port});const url=`http://127.0.0.1:${address.port}/`;
    let browserOpened=false;if(open){try{await openClient(url);browserOpened=true;}catch{/* A headless terminal can use the printed address. */}}
    return {url,dataDirectory:data,webState:state,adminKeyPath:app.adminKeyPath,browserOpened,close};
  } catch(error){await close();throw error;}
}
