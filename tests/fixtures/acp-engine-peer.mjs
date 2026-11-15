import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const sessions = new Map(), prompts = new Map(), callbacks = new Map();
let callbackSeq = 0;
let latestSession = null;
const settings = new Map();
const splitSettings = process.env.ACP_TEST_SPLIT_MODEL_CONFIG === '1';
const parameterizedSettings = process.env.ACP_TEST_PARAMETERIZED === '1';
const flatReasoning = process.env.ACP_TEST_FLAT_REASONING === '1';
const flatModels = ['claude-opus', 'claude-haiku'];
const flatEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'enabled'];
const flatOptions = state => [
  {id:'model',category:'model',type:'select',currentValue:state.model,options:flatModels.map(value=>({value,name:value}))},
  {id:'thought_level',category:'thought_level',type:'select',currentValue:state.effort,options:flatEfforts.map(value=>({value,name:value}))},
];
const flatSetup = id => { settings.set(id,{model:'claude-opus',effort:'high',fast:false,context:'1m'}); const state = settings.get(id); return {
  sessionId:id, configOptions:flatOptions(state), models:{currentModelId:state.model, availableModels:flatModels.map(modelId=>({modelId,name:modelId}))},
};};
let parameterizedPicker = false;
const configOptions = (id, state = settings.get(id)) => {
  if (parameterizedSettings) return [
    {id:'model',category:'model',type:'select',currentValue:state.model,options:['one','two'].map(value=>({value,name:value}))},
    ...(state.model==='one' ? [
      {id:'reasoning',category:'thought_level',type:'select',currentValue:state.effort,options:['low','high'].map(value=>({value,name:value}))},
      {id:'fast',category:'other',type:'select',currentValue:String(state.fast),options:['false','true'].map(value=>({value,name:value}))},
      {id:'context',category:'other',type:'select',currentValue:state.context,options:['256k','1m'].map(value=>({value,name:value}))},
    ] : []),
  ];
  return [
    {id:'model',category:'model',type:'select',currentValue:state.model,options:['one','two'].map(value=>({value,name:value}))},
    {id:'reasoning_effort',category:'thought_level',type:'select',currentValue:state.effort,options:['low','high'].map(value=>({value,name:value}))},
    ...(state.model==='one'?[process.env.ACP_TEST_BOOLEAN_FAST==='1'
      ? {id:'fast-mode',type:'boolean',currentValue:state.fast}
      : {id:'fast-mode',type:'select',currentValue:state.fast?'on':'off',options:[{value:'off',name:'Off'},{value:'on',name:'On'}]}]:[]),
  ];
};
const setup = id => { settings.set(id,{model:'one',effort:'high',fast:false,context:'1m'});return {
  sessionId:id,configOptions:configOptions(id),models:{currentModelId:'one[high]',availableModels:['one','two'].flatMap(model=>['low','high'].map(effort=>({modelId:`${model}[${effort}]`,name:`${model} (${effort})`})))}
};};
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const codexModes = currentValue => ({ id:'mode', category:'mode', type:'select', currentValue,
  options:['read-only','agent','agent-full-access'].map(value=>({value,name:value})) });
const result = (id, value) => send({ id, result: process.env.ACP_TEST_CODEX_MODES && value.sessionId
  ? {...value, configOptions:[...(value.configOptions??[]),codexModes('agent')]} : value });
const trace = frame => { if (process.env.ACP_TEST_TRACE) appendFileSync(process.env.ACP_TEST_TRACE, JSON.stringify({ method: frame.method, pid: process.pid, sessionId: frame.params?.sessionId, configId:frame.params?.configId,value:frame.params?.value,type:frame.params?.type,build: process.env.ACP_TEST_BUILD,
  ...(frame.method==='initialize'?{parameterizedPicker:frame.params?.clientCapabilities?._meta?.parameterizedModelPicker}:{}),
  ...(process.env.ACP_TEST_CAPTURE_PROMPT && frame.method==='session/prompt'?{prompt:frame.params.prompt}:{}),
  ...(parameterizedSettings&&frame.method==='session/prompt'?{settings:settings.get(frame.params.sessionId)}:{}),
}) + '\n'); };
const mcp = async (server, id, method, params = {}) => {
  const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  if (!response.ok) throw new Error('MCP request failed');
  return (await response.json()).result;
};
createInterface({ input: process.stdin }).on('line', line => {
  void (async () => {
    const frame = JSON.parse(line);
    if(!frame.method && callbacks.has(frame.id)){callbacks.get(frame.id)(frame.result);callbacks.delete(frame.id);return;}
    trace(frame); const params = frame.params ?? {};
    if (frame.method === 'initialize') { parameterizedPicker=params.clientCapabilities?._meta?.parameterizedModelPicker===true;return result(frame.id, { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: {...(process.env.ACP_TEST_SESSION_HANDOFF ? {fork:{},close:{}} : {}),... (process.env.ACP_TEST_NO_RESUME ? {} : { resume: {} }),...((process.env.ACP_TEST_TITLE_LIST||process.env.ACP_TEST_IMPORT_SESSIONS)?{list:{}}:{})} } }); }
    if(frame.method==='session/list'&&process.env.ACP_TEST_IMPORT_SESSIONS)return result(frame.id,JSON.parse(process.env.ACP_TEST_IMPORT_SESSIONS));
    if(frame.method==='session/list')return result(frame.id,{sessions:[...sessions.keys()].map(sessionId=>({sessionId,title:process.env.ACP_TEST_TITLE_LIST}))});
    if(frame.method==='_cursor/list_available_models') {
      if(process.env.ACP_TEST_NO_MODEL_EXTENSION==='1')return send({id:frame.id,error:{code:-32601,message:'Method not found'}});
      return result(frame.id,{models:['one','two'].map(model=>({value:model,name:model,configOptions:configOptions(null,{model,effort:'high',fast:false,context:'1m'}).filter(option=>option.id!=='model')}))});
    }
    if (frame.method === 'session/new') {
      const sessionId = process.env.ACP_TEST_NATIVE_ID ?? `native-${sessions.size + 1}`;
      for (const server of params.mcpServers) { await mcp(server, 'init', 'initialize'); await mcp(server, 'list', 'tools/list'); }
      if(parameterizedSettings&&!parameterizedPicker)return send({id:frame.id,error:{code:-32602,message:'Parameterized picker not enabled'}});
      sessions.set(sessionId, params); latestSession = sessionId; if(flatReasoning)return result(frame.id,flatSetup(sessionId)); if(splitSettings||parameterizedSettings)return result(frame.id,setup(sessionId));return result(frame.id, { sessionId, ...(process.env.ACP_TEST_MODELS ? {...(process.env.ACP_TEST_MODEL_CONFIG_ID ? {configOptions:[{id:process.env.ACP_TEST_MODEL_CONFIG_ID,category:'model',currentValue:'default-native',options:[{value:'default-native',name:'Default'},{value:'allowed-native',name:'Allowed'}]}]} : {}),models:{currentModelId:"default-native",availableModels:[{modelId:"default-native",name:"Default"},{modelId:"allowed-native",name:"Allowed"}]}} : {}) });
    }
    if (frame.method === 'session/fork') {
      if (!process.env.ACP_TEST_SESSION_HANDOFF) return send({id:frame.id,error:{code:-32601,message:'Unsupported'}});
      const sessionId = `forked-${sessions.size + 1}`; sessions.set(sessionId, params);
      return result(frame.id, splitSettings ? setup(sessionId) : {sessionId});
    }
    if (frame.method === 'session/close') { sessions.delete(params.sessionId); return result(frame.id, {}); }
    if (frame.method === 'session/resume') {
      if(process.env.ACP_TEST_CODEX_MODES)return result(frame.id,{sessionId:params.sessionId});
      if(process.env.ACP_TEST_BUSY_NATIVE===params.sessionId)return send({id:frame.id,error:{code:-32600,message:'This Codex session is in use by another Codex client'}});
 sessions.set(params.sessionId, params); latestSession = params.sessionId; if(splitSettings||parameterizedSettings)return result(frame.id,setup(params.sessionId));return result(frame.id, process.env.ACP_TEST_MODELS ? {...(process.env.ACP_TEST_MODEL_CONFIG_ID ? {configOptions:[{id:process.env.ACP_TEST_MODEL_CONFIG_ID,category:'model',currentValue:'default-native',options:[{value:'default-native',name:'Default'},{value:'allowed-native',name:'Allowed'}]}]} : {}),models:{currentModelId:'default-native',availableModels:[{modelId:'default-native',name:'Default'}]}} : {}); }
    if (frame.method === 'session/set_config_option') {
      if(process.env.ACP_TEST_CODEX_MODES && params.configId==='mode') {
        if(process.env.ACP_TEST_CODEX_MODES==='reject')return send({id:frame.id,error:{code:-32602,message:'Mode rejected'}});
        return result(frame.id,{configOptions:[codexModes(process.env.ACP_TEST_CODEX_MODES==='ignore'?'agent':params.value)]});
      }
      if(flatReasoning){
        const state=settings.get(params.sessionId), option=state&&flatOptions(state).find(option=>option.id===params.configId);
        if(!option||!option.options.some(choice=>choice.value===params.value))return send({id:frame.id,error:{code:-32602,message:'Invalid params'}});
        if(params.configId==='model')state.model=params.value;
        if(params.configId==='thought_level')state.effort=params.value;
        return result(frame.id,{configOptions:flatOptions(state),models:{currentModelId:state.model,availableModels:flatModels.map(modelId=>({modelId,name:modelId}))}});
      }
      if(splitSettings||parameterizedSettings){
        const state=settings.get(params.sessionId),option=state&&configOptions(params.sessionId).find(option=>option.id===params.configId);
        if(!option||(option.type==='boolean'?params.type!=='boolean'||typeof params.value!=='boolean':!option.options.some(option=>option.value===params.value)))return send({id:frame.id,error:{code:-32602,message:'Invalid params'}});
        if(params.configId==='model')state.model=params.value;
        if(params.configId==='reasoning_effort'||params.configId==='reasoning')state.effort=params.value;
        if(params.configId==='fast-mode'||params.configId==='fast')state.fast=params.value===true||params.value==='on'||params.value==='true';
        if(params.configId==='context')state.context=params.value;
        return result(frame.id,{configOptions:configOptions(params.sessionId)});
      }
      if(process.env.ACP_TEST_MODEL_CONFIG_ID && (!sessions.has(params.sessionId) || params.configId!==process.env.ACP_TEST_MODEL_CONFIG_ID)) return send({id:frame.id,error:{code:-32602,message:'Unknown session or config id'}});
      return result(frame.id,{configOptions:process.env.ACP_TEST_MODEL_CONFIG_ID ? [{id:process.env.ACP_TEST_MODEL_CONFIG_ID,category:'model',currentValue:params.value,options:[{value:'default-native',name:'Default'},{value:'allowed-native',name:'Allowed'}]}] : []});
    }
    if(frame.method==='fixture/requestPermission') {
      const id='permission-'+(++callbackSeq);
      const response=new Promise(resolve=>callbacks.set(id,resolve));
      send({id,method:'session/request_permission',params:{sessionId:params.sessionId,options:[{kind:'allow_once',optionId:'allow'}]}});
      return result(frame.id,await response);
    }
    if(frame.method==='fixture/modelUpdate') {
      send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'config_option_update',configOptions:[{id:'model-selector',category:'model',currentValue:'blocked-native',options:[{value:'blocked-native',name:'Blocked'}]}]}}});
      return result(frame.id,{});
    }
    if(frame.method==='fixture/sessionInfo') {
      send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'session_info_update',title:params.title}}});
      return result(frame.id,{});
    }
    if (frame.method === '_codebuddy.ai/getUserInfo') {
      const mode = process.env.ACP_TEST_CODEBUDDY_USER ?? 'missing';
      if (mode === 'refused') return send({ id: frame.id, error: { code: -32000, message: 'Authentication required' } });
      if (mode === 'present') return result(frame.id, { userInfo: { userId: 'account' } });
      return result(frame.id, {});
    }
    if (frame.method === 'session/cancel') { const pending = prompts.get(params.sessionId); if (pending) { clearTimeout(pending.timer); prompts.delete(params.sessionId); result(pending.id, { stopReason: 'cancelled' }); } return; }
    if (frame.method === 'session/prompt') {
      if (process.env.ACP_TEST_LATEST_SESSION_ONLY === '1' && latestSession && params.sessionId !== latestSession) return;
      const text = params.prompt.map(item => item.text).join('');
      if(process.env.ACP_TEST_PROGRESS==='1') {
        for(let i=0;i<2;i++)send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'usage_update',used:1200,size:200000}}});
        for(let i=0;i<2;i++)send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'plan',entries:[{content:'Check the request',status:'in_progress'},{content:'Report the result',status:'pending'}]}}});
      }
      const finish = async () => {
        if(text==='fail:response') {prompts.delete(params.sessionId);return send({id:frame.id,error:{code:-32000,message:'Provider rejected the prompt'}})}
        if (text.startsWith('call:')) {
          const session = sessions.get(params.sessionId);
          send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'native-call-1', title: text.slice(5), status: 'in_progress', rawInput: { prompt: 'child task' } } } });
          const output = await mcp(session.mcpServers[0], 'call-1', 'tools/call', { name: text.slice(5), arguments: { prompt: 'child task' } });
          send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'native-call-1', status: 'completed', rawOutput: output } } });
        }
        send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done:' + text } } } });
        result(frame.id, { stopReason: 'end_turn' }); prompts.delete(params.sessionId);
      };
      const timer = setTimeout(() => void finish().catch(() => send({ id: frame.id, error: { code: -32603, message: 'Fixture tool failed' } })), text.startsWith('wait') ? 600 : 5);
      prompts.set(params.sessionId, { id: frame.id, timer }); return;
    }
    result(frame.id, {});
  })().catch(() => process.exit(2));
});
