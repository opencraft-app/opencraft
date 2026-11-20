import { readdir, stat, readFile, writeFile, mkdtemp, chmod } from 'node:fs/promises';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A build owns artifacts, never the deployment lease. Inspect inherited aliases too. */
export async function assertBuildOutsideDeploymentLock(lockPath) {
  let target;
  try { target = await stat(lockPath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const fd of await readdir('/proc/self/fd')) {
    if (!/^\d+$/.test(fd)) continue;
    try {
      const value = await stat('/proc/self/fd/' + fd);
      if (value.dev !== target.dev || value.ino !== target.ino) continue;
      if (/^lock:\s+.*\bFLOCK\s+ADVISORY\s+WRITE\b/m.test(await readFile('/proc/self/fdinfo/' + fd, 'utf8')))
        throw Error('Build inherited the deployment lock; release it before preparing a candidate');
    } catch (error) { if (!['ENOENT', 'EBADF'].includes(error.code)) throw error; }
  }
}

export async function sealPreparedPlan(planPath, lockPath) {
  await assertBuildOutsideDeploymentLock(lockPath);
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  if (plan.schemaVersion !== 1 || typeof plan.candidateOverride !== 'string' || !isAbsolute(plan.candidateOverride))
    throw Error('A completed candidate plan with an absolute override is required');
  const override = await readFile(plan.candidateOverride);
  // No ready flag or deployment state is created here. The publisher exclusively
  // owns its receipt directory after it acquires the deployment lease.
  const directory = await mkdtemp(join(dirname(planPath), '.prepared-'));
  await chmod(directory, 0o700);
  const candidate = join(directory, 'candidate-override.yaml');
  await writeFile(candidate, override, { mode: 0o400, flag: 'wx' });
  let rollback = plan.rollback;
  if (rollback) {
    if (typeof rollback.override !== 'string' || !isAbsolute(rollback.override)) throw Error('Expected absolute rollback override');
    const path = join(directory, 'rollback-override.yaml');
    await writeFile(path, await readFile(rollback.override), { mode: 0o400, flag: 'wx' });
    rollback = { ...rollback, override: path };
  }
  const path = join(directory, 'plan.json');
  await writeFile(path, JSON.stringify({ ...plan, candidateOverride: candidate, ...(rollback ? { rollback } : {}) }, null, 2) + '\n', { mode: 0o400, flag: 'wx' });
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, planOrLock, lock] = process.argv.slice(2);
  if (mode === 'assert-unlocked' && planOrLock && !lock) await assertBuildOutsideDeploymentLock(resolve(planOrLock));
  else if (mode === 'seal' && planOrLock && lock) console.log(await sealPreparedPlan(resolve(planOrLock), resolve(lock)));
  else throw Error('Usage: prepare.mjs assert-unlocked LOCK | seal PLAN LOCK');
}
