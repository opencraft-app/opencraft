import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createControls } = createRequire(import.meta.url)('../../scripts/remote-browser/controls.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const input = (type, x = 0, page = 'a') => ({ page, method: 'input', input: { type, x } });

test('slow native touch coalesces positions while preserving release, resize and every reply', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; }), seen = [];
  const dispatch = createControls(async message => { seen.push(message); if (seen.length === 1) await gate; });
  const results = [dispatch(input('mouseDown'))];
  await tick();
  for (let x = 1; x <= 150; x++) results.push(dispatch(input('mouseMove', x)));
  results.push(dispatch(input('mouseUp', 150)));
  results.push(dispatch({ page: 'a', method: 'viewport', input: { width: 390, height: 440 } }));
  assert.equal(seen.length, 1);
  release(); await Promise.all(results);
  assert.deepEqual(seen.map(m => m.input.type ?? m.method), ['mouseDown', 'mouseMove', 'mouseUp', 'viewport']);
  assert.equal(seen[1].input.x, 150);
});

test('in-flight positions, cancellation, editing and modifier boundaries cannot be replaced', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; }), seen = [];
  const dispatch = createControls(async message => { seen.push(message); if (seen.length === 1) await gate; });
  const results = [dispatch(input('mouseMove', 1))];
  await tick();
  results.push(dispatch(input('mouseMove', 2)), dispatch(input('touchCancel')));
  results.push(dispatch(input('mouseMove', 3)));
  results.push(dispatch({ page: 'a', method: 'ime', input: { type: 'commit', text: '你' } }));
  results.push(dispatch(input('mouseMove', 4)));
  results.push(dispatch({ ...input('mouseMove', 5), input: { type: 'mouseMove', x: 5, modifiers: ['shift'] } }));
  release(); await Promise.all(results);
  assert.deepEqual(seen.map(m => m.input.type), ['mouseMove', 'mouseMove', 'touchCancel', 'mouseMove', 'commit', 'mouseMove', 'mouseMove']);
  assert.deepEqual(seen.filter(m => m.input.type === 'mouseMove').map(m => m.input.x), [1, 2, 3, 4, 5]);
});

test('failure rejects merged requests and releases the page; other pages and stop stay independent', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; }), seen = [];
  const dispatch = createControls(async m => {
    seen.push(m);
    if (m.page === 'a' && m.input.type === 'mouseDown') await gate;
    if (m.input.type === 'mouseMove') throw Error('native failure');
  });
  const down = dispatch(input('mouseDown'));
  await tick();
  const first = assert.rejects(dispatch(input('mouseMove', 1)), /native failure/);
  const second = assert.rejects(dispatch(input('mouseMove', 2)), /native failure/);
  await dispatch(input('mouseDown', 0, 'b'));
  await dispatch({ page: 'a', method: 'stop', input: {} });
  assert.equal(seen.length, 3);
  release(); await Promise.all([down, first, second]);
  await dispatch(input('mouseUp'));
  assert.equal(seen.at(-1).input.type, 'mouseUp');
});

test('native pointer identity is a pending motion boundary on hybrid devices', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; }), seen = [];
  const dispatch = createControls(async m => { seen.push(m); if (seen.length === 1) await gate; });
  const down = dispatch(input('mouseDown')); await tick();
  const moves = ['touch', 'mouse', 'mouse'].map((pointerType, x) => dispatch({ page: 'a', method: 'input', input: { type: 'mouseMove', x, pointerType } }));
  release(); await Promise.all([down, ...moves]);
  assert.deepEqual(seen.slice(1).map(m => [m.input.pointerType, m.input.x]), [['touch', 0], ['mouse', 2]]);
});

test('complete touch snapshots coalesce only within the same set and preserve every contact edge', async () => {
 let release;const gate=new Promise(r=>release=r),seen=[];
 const dispatch=createControls(async m=>{seen.push(m);if(seen.length===1)await gate});
 const touch=(type,ids,x)=>({page:'a',method:'input',input:{type,touchPoints:ids.map(id=>({id,x,y:id}))}});
 const ops=[dispatch(touch('touchStart',[1],0))];await tick();
 for(let x=1;x<=80;x++)ops.push(dispatch(touch('touchMove',[1],x)));
 ops.push(dispatch(touch('touchStart',[1,2],80)));
 for(let x=81;x<=150;x++)ops.push(dispatch(touch('touchMove',x%2?[1,2]:[2,1],x)));
 ops.push(dispatch(touch('touchEnd',[2],150)),dispatch(touch('touchMove',[2],155)),dispatch(touch('touchEnd',[],155)));
 release();await Promise.all(ops);
 assert.deepEqual(seen.map(m=>[m.input.type,m.input.touchPoints.map(p=>p.id),m.input.touchPoints[0]?.x]),[
  ['touchStart',[1],0],['touchMove',[1],80],['touchStart',[1,2],80],['touchMove',[2,1],150],['touchEnd',[2],150],['touchMove',[2],155],['touchEnd',[],undefined],
 ]);
});


test('handoff resets are ordered with writes and coalescing never crosses a control token', async () => {
  let unblock; const gate=new Promise(r=>unblock=r),seen=[];
  const dispatch=createControls(async m=>{seen.push(m);if(seen.length===1)await gate});
  const ops=[dispatch({...input('mouseDown'),control:'first'})]; await tick();
  ops.push(dispatch({...input('mouseMove',1),control:'first'}));
  ops.push(dispatch({...input('mouseMove',2),control:'second'}));
  ops.push(dispatch({page:'a',method:'control',input:{token:'second'}}));
  ops.push(dispatch({page:'a',method:'automation',input:{method:'fill'},control:'second'}));
  ops.push(dispatch({page:'a',method:'viewport',input:{width:390,height:640},control:'second'}));
  unblock(); await Promise.all(ops);
  assert.deepEqual(seen.map(m=>[m.method,m.control,m.input.x]),[
    ['input','first',0],['input','first',1],['input','second',2],['control',undefined,undefined],['automation','second',undefined],['viewport','second',undefined],
  ]);
});

test('retiring a renderer fences queued input and control from its replacement without waiting for dead work', async () => {
  let release;const seen=[],gate=new Promise(r=>release=r);
  const dispatch=createControls(async m=>{seen.push(m);if(seen.length===1)await gate;return m.method});
  const old=dispatch(input('mouseDown'));await tick();
  const stale=assert.rejects(dispatch({page:'a',method:'control',input:{token:'stale'}}),{code:'BROWSER_UNAVAILABLE'});
  dispatch.retire('a');
  assert.equal(await dispatch({page:'a',method:'control',input:{token:'fresh'}}),'control');
  release();await Promise.all([old,stale]);
  assert.deepEqual(seen.map(m=>m.input.token??m.input.type),['mouseDown','fresh']);
});

test('native wheel backlog adds distance only at the same hit point, direction, modifiers and control grant', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }), seen = [];
  const dispatch = createControls(async message => { seen.push(message); if (seen.length === 1) await gate; });
  const wheel = (deltaY, x = 10, control = 'grant', modifiers = []) => ({ page: 'a', method: 'input', control, input: { type: 'mouseWheel', x, y: 20, deltaY, deltaX: 0, modifiers } });
  const operations = [dispatch(input('mouseDown'))]; await tick();
  for (let i = 0; i < 100; ++i) operations.push(dispatch(wheel(-2)));
  operations.push(dispatch(wheel(3)), dispatch(wheel(4, 11)), dispatch(wheel(5, 11, 'replacement')), dispatch(wheel(6, 11, 'replacement', ['control'])));
  operations.push(dispatch(input('mouseUp'))); release(); await Promise.all(operations);
  assert.deepEqual(seen.map(m => m.input.type === 'mouseWheel' ? [m.input.deltaY, m.input.x, m.control, m.input.modifiers] : m.input.type),
    ['mouseDown', [-200, 10, 'grant', []], [3, 10, 'grant', []], [4, 11, 'grant', []], [5, 11, 'replacement', []], [6, 11, 'replacement', ['control']], 'mouseUp']);
});

test('document identity is captured at admission and checked before native dispatch', async () => {
  let document='old', release;const gate=new Promise(r=>release=r),seen=[];
  const dispatch=createControls(async message=>{seen.push(message);if(seen.length===1)await gate},()=>document);
  const held=dispatch(input('mouseWheel'));await tick();
  const old=assert.rejects(dispatch(input('char')), {code:'DOCUMENT_CHANGED'});
  document='new';release();await Promise.all([held,old]);assert.equal(seen.length,1);
  await dispatch(input('char'));assert.equal(seen.at(-1).document,'new');
});
