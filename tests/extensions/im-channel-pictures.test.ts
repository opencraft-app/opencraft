import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { BlobResourceService } from '@opencraft/blob-resources';
import { ExtensionSupervisor, type TrustedExtensionApiV1 } from '@opencraft/extension-runtime';
import type { ChannelsClient } from '../../plugins/im/src/channel-client';
import { createChannelPictures, type ChannelPictures, type ChannelPictureSnapshot } from '../../plugins/im/src/channel-pictures';

function fakeClient() {
  const calls: string[] = [];
  const client = {
    image: async (group: string, sequence: number) => { calls.push(`image:${group}:${sequence}`); return new Blob(['png'], { type: 'image/png' }); },
    attachment: async (group: string, sequence: number) => { calls.push(`attachment:${group}:${sequence}`); return new Blob(['jpg']); },
  } as unknown as ChannelsClient;
  return { client, calls };
}

function ready(pictures: ChannelPictures, resource: ReturnType<ChannelPictures['resource']>): Promise<ChannelPictureSnapshot> {
  return new Promise((resolve, reject) => {
    let release = () => {};
    const check = () => {
      const snapshot = pictures.getSnapshot(resource);
      if (snapshot.status === 'loading') return;
      queueMicrotask(release);
      if (snapshot.status === 'ready') resolve(snapshot); else reject(snapshot.error);
    };
    release = pictures.subscribe(resource, check);
    check();
  });
}

for (const shared of [false, true]) {
  test(`channel pictures survive row recycling (${shared ? 'application blob service' : 'standalone store'})`, async () => {
    const context = new Context();
    let blobs: BlobResourceService | undefined;
    if (shared) { await context.plugin(BlobResourceService, {}); blobs = (context as unknown as { blobResources: BlobResourceService }).blobResources; }
    const { client, calls } = fakeClient();
    const owner = new AbortController();
    let scope = 'account-a';
    const pictures = createChannelPictures({ client, blobs, signal: owner.signal, scope: () => scope });
    const target = { group: 'g1', sequence: 7, kind: 'image' as const };
    const resource = pictures.resource(target);
    assert.equal(pictures.getSnapshot(resource).status, 'loading', 'a cold row starts pending');
    const first = await ready(pictures, resource);
    assert.match(first.value!.source, /^blob:/);
    // The row unmounted (its subscription is gone); a remount reads the decoded result synchronously.
    const remount = pictures.getSnapshot(pictures.resource(target));
    assert.equal(remount.status, 'ready');
    assert.equal(remount.value!.source, first.value!.source);
    await ready(pictures, pictures.resource(target));
    assert.deepEqual(calls, ['image:g1:7'], 'recycled rows do not download again');
    // Attachment previews are a separate representation of the message.
    const attachment = await ready(pictures, pictures.resource({ ...target, kind: 'attachment', mime: 'image/jpeg' }));
    assert.notEqual(attachment.value!.source, first.value!.source);
    // A different authenticated channel identity never reuses another account's picture.
    scope = 'account-b';
    assert.equal(pictures.getSnapshot(pictures.resource(target)).status, 'loading');
    owner.abort();
    assert.equal(pictures.getSnapshot(resource).status, 'unavailable', 'closing the views releases every picture');
    await context.dispose?.();
  });
}

test('trusted extensions receive the application blob service only when the host provides it', async () => {
  const blobResources = {} as BlobResourceService;
  const activate = async (supervisor: ExtensionSupervisor) => {
    let api!: TrustedExtensionApiV1;
    await supervisor.activate({ manifest: { manifestVersion: 1, id: 'test.blobs', name: 'blobs', version: '1.0.0', apiVersion: 1,
      trust: 'trusted', platforms: ['web'], activationEvents: ['onStartupFinished'] }, activate(value) { api = value; } });
    await supervisor.dispose();
    return api;
  };
  assert.equal((await activate(new ExtensionSupervisor({ platform: 'web', blobResources }))).blobResources, blobResources);
  assert.equal((await activate(new ExtensionSupervisor({ platform: 'web' }))).blobResources, undefined);
});

for(const shared of [false,true])test('membership revocation clears retained media for only one group; a later authorized rejoin can reload (shared='+shared+')',async()=>{
 const {client,calls}=fakeClient(),owner=new AbortController();
 const context=new Context();let blobs:BlobResourceService|undefined;
 if(shared){await context.plugin(BlobResourceService,{});blobs=(context as unknown as {blobResources:BlobResourceService}).blobResources;}
 const pictures=createChannelPictures({client,scope:()=> 'lifecycle',signal:owner.signal,blobs});
 const first=pictures.resource({group:'departed',sequence:1,kind:'image'}),other=pictures.resource({group:'retained',sequence:2,kind:'image'});
 await ready(pictures,first);await ready(pictures,other);assert.equal(pictures.getSnapshot(first).status,'ready');
 pictures.revoke('departed');assert.equal(pictures.getSnapshot(first).status,'unavailable');assert.equal(pictures.getSnapshot(other).status,'ready');
 const before=calls.length;await assert.rejects(pictures.resources.read({group:'departed',sequence:1,kind:'image'},owner.signal));assert.equal(calls.length,before);
 pictures.restore('departed');await ready(pictures,first);assert.equal(pictures.getSnapshot(first).status,'ready');assert.ok(calls.length>before);
 owner.abort();await context.dispose?.();
});
