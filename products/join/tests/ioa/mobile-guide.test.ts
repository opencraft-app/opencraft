import assert from 'node:assert/strict';
import test from 'node:test';
import { MobileGuide, MOBILE_GUIDE_STORAGE_KEY, mobileSiteUrl } from '../../plugins/tencentoa/src/mobile-guide';

function fixture(initial = false) {
  const values = new Map<string,string>(initial ? [[MOBILE_GUIDE_STORAGE_KEY,'1']] : []);
  const controller = new AbortController();
  let eligible = true, count = 0, action = 'done';
  const ports = {
    signal: controller.signal, url: 'https://join.woa.com/',
    storage: { getItem: (k:string)=>values.get(k) ?? null, setItem: (k:string,v:string)=>{values.set(k,v);}, removeItem: (k:string)=>{values.delete(k);} },
    eligible: ()=>eligible, qr: async (_url:string)=> 'data:image/png;base64,QR',
    show: async (_value: unknown) => {count++; return {kind:'action' as const,actionId:action};},
  };
  return { ports, values, controller, count:()=>count, eligible:(v:boolean)=>{eligible=v;}, action:(v:string)=>{action=v;} };
}

test('QR URL preserves workspace but drops credentials and auth parameters',()=>{
  assert.equal(mobileSiteUrl('https://join.woa.com/chat/secret?token=secret#auth'),'https://join.woa.com/chat/secret');
  for(const url of ['file:///app/index.html','http://localhost:3000','http://127.0.0.1:3000','http://[::1]/','https://user:secret@join.woa.com/','bad']) assert.equal(mobileSiteUrl(url),null);
});
test('automatic reminder persists per browser; manual entry can reopen',async()=>{
  const f=fixture();const g=new MobileGuide(f.ports);
  await g.show(true);await g.show(true);assert.equal(f.count(),1);
  assert.equal(f.values.get(MOBILE_GUIDE_STORAGE_KEY),'1');
  await new MobileGuide(f.ports).show(true);assert.equal(f.count(),1);
  await g.show();assert.equal(f.count(),2);
});
test('clearing removes only plugin record, suppresses current visit, reminds next visit',async()=>{
  const f=fixture(true);f.values.set('unrelated','keep');f.action('forget');
  const g=new MobileGuide(f.ports);await g.show();
  assert.equal(f.values.has(MOBILE_GUIDE_STORAGE_KEY),false);assert.equal(f.values.get('unrelated'),'keep');
  await g.show(true);assert.equal(f.count(),1);
  await new MobileGuide(f.ports).show(true);assert.equal(f.count(),2);
});
test('concurrent automatic/manual attempts share one pending popup',async()=>{
  const f=fixture();let resolve!: (v:string)=>void;
  f.ports.qr=()=>new Promise(r=>{resolve=r;});const g=new MobileGuide(f.ports);
  const first=g.show(true);const second=g.show();assert.equal(first,second);
  resolve('data:image/png;base64,QR');await first;assert.equal(f.count(),1);
});
test('retiring plugin or losing eligibility during QR generation never shows or marks seen',async()=>{
  for(const dispose of [true,false]){
    const f=fixture();let resolve!: (v:string)=>void;f.ports.qr=()=>new Promise(r=>{resolve=r;});
    const promise=new MobileGuide(f.ports).show(true);
    if(dispose)f.controller.abort();else f.eligible(false);
    resolve('data:image/png;base64,QR');await promise;
    assert.equal(f.count(),0);assert.equal(f.values.size,0);
  }
});
test('generation failure does not consume reminder and can retry',async()=>{
  const f=fixture();f.ports.qr=async()=>{throw Error('failed');};const g=new MobileGuide(f.ports);
  await assert.rejects(g.show(true));assert.equal(f.values.size,0);
  f.ports.qr=async()=> 'data:image/png;base64,QR';await g.show(true);assert.equal(f.count(),1);
});
test('storage denied falls back to once per plugin activation',async()=>{
  const f=fixture();f.ports.storage={getItem(){throw Error('denied');},setItem(){throw Error('denied');},removeItem(){throw Error('denied');}};
  const g=new MobileGuide(f.ports);await g.show(true);await g.show(true);assert.equal(f.count(),1);
});
test('phone QR and frame open the same live workspace with only routing parameters',async()=>{
 const f=fixture();f.ports.url='https://join.woa.com/local/thread?hostId=local-codex&token=private#auth';
 let encoded='';f.ports.qr=async(value:string)=>{encoded=value;return 'data:image/png;base64,QR';};
 let contribution:any;f.ports.show=async(value:unknown)=>{contribution=value;return {kind:'action',actionId:'done'};};
 await new MobileGuide(f.ports).show();assert.equal(encoded,'https://join.woa.com/local/thread?hostId=local-codex');assert.deepEqual(contribution.preview,{path:'/local/thread?hostId=local-codex'});assert.equal(contribution.media.alt,encoded);assert.equal(contribution.anchorNavigationId,undefined);
});
test('manual reopen resolves the current route rather than the activation route',async()=>{
 const f=fixture();let url='https://join.woa.com/local/one?hostId=host';let encoded='';
 const guide=new MobileGuide({...f.ports,currentUrl:()=>mobileSiteUrl(url),qr:async value=>{encoded=value;return 'data:image/png;base64,QR';}});
 await guide.show();url='https://join.woa.com/local/two?hostId=host';await guide.show();assert.equal(encoded,url);
});
