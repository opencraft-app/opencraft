import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {AccountPoolStore,CodexAccountPoolProxy} from '../../packages/account-pool-host/src/index.js';

test('personal subscriptions persist ownership and never fall back to platform or another Human',async t=>{
  const root=await mkdtemp(join(tmpdir(),'human-account-owner-'));
  const options={databasePath:join(root,'accounts.sqlite'),secretsDirectory:join(root,'secrets')};
  const platform=new AccountPoolStore(options),alice=new AccountPoolStore({...options,ownerActor:'alice'}),bob=new AccountPoolStore({...options,ownerActor:'bob'});
  t.after(async()=>{platform.close();alice.close();bob.close();await rm(root,{recursive:true,force:true});});
  for(const [store,id] of [[platform,'platform'],[alice,'alice'],[bob,'bob']] as const)store.addAccount({id,provider:'codex',label:id,upstreamAccountId:'same-upstream-account',priority:1,enabled:true},{accessToken:id+'-secret',refreshToken:null,expiresAt:null});
  for(const [store,id] of [[platform,'platform'],[alice,'alice'],[bob,'bob']] as const){
    assert.deepEqual(store.listAccounts().map(a=>a.id),[id]);
    assert.deepEqual(store.listAccountStates().map(a=>a.accountId),[id]);
    assert.equal(store.select({provider:'codex',hostId:'host',affinityId:'same-thread'}).account.id,id);
    for(const other of ['platform','alice','bob'].filter(x=>x!==id)){
      assert.throws(()=>store.readCredential(other),/not found/);
      assert.throws(()=>store.setEnabled(other,false),/not found/);
      assert.throws(()=>store.setAllowCredits(other,true),/not found/);
      assert.throws(()=>store.removeAccount(other),/not found/);
      assert.throws(()=>store.clearExternalAuthorizationError(other),/not found/);
    }
  }
  alice.setEnabled('alice',false);
  assert.throws(()=>alice.select({provider:'codex',hostId:'host',affinityId:'new-thread'}));
  assert.equal(platform.select({provider:'codex',hostId:'host',affinityId:'same-thread'}).account.id,'platform');
  const reopened=new AccountPoolStore({...options,ownerActor:'alice'});
  try{assert.deepEqual(reopened.listAccounts().map(a=>a.id),['alice']);assert.equal(reopened.getAccount('alice').enabled,false);}finally{reopened.close();}
});

test('private subscription proxy tokens cannot authenticate on platform or another private proxy',async t=>{
  const root=await mkdtemp(join(tmpdir(),'human-proxy-owner-'));
  const options={databasePath:join(root,'accounts.sqlite'),secretsDirectory:join(root,'secrets')};
  const store=new AccountPoolStore(options);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const privateToken=store.issueHostToken('personal-subscription:alice'),platformToken=store.issueHostToken('local-codex');
  let calls=0;
  const common={store,upstreamBaseUrl:'https://unused.invalid',fetch:async()=>{calls++;return Response.json({models:[]});}};
  const platform=new CodexAccountPoolProxy(common),privateProxy=new CodexAccountPoolProxy({...common,privateHostId:'personal-subscription:bob'});
  const request=(token:string)=>new Request('http://local/v1/models',{headers:{'x-opencraft-account-pool-token':token}});
  assert.equal((await platform.handle(request(privateToken))).status,401);
  assert.equal((await privateProxy.handle(request(privateToken))).status,401);
  assert.equal((await privateProxy.handle(request(platformToken))).status,401);
  assert.equal(calls,0);
});
