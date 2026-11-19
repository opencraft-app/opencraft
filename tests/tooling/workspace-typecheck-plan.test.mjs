import assert from 'node:assert/strict';
import test from 'node:test';
import { selectWorkspaceManifests } from '../../scripts/workspace-typecheck-plan.mjs';

test('typecheck covers exact and nested declared workspace owners without unrelated manifests',()=>{
 const files=['apps/web/package.json','packages/domain/package.json','products/join/package.json','products/join/plugins/ioa/package.json','products/join/plugins/wecom/package.json','apps/web/fixtures/package.json','products/other/package.json','package.json',''];
 assert.deepEqual(selectWorkspaceManifests(['apps/*','packages/*','plugins/*','products/join','products/join/plugins/*'],files),files.slice(0,5).sort());
});
test('overlapping workspace patterns and duplicate tracked paths run each owner once',()=>{
 assert.deepEqual(selectWorkspaceManifests(['products/*','products/join'],['products/join/package.json','products/join/package.json']),['products/join/package.json']);
 assert.deepEqual(selectWorkspaceManifests([],['apps/web/package.json']),[]);
});
