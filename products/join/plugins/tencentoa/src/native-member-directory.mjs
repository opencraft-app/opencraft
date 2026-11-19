import {createHash} from 'node:crypto';
import {createRtxDirectoryResolver, resolveRtxAssociation, normalizeRtx} from './rtx-directory.mjs';

/** Reverse bridge for native Actors. Hints only select a trusted directory key;
 * neither caller labels nor directory names establish an OA subject. */
export function createNativeMemberEvidence(identityDirectory, employeeForRtx, corpId, now = Date.now) {
  return async (members, signal) => {
    if (!/^wx[a-z0-9]+$/iu.test(corpId)) throw Error('ioa_member_corp_invalid');
    const principals = await identityDirectory.knownPrincipals();
    if (!Array.isArray(principals)) throw Error('ioa_directory_unavailable');
    const resolve = createRtxDirectoryResolver({knownPrincipals:async()=>principals,
      read:key=>identityDirectory.read(key),evaluate:(...args)=>identityDirectory.evaluate(...args)}, {now});
    // Only the authenticated installation's IOA owner may supply this metadata.
    // It is stored as directory association, never as a login Principal/session.
    async function retainAdmission(rtx, subject, key) {
      const identity={provider:'tencentoa',subject,attributes:{loginName:rtx},aliases:['login:'+rtx]};
      for(let attempt=0;attempt<8;attempt++) {
        const raw=await identityDirectory.read(key);
        let stored;
        try {stored=raw===null?null:JSON.parse(raw);} catch {stored={state:'conflict'};}
        const prior=resolveRtxAssociation(rtx,principals,stored,now());
        const admitted=resolveRtxAssociation(rtx,principals,identity,now());
        const conflict=prior.state==='conflict'||admitted.state!=='resolved'
          ||(prior.state==='resolved'&&prior.identity.subject!==subject);
        const next=JSON.stringify(conflict?{state:'conflict'}:admitted.identity);
        if(raw===next||Number(await identityDirectory.evaluate(
          "local old=redis.call('GET',KEYS[1]);if (old or '')~=ARGV[1] then return 0 end;redis.call('SET',KEYS[1],ARGV[2]);return 1",
          [key],[raw??'',next]))===1)return !conflict;
      }
      throw Error('ioa_directory_contended');
    }
    const candidates = [];
    for (let offset = 0; offset < members.length; offset += 8) {
      signal?.throwIfAborted();
      const batch = await Promise.all(members.slice(offset, offset + 8).map(async member => {
        const rtxs = new Set(principals.filter(p => p?.provider === 'tencentoa' && p.subject === member.subject
          && Number.isFinite(p.expiresAt) && p.expiresAt > now()
          && normalizeRtx(p.attributes?.loginName) && Array.isArray(p.aliases)
          && p.aliases.includes('login:' + normalizeRtx(p.attributes.loginName)))
          .map(p => normalizeRtx(p.attributes.loginName)));
        const hint = normalizeRtx(member.rtxHint);
        if (hint) rtxs.add(hint);
        const admissionRtx=member.identitySource==='ioa-admission'?normalizeRtx(member.rtx):null;
        if(admissionRtx) {
          rtxs.add(admissionRtx);
          const admissionKey='wecom-directory:v1:identity:'+createHash('sha256').update(JSON.stringify(['wecom',corpId,admissionRtx])).digest('hex');
          if(!await retainAdmission(admissionRtx,member.subject,admissionKey))return null;
        }
        const matches = [];
        for (const rtx of rtxs) {
          const key = 'wecom-directory:v1:identity:' + createHash('sha256').update(JSON.stringify(['wecom',corpId,rtx])).digest('hex');
          const result = await resolve(rtx, key);
          // Existing resolver retains conflicts and verifies loginName + login:alias.
          if (result.state === 'resolved' && result.identity.subject === member.subject) matches.push(rtx);
        }
        if (matches.length !== 1) return null;
        const rtx = matches[0], observedAt = now();
        let employee;
        try { employee = await employeeForRtx(rtx, signal); } catch { return null; }
        if (employee?.corpId !== corpId || employee.rtx !== rtx || typeof employee.userId !== 'string'
          || !/^[A-Za-z0-9_.@-]{1,64}$/u.test(employee.userId) || /^(wb|fw|external:)/iu.test(employee.userId)) return null;
        const expiresAt = observedAt + 60000;
        if (expiresAt <= now()) return null;
        return {actorId:member.actorId,subject:member.subject,rtx,userId:employee.userId,expiresAt};
      }));
      candidates.push(...batch.filter(Boolean));
    }
    signal?.throwIfAborted();
    // A response must never associate the same account with different people.
    const conflicts = new Set();
    for (const field of ['actorId','subject','rtx','userId']) {
      const seen = new Map();
      for (const member of candidates) {
        const previous = seen.get(member[field]);
        if (previous && (previous.actorId !== member.actorId || previous.subject !== member.subject
          || previous.rtx !== member.rtx || previous.userId !== member.userId)) {
          conflicts.add(previous); conflicts.add(member);
        } else seen.set(member[field], member);
      }
    }
    // Another assertion in this batch may have exposed a conflict after an
    // earlier directory read. Recheck retained state before issuing evidence.
    const verified=await Promise.all(candidates.map(async member=>{
      const key='wecom-directory:v1:identity:'+createHash('sha256').update(JSON.stringify(['wecom',corpId,member.rtx])).digest('hex');
      const result=await resolve(member.rtx,key);
      return result.state==='resolved'&&result.identity.subject===member.subject;
    }));
    signal?.throwIfAborted();
    return {corpId, members:candidates.filter((m,i) => verified[i] && !conflicts.has(m) && m.expiresAt > now())};
  };
}
