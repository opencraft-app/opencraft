import { avatarProfiles } from './plugins/tencentoa/src/avatar-profiles.mjs';
import './plugins/wecom/assistant-install.mjs';
import { join } from 'node:path';
import { readPrivateJson } from '../../packages/identity-core/src/node.ts';
import { deploymentPaths } from '../../scripts/container-deployment/paths.mjs';
import { startContainerGateway } from '../../scripts/container-deployment/gateway-application.mjs';
import { createMirrorTarget, withWeComDirectory } from './plugins/wecom/mirror/target.mjs';
import { createAutomaticMirrorTarget } from './plugins/wecom/mirror/automatic-target.mjs';
import { createWeComChannelTransport } from './plugins/wecom/channel-transport.mjs';
import { joinIdentityComposition } from './identity.mjs';
import {createHandsPluginSource} from './runtime-plugins/hands-source.mjs';
import {runtimePluginDirectory} from './runtime-plugins/host.mjs';
// Explicit utility modes are platform tools; they never start Gateway/Hands core owners.
if(process.argv[2]==='--runtime-plugin-executor') {
  const {main}=await import('./runtime-plugins/executor.mjs');await main(process.argv.slice(3));
}else if(process.argv[2]==='--runtime-plugin-admin') {
  const {main}=await import('./runtime-plugins/install.mjs');console.log(JSON.stringify(await main(process.argv.slice(3))));
}else await startJoinGateway();

async function startJoinGateway() {
const profiles = avatarProfiles(deploymentPaths().dataDirectory);
const transport = config => createWeComChannelTransport(config, {
  onSenderProfile: ({source,id,name}) => profiles.observeDirectory(source,id,name),
});
let config;
try { config = await readPrivateJson(join(deploymentPaths().dataDirectory, 'wecom-channel-sync.json')); }
catch (error) {
  if (error?.code !== 'ENOENT') throw new Error('Invalid private WeCom channel sync configuration');
}
let mirror;
try { mirror=await readPrivateJson(join(deploymentPaths().dataDirectory,'wecom-mirror-target.json')); }
catch(error) { if(error?.code!=='ENOENT')throw new Error('Invalid private WeCom mirror target'); }
if(mirror&&config)throw new Error('Choose one WeCom message ingress owner');
let directory;
try { directory=await readPrivateJson(join(deploymentPaths().dataDirectory,'wecom-directory-target.json')); }
catch(error) {if(error?.code!=='ENOENT')throw new Error('Invalid private WeCom directory target');}
if(directory&&(mirror||!config||directory.corpId!==config.corpId))throw new Error('WeCom directory target requires the matching existing channel transport');
const {existsSync}=await import('node:fs');
if(!mirror&&!config&&existsSync(join(deploymentPaths().dataDirectory,'wecom-shadow-groups.json')))
  throw new Error('Replace retired WeCom shadow configuration with explicit native group bindings');
const { prepareDirectoryIdentity, resolveNativeMemberRtx, ...identity } = joinIdentityComposition({pluginSourceFactory:dataDirectory=>{
  const paths=deploymentPaths();
  return createHandsPluginSource({root:process.env.OPENCRAFT_RUNTIME_PLUGIN_VFS_DIRECTORY??runtimePluginDirectory(dataDirectory),
    endpoint:paths.fileSystemEndpoint,tokenFile:paths.fileSystemToken});
}});
await startContainerGateway({ ...identity,
  ...(mirror?{createChannelSync:dependencies=>createMirrorTarget(mirror,{...dependencies,prepareDirectoryIdentity,resolveNativeMemberRtx})}:directory
    ?{createChannelSync:dependencies=>withWeComDirectory(transport(config),directory,dependencies)}
    :config?{channelSync:transport(config)}:process.env.JOIN_WECOM_AUTOMATIC_RECEIVER==='0'?{}
      :{createChannelSync:dependencies=>createAutomaticMirrorTarget({dataDirectory:deploymentPaths().dataDirectory,
        relayConnectFile:process.argv.includes('--relay-connect-file')?process.argv[process.argv.indexOf('--relay-connect-file')+1]:undefined},
      {...dependencies,prepareDirectoryIdentity,resolveNativeMemberRtx})}),
});

}
