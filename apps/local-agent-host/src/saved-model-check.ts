import {isDeepStrictEqual} from 'node:util';
import {modelBaseUrlError,type RuntimeSavedModelCheckParams} from '@opencraft/appserver-protocol';
import type {ModelDocument} from './model-config/model-document.js';
import {probeRuntimeModel} from './runtime-model-probe.js';

interface SavedModelSource {
  read():Promise<ModelDocument>;
  credential(reference:string):Promise<string|undefined>;
}
/** Check one committed connection. Never accept a caller-controlled destination or secret. */
export async function checkSavedModel(input:RuntimeSavedModelCheckParams,source:SavedModelSource,probe=probeRuntimeModel){
  if(!input||typeof input.provider!=='string'||typeof input.model!=='string'||!Number.isSafeInteger(input.expectedRevision)
    ||Object.keys(input).some(key=>!['provider','model','expectedRevision'].includes(key)))throw new Error('无效的连接检查请求');
  const snapshot=await source.read();
  if(snapshot.revision!==input.expectedRevision)throw new Error('配置已更新，请刷新后重新检查');
  const provider=snapshot.providers.find(p=>p.id===input.provider);
  if(!provider)throw new Error('请先保存提供商配置');
  if(!provider.models.some(m=>m.id===input.model))throw new Error('所选模型不在已保存的连接中');
  const api=provider.protocol;
  if(api!=='openai-completions'&&api!=='openai-responses')throw new Error('当前协议暂不支持连接检查');
  const issue=modelBaseUrlError(provider.baseUrl);if(issue||!provider.baseUrl.trim())throw new Error(issue??'请先保存 API 基础地址');
  const apiKey=provider.credentialRef?await source.credential(provider.credentialRef):undefined;
  if(!apiKey)throw new Error('此连接没有可用的 API Key，请先保存密钥');
  const latest=await source.read();
  if(latest.revision!==snapshot.revision||!isDeepStrictEqual(latest.providers.find(p=>p.id===provider.id),provider))throw new Error('配置已更新，请刷新后重新检查');
  return probe({baseURL:provider.baseUrl,api,model:input.model,apiKey});
}
