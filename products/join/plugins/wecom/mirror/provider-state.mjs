const same=(a,b)=>a&&b&&a.serverId===b.serverId&&a.humanKey===b.humanKey&&a.generation===b.generation;
/** Scoped, authenticated read only. No caller-selected identity can reach this endpoint. */
export async function readProviderState(svc,server,{source,owner,query},signal) {
  if(typeof owner!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/u.test(owner)||!query||!['chat','interaction'].includes(query.kind)
    ||Object.keys(query).some(k=>!['kind','taskId','offset'].includes(k)))throw Error('invalid_provider_query');
  const binding=await svc.authorizedSource(server,source);
  if(!(await svc.transport.chatMembers(source,signal)).includes(owner))throw Error('denied');
  let result;
  if(query.kind==='chat') {
    if(query.taskId!==undefined||query.offset!==undefined)throw Error('invalid_provider_query');
    const snapshot=await svc.transport.chatSnapshot(source,signal),rows=await svc.transport.memberInfo(source,signal);
    result={...snapshot,membershipSource:'provider',members:rows.map(r=>({id:r.id,name:r.name,kind:r.kind})),checkedAt:Date.now()};
  } else {
    const offset=query.offset??0;
    if(typeof query.taskId!=='string'||!/^oc-m-[a-f0-9]{40}$/u.test(query.taskId)||!Number.isInteger(offset)||offset<0||offset>512)throw Error('invalid_provider_query');
    const card=await svc.store.card(source,query.taskId);
    if(!card)result={taskId:query.taskId,status:'missing'};
    else {
      if(!card.multi||card.owner!==owner||!same(card.binding,binding))throw Error('denied');
      const state=await svc.store.submitCard(source,query.taskId,'');
      const rows=state.answers.sort((a,b)=>a.author.localeCompare(b.author));
      const current=await svc.transport.chatMembers(source,signal),participants=card.participants?.filter(id=>current.includes(id)&&!/^(wb|fw|external:)/u.test(id));
      result={taskId:query.taskId,title:card.main_title.title,deliveryStatus:card.deliveryStatus,closed:state.closed,closedReason:state.closedReason,
        total:rows.length,answers:rows.slice(offset,offset+50),nextOffset:offset+50<rows.length?offset+50:null,
        participantBasis:'initial-current-members',participantIds:participants??null,pendingMemberIds:participants?.filter(id=>!rows.some(a=>a.author===id))??null};
    }
  }
  if(!same(binding,await svc.authorizedSource(server,source))||!(await svc.transport.chatMembers(source,signal)).includes(owner))throw Error('denied');
  return result;
}
export async function verifyChatChange(transport,source,{name,add,remove},signal) {
  try {
    const actual=await transport.chatSnapshot(source,signal);
    return {verified:(!name||actual.name===name)&&add.every(id=>actual.memberIds.includes(id))&&remove.every(id=>!actual.memberIds.includes(id)),checkedAt:Date.now(),observed:actual};
  }catch{return {verified:false,error:'read_failed'};}
}
