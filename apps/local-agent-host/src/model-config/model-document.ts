export interface ConfiguredModel {
  id: string;
  /** Omitted in legacy documents means chat, never inferred from a model name. */
  type?: "chat" | "asr";
  name?: string;
  enabled: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  reasoningEfforts?: false | Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
}
export interface ConfiguredProvider {
  id: string;
  name: string;
  catalogId?: string;
  protocol: string;
  baseUrl: string;
  credentialRef: string | null;
  enabled: boolean;
  models: ConfiguredModel[];
}
export interface ModelDocument {
  schemaVersion: 1;
  revision: number;
  providers: ConfiguredProvider[];
  defaultModel: { providerId: string; modelId: string; reasoningEffort?: string } | null;
  defaultSpeechModel?: { providerId: string; modelId: string } | null;
}
export const emptyModelDocument = (): ModelDocument => ({schemaVersion:1, revision:0, providers:[], defaultModel:null});
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!plain(value) || Object.keys(value).some(k=>!allowed.includes(k))) throw new Error("模型配置包含不支持的字段或格式");
}
export function validateModelDocument(value: unknown): asserts value is ModelDocument {
  fields(value, ['schemaVersion','revision','providers','defaultModel','defaultSpeechModel']);
  if(value.schemaVersion!==1 || !Number.isSafeInteger(value.revision) || Number(value.revision)<0 || !Array.isArray(value.providers)) throw new Error("不支持的模型配置版本");
  const ids=new Set<string>();
  for(const p of value.providers) {
    fields(p,['id','name','catalogId','protocol','baseUrl','credentialRef','enabled','models']);
    if(typeof p.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p.id)||['__proto__','constructor','prototype'].includes(p.id)||ids.has(p.id))throw new Error('提供商 ID 无效或重复');
    ids.add(p.id);
    if(typeof p.name!=='string'||!p.name.trim()||typeof p.protocol!=='string'||!p.protocol.trim()||typeof p.enabled!=='boolean'||typeof p.baseUrl!=='string'||!Array.isArray(p.models))throw new Error('提供商配置不完整');
    if(p.catalogId!==undefined&&typeof p.catalogId!=='string')throw new Error('提供商目录标识无效');
    if(p.credentialRef!==null&&(typeof p.credentialRef!=='string'||!/^[_A-Za-z][_A-Za-z0-9]*$/.test(p.credentialRef)))throw new Error('凭据引用无效');
    if(p.baseUrl){let url:URL;try{url=new URL(p.baseUrl)}catch{throw new Error('模型地址无效')}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('模型地址不得包含认证或查询信息');}
    const models=new Set<string>();
    for(const m of p.models){
      fields(m,['id','type','name','enabled','contextWindow','maxTokens','input','reasoningEfforts']);
      if(typeof m.id!=='string'||!m.id.trim()||models.has(m.id)||typeof m.enabled!=='boolean')throw new Error('模型 ID 无效或重复');
      models.add(m.id);
      if(m.type!==undefined&&m.type!=='chat'&&m.type!=='asr')throw new Error('模型用途无效');
      if((m.type==='asr')!==(p.protocol==='hunyuan-asr'))throw new Error('模型用途与连接协议不匹配');
      if(m.type==='asr'&&(m.input!==undefined||m.contextWindow!==undefined||m.maxTokens!==undefined||m.reasoningEfforts!==undefined))throw new Error('语音模型不得声明聊天能力');
      if(m.name!==undefined&&(typeof m.name!=='string'||!m.name.trim()))throw new Error('模型名称无效');
      for(const key of ['contextWindow','maxTokens'])if(m[key]!==undefined&&(!Number.isSafeInteger(m[key])||Number(m[key])<=0))throw new Error('模型限制无效');
      if(m.contextWindow!==undefined&&m.maxTokens!==undefined&&Number(m.maxTokens)>Number(m.contextWindow))throw new Error('输出限制超过上下文');
      if(m.input!==undefined&&(!Array.isArray(m.input)||!m.input.includes('text')||m.input.some(v=>v!=='text'&&v!=='image')))throw new Error('模型输入类型无效');
      if(m.reasoningEfforts!==undefined&&m.reasoningEfforts!==false){
        const levels=m.reasoningEfforts;
        if(!plain(levels)||!Object.keys(levels).some(level=>level!=='off')||Object.entries(levels).some(([level,wire])=>
          !['off','minimal','low','medium','high','xhigh','max'].includes(level)||
          (wire!==null&&(typeof wire!=='string'||!wire.trim()))||
          (level!=='off'&&wire===null)))throw new Error('模型思考档位无效');
      }
    }
  }
  if(value.defaultModel!==null){fields(value.defaultModel,['providerId','modelId','reasoningEffort']);const d=value.defaultModel;const p=value.providers.find(p=>p.id===d.providerId);if(!p?.enabled||!p.models.some((m:ConfiguredModel)=>m.id===d.modelId&&m.enabled&&m.type!=='asr'))throw new Error('默认聊天模型必须存在并已启用');if(d.reasoningEffort!==undefined&&typeof d.reasoningEffort!=='string')throw new Error('推理强度无效');}
  // Preserve explicit unavailable selections after removal/disable; never silently substitute.
  if(value.defaultSpeechModel!==undefined&&value.defaultSpeechModel!==null){fields(value.defaultSpeechModel,['providerId','modelId']);if(typeof value.defaultSpeechModel.providerId!=='string'||!value.defaultSpeechModel.providerId.trim()||typeof value.defaultSpeechModel.modelId!=='string'||!value.defaultSpeechModel.modelId.trim())throw new Error('语音模型选择无效');const d=value.defaultSpeechModel,p=value.providers.find(p=>p.id===d.providerId);if(p&&p.protocol!=='hunyuan-asr')throw new Error('语音选择不能使用聊天连接');}
}
