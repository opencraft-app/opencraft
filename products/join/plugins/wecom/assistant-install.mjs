import {appendFileSync,statSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {deploymentPaths} from '../../../../scripts/container-deployment/paths.mjs';
import {scopedProviderQuery,resolveProviderRead} from './provider-query.mjs';
import { installCommunicationExtension } from '../../../../packages/access-control/src/communication-extension.ts';
import { communicationExtension } from './assistant-extension.mjs';
installCommunicationExtension(communicationExtension,new URL('./assistant-extension.mjs',import.meta.url).href);
import { installAssistantHostExtension } from '../../../../apps/personal-assistant/src/runtime/host-extension.mjs';
installAssistantHostExtension({
  entryURL:new URL('./assistant-server.mjs',import.meta.url),
  reportFailure(error){
    const root=deploymentPaths().dataDirectory,file=join(root,'join-wecom-host-failures.log');
    mkdirSync(root,{recursive:true,mode:0o700});
    if((statSync(file,{throwIfNoEntry:false})?.size??0)>1048576)renameSync(file,file+'.1');
    appendFileSync(file,JSON.stringify({at:new Date().toISOString(),event:'assistant-startup-failed',error:String(error?.message??error).replace(/\s+/gu,' ').slice(0,200)})+'\n',{mode:0o600});
  },
  request(service,context,method,params){
    if(method==='join/wecom-assistant/provider-query')return {result:scopedProviderQuery(service,context,params.scope,params.query)};
    if(method==='opencraft/personal-assistant/threads/command'&&params.argv?.[0]==='wecom')return {result:Promise.resolve(service.communicate(context,'join/wecom-cli/command',{argv:params.argv.slice(1)})).then(r=>resolveProviderRead(service,context,r))};
    if(['scopes','authorize','messages','history','image','search','activity','reply','file','chat','edit','cli','edit-results','edit-result-ack'].some(op=>method==='join/wecom-assistant/'+op))
      return {result:Promise.resolve(service.communicate(context,method,params)).then(r=>method.endsWith('/cli')?resolveProviderRead(service,context,r):r)};
  },
});
