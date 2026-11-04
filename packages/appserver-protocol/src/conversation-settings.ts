/** Explicit overrides only. No provider credentials or arbitrary native config. */
export interface ConversationInputSettings { model?: string; reasoningEffort?: string }
export interface NativeConfirmedConfiguration {
  model: string | null; reasoningEffort: string | null;
  scope: 'creation' | 'thread-current' | 'thread-last-persisted';
  source: 'native/thread/start' | 'native/thread/read'; observedAt: number;
}
export function parseConversationSettings(value: unknown): ConversationInputSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_model_settings');
  const row=value as Record<string,unknown>, result:ConversationInputSettings={};
  if(Object.keys(row).some(k=>!['model','reasoningEffort'].includes(k)))throw Error('invalid_model_settings');
  for(const key of ['model','reasoningEffort'] as const)if(Object.hasOwn(row,key)){
    const v=row[key];if(typeof v!=='string'||v!==v.trim()||!v||v.length>256||/[\s\x00-\x1f]/u.test(v))throw Error('invalid_model_settings');result[key]=v;
  }
  if(!Object.keys(result).length)throw Error('invalid_model_settings');return result;
}
export function nativeConfiguration(value:unknown,source:NativeConfirmedConfiguration['source'],scope:NativeConfirmedConfiguration['scope']):NativeConfirmedConfiguration | null {
  const row=value && typeof value==='object'?value as Record<string,unknown>:{};
  if(typeof row.model!=='string' && typeof row.reasoningEffort!=='string')return null;
  return {model:typeof row.model==='string'?row.model:null,reasoningEffort:typeof row.reasoningEffort==='string'?row.reasoningEffort:null,source,scope,observedAt:Date.now()};
}
