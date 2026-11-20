import { createRoot } from 'react-dom/client';
import { createComposerController } from '@opencraft/composer-core';
import { createConversationKey } from '@opencraft/chat-core';
import { BrowserAnnotationSinkProvider } from '../../../apps/workbench-web/src/browser-annotation/composer-sink';
import { useBrowserAnnotation } from '../../../apps/workbench-web/src/browser-annotation/use-browser-annotation';
import type { BrowserAnnotator, BrowserAnnotationPick, BrowserAnnotationPointerHandlers } from '@opencraft/browser-core';
const target=(id:string)=>({type:'existing-thread' as const,key:createConversationKey('local',id)});
const composer=createComposerController(target('a'), {now: () => Date.now(), createId: () => crypto.randomUUID()});
let handlers: BrowserAnnotationPointerHandlers | null=null;
const anchor={kind:'element' as const,bindingKey:'doc:1',ref:'e1',selector:'#target',url:'https://example.test',title:'Example',revision:1,elementPath:'button',tag:'button',role:null,name:null,text:'Target',nearbyText:null,childCount:0,sensitive:false,rect:{x:100,y:0,width:200,height:200},isFixed:false,source:null,frame:'main' as const};
const pick:BrowserAnnotationPick={anchor,depth:0,maxDepth:0,viewport:{left:.25,right:.75,top:0,bottom:1}};
const state={controller:null as ReturnType<typeof useBrowserAnnotation>|null,captures:0,hold:false,release:()=>{},composer,
 tap:()=>handlers?.tap({x:150,y:100,frameWidth:400,frameHeight:200},'mouse'),switch:()=>composer.dispatch({type:'switch-target',target:target('b')})};
const annotator:BrowserAnnotator={pick:async()=>pick,mark:async()=>{},intercept:h=>{handlers=h;return()=>{handlers=null}},capture:async()=>{
 state.captures++;if(state.hold)await new Promise<void>(r=>{state.release=r});
 const c=document.createElement('canvas');c.width=400;c.height=200;const x=c.getContext('2d')!;x.fillStyle='red';x.fillRect(0,0,400,200);x.fillStyle='blue';x.fillRect(100,0,200,200);
 const blob=await new Promise<Blob>(r=>c.toBlob(b=>r(b!)));return new Promise<string>(r=>{const f=new FileReader();f.onload=()=>r(String(f.result));f.readAsDataURL(blob)});
}};
function App(){state.controller=useBrowserAnnotation({annotator,tabId:'tab',url:anchor.url,blocked:false,surface:'browser'});return null;}
(window as any).draftTest=state;
createRoot(document.body.appendChild(document.createElement('div'))).render(<BrowserAnnotationSinkProvider controller={composer}><App/></BrowserAnnotationSinkProvider>);
