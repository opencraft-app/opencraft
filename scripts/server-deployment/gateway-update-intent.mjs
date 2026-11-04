import { readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Observation only: this receipt never authorizes stopping or taking a lock. */
export async function withGatewayUpdateIntent(link, release, restart) {
  const path = `${link}.restart.json`, temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ updateId: randomUUID(), at: Date.now(), targetRoot: release.releaseRoot, buildId: release.buildId }), { mode: 0o600 });
    await rename(temporary, path);
    return await restart();
  } finally { await rm(temporary, { force: true }); await rm(path, { force: true }); }
}
export async function readGatewayUpdateIntent(executable = process.argv[1], now = Date.now()) {
  try {
    const pointer = dirname(dirname(executable));
    const intent = JSON.parse(await readFile(`${pointer}.restart.json`, 'utf8'));
    if (!/^[a-f0-9-]{36}$/u.test(intent.updateId) || !Number.isFinite(intent.at) || now < intent.at || now - intent.at > 120000
      || typeof intent.buildId !== 'string' || !/^[a-zA-Z0-9_.:+-]{1,128}$/u.test(intent.buildId)
      || resolve(pointer, '..', await readlink(pointer)) !== intent.targetRoot) return null;
    const manifest = JSON.parse(await readFile(join(pointer, 'package.json'), 'utf8'));
    if (manifest.opencraftWeb?.buildId !== intent.buildId) return null;
    return { updateId: intent.updateId, buildId: intent.buildId };
  } catch { return null; }
}
