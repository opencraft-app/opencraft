import assert from 'node:assert/strict';
import test from 'node:test';
import { AnnouncementCenter } from '../../packages/extension-runtime/src/announcement-center';
const owner={extensionId:'test.plugin',activationId:'test',generation:1};
test('announcement messages are validated and frozen with their owner',async()=>{
 const center=new AnnouncementCenter();const titleMessage={id:'title',defaultMessage:'Title'};const labelMessage={id:'done',defaultMessage:'Done'};
 const result=center.show(owner,{id:'test.plugin.guide',title:'Title',titleMessage,primaryAction:{id:'done',label:'Done',labelMessage}});
 titleMessage.defaultMessage='changed';labelMessage.defaultMessage='changed';
 const entry=center.getSnapshot().announcements[0]!;
 assert.equal(entry.contribution.titleMessage?.defaultMessage,'Title');assert.equal(entry.contribution.primaryAction?.labelMessage?.defaultMessage,'Done');
 assert(Object.isFrozen(entry.contribution.titleMessage));assert(Object.isFrozen(entry.contribution.primaryAction?.labelMessage));
 center.dismissOwner(owner);assert.deepEqual(await result,{kind:'dismissed',reason:'owner-disposed'});
 assert.throws(()=>center.show(owner,{id:'test.plugin.bad',title:'Title',titleMessage:{id:'',defaultMessage:'Title'}}),/must not be empty/);
});
test('navigation hints can only anchor to their own extension namespace',async()=>{
 const center=new AnnouncementCenter();
 assert.throws(()=>center.show(owner,{id:'test.plugin.guide',title:'Title',anchorNavigationId:'another.plugin.entry'}));
 assert.throws(()=>center.show(owner,{id:'test.plugin.guide',title:'Title',anchorNavigationId:''}));
 const result=center.show(owner,{id:'test.plugin.guide',title:'Title',anchorNavigationId:'test.plugin.entry'});
 const entry=center.getSnapshot().announcements[0]!;
 assert.equal(entry.contribution.anchorNavigationId,'test.plugin.entry');
 center.dismissOwner(owner);
 assert.deepEqual(await result,{kind:'dismissed',reason:'owner-disposed'});
});
test('interactive previews stay in same-origin document space and are frozen',async()=>{
 const center=new AnnouncementCenter();
 for(const path of ['https://external.test/demo','//external.test/demo','javascript:alert(1)','/demo#secret','/demo/../__rpc','/demo\\other']) {
  assert.throws(()=>center.show(owner,{id:'test.plugin.preview',title:'Preview',preview:{path}}),undefined,path);
 }
 const preview={path:'/local/example?hostId=demo'};const pending=center.show(owner,{id:'test.plugin.preview',title:'Preview',preview});preview.path='/changed';
 const saved=center.getSnapshot().announcements[0]!.contribution.preview!;assert.equal(saved.path,'/local/example?hostId=demo');assert(Object.isFrozen(saved));center.dismissOwner(owner);await pending;
});
