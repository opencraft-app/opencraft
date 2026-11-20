import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CompanionAvatar } from '../../packages/design-system-web/src/companion-avatar';
import { companionKinds, type CompanionKind } from '../../packages/design-system/src/companion-artwork';
import type { CompanionActivity } from '../../packages/design-system/src/companion-motion';
import { initializeAppearanceTheme, setThemePreference, setAppearanceThemeId, frostThemeId } from '../../apps/workbench-web/src/appearance-theme';
import '../../apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const names = ['豆子 · 轻摆','芽苗 · 摇头','团子 · 呼吸','小灯 · 点头','云朵 · 漂浮','星星 · 倾转'];
function Gallery() {
 const [selected,setSelected]=useState<CompanionKind>('bean'),[activity,setActivity]=useState<CompanionActivity>('working'),[crowd,setCrowd]=useState(false),[mounted,setMounted]=useState(true);
 (window as any).companionTest={setSelected,setActivity,setCrowd,setMounted,theme:(theme:string)=>{setThemePreference(theme==='dark'?'dark':'light');if(theme==='frost')setAppearanceThemeId(frostThemeId);}};
 return <main style={{maxWidth:960,margin:'auto',padding:24,height:'100dvh',overflow:'auto',boxSizing:'border-box'}}>
  <h1>有个小伙伴，正在认真想。</h1><p>同一个身份，六种动作。页面统一分配动画预算。</p>
  <div style={{display:'flex',gap:12,marginBlock:24}}>{(['rest','working','waiting'] as const).map((a,i)=><button key={a} onClick={()=>setActivity(a)}>{['安静','正在回复','等待'][i]}</button>)}<button onClick={()=>setCrowd(!crowd)}>200 个头像压力场景</button></div>
  {mounted&&<><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:20}}>{companionKinds.map((kind,i)=><button key={kind} data-kind={kind} onClick={()=>setSelected(kind)} style={{display:'grid',gap:20,placeItems:'center',padding:24,border:'1px solid var(--color-border-subtle)',borderRadius:20,background:'var(--color-background-panel)',color:'var(--color-text)'}}>
   <CompanionAvatar id={'gallery-'+kind} identity={{version:1,kind,palette:(['rose','sage','peach','honey','sky','lilac'] as const)[i]!}} size={80} activity={kind===selected?activity:'rest'}/><strong>{names[i]}</strong>
  </button>)}</div>
  {crowd&&<div data-crowd style={{display:'flex',flexWrap:'wrap',gap:12,marginTop:30}}>{Array.from({length:200},(_,i)=><CompanionAvatar key={i} id={'crowd-'+i} size={32} activity="working"/>)}</div>}
  <div style={{height:1000}}/><div data-offscreen><CompanionAvatar id="offscreen" activity="working" size={40}/></div></>}
 </main>;
}
createRoot(document.getElementById('app')!).render(<Gallery/>);
