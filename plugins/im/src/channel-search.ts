import type { ChannelSearchPage } from '@opencraft/appserver-protocol';
export interface ChannelSearchContribution {
  readonly id: string;
  search(query:string,before:number|undefined,signal:AbortSignal):Promise<ChannelSearchPage>;
}
export const CHANNEL_SEARCH_CONTRIBUTION='nativeChannelSearch';
export function channelResource(id:string,sequence?:number){return 'opencraft-channel:'+id+(sequence===undefined?'':'#message='+sequence);}
export function parseChannelResource(resource:string|null|undefined){
  const match=resource?.match(/^opencraft-channel:(.+?)(?:#message=([1-9]\d*))?$/);
  if(!match)return null;
  const sequence=match[2]?Number(match[2]):undefined;
  return sequence!==undefined&&!Number.isSafeInteger(sequence)?null:{id:match[1]!,sequence};
}
