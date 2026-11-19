import assert from 'node:assert/strict';
import test from 'node:test';
import {createIoaNotificationDefaultTarget} from '../../plugins/tencentoa/src/notification-defaults.mjs';
import {createWeComTurnNotifications} from '../../plugins/wecom/turn-notifications.mjs';

test('iOA defaults require current signed employee identity, unique verified personal WeCom binding and ready Relay',()=>{
  let principal:any={provider:'tencentoa',subject:'staff-a',expiresAt:Date.now()+60000},current=true,ready=false;
  let links=[{provider:'tencentoa',subject:'staff-a'},{provider:'wecom.corp',subject:'self'}];
  const actors={get:()=>({kind:'human',enabled:true}),bindings:()=>links,isCurrent:()=>current};
  const binding:any={context:{actorId:'human-a',credentialId:null}};
  const port=createWeComTurnNotifications({actors,corpId:'corp',ready:()=>ready,deliver:()=>{throw Error('No delivery permitted');}});
  const policy=createIoaNotificationDefaultTarget({actors,resolveIdentity:()=>principal});
  const decide=()=>policy({},binding,port.targets('human-a').map((target:any)=>({kind:'im',...target})));
  assert.equal(decide(),null);ready=true;
  const selected=decide();assert.equal(selected.policyId,'tencentoa.employee.wecom-turn');assert.equal(selected.target.senderId,'self');
  links.push({provider:'wecom.corp',subject:'someone-else'});assert.equal(decide(),null);links.pop();
  links=links.filter(link=>link.provider==='tencentoa');assert.equal(decide(),null);links.push({provider:'wecom.corp',subject:'self'});
  current=false;assert.equal(decide(),false);current=true;
  principal={...principal,subject:'staff-b'};assert.equal(decide(),false);
  principal={...principal,subject:'staff-a',provider:'local'};assert.equal(decide(),false);
  principal={provider:'tencentoa',subject:'staff-a',expiresAt:0};assert.equal(decide(),false);
  principal={...principal,expiresAt:Date.now()+60000};binding.context.credentialId='bot';assert.equal(decide(),false);
});
