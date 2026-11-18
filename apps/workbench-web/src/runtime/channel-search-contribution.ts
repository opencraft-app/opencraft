import { SingleContributionRegistry } from '@opencraft/extension-runtime';
import type { ChannelSearchContribution } from '@opencraft/plugin-im';
import type { ConversationSearchSource } from './conversation-content-search';
export class ChannelSearchRegistry extends SingleContributionRegistry<ChannelSearchContribution> {
  constructor(){super('native channel search',(value):value is ChannelSearchContribution=>!!value&&typeof value==='object'&&typeof (value as ChannelSearchContribution).id==='string'&&typeof (value as ChannelSearchContribution).search==='function');}
}
function excerpt(text:string,term:string){
  const match=text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  const start=Math.max(0,match-60),end=Math.min(text.length,start+220);
  return (start?'…':'')+text.slice(start,end)+(end<text.length?'…':'');
}
export function channelSearchSource(provider:ChannelSearchContribution,label:string):ConversationSearchSource {
  return {key:provider.id,hostId:'opencraft-channels',label,available:true,
    async search(term,cursor,signal){
      signal.throwIfAborted();
      const page=await provider.search(term,cursor===null?undefined:Number(cursor),signal);
      signal.throwIfAborted();
      return {matches:page.matches.map(({channel,message})=>({id:channel.id+':'+message.sequence,
        title:channel.title,updatedAt:message.at,connectionHostId:'opencraft-channels',serverOrigin:{label},
        snippet:message.author+' · '+excerpt(message.text,term),searchTerm:term,
        viewTarget:{viewId:'opencraft.im.channel-chat',resourceUri:'opencraft-channel:'+channel.id+'#message='+message.sequence}})),
        nextCursor:page.nextBefore===null?null:String(page.nextBefore)};
    },async locate(){return null;}};
}
