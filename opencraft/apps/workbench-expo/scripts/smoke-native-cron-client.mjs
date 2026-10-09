import assert from 'node:assert/strict';
import { listCronJobs } from '../src/generated/native-cron-client.js';

const requests = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  requests.push({ url, authorization: init.headers.get('Authorization'), body: JSON.parse(init.body) });
  return { ok: true, json: async () => ({ data: { status: 'SUCCESS', exit_code: 0, output: 'No scheduled jobs.' } }) };
};
try {
  const make = (instanceId, token, region) => ({
    instanceId, profileId: `profile-${instanceId}`,
    apiBase: `https://${instanceId}.example.test`, token, region,
    onUnauthorized: () => { throw new Error('Unexpected unauthorized'); },
  });
  await Promise.all([
    listCronJobs(make('bot-a', 'token-a', 'cn')),
    listCronJobs(make('bot-b', 'token-b', 'intl')),
  ]);
  assert.equal(requests.length, 2);
  const cn = requests.find(item => item.url.includes('/bot-a/'));
  const intl = requests.find(item => item.url.includes('/bot-b/'));
  assert.equal(cn.authorization, 'Bearer token-a');
  assert.equal(cn.body.execution_backend, undefined);
  assert.equal(intl.authorization, 'Bearer token-b');
  assert.equal(intl.body.execution_backend, 'tat');
  assert.match(cn.body.command, /hermes -p .* cron list --all/);
  assert.match(intl.body.command, /hermes -p .* cron list --all/);
  let expired = false;
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(listCronJobs({ ...make('bot-c', 'token-c', 'cn'), onUnauthorized: () => { expired = true; } }));
  assert.equal(expired, true);
  process.stdout.write('Native Cron client keeps concurrent Bot credentials separate.\n');
} finally { globalThis.fetch = previousFetch; }
