import { join, isAbsolute } from 'node:path';
import { fullReleaseTrust } from '../full-release/trust.mjs';
import { copyPreparedTree } from '../full-release/prepared-tree.mjs';
import { readReplayState, writeReplayState } from '../full-release/archive.mjs';
import { inspectRelease } from './releases.mjs';

export function createLocalTreeReleaseSource(tree, manifestSha256, { stateFile } = {}) {
  if (!fullReleaseTrust || typeof tree !== 'string' || !isAbsolute(tree) || !/^[a-f0-9]{64}$/.test(manifestSha256)) throw new Error('Signed local tree requires fixed trust, an absolute path and manifest digest');
  return {
    async prepare(selected, staging) {
      const target = join(staging, 'unpacked/package');
      const accepted = await copyPreparedTree(tree, target, fullReleaseTrust, { expectedManifestSha256: manifestSha256, state: await readReplayState(stateFile) });
      const release = await inspectRelease(target);
      if (release.version !== selected.version || release.buildId !== selected.buildId) throw new Error('Prepared tree differs from requested release');
      if (stateFile) await writeReplayState(stateFile, accepted.state);
      return { ...release, fullRelease: { manifestSha256: accepted.state.manifestSha256,
        releaseId: accepted.record.release.releaseId, releaseSequence: accepted.record.release.releaseSequence,
        authorization: 'verified-installation' } };
    },
  };
}
