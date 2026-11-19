/** Installation-owned directory evidence links existing OA Actors; labels are lookup hints only. */
export async function resolveNativeMemberIdentities(collaboration, request, corpId, group, now=Date.now, resolveRtx) {
  if(!group.members.length)return;
  const members=group.members.map(({actorId,subject})=>{
    const rtx=resolveRtx?.(subject);
    return{actorId,subject,...(typeof rtx==='string'&&/^[a-z0-9._-]{1,128}$/u.test(rtx)?{rtx,identitySource:'ioa-admission'}:{})};
  });
  const result=await request('native-member-resolve',{owner:group.owner,members});
  if(result?.corpId!==corpId||!Array.isArray(result.members)||result.members.length>group.members.length)throw Error('wecom_member_evidence_invalid');
  const seen=new Set(),userIds=new Set();
  for(const m of result.members){
    const selected=group.members.find(c=>c.actorId===m?.actorId&&c.subject===m.subject);
    const verified=members.find(c=>c.actorId===m?.actorId)?.rtx;
    if(!selected||seen.has(m.actorId)||userIds.has(m.userId)||(verified&&verified!==m.rtx)||typeof m.rtx!=='string'||!/^[a-z0-9._-]{1,128}$/u.test(m.rtx)
      ||typeof m.userId!=='string'||!/^[A-Za-z0-9._-]{1,128}$/u.test(m.userId)||/^(wb|fw|external:)/iu.test(m.userId)
      ||!Number.isSafeInteger(m.expiresAt)||m.expiresAt>now()+60000)throw Error('wecom_member_evidence_invalid');
    seen.add(m.actorId);userIds.add(m.userId);
  }
  for(const m of result.members){
    if(m.expiresAt<=now())continue;
    const actor=collaboration.actors.get(m.actorId);
    if(!actor?.enabled||actor.kind!=='human'||!collaboration.admittedActor(actor.id)
      ||collaboration.actors.findHuman({provider:'tencentoa',subject:m.subject})?.id!==actor.id)continue;
    const provider='wecom.'+corpId,existing=collaboration.actors.findHuman({provider,subject:m.userId});
    if(existing&&existing.id!==actor.id)continue;
    const bindings=collaboration.actors.bindings(actor.id).filter(b=>b.provider===provider);
    if(existing||bindings.length)continue; // Never move, replace or merge another identity.
    await collaboration.synchronizeChannels({method:'mirrorLink',params:{actorId:actor.id,generation:actor.generation,corpId,userId:m.userId}});
  }
}
