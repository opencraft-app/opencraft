import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {joinProductPluginBuilds} from '../plugin-packs/builds.mjs';
const read=path=>readFile(new URL(path,import.meta.url),'utf8');
test('standard Join never selects Vela Overview or bundled Tasks presentation',async()=>{
 assert.deepEqual(joinProductPluginBuilds,[]);
 assert.doesNotMatch(await read('../web.ts'),/projectOverview|proj-overview/);
 assert.match(await read('../vite.config.mjs'),/tasksPresentation: false/);
 assert.doesNotMatch(await read('../vite.config.mjs'),/tasks: false/);
});
test('task workflow ports remain host-owned and renderer-only code is demand-loaded',async()=>{
 const supervisor=await read('../../../apps/workbench-web/src/runtime/web-workbench-supervisor.ts');
 assert.match(supervisor,/tasks: createTasksPorts/);
 assert.match(supervisor,/VITE_INCLUDE_TASKS_PRESENTATION/);
 const bridge=await read('../../../apps/workbench-web/src/runtime/trusted-renderer-host.ts');
 assert.doesNotMatch(bridge,/import \* as extensionReact/);
 assert.match(bridge,/services:Object.freeze/);
});
