/** Shared paint-only retention policy. Drafts and command receipts are separate owners. */
export const CONVERSATION_DISPLAY_POLICY={maxEntries:64,maxMessages:24,maxCharacters:64*1024,maxAgeMs:7*24*60*60*1000} as const;
export function createConversationDisplayCache<T extends {savedAt:number}>(now:()=>number=Date.now){
  const entries=new Map<string,T>();
  return {
    get(key:string){const value=entries.get(key);if(value&&(now()<value.savedAt||now()-value.savedAt>CONVERSATION_DISPLAY_POLICY.maxAgeMs)){entries.delete(key);return undefined;}return value;},
    set(key:string,value:T){entries.delete(key);entries.set(key,value);while(entries.size>CONVERSATION_DISPLAY_POLICY.maxEntries)entries.delete(entries.keys().next().value!);},
    delete:(key:string)=>entries.delete(key),clear:()=>entries.clear(),get size(){return entries.size}
  };
}
