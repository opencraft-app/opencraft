import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConnectedPi} from '../../apps/local-agent-host/src/connected-pi.js';
import {connectedAgentEngineId} from '../../apps/local-agent-host/src/connected-agents.js';

const client={notify(){},async request(){throw Error('No tool owner during discovery');}};
test('native Pi models and defaults appear without copying authentication or importing old sessions',async t=>{
 const root=await mkdtemp(join(tmpdir(),'opencraft-native-pi-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const native=join(root,'native'),directory=join(root,'opencraft');await mkdir(native);await mkdir(directory);
 const models=JSON.stringify({providers:{fixture:{baseUrl:'http://127.0.0.1:9/v1',api:'openai-completions',apiKey:'fixture-native-only',models:[{id:'test',name:'Local Pi model',input:['text'],contextWindow:1000,maxTokens:100,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}});
 const auth='{}',settings=JSON.stringify({defaultProvider:'fixture',defaultModel:'test'});
 await writeFile(join(native,'models.json'),models);await writeFile(join(native,'auth.json'),auth);await writeFile(join(native,'settings.json'),settings);await writeFile(join(native,'old-session.json'),'retained-native-session');
 const engine=await createConnectedPi(directory,root,{homedir:root,env:{PI_CODING_AGENT_DIR:native}});t.after(()=>engine.close());
 const page=await engine.request('model/list',{},client);
 assert.ok(page.data.some((m:any)=>m.id==='pi:fixture:test'&&m.isDefault));
 assert.deepEqual((await engine.request('thread/list',{},client)).data,[]);
 for(const [name,expected] of [['models.json',models],['auth.json',auth],['settings.json',settings],['old-session.json','retained-native-session']])assert.equal(await readFile(join(native,name!),'utf8'),expected);
 const started=await engine.request('thread/start',{model:'pi:fixture:test',cwd:root},client);
 assert.equal(started.thread.cwd,root);assert.equal(started.model,'pi:fixture:test');
 await engine.request('thread/archive',{threadId:started.thread.id},client);
 assert.equal((await readdir(directory)).includes('auth.json'),false);
});

test('local Pi models remain owned by Pi and are not routed to ACP',()=>{
 assert.equal(connectedAgentEngineId('pi:fixture:test'),'pi');assert.equal(connectedAgentEngineId('pi_abc'),'pi');
});
