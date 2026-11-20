import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const notice = require('../../packages/react-runtime/NOTICE.json');
const pkg = require('react-use-event-hook/package.json');

test('the retained notice matches the exact installed public dependency and complete license', () => {
  const license = readFileSync(new URL('../../node_modules/react-use-event-hook/LICENSE', import.meta.url), 'utf8');
  assert.equal(notice.name, pkg.name);
  assert.equal(notice.version, pkg.version);
  assert.equal(notice.license, pkg.license);
  assert.equal(notice.text, license);
  assert.ok(notice.text.includes(notice.copyright));
  const lock = require('../../package-lock.json');
  assert.equal(lock.packages['node_modules/react-use-event-hook'].version, '0.9.6');
  assert.equal(lock.packages['node_modules/react-use-event-hook'].integrity,
    'sha512-wNchkFrrlz64QQOJOf5+dFjy+27bJEwtS1SgliRXVsU60wo3pSntNRlwDws2qPHwrAP/wlm5IyQHBlPCya0JIQ==');
});

test('Expo config retains the full notice without losing unrelated public metadata', () => {
  const configure = require('../../apps/mobile/app.config.js');
  const config = configure({ config: { name: 'Fixture', extra: { existing: true } } });
  assert.equal(config.name, 'Fixture');
  assert.equal(config.extra.existing, true);
  assert.deepEqual(config.extra.openSourceNotices, [notice]);
});
