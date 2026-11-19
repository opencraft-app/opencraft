/** iOA owns employee defaults; WeCom supplies only currently verified personal targets.
 * The stable policy ID is per Actor, independent of browser/login/binding revisions. */
export function createIoaNotificationDefaultTarget({resolveIdentity,actors}) {
  return (request,binding,targets) => {
    const principal=resolveIdentity(request);
    if(principal?.provider!=='tencentoa'||principal.expiresAt<=Date.now()||binding.context.credentialId!==null)return false;
    const actorId=binding.context.actorId,actor=actors.get(actorId);
    if(!actors.isCurrent(binding.context)||!actor?.enabled||actor.kind!=='human')return false;
    const identities=actors.bindings(actorId).filter(value=>value.provider==='tencentoa');
    if(identities.length!==1||identities[0].subject!==principal.subject)return false;
    const selected=targets.filter(target=>target.kind==='im'&&target.methodId==='join.wecom');
    // WeCom's target port already requires its sole verified recipient and a live Relay lease.
    if(selected.length!==1)return null;
    return {policyId:'tencentoa.employee.wecom-turn',target:selected[0]};
  };
}
