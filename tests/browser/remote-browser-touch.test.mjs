import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {createTouchInput,createWidgetTouchDispatcher}=createRequire(import.meta.url)('../../scripts/remote-browser/touch.cjs');
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
 await assert.rejects(t.apply(frame('touchEnd',p(1),p(2))),/sequence/);
 assert.equal(seen.length,1);assert(t.active);
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
