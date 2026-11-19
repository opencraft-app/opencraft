import fs from 'node:fs';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
/** IOA-owned durable metadata. The existing admission database is read-only;
 * fresh verified logins are retained independently of optional access policy wiring. */
export function createNativeMemberOwnerDirectory(directory,now=Date.now){
 const file=join(directory,'join-native-member-identities.json'),legacyFile=join(directory,'employee-admission.sqlite');
 let legacy,identities={};
 try{if(fs.existsSync(legacyFile))legacy=new DatabaseSync(legacyFile,{readOnly:true});}catch{}
 try{const data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.schemaVersion===1&&data.identities&&typeof data.identities==='object')identities=data.identities;}catch(e){if(e.code!=='ENOENT')throw e;}
 const valid=(subject,rtx)=>typeof subject==='string'&&/^[1-9][0-9]*$/u.test(subject)&&typeof rtx==='string'&&/^[a-z0-9._-]{1,128}$/u.test(rtx);
 const prior=subject=>{try{return legacy?.prepare('SELECT login_name FROM employee_policy_identities WHERE subject=?').get(subject)?.login_name;}catch{return undefined;}};
 return{
  lookup(subject){
   const names=new Set([...(Array.isArray(identities[subject])?identities[subject]:[]),prior(subject)].filter(rtx=>valid(subject,rtx)));
   if(names.size!==1)return null;const [rtx]=names;
   if(Object.entries(identities).some(([id,names])=>id!==subject&&Array.isArray(names)&&names.includes(rtx)))return null;
   try{if(legacy?.prepare('SELECT subject FROM employee_policy_identities WHERE login_name=? AND subject<>?').get(rtx,subject))return null;}catch{}
   return rtx;
  },
  // Reverse only the same durable, verified association used for native invitations.
  // A conflict is distinct from absence, so a legacy RTX binding cannot mask it.
  resolve(rtx){
   if(typeof rtx!=='string'||!/^[a-z0-9._-]{1,128}$/u.test(rtx))return{state:'unresolved'};
   const subjects=new Set(Object.entries(identities).filter(([,names])=>Array.isArray(names)&&names.includes(rtx)).map(([id])=>id));
   try{for(const row of legacy?.prepare('SELECT subject FROM employee_policy_identities WHERE login_name=?').all(rtx)??[])subjects.add(row.subject);}catch{}
   if(!subjects.size)return{state:'unresolved'};
   const [subject]=subjects;
   return subjects.size===1&&this.lookup(subject)===rtx?{state:'resolved',subject}:{state:'conflict'};
  },
  observe(principal){
   const rtx=typeof principal?.attributes?.loginName==='string'?principal.attributes.loginName.toLowerCase():null;
   if(principal?.provider!=='tencentoa'||!Number.isSafeInteger(principal.expiresAt)||principal.expiresAt<=now()||!valid(principal.subject,rtx)||!Array.isArray(principal.aliases)||!principal.aliases.includes('login:'+rtx))return;
   const names=new Set([...(Array.isArray(identities[principal.subject])?identities[principal.subject]:[]),prior(principal.subject),rtx].filter(v=>valid(principal.subject,v)));
   if(JSON.stringify([...names])===JSON.stringify(identities[principal.subject]))return;
   if(!Object.hasOwn(identities,principal.subject)&&Object.keys(identities).length>=5000)return;
   identities[principal.subject]=[...names];const temporary=file+'.'+process.pid+'.tmp';
   fs.writeFileSync(temporary,JSON.stringify({schemaVersion:1,identities})+'\n',{mode:0o600});fs.renameSync(temporary,file);
  },
  close(){legacy?.close();legacy=undefined;},
 };
}
