import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';

test('attachment deadline source remains compatible with native Node strip-only loading', () => {
  const source = new URL('../../packages/appserver-client/src/attachment-chunk-deadline.ts', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const {AttachmentChunkDeadline} = await import(${JSON.stringify(source)});
    const timers = new Map(); let serial = 0;
    const clock = {setTimeout(run, ms) { const id = ++serial; timers.set(id, {run, ms}); return id; }, clearTimeout(id) { timers.delete(id); }};
    const deadline = new AttachmentChunkDeadline(1000, false, clock);
    assert.equal(deadline.signal.aborted, false);
    deadline.observe({loaded: 1000, total: 1000});
    assert.equal([...timers.values()][0].ms, 30000);
    deadline.dispose(); assert.equal(timers.size, 0);
    console.log('native deadline source passed');
  `], {encoding: 'utf8'});
  assert.match(output, /native deadline source passed/);
});
