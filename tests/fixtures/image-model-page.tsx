import React from 'react';
import {createIntlTestRoot} from './intl-root';
import {initializeAppearanceTheme} from '../../apps/workbench-web/src/appearance-theme';
import {LocalAgentSettingsService,type HostProtocolRequest} from '../../plugins/builtin-agents/src/local-agent-settings-service';
import {ModelServicesController} from '../../plugins/builtin-agents/src/model-services/controller';
import {createModelServicesView} from '../../plugins/builtin-agents/src/model-services/view';
import '../../apps/workbench-web/src/styles/app.scss';
import '../../apps/workbench-web/src/styles/settings-page.scss';
initializeAppearanceTheme();
let revision=3,defaultModel:any=null;
const calls:any[]=[];
let config:any={baseURL:'https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation',api:'hunyuan-image-v35',apiKeyEnv:'IMAGE_FIXTURE',models:[{id:'ep-fixture',name:'混元 Image v3.5',type:'image'}]};
const provider={provider:'image-fixture',displayName:'混元图像生成',settingsNs:'image-generation',settingsPath:['providers','image-fixture'],active:true,configured:true,declared:true,enabled:true,configuration:{modelDeclarations:true,modelType:'image',apis:['hunyuan-image-v35'],canToggle:true,canCheckSaved:false,canInspectSaved:false}};
const request=(async(_host:string,method:string,params:any)=>{
 calls.push({method,params});
 if(method==='runtime/settings/describe')return{writable:true,namespaces:[{ns:'llm-pi-ai',revision:55,value:{}},{ns:'agent-default-model',revision:55,value:{provider:'thinking-provider',model:'thinking-model'}},{ns:'image-generation',revision,value:{defaultModel,providers:{'image-fixture':config}}}]};
 if(method==='runtime/providers/list')return{providers:[provider],creation:{kind:'openai-compatible',revision:55,apis:['openai-responses'],image:{api:'hunyuan-image-v35',baseURL:config.baseURL,model:'ep-fixture',revision}}};
 if(method==='runtime/models/list')return{groups:[{id:'image-fixture',models:config.models.map((m:any)=>({...m,enabled:true}))}]};
 if(method==='runtime/credentials/describe')return{credentials:{IMAGE_FIXTURE:{configured:true}}};
 if(method==='runtime/settings/mutate'){if(params.ns!=='image-generation'||params.expectedRevision!==revision)throw Error('wrong namespace or revision');defaultModel=params.ops[0].value;revision++;return{};}
 if(method==='runtime/providers/apply'){if(params.expectedRevision!==revision)throw Error('settings-conflict');config={...config,...params,models:params.models??config.models};revision++;return{saved:true,revision};}
 return{};
})as HostProtocolRequest;
const service=new LocalAgentSettingsService(request,'fixture');await service.refresh();const controller=new ModelServicesController(service);controller.select('image-fixture');const View=createModelServicesView(controller);
Object.assign(window,{imageModelProof:{calls,controller,service}});
createIntlTestRoot(document.getElementById('root')!,undefined,'zh-CN').render(<View {...{}as any}/>);
