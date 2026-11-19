import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRtxMemberEvidence} from '../../plugins/tencentoa/src/rtx-directory.mjs';
const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']);
const principal={provider:'tencentoa',subject:'110337',displayName:'ruippan',attributes:{loginName:'ruippan'},aliases:['login:ruippan'],expiresAt:2000};
const key='wecom-directory:v1:identity:'+createHash('sha256').update(JSON.stringify(['wecom','wxfixture','ruippan'])).digest('hex');
const store=(claims,seed)=>{const rows=new Map(seed?[[key,JSON.stringify(seed)]]:[]);return{knownPrincipals:async()=>claims,read:async k=>rows.get(k)??null,evaluate:async(_script,[k],[old,next])=>{if((rows.get(k)??'')!==old)return 0;rows.set(k,next);return 1;}}};
test('durable IOA account mapping survives browser expiry without issuing a login',async()=>{
 const redis=store([],principal);const resolve=createRtxMemberEvidence(redis,async()=> 'ruippan',()=>3000);
 const value=await resolve(source,['T03370011A']);assert.deepEqual(value.members,[{userId:'T03370011A',rtx:'ruippan',subject:'110337',expiresAt:63000}]);
 assert.equal(value.members[0].token,undefined);
});
test('unmapped employees stay unresolved, conflicting current staffId does not rebind',async()=>{
 assert.deepEqual((await createRtxMemberEvidence(store([],null),async()=> 'ruippan',()=>1000)(source,['T03370011A'])).members,[]);
 assert.deepEqual((await createRtxMemberEvidence(store([{...principal,subject:'999'}],principal),async()=> 'ruippan',()=>1000)(source,['T03370011A'])).members,[]);
});
