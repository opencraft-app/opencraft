import {nativeFileCommand} from './native-files.mjs';
import {nativeMentionRecipients} from './native-mentions.mjs';
import{forwardedFingerprint,persistForwardedRecord,forwardedResource}from'./forwarded-storage.mjs';
import {groupSyncCommand,groupSyncMutation,groupSyncView,groupSyncRefresh,groupDisplayTitle,groupSyncCreated} from './group-sync-storage.mjs';
import {wecomCliCommand} from './scoped-cli.mjs';
import { communicationAvatar } from '../tencentoa/src/avatar-profiles.mjs';
import { communicationSenderHuman } from './linked-sender.mjs';
import { admitWecomAssistant, admitNativeWecomAssistant, wecomAssistantDeliveryAllowed, wecomAssistantCommand, wecomAssistantReadGuard } from './assistant-storage.ts';
// Only the Join gateway installs this adapter; the public core has no WeCom policy.
export const communicationExtension = {
  groupDisplayTitle,
  channelFiles(source){try{const p=JSON.parse(source);return p.length===4&&p[0]==='wecom-customer-service';}catch{return false;}},
  synchronize:(service,db,c)=>nativeFileCommand(service,db,c)??groupSyncCommand(service,db,c),groupMutation:groupSyncMutation,groupCreated:groupSyncCreated,
  senderHuman: communicationSenderHuman,
  avatar: communicationAvatar,
  fingerprint:arrival=>[...(arrival.mentioned===true?[true,arrival.author]:[]),...forwardedFingerprint(arrival)],
  arrival(service,db,arrival,source,messageId){persistForwardedRecord(db,arrival,messageId);admitWecomAssistant(service,db,arrival,source,messageId);},
  nativeMessage: admitNativeWecomAssistant,
  outboundMentions:nativeMentionRecipients,
  outboundPresentation(service,db,delivery) {
    // This row is written only by the native assistant owner, not by a user's
    // display name or a model-selected request field. Authorization ran first.
    const reply=db.prepare('SELECT 1 FROM join_wecom_assistant_replies WHERE message_id=?').get(delivery.message_id);
    if(!reply)return undefined;
    return delivery.author_id==='external:wecom-assistant-notice'
      ?{role:'system',format:'text'}:{role:'assistant',format:'markdown'};
  },
  mentionDelivery(service,db,channelId,actorId){
    const delivery=db.prepare('SELECT source,channel_id FROM actor_channel_sources WHERE channel_id=? AND active=1').get(channelId);
    if(!delivery)return undefined;
    let parts;try{parts=JSON.parse(delivery.source)}catch{return undefined}
    if(!Array.isArray(parts)||parts[0]!=='wecom-customer-service')return undefined;
    return nativeMentionRecipients(service,db,delivery,[{actorId,start:0,end:1}]).length?'linked':'native-only';
  },
  deliveryAllowed: wecomAssistantDeliveryAllowed,
  // Assistant replies answer the latest mention in their scope that precedes them and has
  // not already been answered by an earlier reply; later output with no open mention (such as
  // a scheduled report) posts on its own. Scope-less notices answer their own request.
  replyTarget(db,messageId) {
    return db.prepare(`SELECT e.external_id FROM join_wecom_assistant_replies rp
      JOIN join_wecom_assistant_requests q0 ON q0.message_id=rp.request_id
      JOIN actor_messages reply ON reply.id=rp.message_id
      JOIN join_wecom_assistant_requests q ON (q0.scope IS NULL AND q.message_id=q0.message_id) OR (q0.scope IS NOT NULL AND q.scope=q0.scope)
      JOIN actor_messages m ON m.id=q.message_id
      JOIN actor_channel_external_messages e ON e.message_id=q.message_id
      WHERE rp.message_id=? AND m.seq<reply.seq
        AND (q0.scope IS NULL OR NOT EXISTS (SELECT 1 FROM join_wecom_assistant_replies rp2
          JOIN join_wecom_assistant_requests q2 ON q2.message_id=rp2.request_id
          JOIN actor_messages earlier ON earlier.id=rp2.message_id
          WHERE q2.scope=q0.scope AND earlier.seq>m.seq AND earlier.seq<reply.seq
            AND rp2.payload_hash<>rp.payload_hash AND earlier.content NOT LIKE '[文件] %'))
      ORDER BY m.seq DESC LIMIT 1`).get(messageId)?.external_id;
  },
  command(service,db,assistants,context,method,params) {
    if(method==='opencraft/channels/group/sync/status'||method==='opencraft/channels/group/sync/refresh') {
      const refresh=method.endsWith('/refresh'),allowed=refresh?['channelId','clientRequestId']:['channelId'];
      if(!params||Object.keys(params).some(k=>!allowed.includes(k))||typeof params.channelId!=='string'||!params.channelId||params.channelId.length>2048)
        throw Object.assign(Error('invalid_input'),{status:400,code:'invalid_input'});
      return {result:refresh?groupSyncRefresh(service,db,context,params.channelId,params.clientRequestId):groupSyncView(service,db,context,params.channelId)};
    }
    if(method==='opencraft/channels/records/resource/read')return{result:forwardedResource(service,db,context,params)};
    if(method==='join/wecom-cli/command'||method==='join/wecom-assistant/cli') {
      const result=wecomCliCommand(service,db,assistants,context,params,(op,p)=>wecomAssistantCommand(service,db,assistants,context,'join/wecom-assistant/'+op,p));
      const access=assistants.readAuthority(context);
      const scopes=wecomAssistantCommand(service,db,assistants,context,'join/wecom-assistant/scopes',{});
      return {result,personalReadGuard:{epoch:access.epoch,groups:scopes.map(r=>({id:r.channelId,epoch:service.channels.memberEpoch(r.channelId,access.context.actorId)}))}};
    }
    if(method.startsWith('join/wecom-assistant/')) {
      const result=wecomAssistantCommand(service,db,assistants,context,method,params);
      return {result,personalReadGuard:wecomAssistantReadGuard(db,assistants,context,params.scope)};
    }
  },
};
