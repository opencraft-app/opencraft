import assert from 'node:assert/strict';
import test from 'node:test';
import { selectWorkspaceManifests } from '../../scripts/check/workspace-typecheck-plan.mjs';

test('typecheck covers exact and nested declared workspace owners without unrelated manifests',()=>{
 const files=['apps/web/package.json','packages/domain/package.json','products/example/package.json','products/example/plugins/identity-example/package.json','products/example/plugins/channel-example/package.json','apps/web/fixtures/package.json','products/other/package.json','package.json',''];
 assert.deepEqual(selectWorkspaceManifests(['apps/*','packages/*','plugins/*','products/example','products/example/plugins/*'],files),files.slice(0,5).sort());
});
test('overlapping workspace patterns and duplicate tracked paths run each owner once',()=>{
 assert.deepEqual(selectWorkspaceManifests(['products/*','products/example'],['products/example/package.json','products/example/package.json']),['products/example/package.json']);
 assert.deepEqual(selectWorkspaceManifests([],['apps/web/package.json']),[]);
});
