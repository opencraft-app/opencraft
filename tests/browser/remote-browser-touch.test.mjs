import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {createTouchInput,createWidgetTouchDispatcher,isTouchInput}=createRequire(import.meta.url)('../../scripts/remote-browser/touch.cjs');
const p=(id,x=30)=>({id,x,y:50,force:.5,radiusX:4,radiusY:5});
const frame=(type,...touchPoints)=>({type,touchPoints});

test('native slots bound large wire identities and survive release/reorder/cancel',async()=>{
 const seen=[],port={async sendCommand(method,input){if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{scale:1}};seen.push(input);}};
 const touch=createTouchInput(createWidgetTouchDispatcher(port,()=>1));
 await touch.apply(frame('touchStart',p(2147483647)));
 await touch.apply(frame('touchStart',p(2147483647),p(101)));
 await touch.apply(frame('touchMove',p(101),p(2147483647)));
 await touch.apply(frame('touchEnd',p(101)));
 await touch.apply(frame('touchStart',p(101),p(102)));
 await touch.reset();
 await touch.apply(frame('touchStart',p(500)));
 await touch.apply(frame('touchEnd'));
 await touch.apply(frame('touchStart',p(501)));
 assert.deepEqual(seen.map(v=>v.touchPoints.map(p=>p.id)),[[0],[1],[1,0],[0],[0],[],[0],[],[0]]);
});

test('native slots reset after an accepted press with failed ACK or failed cancel',async()=>{
 let fail=true;const seen=[];
 const port={async sendCommand(method,input){if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{scale:1}};seen.push(input);if(fail)throw Error('lost ack');}};
 const touch=createTouchInput(createWidgetTouchDispatcher(port,()=>1));
 await assert.rejects(touch.apply(frame('touchStart',p(101))),/lost ack/);
 fail=false;await touch.apply(frame('touchStart',p(102)));
 assert.deepEqual(seen.map(v=>[v.type,v.touchPoints.map(p=>p.id)]),[['touchStart',[0]],['touchCancel',[]],['touchStart',[0]]]);
});

test('rendered touch locations survive changing native pinch and browser zoom',async()=>{
 let pinch=1,zoom=1;const seen=[],queries=[];
 const port={async sendCommand(method,input){queries.push(method);if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{scale:pinch,pageX:700,pageY:900,offsetX:140,offsetY:80}};seen.push(input);}};
 const touch=createTouchInput(createWidgetTouchDispatcher(port,()=>zoom));
 await touch.apply(frame('touchStart',p(1,120)));
 pinch=2;await touch.apply(frame('touchStart',p(1,120),p(2,240)));
 pinch=3;zoom=1.25;await touch.apply(frame('touchMove',p(1,150),p(2,300)));
 pinch=1.5;await touch.apply(frame('touchEnd',p(2,300)));
 await touch.apply(frame('touchEnd'));
 assert.deepEqual(seen.map(v=>v.touchPoints.map(p=>p.x)),[[120],[120],[40,80],[80],[]]);
 assert.equal(seen[2].touchPoints[0].y,50/3.75);
 assert.equal(seen[2].touchPoints[0].radiusX,4);assert.equal(seen[2].touchPoints[0].force,.5);
 assert.equal(queries.filter(x=>x==='Page.getLayoutMetrics').length,4);
 assert(!touch.active);
});

test('failed native metrics cancel owned contacts without stale scale fallback',async()=>{
 let invalid=false;const seen=[];
 const port={async sendCommand(method,input){if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{scale:invalid?0:1}};seen.push(input);}};
 const touch=createTouchInput(createWidgetTouchDispatcher(port,()=>1));
 await touch.apply(frame('touchStart',p(1)));invalid=true;
 await assert.rejects(touch.apply(frame('touchMove',p(1))),/native touch scale/);
 assert.deepEqual(seen.map(v=>v.type),['touchStart','touchCancel']);assert(!touch.active);
 await touch.reset();assert.equal(seen.length,2);
});

test('independent fingers retain identity through partial release and re-add',async()=>{
 const seen=[],t=createTouchInput(async v=>seen.push(v));
 await t.apply(frame('touchStart',p(17)));
 await t.apply(frame('touchStart',p(17),p(93,80)));
 await t.apply(frame('touchMove',p(93,90),p(17,20)));
 await t.apply(frame('touchEnd',p(93,90)));
 assert(t.active);await t.apply(frame('touchMove',p(93,95)));
 await t.apply(frame('touchStart',p(93,95),p(201,30)));
 await t.apply(frame('touchEnd',p(201,30)));
 await t.apply(frame('touchEnd'));
 assert(!t.active);
 assert.deepEqual(seen.map(v=>[v.type,v.touchPoints.map(p=>p.id)]),[
  ['touchStart',[17]],['touchStart',[93]],['touchMove',[93,17]],['touchEnd',[17]],
  ['touchMove',[93]],['touchStart',[201]],['touchEnd',[93]],['touchEnd',[]],
 ]);
});

test('reset orders behind a native ACK and stale contacts never restart it',async()=>{
 let release;const gate=new Promise(r=>release=r),seen=[];
 const t=createTouchInput(async v=>{seen.push(v);if(seen.length===1)await gate});
 const down=t.apply(frame('touchStart',p(1))),cancel=t.reset(),move=t.apply(frame('touchMove',p(1)));
 await new Promise(r=>setImmediate(r));assert.equal(seen.length,1);
 release();await Promise.all([down,cancel,move]);
 await t.apply(frame('touchStart',p(1),p(2)));await t.apply(frame('touchEnd',p(2)));
 assert.deepEqual(seen.map(v=>v.type),['touchStart','touchCancel']);assert(!t.active);
 await t.apply(frame('touchStart',p(9)));assert(t.active);
});

test('invalid or oversized input is rejected before native side effects',async()=>{
 const seen=[],t=createTouchInput(async v=>seen.push(v));
 for(const input of [frame('touchStart',p(-1)),frame('touchStart',{...p(1),x:NaN}),frame('touchStart',{...p(1),force:2}),frame('touchStart',p(1),p(1)),frame('touchStart',...Array.from({length:11},(_,id)=>p(id))),{type:'touchMove',touchPoints:'bad'},frame('touchCancel',p(1))])await assert.rejects(t.apply(input),/Invalid touch/);
 assert.equal(seen.length,0);
 await t.apply(frame('touchStart',p(1)));
 await assert.rejects(t.apply(frame('touchMove',p(2))),/sequence/);
 assert(!t.active);await t.apply(frame('touchStart',p(1)));
 await assert.rejects(t.apply(frame('touchEnd',p(1),p(2))),/sequence/);
 assert.deepEqual(seen.map(v=>v.type),['touchStart','touchCancel','touchStart','touchCancel']);assert(!t.active);
});

test('failed native acknowledgement cancels rather than retrying a press',async()=>{
 let fail=true;const seen=[],t=createTouchInput(async v=>{seen.push(v);if(fail&&v.type==='touchStart'){fail=false;throw Error('lost ack')}});
 await assert.rejects(t.apply(frame('touchStart',p(1))),/lost ack/);
 assert(!t.active);assert.deepEqual(seen.map(v=>v.type),['touchStart','touchCancel']);
 await t.apply(frame('touchMove',p(1)));assert.equal(seen.length,2);
 await t.apply(frame('touchStart',p(9)));assert(t.active);
});

test('legacy mouse emulation remains single touch and respects modifiers',async()=>{
 const seen=[],t=createTouchInput(async v=>seen.push(v));
 await t.mouse({type:'mouseDown',x:20,y:30,modifiers:['shift']});
 await t.mouse({type:'mouseMove',x:25,y:35});await t.mouse({type:'mouseUp'});
 assert.deepEqual(seen.map(v=>v.type),['touchStart','touchMove','touchEnd']);
 assert.equal(seen[0].modifiers,8);assert(!t.active);
});

test('navigation during touch metrics rejects the old contact before native injection', async () => {
  let document='old',release;const gate=new Promise(r=>release=r),calls=[];
  const dispatch=createWidgetTouchDispatcher({async sendCommand(method,input){calls.push(method);if(method==='Page.getLayoutMetrics'){await gate;return {cssVisualViewport:{scale:1}}}}},()=>1,()=>document);
  const result=assert.rejects(dispatch({type:'touchStart',touchPoints:[{id:1,x:10,y:20}]}),{code:'DOCUMENT_CHANGED'});
  document='new';release();await result;assert.deepEqual(calls,['Page.getLayoutMetrics']);
});

test('gesture sample time survives slow native ACKs and resets on final release', async () => {
 let wall=1700000000000;const seen=[];
 const touch=createTouchInput(async event=>{seen.push(event);wall+=70;},()=>wall);
 await touch.apply({...frame('touchStart',p(1)),time:500});
 await touch.apply({...frame('touchMove',p(1,90)),time:548,history:[{time:516,touchPoints:[p(1,50)]},{time:532,touchPoints:[p(1,70)]}]});
 await touch.apply({...frame('touchEnd'),time:556});
 assert.deepEqual(seen.map(v=>Math.round((v.timestamp-1700000000)*1000)),[-2,30,46,54]);
 await touch.apply({...frame('touchStart',p(3)),time:10});
 assert.equal(Math.round(seen.at(-1).timestamp*1000),wall-72,'new gesture owns a new clock anchor');
 await touch.reset();await touch.apply({...frame('touchStart',p(4)),time:0});assert(touch.active);
});

test('invalid timed motion validates the complete tail and retires held native contacts',async()=>{
 for(const extra of [{time:NaN},{time:99},{time:1000000},{time:120,age:NaN},{time:120,age:25001},{time:120,history:{}},{time:120,history:[{time:115,touchPoints:[p(2)]}]},
   {time:200,history:[{time:120,touchPoints:[p(1)]}]},{time:130,history:[{time:120,touchPoints:[p(1)]},{time:110,touchPoints:[p(1)]}]},
   {time:120,history:Array.from({length:3},()=>({time:110,touchPoints:[p(1)]}))}]) {
  const seen=[],touch=createTouchInput(async event=>seen.push(event),()=>1700000000000);
  await touch.apply({...frame('touchStart',p(1)),time:100});
  await assert.rejects(touch.apply({...frame('touchMove',p(1)),...extra}),/Invalid touch/);
  assert.deepEqual(seen.map(v=>v.type),['touchStart','touchCancel']);assert(!touch.active);
 }
});

test('a real stationary release preserves its pause and overlapping history is not replayed',async()=>{
 let wall=1700000000000;const seen=[],touch=createTouchInput(async event=>seen.push(event),()=>wall);
 await touch.apply({...frame('touchStart',p(1)),time:100});wall+=16;
 await touch.apply({...frame('touchMove',p(1,40)),time:116});wall+=32;
 await touch.apply({...frame('touchMove',p(1,60)),time:148,history:[{time:116,touchPoints:[p(1,40)]},{time:132,touchPoints:[p(1,50)]}]});wall+=120;
 await touch.apply({...frame('touchEnd'),time:268});
 assert.deepEqual(seen.map(v=>v.type),['touchStart','touchMove','touchMove','touchEnd']);
 assert.equal(Math.round((seen.at(-1).timestamp-seen.at(-2).timestamp)*1000),120);
});

test('failure while draining a timed tail cancels without leaking samples into another gesture',async()=>{
 const seen=[];let fail=true,wall=1700000000000;
 const touch=createTouchInput(async event=>{seen.push(event);if(fail&&event.type==='touchMove')throw Error('failed ACK')},()=>wall);
 await touch.apply({...frame('touchStart',p(1)),time:1});wall+=48;
 await assert.rejects(touch.apply({...frame('touchMove',p(1,80)),time:49,history:[{time:17,touchPoints:[p(1,50)]}]}),/failed ACK/);
 assert(!touch.active);assert.equal(seen.at(-1).type,'touchCancel');fail=false;
 await touch.apply({...frame('touchStart',p(2)),time:0});assert(touch.active);
});

test('navigation during a timed tail cannot inject its remaining samples into the new document', async()=>{
 const seen=[];let document='old',wall=1700000000000;
 const touch=createTouchInput(async event=>{seen.push(event);if(event.type==='touchMove')document='new';},()=>wall,()=>document);
 await touch.apply({...frame('touchStart',p(1)),time:0});wall+=48;
 await assert.rejects(touch.apply({...frame('touchMove',p(1,70)),time:48,history:[{time:16,touchPoints:[p(1,40)]},{time:32,touchPoints:[p(1,50)]}]}),{code:'DOCUMENT_CHANGED'});
 assert.deepEqual(seen.map(v=>v.type),['touchStart','touchMove','touchCancel']);assert(!touch.active);
});

test('dense delivered motion never adds historical native ACK work',async()=>{
 let wall=1700000000000;const seen=[],touch=createTouchInput(async event=>seen.push(event),()=>wall);
 await touch.apply({...frame('touchStart',p(1)),time:0});wall+=16;
 await touch.apply({...frame('touchMove',p(1,40)),time:16});wall+=32;
 await touch.apply({...frame('touchMove',p(1,60)),time:48,history:[{time:32,touchPoints:[p(1,50)]}]});
 assert.deepEqual(seen.map(v=>Math.round((v.timestamp-1700000000)*1000)),[-2,14,46]);
});

test('control-wait age dates a buffered gesture without future timestamps or lost relative time',async()=>{
 const wall=1700000001800,seen=[],touch=createTouchInput(async event=>seen.push(event),()=>wall);
 await touch.apply({...frame('touchStart',p(1)),time:0,age:1800});
 await touch.apply({...frame('touchMove',p(1,60)),time:1200,age:600});
 await touch.apply({...frame('touchEnd'),time:1400,age:400});
 assert.deepEqual(seen.map(v=>Math.round(v.timestamp*1000-(wall-1800))),[-2,1198,1398]);
 assert(seen.every(v=>v.timestamp*1000<=wall-2));assert(!touch.active);
});

test('clock drift and shrinking transport delay cannot inject a future or decreasing native event',async()=>{
 let wall=1700000000000;const seen=[],touch=createTouchInput(async event=>{if(event.timestamp!==undefined)assert(event.timestamp*1000<=wall-1);seen.push(event)},()=>wall);
 await touch.apply({...frame('touchStart',p(1)),time:0});
 wall+=16;await touch.apply({...frame('touchMove',p(1,40)),time:16.4});
 wall+=1;await touch.apply({...frame('touchMove',p(1,41)),time:17.4,age:100});
 wall+=20;await touch.apply({...frame('touchEnd'),time:37.4});
 assert(seen.every((event,i)=>!i||event.timestamp>=seen[i-1].timestamp));
});

test('a backward native wall clock retires the gesture rather than forwarding a future event',async()=>{
 let wall=1700000000000;const seen=[],touch=createTouchInput(async event=>seen.push(event),()=>wall);
 await touch.apply({...frame('touchStart',p(1)),time:0});wall-=20;
 await assert.rejects(touch.apply({...frame('touchMove',p(1,50)),time:16}),/clock changed/);
 assert.deepEqual(seen.map(v=>v.type),['touchStart','touchCancel']);assert(!touch.active);
});

test('shrinking transport delay over one second is normalized before native time validation',async()=>{
 let wall=1700000000000;const seen=[],touch=createTouchInput(async event=>seen.push(event),()=>wall);
 await touch.apply({...frame('touchStart',p(1)),time:0,age:0});
 wall+=100;await touch.apply({...frame('touchMove',p(1,60)),time:1700,age:0});
 wall+=120;await touch.apply({...frame('touchEnd'),time:1820,age:0});
 assert.deepEqual(seen.map(v=>v.type),['touchStart','touchMove','touchEnd']);
 assert(seen.every(v=>v.timestamp*1000<=wall-2));
 assert.equal(Math.round((seen[2].timestamp-seen[1].timestamp)*1000),120);
 assert(!touch.active);
});

test('transport skew is bounded and a real long hold or maximum capture age remains valid',async()=>{
 let wall=1700000000000;const seen=[],touch=createTouchInput(async event=>seen.push(event),()=>wall);
 await touch.apply({...frame('touchStart',p(1)),time:0});
 wall+=30000;await touch.apply({...frame('touchEnd'),time:30000});
 await touch.apply({...frame('touchStart',p(1)),time:0,age:25000});await touch.reset();
 await touch.apply({...frame('touchStart',p(1)),time:0});
 await assert.rejects(touch.apply({...frame('touchMove',p(1,60)),time:25001}),/Invalid touch time/);
 assert.equal(seen.at(-1).type,'touchCancel');assert(!touch.active);
});

test('capture age and transport skew cannot combine into an expired native event',async()=>{
 let wall=1700000000000;const seen=[],touch=createTouchInput(async event=>seen.push(event),()=>wall);
 await touch.apply({...frame('touchStart',p(1)),time:0,age:25000});wall+=25000;
 await assert.rejects(touch.apply({...frame('touchMove',p(1,60)),time:0,age:25000}),/Invalid touch time/);
 assert.deepEqual(seen.map(v=>v.type),['touchStart','touchCancel']);assert(!touch.active);
});

test('new runtime touch release receipt survives dispatch layers and old runtime keeps the original command',async()=>{
 for(const enabled of [false,true]){
  const calls=[],receipt={nativeInputTicket:'private-native-receipt'};
  const port={async sendCommand(method,input){if(method==='Page.getLayoutMetrics')return{cssVisualViewport:{scale:1}};calls.push(method);return method.endsWith('WithNativeInputTicket')?receipt:undefined}};
  const touch=createTouchInput(createWidgetTouchDispatcher(port,()=>1,()=>undefined,()=>enabled));
  assert.equal(await touch.apply(frame('touchStart',p(1))),undefined);
  assert.equal(await touch.apply(frame('touchEnd')),enabled?receipt:undefined);
  assert.deepEqual(calls,['Input.dispatchTouchEvent',enabled?'Input.dispatchTouchEventWithNativeInputTicket':'Input.dispatchTouchEvent']);
 }
});
test('explicit hybrid mouse or pen remains native mouse even under a mobile profile',()=>{
 for(const profile of ['desktop','desktop-touch','iphone','ipad','android-phone','android-tablet']){
  assert.equal(isTouchInput({pointerType:'mouse'},profile),false);assert.equal(isTouchInput({pointerType:'pen'},profile),false);
  assert.equal(isTouchInput({pointerType:'touch'},profile),true);assert.equal(isTouchInput({},profile),profile!=='desktop');
 }
});

 test('explicit mouse or pen keeps its identity across mobile profiles',()=>{
  for(const profile of ['desktop','desktop-touch','iphone','ipad','android-phone','android-tablet']){
   assert.equal(isTouchInput({pointerType:'mouse'},profile),false);
   assert.equal(isTouchInput({pointerType:'pen'},profile),false);
   assert.equal(isTouchInput({pointerType:'touch'},profile),true);
   assert.equal(isTouchInput({},profile),profile!=='desktop');
  }
 });
