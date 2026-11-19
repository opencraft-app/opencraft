import {createNativeMemberEvidence} from '../../tencentoa/src/native-member-directory.mjs';
import {createRtxMemberEvidence} from '../../tencentoa/src/rtx-directory.mjs';
import {shortcutEvent} from '../rich-outbound.mjs';
import { readPrivateJson } from '../../../../../packages/identity-core/src/node.ts';
import { createWeComChannelTransport } from '../channel-transport.mjs';
import { MirrorStore } from './store.mjs';
import { MirrorService } from './service.mjs';
import { createAutomaticDirectory } from '../automatic-directory.mjs';
import { createGroupSelection } from './selection.mjs';
import { createReceiverEnrollment } from './receiver-enrollment.mjs';
export { MIRROR_PATH } from './service.mjs';
import { MIRROR_PATH } from './service.mjs';

/** Commands and directory registration also work while the existing Hub owns message delivery. */
export async function createForwardingIngress(file, redis, callbackIngress, {fetcher,listServers,authenticateEntryRequest,beginEntryAuthentication}={}) {
  const config=await readPrivateJson(file);
  let service;
  const transport=createWeComChannelTransport({...config,localGroups:[],relayIngress:true,
    ...(redis?{onMention:event=>service.track(service.ingest(event))}:{}),...(fetcher?{fetcher}:{})});
  const callback=callbackIngress(transport.callback);
  // A non-clustered legacy Relay keeps its private-chat notice without pretending
  // to offer a shared command directory.
  if(!redis)return callback;
  service=new MirrorService({store:new MirrorStore(redis),transport,servers:config.servers??[],memberEvidence:createRtxMemberEvidence(redis,(source,id,signal)=>transport.employeeIdentity(source,id,signal),Date.now,(source,ids,signal)=>transport.employeeIdentities(source,ids,signal)),corpId:config.corpId,forwardingOnly:true,
    ...(listServers?{directory:createAutomaticDirectory(redis,config.corpId,listServers,
      (source,id)=>transport.resolveSender(source,id,service.abort.signal))}:{})});
  const selection=authenticateEntryRequest&&beginEntryAuthentication&&listServers?createGroupSelection({store:service.store,transport,corpId:config.corpId,
    authenticate:authenticateEntryRequest,beginLogin:beginEntryAuthentication,listServers,enabled:false,track:job=>service.track(job)}):undefined;
  service.selection=selection;
  const handle=(req,res)=>selection?.ingress(req,res)||(req.url?.startsWith(MIRROR_PATH+'/')?service.ingress(req,res):callback(req,res));
  handle.employeeForRtx=(rtx,signal)=>transport.employeeForRtx(rtx,signal);
  handle.close=()=>service.close();service.start();return handle;
}

/** Product composition consumes the existing Relay-owned Redis lifecycle. */
export async function createMirrorIngress(file, redis, {listServers,authenticateEntryRequest,beginEntryAuthentication,identityDirectory=redis,receiverEnrollment}={}) {
  if(!redis)throw Error('Store-and-forward requires the Relay Redis owner');
  const config=await readPrivateJson(file);
  if(!config||Object.keys(config).some(key=>!['wecom','servers'].includes(key)))throw Error('Invalid mirror configuration');
  const store=new MirrorStore(redis);await store.verifyDurability();
  let service;
  const transport=createWeComChannelTransport({...config.wecom,localGroups:[],relayIngress:true,enableImages:true,
    directChats:process.env.JOIN_WECOM_DIRECT_CHATS!=='0',
    onDirectEnter:userId=>service?.track(service.welcome(userId)),
    onShortcut:event=>service?.track(shortcutEvent(service,event)),
    onCardEvent:event=>service?.track(service.cardEvent(event))});
  service=new MirrorService({store,transport,servers:config.servers,nativeMemberEvidence:createNativeMemberEvidence(identityDirectory,(rtx,signal)=>transport.employeeForRtx(rtx,signal),config.wecom.corpId),memberEvidence:createRtxMemberEvidence(identityDirectory,(source,id,signal)=>transport.employeeIdentity(source,id,signal),Date.now,(source,ids,signal)=>transport.employeeIdentities(source,ids,signal)),corpId:config.wecom.corpId,
    receiverEnrollment:receiverEnrollment?createReceiverEnrollment({store,corpId:config.wecom.corpId,...receiverEnrollment}):undefined,
    streamReplies:process.env.JOIN_WECOM_STREAM_REPLIES==='1',
    followUps:process.env.JOIN_WECOM_FOLLOW_UPS!=='0'});
  const selection=authenticateEntryRequest&&beginEntryAuthentication&&listServers?createGroupSelection({store,transport,corpId:config.wecom.corpId,
    authenticate:authenticateEntryRequest,beginLogin:beginEntryAuthentication,listServers,enabled:true,track:job=>service.track(job)}):undefined;
  service.selection=selection;
  const handle=(req,res)=>selection?.ingress(req,res)||service.ingress(req,res);
  handle.employeeForRtx=(rtx,signal)=>transport.employeeForRtx(rtx,signal);
  handle.close=()=>service.close();
  service.start();return handle;
}
