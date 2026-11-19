import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChannelSyncTransport } from '../../../../plugins/im/src/channel-sync.js';

export function createWeComChannelTransport(options: Record<string, unknown>, hooks?: {onSenderProfile?(profile:{source:string;id:string;name:string}):void}): Omit<ChannelSyncTransport, 'callback'> & {
  sendDirectNotification(userId:string,content:string,signal:AbortSignal,assertCurrent:()=>void|Promise<void>):Promise<'delivered'|'rejected'>;
  updateChatDetailed(sourceKey:string, change:{name?:string;add?:string[];remove?:string[]}, signal:AbortSignal):Promise<{status:'delivered'|'rejected'|'unknown';diagnostics:Record<string,unknown>}>;
  callback: {
    path: string;
    handle(
      request: IncomingMessage,
      response: ServerResponse,
      forward?: (body: string) => Promise<void>,
    ): Promise<void>;
  };
};
