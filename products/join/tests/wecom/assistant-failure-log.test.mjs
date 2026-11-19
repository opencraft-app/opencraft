import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logGroupFailure, failureSummary } from '../../plugins/wecom/assistant-runtime.mjs';
test('group assistant failures log the real reason, sparsely when repeated', () => {
  const lines=[];const warn=console.warn;console.warn=l=>lines.push(l);
  try {
    const e=Error('text must contain 1..20000 characters');
    logGroupFailure(e,{scope:'8f614c9b28',failures:1});
    for(let i=2;i<=10;i++)logGroupFailure(e,{scope:'8f614c9b28',failures:i,repeated:true});
    logGroupFailure(Error('Memory root/agent binding changed'),{scope:'8f614c9b28',failures:11});
  } finally { console.warn=warn; }
  assert.equal(lines.length,3);
  const first=JSON.parse(lines[0]);
  assert.equal(first.event,'wecom-group-assistant-failure');assert.equal(first.scope,'8f614c9b');
  assert.match(first.error,/20000 characters/);assert.equal(JSON.parse(lines[1]).failures,10);
  assert.match(JSON.parse(lines[2]).error,/Memory root/);
  assert.ok(failureSummary('x'.repeat(5000)).length<=400);
});

test('failures are appended to the bounded data-directory log', () => {
  const file=join(mkdtempSync(join(tmpdir(),'wf-')),'f.log');const warn=console.warn;console.warn=()=>{};
  try { logGroupFailure(Error('boom'),{scope:'abcdef1234',file}); } finally { console.warn=warn; }
  assert.match(readFileSync(file,'utf8'),/"error":"boom/);
});
test('the Host allowlist carries group file and chat operations', () => {
  const src=readFileSync(new URL('../../plugins/wecom/assistant-install.mjs',import.meta.url),'utf8');
  assert.match(src,/'file','chat','edit'/);
});
