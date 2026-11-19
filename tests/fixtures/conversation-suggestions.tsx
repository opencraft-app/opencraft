import React from 'react';
import {createComposerController} from '@opencraft/composer-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {compileSubmitIntent} from '@opencraft/composer-appserver';
import {ConversationReferenceSurface} from '../../apps/workbench-web/src/components/conversation-reference-surface';
import {createIntlTestRoot} from './intl-root';
import {initializeAppearanceTheme,setThemePreference} from '../../apps/workbench-web/src/appearance-theme';
import '../../apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();setThemePreference(new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light');
const controller=createComposerController({type:'existing-thread',key:{hostId:'fixture',threadId:'current'}},{now:Date.now,createId:()=>crypto.randomUUID()});
const requests:any[]=[];let holdFiles=true,holdRefs=false;const pending:(()=>void)[]=[];
const catalog:any={agentRuntimes:{async request(host:string,_method:string,body:any){
 requests.push({host,...body});
 if(holdRefs)await new Promise<void>(resolve=>pending.push(resolve));
 if(body.action==='read'){if(body.bounded!==true)throw Error('Unbounded preview');return {history:{entries:[{turnId:'turn',itemId:'item',role:'assistant',text:'Bounded preview',offset:0}],nextCursor:null,truncated:false}};}
 if(body.action!=='discover')throw Error('Unexpected send');
 return {conversations:Array.from({length:body.limit},(_,i)=>({ref:{serverId:'fixture',threadId:'target-'+body.search+'-'+i},title:body.search ? body.search+' 会话 '+i : '最近会话 '+i,cwd:'/work/project',updatedAt:1700000000})),nextCursor:null};
}},threadManagement:{capabilities:()=>({reference:true})}};
const files={async search(q:any){requests.push({action:'files',query:q.query});if(holdFiles)await new Promise<void>(resolve=>pending.push(resolve));return [{id:'file',kind:'mention' as const,label:'example.ts',uri:'file:///example.ts'}];}};
Object.assign(window,{fixture:{requests,controller,holdRefs:(value:boolean)=>{holdRefs=value;},release:()=>{holdFiles=false;holdRefs=false;pending.splice(0).forEach(f=>f());},prompt:()=>compileSubmitIntent(controller.createSubmitIntent())}});
createIntlTestRoot(document.getElementById('root')!,undefined,new URLSearchParams(location.search).get('locale')??'en-US').render(
 <ConversationReferenceSurface catalog={catalog} hostId='fixture'><main style={{padding:'280px 16px 20px',maxWidth:700,margin:'auto'}}>
 <OpenCraftComposer controller={controller} catalog={files} onSubmit={()=>false} onCancel={()=>{}}/>
 </main></ConversationReferenceSurface>);
