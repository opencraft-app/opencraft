/** Provider account names are not globally unique. Foreign identities are archival, never local grants. */
export function senderIdentity(id,senderCorpId,localCorpId) {
  if(!senderCorpId||senderCorpId===localCorpId)return {id,displayName:id,external:false};
  if(typeof senderCorpId!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(senderCorpId)||typeof id!=='string'||!id||id.length>128)throw Error('Invalid external sender');
  const scoped='external:'+Buffer.from(JSON.stringify([senderCorpId,id])).toString('base64url');
  if(scoped.length>256)throw Error('External sender identity too long');
  return {id:scoped,displayName:`${id}（外部企业 ${senderCorpId}）`,external:true,corpId:senderCorpId};
}
