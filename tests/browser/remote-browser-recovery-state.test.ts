import assert from 'node:assert/strict';
import test from 'node:test';
import { WebBrowserPageRuntime } from '../../apps/workbench-web/src/browser/web-browser-runtime';

test('a recovered blank document clears the error in the real page state owner', () => {
  const surfaces = { close() {}, dispose() {} };
  const runtime:any = new WebBrowserPageRuntime(surfaces as any,null,()=>null,{getItem:()=>null,setItem(){}});
  const id=runtime.create({ownerId:'synthetic-recovery'});
  const events=runtime.surfaceEvents(runtime.pages.get(id));
  try {
    events.onError('Browser disconnected; reconnecting');
    assert.equal(runtime.getSnapshot(id).error,'Browser disconnected; reconnecting');
    events.onNavigation({url:'about:blank',title:'',isLoading:false,canGoBack:false,canGoForward:false});
    assert.equal(runtime.getSnapshot(id).error,'Browser disconnected; reconnecting','blank navigation does not invent a history entry');
    events.onLoaded(null);
    assert.equal(runtime.getSnapshot(id).error,null);
    assert.equal(runtime.getSnapshot(id).navigation.currentUrl,null);
    assert.equal(runtime.getSnapshot(id).navigation.isLoading,false);
    events.onError('A later failure');assert.equal(runtime.getSnapshot(id).error,'A later failure');
  } finally { runtime.dispose(); }
});
