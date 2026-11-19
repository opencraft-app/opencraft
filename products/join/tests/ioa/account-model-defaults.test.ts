import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTencentOaModelDefaults } from "../../plugins/tencentoa/src/model-defaults";

const selection = { model: 'provider/model', effort: 'high', serviceTier: 'priority' };
test('HTTP adapter checks identity/Host, credentials and CAS conflicts', async () => {
  const calls: RequestInit[] = [];
  let scope = 'wrong', hostId = 'host', status = 200;
  const port = createTencentOaModelDefaults((async (_url, options) => {
    calls.push(options!);
    return new Response(JSON.stringify({ scope, hostId, record: { revision: 1, selection } }), { status });
  }) as typeof fetch);
  const signal = new AbortController().signal;
  await assert.rejects(port.read('alice', 'host', signal), /account changed/);
  scope = 'alice'; hostId = 'wrong';
  await assert.rejects(port.read('alice', 'host', signal), /account changed/);
  hostId = 'host';
  assert.deepEqual(await port.write('alice', 'host', 0, selection, signal), { revision: 1, selection });
  assert.equal(calls.at(-1)?.credentials, 'same-origin');
  assert.equal(calls.at(-1)?.cache, 'no-store');
  assert.deepEqual(JSON.parse(calls.at(-1)?.body as string), { revision: 0, selection });
  status = 409; await assert.rejects(port.write('alice', 'host', 0, selection, signal), /retry/);
});
