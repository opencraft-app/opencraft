import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Arguments for the split account Core (model proxy): one definition for the embedded Brain and the proxy service. */
export function codexCoreArguments(paths, root, proxyPort) {
  if (!Number.isSafeInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error('Invalid model proxy port');
  return [
    '--app-server-endpoint', paths.appServerEndpoint, '--proxy-port', String(proxyPort),
    '--endpoint', paths.coreEndpoint, '--token-file', paths.tokenPath,
    '--codex-executable', join(root, 'runtime/codex/bin/codex'),
    '--runtime-directory', paths.runtimeDirectory,
    '--data-directory', join(paths.dataDirectory, 'codex'),
    '--native-codex-home-directory', join(paths.dataDirectory, 'native-codex'),
  ];
}

/** Account-owner readiness only. It does not require the Brain AppServer, so the proxy can start first. */
export async function proxyHealth(endpoint, tokenPath, timeoutMs = 4000) {
  const token = (await readFile(tokenPath, 'utf8')).trim();
  return new Promise((accept, reject) => {
    const req = request({ socketPath: endpoint, path: '/owner-handoff', headers: { authorization: `Bearer ${token}` } }, response => {
      let data = '';
      response.setEncoding('utf8');
      // The handoff snapshot carries the retained uncertainty ledger (hundreds of KB live); bound it like the Core does.
      response.on('data', chunk => { data += chunk; if (data.length > 64 * 1024 * 1024) req.destroy(new Error('Invalid model proxy health')); });
      response.on('end', () => {
        try {
          const value = JSON.parse(data);
          if (response.statusCode !== 200 || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.handoff?.phase !== 'open') throw new Error();
          accept({ pid: value.pid, phase: value.handoff.phase });
        } catch { reject(new Error('Model proxy is not serving accounts')); }
      });
      response.on('error', reject);
    });
    req.on('error', () => reject(new Error('Model proxy health request failed')));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Model proxy health timeout')));
    req.end();
  });
}

export async function waitForProxy(endpoint, tokenPath, { attempts = 240, delayMs = 500, signal } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts && !signal?.aborted; attempt++) {
    try { return await proxyHealth(endpoint, tokenPath); }
    catch (error) { last = error; await new Promise(accept => setTimeout(accept, delayMs)); }
  }
  throw new Error(`Model proxy did not become ready: ${last?.message ?? 'cancelled'}`);
}
