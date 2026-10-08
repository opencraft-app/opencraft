import assert from 'node:assert/strict';
import test from 'node:test';

const { classifyBotDocumentNavigation: decide } = await import('../apps/workbench-expo/src/runtime/mobile-bot-document-policy.ts');
const site = 'https://lightvela.ai';

test('only the initial top-level local document may use the site base URL', () => {
  assert.equal(decide(`${site}/`, site, true, true), 'initial-document');
  assert.equal(decide('about:blank', site, true, true), 'initial-document');
  assert.equal(decide(`${site}/`, site, false, true), 'blocked');
  assert.equal(decide(`${site}/?source=redirect`, site, true, true), 'blocked');
  assert.equal(decide(`${site}/`, site, true, false), 'blocked');
  assert.equal(decide('data:text/html,<h1>remote</h1>', site, false, true), 'blocked');
});

test('bot routes stay in the bridge; other documents leave the embedded runtime', () => {
  assert.equal(decide(`${site}/agents/one/model`, site, false, true), 'bot-route');
  assert.equal(decide(`${site}/account`, site, false, true), 'external');
  assert.equal(decide('https://example.com/', site, false, true), 'external');
  assert.equal(decide('javascript:alert(1)', site, false, true), 'blocked');
  assert.equal(decide('https://example.com/', site, false, false), 'blocked');
});
