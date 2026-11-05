import React from 'react';
import {createIntlTestRoot} from './intl-root';
import {initializeAppearanceTheme} from '../../apps/workbench-web/src/appearance-theme';
import {LocalAgentSettingsService,type HostProtocolRequest} from '../../plugins/builtin-agents/src/local-agent-settings-service';
import {ModelServicesController} from '../../plugins/builtin-agents/src/model-services/controller';
import {createModelServicesView} from '../../plugins/builtin-agents/src/model-services/view';
import '../../apps/workbench-web/src/styles/app.scss';
import '../../apps/workbench-web/src/styles/settings-page.scss';
initializeAppearanceTheme();
const calls: {method:string;params:any}[]=[];let revision=4;
let config:any={baseURL:'https://provider.invalid/v1',api:'openai-responses',apiKeyEnv:'FIXTURE_KEY',models:[{id:'vendor/flash',contextWindow:262144,maxTokens:4096,input:['text','image'],reasoningEfforts:{medium:'medium',high:'high'}}]};
const provider={provider:'fixture',displayName:'模型能力测试',settingsNs:'llm-pi-ai',settingsPath:['providers','fixture'],active:true,configured:true,declared:true,enabled:true,configuration:{modelDeclarations:true,apis:['openai-responses'],canCheckSaved:true,canInspectSaved:true}};
const request=(async(_host:string,method:string,params:any)=>{
 calls.push({method,params});
 if(method==='runtime/settings/describe')return {writable:true,namespaces:[{ns:'llm-pi-ai',revision,value:{providers:{fixture:config}}}]};
 if(method==='runtime/providers/list')return {providers:[provider]};
 if(method==='runtime/models/list')return {groups:[{id:'fixture',models:config.models.map((m:any)=>({...m,name:'Flash 测试模型'}))}]};
 if(method==='runtime/credentials/describe')return {credentials:{FIXTURE_KEY:{configured:true}}};
 if(method==='runtime/models/inspect')return {model:params.model,revision:params.expectedRevision,checkedAt:new Date().toISOString(),capabilities:{contextWindow:1048576,maxTokens:393216,input:['text','image'],reasoningEfforts:{low:'low',high:'high',max:'max'}},sources:{contextWindow:'models.dev · 原厂参考，部署上限可能不同',maxTokens:'models.dev · 原厂参考，部署上限可能不同',input:'当前接口 · 合成图片验证',reasoningEfforts:'当前接口 · 参数接受测试（非强度证明）'},checks:params.mode==='verify'?[{kind:'image',status:'verified',detail:'合成测试通过'},{kind:'reasoning',effort:'high',status:'accepted',detail:'参数被接受；不证明档位强度差异'}]:[],notes:[]};
 if(method==='runtime/providers/apply'){if(params.expectedRevision!==revision)throw Error('settings-conflict');config={...config,...params,models:params.models??config.models};revision++;return {saved:true,revision};}
 return {};
})as HostProtocolRequest;
const service=new LocalAgentSettingsService(request,'fixture');await service.refresh();const controller=new ModelServicesController(service);controller.select('fixture');const View=createModelServicesView(controller);
Object.assign(window,{modelCapabilityProof:{calls,controller,service}});
createIntlTestRoot(document.getElementById('root')!,undefined,'zh-CN').render(<View {...{} as any}/>);
