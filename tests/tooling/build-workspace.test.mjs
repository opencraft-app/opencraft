import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildPaths,validateBuildVolume} from '../../scripts/build-workspace.mjs';

const metadata={schemaVersion:1,purpose:'opencraft-build',filesystemUuid:'ff2b5c55-9da9-483f-956a-e08c896aca5d'};
const mount='40 30 253:17 / /data/build rw,noatime - ext4 /dev/vdb1 rw\n';
const options={mountInfo:mount,metadata,device:2,parentDevice:1};
test('build volume accepts a separate writable mounted filesystem, including a container bind mount',()=>{
  assert.equal(validateBuildVolume('/data/build',options),metadata);
  assert.equal(validateBuildVolume('/data/build',{...options,mountInfo:mount.replace(' / /data/build ',' /build /data/build ')}),metadata);
});
test('missing mount, root-disk directory and read-only mount refuse builds',()=>{
  for(const value of [{...options,mountInfo:''},{...options,device:1},{...options,mountInfo:mount.replace('rw,noatime','ro,noatime')}]) assert.throws(()=>validateBuildVolume('/data/build',value),/refusing/);
  assert.throws(()=>validateBuildVolume('/',options),/absolute dedicated/);
});
test('unprovisioned volumes do not become build storage just because a disk is mounted',()=>{
  assert.throws(()=>validateBuildVolume('/data/build',{...options,metadata:undefined}),/identity/);
  assert.throws(()=>validateBuildVolume('/data/build',{...options,metadata:{...metadata,purpose:'unrelated'}}),/identity/);
});
test('tool caches and temporary paths stay on the build volume and isolate users',()=>{
  const paths=buildPaths('/data/build',994),other=buildPaths('/data/build',0);
  assert.ok(Object.values(paths).every(path=>path==='/data/build'||path.startsWith('/data/build/')));
  assert.notEqual(paths.npm_config_cache,other.npm_config_cache);
  assert.equal(paths.npm_config_cache,paths.NPM_CONFIG_CACHE);
  assert.equal(paths.TMPDIR,paths.TEMP);
});
