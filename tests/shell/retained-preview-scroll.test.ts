import assert from 'node:assert/strict';
import test from 'node:test';
import { cancelRetainedScrollRestore, queueRetainedScrollRestore, restoreRetainedScroll } from '../../apps/workbench-web/src/components/retained-preview-scroll';

function position(name: string, events: string[], followEnd = true) {
  let top = 12, left = 5;
  const node = {
    get scrollHeight() { events.push('read:'+name); return 900; },
    get clientHeight() { events.push('read:'+name); return 300; },
    get scrollTop() { return top; }, set scrollTop(value: number) { events.push('write:'+name); top=value; },
    get scrollLeft() { return left; }, set scrollLeft(value: number) { events.push('write:'+name); left=value; },
  } as HTMLElement;
  return { node, top, left, followEnd };
}
const owner = () => ({ isConnected: true }) as HTMLElement;
test('restoration batches all reads before writes, preserving historical reading and a growing tail', () => {
  const events: string[] = [], a=position('a',events), b=position('b',events), c=position('c',events,false);
  restoreRetainedScroll([a,b,c]);
  assert.deepEqual(events,['read:a','read:a','read:b','read:b','write:a','write:a','write:b','write:b','write:c','write:c']);
  assert.equal(a.node.scrollTop,600); assert.equal(b.node.scrollTop,600); assert.equal(c.node.scrollTop,12); assert.equal(c.node.scrollLeft,5);
});
test('multiple retained roots restore once after synchronous handback, before another frame', async () => {
  const events: string[]=[], a=position('a',events), b=position('b',events);
  queueRetainedScrollRestore(owner(),[a]); queueRetainedScrollRestore(owner(),[b]);
  assert.deepEqual(events,[]);
  await Promise.resolve();
  assert.deepEqual(events,['read:a','read:a','read:b','read:b','write:a','write:a','write:b','write:b']);
});
test('cancelled, detached and superseded leases cannot restore an obsolete reading position', async () => {
  const events: string[]=[], a=position('a',events), b=position('b',events), root=owner(), gone=owner(), detached=owner();
  queueRetainedScrollRestore(root,[a]); queueRetainedScrollRestore(root,[b]);
  queueRetainedScrollRestore(gone,[a]); assert.deepEqual(cancelRetainedScrollRestore(gone),[a]);
  Object.defineProperty(detached,'isConnected',{value:false}); queueRetainedScrollRestore(detached,[a]);
  await Promise.resolve(); assert.deepEqual(events,['read:b','read:b','write:b','write:b']);
});
