/** Presentation-only bridge. Call only with authenticated Relay directory replies.
 * A display name is at most a search hint; the reply must prove the exact OA subject.
 * This module cannot register Actors, bind identities, admit users or grant access. */
export function createAvatarDirectorySync({collaboration,profiles,corpId,request,now=Date.now}) {
  const rtx=value=>typeof value==='string'&&/^[a-z0-9._-]{1,128}$/u.test(value);
  const subject=value=>typeof value==='string'&&/^[1-9][0-9]*$/u.test(value);
  const due=new Map();let busy;
  const current=id=>{const a=collaboration.actors.get(id);return a?.enabled&&a.kind==='human'&&collaboration.admittedActor(id)?a:null;};
  const bindings=id=>collaboration.actors.bindings(id);
  function retain(id,oa,name){
    if(!current(id)||!bindings(id).some(b=>b.provider==='tencentoa'&&b.subject===oa))return false;
    const prior=profiles.forActor(collaboration.actors,id,new Map());
    // Contradictory trusted metadata needs identity repair, not a silent photo rewrite.
    if(prior&&prior.name!==name)return false;
    profiles.remember(JSON.stringify(['tencentoa',oa]),name);
    if(!prior)collaboration.channels?.identityChanged?.(id);
    return !prior;
  }
  function observeGroup(source,snapshot,evidence){
    let parts;try{parts=JSON.parse(source);}catch{return 0;}
    if(!Array.isArray(parts)||parts.length!==4||parts[0]!=='wecom-customer-service'||parts[1]!==corpId
      ||snapshot?.externalId!==parts[3]||!Array.isArray(snapshot.memberIds)||evidence?.source!==source
      ||!Array.isArray(evidence.members)||evidence.members.length>2000)return 0;
    const ids=new Set(snapshot.memberIds),users=new Set(),names=new Set(),subjects=new Set();
    for(const m of evidence.members){
      if(!m||typeof m.userId!=='string'||!ids.has(m.userId)||/^(wb|fw|external:)/iu.test(m.userId)
        ||!rtx(m.rtx)||m.subject!==null&&!subject(m.subject)||!Number.isSafeInteger(m.expiresAt)
        ||m.expiresAt>now()+60000||users.has(m.userId)||names.has(m.rtx)||m.subject!==null&&subjects.has(m.subject))return 0;
      users.add(m.userId);names.add(m.rtx);if(m.subject!==null)subjects.add(m.subject);
    }
    let changed=0;
    for(const m of evidence.members){
      if(m.expiresAt<=now())continue;
      const byWecom=collaboration.actors.findHuman({provider:'wecom.'+corpId,subject:m.userId});
      const byOa=m.subject===null?null:collaboration.actors.findHuman({provider:'tencentoa',subject:m.subject});
      if(byWecom&&byOa&&byWecom.id!==byOa.id)continue;
      const actor=byOa??byWecom;if(!actor||!current(actor.id))continue;
      const oa=bindings(actor.id).filter(b=>b.provider==='tencentoa'&&subject(b.subject));
      if(oa.length!==1||m.subject!==null&&m.subject!==oa[0].subject)continue;
      if(retain(actor.id,oa[0].subject,m.rtx))changed++;
    }
    return changed;
  }
  async function refresh(humans,signal){
    if(busy)return busy;
    busy=(async()=>{
      signal?.throwIfAborted();
      const owner=Object.values(humans??{}).flatMap(id=>current(id)?bindings(id).filter(b=>b.provider==='wecom.'+corpId).map(b=>b.subject):[])[0];
      if(!owner)return 0;
      const candidates=collaboration.actors.list().filter(a=>current(a.id)&&!profiles.forActor(collaboration.actors,a.id,new Map()))
        .flatMap(a=>{const oa=bindings(a.id).filter(b=>b.provider==='tencentoa'&&subject(b.subject));
          return oa.length===1?[{actorId:a.id,subject:oa[0].subject,generation:a.generation,hint:a.displayName?.toLowerCase()}]:[];});
      const live=new Set(candidates.map(c=>c.actorId));for(const id of due.keys())if(!live.has(id))due.delete(id);
      const selected=candidates.filter(c=>(due.get(c.actorId)??0)<=now()).slice(0,16);
      if(!selected.length)return 0;
      for(const c of selected)due.set(c.actorId,now()+5*60000);
      // An untrusted hint only selects a key. The existing Relay resolves it
      // against trusted OA claims, exact subjects and bidirectional WeCom directory.
      const result=await request('native-member-resolve',{owner,members:selected.map(c=>({actorId:c.actorId,subject:c.subject,...(rtx(c.hint)?{rtxHint:c.hint}:{})}))},signal);
      signal?.throwIfAborted();
      if(result?.corpId!==corpId||!Array.isArray(result.members)||result.members.length>selected.length)return 0;
      const seen=new Set(),names=new Set(),users=new Set();
      for(const m of result.members){
        const c=selected.find(c=>c.actorId===m?.actorId&&c.subject===m.subject);
        if(!c||!rtx(m.rtx)||typeof m.userId!=='string'||!/^[A-Za-z0-9_.@-]{1,64}$/u.test(m.userId)
          ||/^(wb|fw|external:)/iu.test(m.userId)||!Number.isSafeInteger(m.expiresAt)||m.expiresAt>now()+60000
          ||seen.has(m.actorId)||names.has(m.rtx)||users.has(m.userId))return 0;
        seen.add(m.actorId);names.add(m.rtx);users.add(m.userId);
      }
      let changed=0;
      for(const m of result.members){
        const c=selected.find(c=>c.actorId===m.actorId),actor=current(m.actorId);
        if(m.expiresAt<=now()||!actor||actor.generation!==c.generation)continue;
        const linked=collaboration.actors.findHuman({provider:'wecom.'+corpId,subject:m.userId});
        if(linked&&linked.id!==actor.id)continue;
        if(retain(actor.id,m.subject,m.rtx))changed++;
      }
      return changed;
    })();
    try{return await busy;}finally{busy=undefined;}
  }
  return {observeGroup,refresh};
}
