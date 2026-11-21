#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function recoverLocalServer({ url, stateDirectory, origin = url, jobId, version, buildId, recoveryId, recoveryIdFile } = {}) {
  const address = new URL(url);
  if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) || address.username || address.password)
    throw new Error('Recovery URL must be loopback HTTP');
  if (recoveryIdFile) recoveryId = (await readFile(recoveryIdFile, 'utf8')).trim();
  const endpoint = address.origin + '/__opencraft_updates';
  let cookie = '';
  const post = async (action, input) => {
    const response = await fetch(endpoint + '/' + action, { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { origin, cookie, 'content-type': 'application/json', ...(recoveryId ? { 'x-opencraft-recovery-id': recoveryId } : {}) }, body: JSON.stringify(input) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Recovery request rejected');
    return response;
  };
  const key = (await readFile(join(stateDirectory, 'admin-key'), 'utf8')).trim();
  cookie = (await post('login', { key })).headers.get('set-cookie').split(';')[0];
  {
    await post('recover-current', { jobId, version, buildId });
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const response = await fetch(endpoint, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('Recovery observation unavailable');
      const status = await response.json();
      if (status.job?.id !== jobId) throw new Error('Recovery job changed; inspect the original transaction');
      if (status.job.phase === 'failed') {
        if (status.job.recoveryError || status.job.recovery?.outcome !== 'rolled-back') throw new Error('Recovery verification failed; original transaction retained');
        return { jobId, recovery: status.job.recovery, recoveryRequired: status.recoveryRequired };
      }
      await delay(250);
    }
    throw new Error('Recovery result unknown; inspect the same job before retrying');
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = {};
  const flags = { '--url': 'url', '--state-directory': 'stateDirectory', '--origin': 'origin', '--job-id': 'jobId', '--version': 'version', '--build-id': 'buildId', '--recovery-id-file': 'recoveryIdFile' };
  try {
    for (let i = 2; i < process.argv.length; i += 2) {
      if (!flags[process.argv[i]] || !process.argv[i + 1]) throw new Error('Invalid recovery arguments');
      options[flags[process.argv[i]]] = process.argv[i + 1];
    }
    console.log(JSON.stringify(await recoverLocalServer(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
