import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserService } from '../../scripts/remote-browser-service.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const service = new RemoteBrowserService({ root:'.', dataDirectory:'.', ownerConnector:null });
  service.checkpoint = () => {};
  const calls = [], ws = { readyState:1, send(){} };
  const page = { id:'native-page', key:'page', live:true, painted:true, document:'doc-a',
    controlToken:'held-control', viewers:new Map([[ws,{visible:true,ready:true,authorize(){}}]]) };
  service.pages.set(page.key,page);
  service.request = async (_id,method,input) => { calls.push({method,input}); };
  const navigation = () => service.receive({ type:'navigation', page:page.id, state:{url:'https://example.test/',isLoading:false} });
  return { service,page,calls,ws,navigation };
}

test('a completed visible document refreshes native capture once without claiming input', async () => {
  const f=fixture();
  try {
    f.navigation(); await tick();
    assert.deepEqual(f.calls,[{method:'visible',input:{visible:true}}]);
    f.navigation(); f.navigation(); await tick();
    assert.equal(f.calls.length,1,'title and repeated idle events cannot form a capture loop');
    assert.equal(f.page.controlToken,'held-control');
    f.page.viewers.get(f.ws).visible=false;
    f.service.receive({type:'input-reset',page:f.page.id,document:'doc-b'});f.navigation();await tick();
    assert.equal(f.calls.length,1,'background navigation does not resume painting');
  } finally { f.service.close(); }
});

test('refresh demand coalesces behind native visibility and a late ACK cannot revive a parked page', async () => {
  const f=fixture();let finish;
  const gate=new Promise(resolve=>finish=resolve);
  f.service.request=async(_id,method,input)=>{f.calls.push({method,input});if(f.calls.length===1)await gate;};
  try {
    f.navigation(); await tick();assert.equal(f.calls.length,1);
    f.service.receive({type:'input-reset',page:f.page.id,document:'doc-b'});f.navigation();
    f.page.viewers.get(f.ws).visible=false;
    const parked=f.service.visibility(f.page);finish();await parked;
    assert.deepEqual(f.calls.map(c=>c.input.visible),[true,false]);
    assert.equal(f.page.painted,false);
    f.page.viewers.get(f.ws).visible=true;await f.service.visibility(f.page);
    assert.deepEqual(f.calls.map(c=>c.input.visible),[true,false,true]);
    assert.equal(f.page.controlToken,'held-control');
  } finally { finish?.();f.service.close(); }
});
