import type { ChannelMessage } from '@opencraft/appserver-protocol';
import type { MessageTimelineCheckpoint } from '@opencraft/chat-render-web/message-timeline';
import { createConversationDisplayCache,CONVERSATION_DISPLAY_POLICY } from '@opencraft/workbench-runtime/conversation-display-cache';
export type ChannelDisplay={messages:ChannelMessage[];cursor?:string;hasEarlier:boolean;checkpoint?:MessageTimelineCheckpoint;savedAt:number};
export function createChannelDisplayCache(now:()=>number=Date.now){
  const cache=createConversationDisplayCache<ChannelDisplay>(now);
  return {get:cache.get,clear:cache.clear,delete:cache.delete,get size(){return cache.size},
    put(key:string,value:Omit<ChannelDisplay,'savedAt'>){
      const messages:ChannelMessage[]=[];let characters=0;
      for(const message of value.messages.slice(-CONVERSATION_DISPLAY_POLICY.maxMessages).reverse()){
        const size=JSON.stringify(message).length;if(characters+size>CONVERSATION_DISPLAY_POLICY.maxCharacters)break;messages.unshift(message);characters+=size;
      }
      if(value.messages.length&&!messages.length){cache.delete(key);return;}
      const trimmed=messages.length!==value.messages.length;
      cache.set(key,{...value,messages,hasEarlier:value.hasEarlier||trimmed,checkpoint:trimmed||value.checkpoint&&JSON.stringify(value.checkpoint).length>CONVERSATION_DISPLAY_POLICY.maxCharacters?undefined:value.checkpoint,savedAt:now()});
    },
    checkpoint(key:string,checkpoint:MessageTimelineCheckpoint,count:number){const value=cache.get(key);if(value&&value.messages.length===count&&JSON.stringify(checkpoint).length<=CONVERSATION_DISPLAY_POLICY.maxCharacters)cache.set(key,{...value,checkpoint});}
  };
}
export type ChannelDisplayCache=ReturnType<typeof createChannelDisplayCache>;
