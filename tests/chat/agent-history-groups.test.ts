import test from 'node:test';
import assert from 'node:assert/strict';
import { groupAgentHistory } from '../../apps/workbench-web/src/components/agent-history-groups';
import type { LocalAgentConversation } from '@opencraft/appserver-protocol';
const row = (id:string,cwd:string):LocalAgentConversation => ({id,cwd,title:id,updatedAt:null,imported:false});
test('native projects preserve their identity and order while directory folders remain distinct',()=>{
  const entries=[row('cwd-a','/first/same'),{...row('native','/first/same'),nativeProject:{source:'codex' as const,id:'p',name:'Saved project',position:0}},row('cwd-b','/second/same'),row('other','')];
  const groups=groupAgentHistory([...entries,{...entries[0]!,title:'Latest page title'}]);
  assert.deepEqual(groups.map(g=>g.id),['project:p','cwd:/first/same','cwd:/second/same','ungrouped']);
  assert.equal(groups[1]!.conversations.length,1);
  assert.equal(groups[1]!.conversations[0]!.title,'Latest page title');
  assert.equal(groups[3]!.name,null);
});


test('a filesystem root is a folder rather than an ungrouped conversation',()=>{
  const [root]=groupAgentHistory([row('root','/')]);
  assert.equal(root?.name,'/');
});

test('resume-style search and ordering retain distinct conversations and native dates',async()=>{
 const {filterAgentHistory}=await import('../../apps/workbench-web/src/components/agent-history-groups');
 const entries=[{...row('old','/same'),title:'Renamed session',updatedAt:'2026-11-15T00:00:00Z',createdAt:'2026-10-01T00:00:00Z'}, {...row('new','/same'),title:'Newest created',updatedAt:'2026-11-01T00:00:00Z',createdAt:'2026-11-01T00:00:00Z'}];
 assert.deepEqual(filterAgentHistory(entries,'','updated').map(e=>e.id),['old','new']);
 assert.deepEqual(filterAgentHistory(entries,'','created').map(e=>e.id),['new','old']);
 assert.deepEqual(filterAgentHistory(entries,'renamed','updated').map(e=>e.id),['old']);assert.equal(filterAgentHistory(entries,'/same','updated').length,2);
 assert.equal(entries[0]!.id,'old');
});
