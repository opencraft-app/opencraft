import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createIntl,RawIntlProvider} from 'react-intl';
import {registerHooks} from 'node:module';
const styles=registerHooks({load(url,context,next){return /\.(?:css|scss)$/u.test(new URL(url).pathname)?{format:'module',source:'export default {};',shortCircuit:true}:next(url,context);}});
const {GroupSyncSection,groupSyncSummary}=await import('../../../../plugins/im/src/channel-group-sync');styles.deregister();
(globalThis as {React?:typeof React}).React=React;
const intl=createIntl({locale:'en',messages:{}});
const status={provider:'wecom',configured:true,canRefresh:true,state:'idle' as const,lastSyncedAt:1700000000000,lastAttemptAt:1700000000000,name:'inbound' as const,members:'observe' as const,pendingOperations:0};
const render=(s:any,busy=false,error=false)=>renderToStaticMarkup(<RawIntlProvider value={intl}><GroupSyncSection status={s} busy={busy} error={error} onRefresh={()=>{}}/></RawIntlProvider>);
test('external group sync section shows the last successful time, configured directions and explicit safe policy',()=>{
 const html=render(status);assert.match(html,/Updated /);assert.match(html,/Receive changes from WeCom/);assert.match(html,/Check for changes only/);assert.match(html,/never grants history access or imports members/);assert.match(html,/Check now/);assert.doesNotMatch(html,/<button[^>]*disabled/);
});
test('pending/syncing disable the native button, with accessible live progress instead of claiming success',()=>{
 for(const state of['pending','syncing']){const html=render({...status,state});assert.match(html,/aria-busy="true"/);assert.match(html,/<button[^>]*disabled/);assert.match(html,/role="status"/);assert.match(html,/aria-live="polite"/);}
});
test('unconfigured groups show no fabricated success and nonowners cannot trigger a refresh',()=>{
 const html=render({...status,configured:false,canRefresh:false,lastSyncedAt:null,state:'never',name:'off'});assert.match(html,/Not checked yet/);assert.match(html,/Only the linked group owner/);assert.match(html,/<button[^>]*disabled/);
});
test('request failures retain the last success and offer a retry rather than a false completed state',()=>{
 const html=render(status,false,true);assert.match(html,/Could not check/);assert.match(html,/Updated /);assert.doesNotMatch(html,/Up to date/);assert.doesNotMatch(html,/<button[^>]*disabled/);
});

test('checks without configured inbound directions never imply active sync',()=>{
 for(const value of [{...status,configured:false},{...status,name:'off',members:'observe'}]){const html=render(value);assert.match(html,/Check complete/);assert.match(html,/Checked /);assert.doesNotMatch(html,/Up to date/);assert.match(html,/<details>/);assert.doesNotMatch(html,/<details open/);}
});
test('nonowners can retry a failed status read without gaining refresh permission',()=>{const html=renderToStaticMarkup(<RawIntlProvider value={intl}><GroupSyncSection status={{...status,canRefresh:false}} error readFailed onRefresh={()=>{}}/></RawIntlProvider>);assert.doesNotMatch(html,/<button[^>]*disabled/);assert.match(html,/Retry/);});

test('delivery failure names the affected action, explains owner privilege and offers a read-only check',()=>{
 const html=render({...status,state:'error',deliveryIssue:{action:'remove',reason:'owner_required'}});
 assert.match(html,/Remove member/);assert.match(html,/WeCom requires group owner privileges/);assert.match(html,/OpenCraft change has taken effect/);
 assert.match(html,/Adding members and renaming are checked independently/);assert.match(html,/Check now/);assert.doesNotMatch(html,/>Retry<|Up to date/);
 assert.match(html,/does not resend failed changes/);
});

test('group overview uses the same attention and check-only semantics as connection details',()=>{
 const state={status:{...status,state:'error' as const,deliveryIssue:{action:'remove' as const,reason:'owner_required' as const}}};
 assert.match(groupSyncSummary(intl,state as any)!,/Some changes have not synced/);
 assert.match(groupSyncSummary(intl,{status:{...status,configured:false}} as any)!,/Check complete/);
});
