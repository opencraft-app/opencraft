/** Product-owned personal notification port; Core retains preferences and Turn outbox.
 * Only verified Actor bindings are recipients. A name/RTX entered by a client is never authority. */
export function createWeComTurnNotifications({actors,corpId,resolveRtx,ready,deliver}) {
  const channelId='join.wecom.'+corpId;
  const targets=actorId=>{
    if(!ready())return [];
    const actor=actors.get(actorId);
    if(!actor?.enabled||actor.kind!=='human')return [];
    const bindings=actors.bindings(actorId);
    const recipients=[...new Set(bindings.filter(b=>b.provider==='wecom.'+corpId).map(b=>b.subject))];
    if(recipients.length!==1||!/^[A-Za-z0-9_-]{1,128}$/u.test(recipients[0])||/^(wb|fw)/iu.test(recipients[0]))return [];
    const oa=bindings.filter(b=>b.provider==='tencentoa');
    const rtx=oa.length===1?resolveRtx?.(oa[0].subject):null;
    return [{channelId,senderId:recipients[0],label:rtx||recipients[0],methodId:'join.wecom',methodLabel:'企业微信'}];
  };
  return {
    targets,
    async send(actorId,target,content,requestId,assertCurrent) {
      const selected=()=>targets(actorId).some(t=>t.channelId===target.channelId&&t.senderId===target.senderId);
      assertCurrent();
      if(!selected())throw Object.assign(Error('notification_binding_denied'),{deliveryState:'not_sent',statusCode:403});
      if(typeof content!=='string'||!content.isWellFormed()||!content.trim()||Buffer.byteLength(content)>5000
        ||typeof requestId!=='string'||!requestId||requestId.length>256)throw Object.assign(Error('notification_invalid'),{deliveryState:'not_sent',statusCode:400});
      // No network lookup may silently change the selected recipient or native owner.
      assertCurrent();
      const result=await deliver({actorId,recipient:target.senderId,content,requestId});
      if(result?.status!=='delivered')throw Object.assign(Error('notification_delivery_failed'),{statusCode:result?.status==='rejected'?400:502,deliveryState:'unknown'});
    },
  };
}
