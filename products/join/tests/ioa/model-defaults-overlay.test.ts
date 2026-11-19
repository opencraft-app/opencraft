import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { modelDefaultsOverlay, modelDefaultsServiceEntry } from '../../tools/model-defaults-overlay.mjs';
const source = '// products/join/gateway.mjs\n/* retained CLI and credential fixes */\nfunction joinIdentityComposition() { return {}; }\n// products/join/gateway.mjs\njoinIdentityComposition();\n';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
test('focused composition overlay preserves baseline and rejects drift or a second application', () => {
  const result = modelDefaultsOverlay(source, digest(source));
  assert.match(result, /retained CLI and credential fixes/);
  assert.match(result, /__joinAccountModelDefaults\(__joinOriginalIdentityComposition\(\)\)/);
  assert.throws(() => modelDefaultsOverlay(source + 'drift', digest(source)), /digest changed/);
  assert.throws(() => modelDefaultsOverlay(result, digest(result)), /Unsupported/);
});

test('image launcher selects the fixed candidate while unrelated roles remain untouched', () => {
  const launcher = "const entries = { hands: 'native-hands.mjs', gateway: 'container-gateway.mjs' };";
  const result = modelDefaultsServiceEntry(launcher, digest(launcher));
  assert.match(result, /gateway: 'container-gateway.account-defaults.mjs'/);
  assert.match(result, /hands: 'native-hands.mjs'/);
  assert.throws(() => modelDefaultsServiceEntry(launcher + 'drift', digest(launcher)), /digest changed/);
});
