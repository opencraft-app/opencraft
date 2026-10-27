import React,{useState} from 'react';
import {createComposerController} from '@opencraft/composer-core';
import {createConversationKey} from '@opencraft/chat-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {compileSubmitIntent} from '@opencraft/composer-appserver';
import {ConversationReferenceSurface} from '../../apps/workbench-web/src/components/conversation-reference-surface';
import {ThreadRowMenu,useThreadActionOwner} from '../../apps/workbench-web/src/components/thread-management';
import {copyConversationReference} from '../../apps/workbench-web/src/runtime/conversation-reference-actions';
import {initializeAppearanceTheme,setThemePreference} from '../../apps/workbench-web/src/appearance-theme';
import {createIntlTestRoot} from './intl-root';
import '../../apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();setThemePreference(new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light');
const controller=createComposerController({type:'existing-thread',key:createConversationKey('fixture','fixture-thread-1')},{now:Date.now,createId:()=>crypto.randomUUID()});
let held=false,reject=false;
const command=async(body:Record<string,unknown>)=>{if(held&&body.action==='send')await new Promise(r=>setTimeout(r,150));if(reject&&body.action==='send')throw Error('offline');const r=await fetch('/fixture/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('denied');return r.json();};
const catalog:any={agentRuntimes:{request:(_id:string,_method:string,body:any)=>command(body)},threadManagement:{capabilities:()=>({reference:true})},navigate:async(location:any)=>{(window as any).navigated=location;return true;}};
function App(){
 const[kind,setKind]=useState<'context'|'dropdown'|null>(null);
 const owner=useThreadActionOwner({onCopyReference:target=>copyConversationReference(command,location.href,target),onRename:async()=>{},onFork:async()=>{},onArchive:async()=>{},onDelete:async()=>{}});
 Object.assign(window,{fixture:{controller,hold(value:boolean){held=value;},offline(value:boolean){reject=value;},prompt(){return compileSubmitIntent(controller.createSubmitIntent());}}});
 return <ConversationReferenceSurface catalog={catalog} hostId='fixture'><main style={{maxWidth:700,margin:'40px auto',padding:16}}>
 <ThreadRowMenu target={{hostId:'fixture',threadId:'fixture-fork-1',title:'Target conversation'}} capabilities={{reference:true,rename:false,fork:false,archive:false,delete:false}} owner={owner} openMenuKind={kind} onOpenMenuChange={(next,open)=>setKind(open?next:null)}><button>Target conversation</button></ThreadRowMenu>
 <OpenCraftComposer controller={controller} catalog={{search:async()=>[]}} onSubmit={()=>false} onCancel={()=>{}} />
 <a href='opencraft://conversation/v1/fixture/fixture-fork-1'>Saved conversation reference</a>
 </main></ConversationReferenceSurface>;
}
createIntlTestRoot(document.getElementById('root')!).render(<App/>);
