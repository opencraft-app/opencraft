import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserSurfaceHost } from '../apps/workbench-web/src/browser/remote-browser-surface-host';
import type { BrowserPageId } from '@opencraft/browser-core';

test('transferred viewer stops retries and implicit navigation; explicit reload takes over', async t => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1; sent: any[] = [];
    onopen?: () => void; onclose?: (event: { code: number }) => void; onmessage?: (event: { data: string }) => void;
    constructor(_url: URL) { sockets.push(this); }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
    result() { this.onmessage?.({ data: JSON.stringify({ type: 'result', id: this.sent[0].id, value: {
      width: 430, height: 932, deviceProfile: 'iphone', resumed: true, document: 'doc-open-1',
      navigation: { url: 'https://example.test/live', title: 'Live', isLoading: false },
    } }) }); }
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originals = new Map(['WebSocket', 'window', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://example.test/' } });
  const errors: string[] = [], events = { onError: (value: string) => errors.push(value), onLoaded() {}, onNavigation() {} };
  const host: any = new RemoteBrowserSurfaceHost({ getItem: () => null, setItem() {} }, 'proof');
  const id = 'page-owned' as BrowserPageId;
  const p: any = { control: {epoch:0,active:false,controller:false,kind:null}, controlGeneration:0, lease: 'browser-12345678901234567890', connection: 0, closed: false, displaced: false,
    viewportMeasured: false, pending: new Map(), retries: 0, events, visible: true,
    navigation: 0, url: 'https://example.test/live' };
  // Exercise real connection and navigation; media/DOM teardown is independent.
  host.resetTransport = (page: any) => { host.rejectPending(page); page.opened = false; };
  host.humanCall = (page: any, method: string, input: unknown) => host.rawCall(page, method, input);
  host.keyboardChanged = host.applyViewport = host.queueViewport = host.run = () => {};
  host.pages.set(id, p);
  try {
    p.ready = host.connect(p); sockets[0].onopen?.();
    assert.equal(sockets[0].sent[0].input.multiView, true);
    assert.equal(sockets[0].sent[0].input.documentInput, true);
    assert.equal(sockets[0].sent[0].input.takeover, undefined);
    sockets[0].result(); await p.ready;
    assert.equal(p.document, 'doc-open-1');
    sockets[0].close(4009);
    assert.equal(p.displaced, true); assert.equal(p.disconnected, true);
    t.mock.timers.tick(60000); assert.equal(sockets.length, 1);
    assert.equal(host.navigate(id, '', 'https://example.test/live' as any, events), false);
    assert.equal(host.navigate(id, '', 'https://example.test/stale' as any, events), false);
    assert.equal(p.url, 'https://example.test/live'); assert.equal(sockets.length, 1);
    assert.match(errors.at(-1)!, /another client/);
    assert.equal(host.navigate(id, '', p.url, events, true), true);
    assert.equal(p.displaced, false); assert.equal(sockets.length, 2);
    sockets[1].onopen?.(); assert.equal(sockets[1].sent[0].input.multiView, true);
    sockets[1].result(); await p.ready; await Promise.resolve();
    assert.equal(sockets[1].sent[1].method, 'reload');
    sockets[0].onclose?.({ code: 4009 }); assert.equal(p.displaced, false); assert.equal(p.opened, true);
  } finally {
    p.closed = true; for (const socket of sockets) socket.close(); host.rejectPending(p);
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});

test('control loss keeps transport alive, fences queued writes and rejects an obsolete grant', async () => {
  const host: any = Object.create(RemoteBrowserSurfaceHost.prototype); host.controlListeners = new Set();
  let resolve: (state: any) => void = () => {}, resets = 0, sends = 0;
  const p: any = {visible:true,control:{epoch:0,active:false,controller:false,kind:null},controlGeneration:0,connection:1,closed:false,acquiring:null,
    resetInput(){resets++;},receiver:{blur(){},value:'',type:'text',inputMode:'none',setAttribute(){}},events:{onError(){}}};
  host.queueViewport = host.keyboardChanged = () => {}; host.retireMenu = () => {};
  host.rawCall = () => { sends++; return new Promise(r => { resolve = r; }); };
  const first = host.acquireControl(p,'human');
  assert.equal(host.acquireControl(p,'human'),first,'one acquisition for continuous gesture');
  const granted={epoch:1,active:true,controller:true,kind:'human',token:'first-token'};
  host.setControl(p,granted); resolve(granted); assert.equal(await first,'first-token');
  host.setControl(p,{epoch:2,active:true,controller:false,kind:'human'});
  assert.equal(resets,1); assert.equal(p.closed,false); assert.equal(p.connection,1);
  await assert.rejects(host.call(p,'navigate',{url:'https://example.test/'},'first-token'),{code:'CONTROL_LOST'});
  assert.equal(sends,1,'old write never enters the transport');
  const late=host.acquireControl(p,'human'), finish=resolve;
  host.setControl(p,{epoch:4,active:true,controller:false,kind:'human'});
  finish({epoch:3,active:true,controller:true,kind:'human',token:'obsolete-token'});
  await assert.rejects(late,{code:'CONTROL_LOST'});
  assert.equal(p.control.epoch,4); assert.equal(p.control.controller,false);
});


test('attaching a modern blank tab cannot replay stale client URL or acquire input', async () => {
  const host: any = Object.create(RemoteBrowserSurfaceHost.prototype);
  const id='blank-tab', calls: unknown[]=[];
  const events={onError(error: string){throw Error(error);},onLoaded(){}};
  const p: any={closed:false,displaced:false,url:undefined,disconnected:false,navigation:0,ready:Promise.resolve(),restored:false,serverInitialNavigation:true};
  host.pages=new Map();host.hostIdentities=new Set([id]);host.ensure=()=>p;host.humanCall=(...input:unknown[])=>calls.push(input);
  assert.equal(host.navigate(id,'','https://example.test/stale-metadata',events),true);
  await Promise.resolve();await Promise.resolve();
  assert.equal(calls.length,0,'existing blank state belongs to server; initial metadata cannot navigate or claim control');
});

test('native connection waits for durable metadata and a failed or abandoned flush cannot start it', async () => {
  const host: any = Object.create(RemoteBrowserSurfaceHost.prototype);
  let finish!: () => void, attempts = 0;
  host.storage = { flush: () => new Promise<void>(resolve => finish = resolve) };
  host.inputFailed = false;
  host.connectTransport = async () => { attempts++; };
  const page: any = { closed: false };
  const pending = host.connect(page); assert.equal(attempts, 0);
  finish(); await pending; assert.equal(attempts, 1);
  const abandoned = host.connect(page); page.closed = true; finish();
  await assert.rejects(abandoned, /closed/); assert.equal(attempts, 1);
  page.closed = false;
  host.storage.flush = async () => { throw Object.assign(new Error('Metadata conflict'), { code: 'STATE_CONFLICT' }); };
  await assert.rejects(host.connect(page), { code: 'STATE_CONFLICT' }); assert.equal(attempts, 1);
});
