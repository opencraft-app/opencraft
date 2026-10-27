import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadHistoryFirstPaintObserver, historyLengthBucket, historyEngine } from '../../apps/workbench-web/src/runtime/thread-history-first-paint';
import type { beginObservedOperation } from '../../apps/workbench-web/src/runtime/observability';

test('paint owns completion after navigation; replacement/cancel/failure/empty never become success', () => {
  const events: any[] = [];
  const begin: typeof beginObservedOperation = (operation, fields) => {
    events.push({operation,fields});
    return (outcome = 'ok', extra = {}) => { events.push({outcome,extra}); };
  };
  const observer = createThreadHistoryFirstPaintObserver(begin);
  const cold = observer.begin('local-view-a','cold');
  assert.equal(events.length,1,'navigation preparation alone has no success');
  const warm = observer.begin('local-view-b','warm');
  observer.settle(cold,'ok',{engine:'pi',lengthBucket:'lt50'});
  assert.equal(events.length,3,'late paint of aborted view is ignored');
  observer.settle(warm,'ok',{engine:'codex',lengthBucket:'50to199'});
  observer.settle(warm,'failed');
  const failure=observer.begin('local-view-c','cold'); observer.settle(failure,'failed');
  const empty=observer.begin('local-view-d','cold'); observer.settle(empty,'empty',{engine:'dsh',lengthBucket:'lt50'});
  observer.begin('local-view-e','warm'); observer.abort(); observer.abort();
  assert.deepEqual(events.filter(entry=>entry.outcome).map(entry=>entry.outcome),['aborted','ok','failed','empty','aborted']);
  assert.equal(observer.getSnapshot(),null);
  assert(!JSON.stringify(events).includes('local-view'));
});

test('length boundaries require complete history and engine follows declared ownership', () => {
  for (const [count,expected] of [[0,'lt50'],[49,'lt50'],[50,'50to199'],[199,'50to199'],[200,'200to499'],[499,'200to499'],[500,'500plus']] as const) {
    assert.equal(historyLengthBucket(count,true),expected);
    assert.equal(historyLengthBucket(count,false),'unknown');
  }
  assert.equal(historyLengthBucket(NaN,true),'unknown');
  const extensions={'opencraft/execution-engines':{defaultEngine:'codex',providers:[{id:'pi',threadPrefix:'pi:'},{id:'dsh',modelPrefix:'dsh:'}]}};
  assert.equal(historyEngine(extensions,'pi:private'),'pi');
  assert.equal(historyEngine(extensions,'dsh:private'),'dsh');
  assert.equal(historyEngine(extensions,'ordinary'),'codex');
  assert.equal(historyEngine(undefined,'private'),'unknown');
});
