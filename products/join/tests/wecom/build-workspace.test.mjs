import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import{join}from'node:path';import{verifyWorkspaceBindings}from'../../build-workspace-guard.mjs';
test('gateway build refuses reused workspace links from a different source assembly',t=>{
 const root=fs.mkdtempSync(join(os.tmpdir(),'workspace-bindings-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(join(root,'package.json'),JSON.stringify({workspaces:['packages/*']}));fs.mkdirSync(join(root,'packages/current'),{recursive:true});fs.mkdirSync(join(root,'node_modules/@fixture'),{recursive:true});fs.mkdirSync(join(root,'old'));
 fs.writeFileSync(join(root,'packages/current/package.json'),JSON.stringify({name:'@fixture/current'}));fs.symlinkSync(join(root,'old'),join(root,'node_modules/@fixture/current'));
 assert.throws(()=>verifyWorkspaceBindings(root),/outside the selected source assembly/u);fs.unlinkSync(join(root,'node_modules/@fixture/current'));fs.symlinkSync(join(root,'packages/current'),join(root,'node_modules/@fixture/current'));assert.doesNotThrow(()=>verifyWorkspaceBindings(root));
});
