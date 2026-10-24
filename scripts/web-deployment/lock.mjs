import { mkdir, readdir, writeFile, unlink } from 'node:fs/promises';
import { randomUUID, randomInt } from 'node:crypto';
import { join } from 'node:path';

// Each claimant owns a unique filename. A claimant must see no other live
// claimant before proceeding. Concurrent contenders may both retry, but cannot
// both win: a later directory scan observes the earlier claimant's entry.
// Stale entries are never reused, so deleting a dead owner's entry cannot
// delete a replacement owner's lock. No shared PID file is unlinked/recreated.
export async function acquireDeploymentLock(directory) {
  const claims = join(directory, 'deployment-lock');
  await mkdir(claims, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 4; attempt++) {
    const filename = `${process.pid}-${randomUUID()}`;
    const path = join(claims, filename);
    await writeFile(path, '', { flag: 'wx', mode: 0o600 });
    let otherLive = false;
    try {
      for (const entry of await readdir(claims)) {
        if (entry === filename) continue;
        if (!/^\d+-[a-f0-9-]{36}$/.test(entry)) throw new Error('Invalid deployment lock entry; inspect the state directory');
        const pid = Number(entry.split('-')[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid deployment lock owner');
        try { process.kill(pid, 0); otherLive = true; }
        catch (error) {
          if (error.code !== 'ESRCH') { otherLive = true; continue; }
          await unlink(join(claims, entry)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      }
      if (!otherLive) {
        let released = false;
        return async () => { if (!released) { released = true; await unlink(path); } };
      }
    } catch (error) { await unlink(path); throw error; }
    await unlink(path);
    if (attempt < 3) await new Promise(done => setTimeout(done, randomInt(25, 100)));
  }
  throw new Error('This deployment is already running');
}
