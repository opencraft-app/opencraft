import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import config from '../next.config.mjs';

test('turbopack root resolves to the real frontend directory', () => {
  const frontendRoot = fileURLToPath(new URL('../', import.meta.url));

  assert.equal(config.turbopack.root, frontendRoot);
  assert.equal(config.turbopack.root.includes('%'), false);
});
