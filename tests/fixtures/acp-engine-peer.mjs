import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
const sessions = new Map(), prompts = new Map();
const settings = new Map();
const nativeCatalogs = new Map(), nativeSelections = new Map();
const readNativeCatalog = () => JSON.parse(readFileSync(process.env.ACP_TEST_MODEL_CATALOG_FILE,'utf8'));
const catalogOptions = id => [{ id:'model',category:'model',type:'select',currentValue:(nativeSelections.get(id)??'').split('[')[0],
  options:(nativeCatalogs.get(id)??[]).map(model=>({value:model.modelId.split('[')[0],name:model.name})) },
  {id:'reasoning_effort',category:'thought_level',type:'select',currentValue:'high',options:[{value:'high',name:'High'}]}];
const permissionSettings = new Map();
let formElicitation = false;
const permissionOptions = id => process.env.ACP_TEST_PERMISSIONS === '1' ? [{id:'execution-mode',category:'mode',type:'select',currentValue:permissionSettings.get(id) ?? 'agent',options:[
  {value:'read-only',name:'Read Only'}, {value:'workspace-write',name:'Workspace Write'}, {value:'agent',name:'Auto Review'}, {value:'agent-full-access',name:'Full Access'},
  {group:'custom',name:'Custom',options:[{value:'permission-profile:team',name:'Team policy'}]},
]}] : [];
const splitSettings = process.env.ACP_TEST_SPLIT_MODEL_CONFIG === '1';
const parameterizedSettings = process.env.ACP_TEST_PARAMETERIZED === '1';
let parameterizedPicker = false;
const configOptions = (id, state = settings.get(id)) => {
  if (parameterizedSettings) return [...permissionOptions(id),
    {id:'model',category:'model',type:'select',currentValue:state.model,options:['one','two'].map(value=>({value,name:value}))},
    ...(state.model==='one' ? [
      {id:'reasoning',category:'thought_level',type:'select',currentValue:state.effort,options:['low','high'].map(value=>({value,name:value}))},
      {id:'fast',category:'other',type:'select',currentValue:String(state.fast),options:['false','true'].map(value=>({value,name:value}))},
      {id:'context',category:'other',type:'select',currentValue:state.context,options:['256k','1m'].map(value=>({value,name:value}))},
    ] : []),
  ];
  return [...permissionOptions(id),
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
const requestSessions = new Map();
const result = (id, value) => {
  const requestSession = requestSessions.get(id); requestSessions.delete(id);
  if(value?.sessionId && process.env.ACP_TEST_MODEL_CATALOG_FILE) {
    if(process.env.ACP_TEST_MODEL_CATALOG_FAILURE==='1')return send({id,error:{code:-32000,message:'Native model discovery failed'}});
    const models=readNativeCatalog();nativeCatalogs.set(value.sessionId,models);nativeSelections.set(value.sessionId,models[0]?.modelId);
    value={...value,models:{availableModels:models,currentModelId:models[0]?.modelId},configOptions:catalogOptions(value.sessionId)};
  }
  if (value && process.env.ACP_TEST_PERMISSIONS === '1' && requestSession && (value.sessionId || value.configOptions || value.models || Object.keys(value).length === 0)) {
    value = {...value, configOptions:[...(value.configOptions ?? []).filter(option=>option.category!=='mode'), ...permissionOptions(requestSession)]};
  }
  send({ id, result: value });
};
const trace = frame => { if (process.env.ACP_TEST_TRACE) appendFileSync(process.env.ACP_TEST_TRACE, JSON.stringify({ method: frame.method, pid: process.pid, sessionId: frame.params?.sessionId, configId:frame.params?.configId,modelId:frame.params?.modelId,value:frame.params?.value,type:frame.params?.type,build: process.env.ACP_TEST_BUILD,
  ...(process.env.ACP_TEST_QUESTIONS && typeof frame.id === 'string' && frame.id.startsWith('fixture-question:') ? { questionId: frame.id, reply: frame.result } : {}),
  ...(process.env.ACP_TEST_TRACE_CWD==='1'?{cwd:process.cwd()}:{}),
  ...(process.env.ACP_TEST_TRACE_HOME==='1'?{codexHome:process.env.CODEX_HOME}:{}),
  ...(frame.method==='initialize'?{parameterizedPicker:frame.params?.clientCapabilities?._meta?.parameterizedModelPicker}:{}),
  ...(parameterizedSettings&&frame.method==='session/prompt'?{settings:settings.get(frame.params.sessionId)}:{}),
  ...(process.env.ACP_TEST_PERMISSIONS==='1'&&frame.method==='session/prompt'?{permissionMode:permissionSettings.get(frame.params.sessionId) ?? 'agent'}:{}),
  ...(process.env.ACP_TEST_IMAGES==='1'&&frame.method==='session/prompt'?{prompt:frame.params.prompt}:{}),
  ...(frame.method==='_session/goal'?{action:frame.params?.action,objective:frame.params?.objective}:{}),
  ...(frame.method==='_session/steering'?{prompt:frame.params?.prompt}:{}),
  ...(process.env.ACP_TEST_GOAL==='1'&&frame.method==='session/prompt'?{promptText:frame.params?.prompt?.map(item=>item.text).join('')}:{}),
}) + '\n'); };
const mcp = async (server, id, method, params = {}) => {
  const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  if (!response.ok) throw new Error('MCP request failed');
  return (await response.json()).result;
};
createInterface({ input: process.stdin }).on('line', line => {
  void (async () => {
    const frame = JSON.parse(line); trace(frame); const params = frame.params ?? {}; requestSessions.set(frame.id, params.sessionId);
    if (frame.method === 'initialize') formElicitation = params.clientCapabilities?.elicitation?.form != null;
    if (frame.method === 'fixture/ask' && process.env.ACP_TEST_QUESTIONS) {
      if (!formElicitation) return send({id:frame.id,error:{code:-32602,message:'Client did not advertise form elicitation'}});
      send({ id: `fixture-question:${params.questionId}`, method: 'elicitation/create', params: params.form });
      return result(frame.id, {});
    }
    if (frame.method === 'fixture/cancelQuestion' && process.env.ACP_TEST_QUESTIONS) {
      send({ method: '$/cancel_request', params: { requestId: `fixture-question:${params.questionId}` } });
      return result(frame.id, {});
    }
    if (frame.method === 'initialize') { parameterizedPicker=params.clientCapabilities?._meta?.parameterizedModelPicker===true;return result(frame.id, { protocolVersion: 1, agentCapabilities: { ...(process.env.ACP_TEST_IMAGES==='1'?{promptCapabilities:{image:true}}:{}), mcpCapabilities: { http: true }, sessionCapabilities: {...(process.env.ACP_TEST_SESSION_HANDOFF ? {fork:{},close:{}} : {}),... (process.env.ACP_TEST_NO_RESUME ? {} : { resume: {} }),...((process.env.ACP_TEST_TITLE_LIST||process.env.ACP_TEST_IMPORT_SESSIONS)?{list:{}}:{})} } }); }
    if(frame.method==='session/list'&&process.env.ACP_TEST_IMPORT_SESSIONS)return result(frame.id,JSON.parse(process.env.ACP_TEST_IMPORT_SESSIONS));
    if(frame.method==='session/list')return result(frame.id,{sessions:[...sessions.keys()].map(sessionId=>({sessionId,title:process.env.ACP_TEST_TITLE_LIST}))});
    if(frame.method==='_cursor/list_available_models') {
      if(process.env.ACP_TEST_NO_MODEL_EXTENSION==='1')return send({id:frame.id,error:{code:-32601,message:'Method not found'}});
      return result(frame.id,{models:['one','two'].map(model=>({value:model,name:model,configOptions:configOptions(null,{model,effort:'high',fast:false,context:'1m'}).filter(option=>option.id!=='model')}))});
    }
    if (frame.method === '_session/goal') {
      return result(frame.id, { status: 'ok' });
    }
    if (frame.method === '_session/steering') {
      return result(frame.id, { outcome: 'steered' });
    }
    if (frame.method === 'session/new') {
      const sessionId = process.env.ACP_TEST_NATIVE_ID ?? `native-${sessions.size + 1}`; requestSessions.set(frame.id,sessionId); permissionSettings.set(sessionId,'agent');
      for (const server of params.mcpServers) { await mcp(server, 'init', 'initialize'); await mcp(server, 'list', 'tools/list'); }
      if(parameterizedSettings&&!parameterizedPicker)return send({id:frame.id,error:{code:-32602,message:'Parameterized picker not enabled'}});
      if (process.env.ACP_TEST_AVAILABLE_COMMANDS) {
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: JSON.parse(process.env.ACP_TEST_AVAILABLE_COMMANDS) } } });
      }
      sessions.set(sessionId, params); if(splitSettings||parameterizedSettings)return result(frame.id,setup(sessionId));return result(frame.id, { sessionId, ...(process.env.ACP_TEST_MODELS ? {...(process.env.ACP_TEST_MODEL_CONFIG_ID ? {configOptions:[{id:process.env.ACP_TEST_MODEL_CONFIG_ID,category:'model',currentValue:'default-native',options:[{value:'default-native',name:'Default'},{value:'allowed-native',name:'Allowed'}]}]} : {}),models:{currentModelId:"default-native",availableModels:[{modelId:"default-native",name:"Default"},{modelId:"allowed-native",name:"Allowed"}]}} : {}) });
    }
    if (frame.method === 'session/fork') {
      if (!process.env.ACP_TEST_SESSION_HANDOFF) return send({id:frame.id,error:{code:-32601,message:'Unsupported'}});
      const sessionId = `forked-${sessions.size + 1}`; requestSessions.set(frame.id,sessionId); permissionSettings.set(sessionId,'agent'); sessions.set(sessionId, params);
      return result(frame.id, splitSettings ? setup(sessionId) : {sessionId});
    }
    if (frame.method === 'session/close') { sessions.delete(params.sessionId); return result(frame.id, {}); }
    if (frame.method === 'session/resume') {
      permissionSettings.set(params.sessionId,'agent');
      if(process.env.ACP_TEST_BUSY_NATIVE===params.sessionId)return send({id:frame.id,error:{code:-32600,message:'This Codex session is in use by another Codex client'}});
 sessions.set(params.sessionId, params);if(splitSettings||parameterizedSettings)return result(frame.id,setup(params.sessionId));return result(frame.id, process.env.ACP_TEST_MODELS ? {...(process.env.ACP_TEST_MODEL_CONFIG_ID ? {configOptions:[{id:process.env.ACP_TEST_MODEL_CONFIG_ID,category:'model',currentValue:'default-native',options:[{value:'default-native',name:'Default'},{value:'allowed-native',name:'Allowed'}]}]} : {}),models:{currentModelId:'default-native',availableModels:[{modelId:'default-native',name:'Default'}]}} : {}); }
    if(frame.method==='session/set_model' && process.env.ACP_TEST_MODEL_CATALOG_FILE) {
      const models=readNativeCatalog();
      if(!models.some(model=>model.modelId===params.modelId))return send({id:frame.id,error:{code:-32602,message:'Unknown model'}});
      nativeCatalogs.set(params.sessionId,models);nativeSelections.set(params.sessionId,params.modelId);
      send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'config_option_update',configOptions:[...catalogOptions(params.sessionId),...permissionOptions(params.sessionId)]}}});
      return send({id:frame.id,result:{}});
    }
    if (frame.method === 'session/set_config_option') {
      if(process.env.ACP_TEST_MODEL_CATALOG_FILE && params.configId==='model') {
        const models=readNativeCatalog();
        if(!models.some(model=>model.modelId.split('[')[0]===params.value))return send({id:frame.id,error:{code:-32602,message:'Unknown model'}});
        nativeCatalogs.set(params.sessionId,models);nativeSelections.set(params.sessionId,params.value);
        return result(frame.id,{configOptions:catalogOptions(params.sessionId)});
      }
      if(process.env.ACP_TEST_PERMISSIONS === '1' && params.configId==='execution-mode') {
        if(process.env.ACP_TEST_PERMISSION_FAILURE==='reject')return send({id:frame.id,error:{code:-32602,message:'Mode change refused'}});
        if(process.env.ACP_TEST_PERMISSION_FAILURE==='empty')return send({id:frame.id,result:{}});
        if(process.env.ACP_TEST_PERMISSION_FAILURE!=='mismatch')permissionSettings.set(params.sessionId,params.value);
        return result(frame.id,{configOptions:permissionOptions(params.sessionId)});
      }
      if(splitSettings||parameterizedSettings){
        const state=settings.get(params.sessionId),option=state&&configOptions(params.sessionId).find(option=>option.id===params.configId);
        if(!option||(option.type==='boolean'?params.type!=='boolean'||typeof params.value!=='boolean':!option.options.some(option=>option.value===params.value)))return send({id:frame.id,error:{code:-32602,message:'Invalid params'}});
        if(params.configId==='model'&&process.env.ACP_TEST_REFUSE_MODEL!=='1')state.model=params.value;
        if((params.configId==='reasoning_effort'||params.configId==='reasoning')&&process.env.ACP_TEST_REFUSE_REASONING!=='1')state.effort=params.value;
        if(params.configId==='fast-mode'||params.configId==='fast')state.fast=params.value===true||params.value==='on'||params.value==='true';
        if(params.configId==='context')state.context=params.value;
        return result(frame.id,{configOptions:configOptions(params.sessionId)});
      }
      if(process.env.ACP_TEST_MODEL_CONFIG_ID && (!sessions.has(params.sessionId) || params.configId!==process.env.ACP_TEST_MODEL_CONFIG_ID)) return send({id:frame.id,error:{code:-32602,message:'Unknown session or config id'}});
      return result(frame.id,{configOptions:process.env.ACP_TEST_MODEL_CONFIG_ID ? [{id:process.env.ACP_TEST_MODEL_CONFIG_ID,category:'model',currentValue:params.value,options:[{value:'default-native',name:'Default'},{value:'allowed-native',name:'Allowed'}]}] : []});
    }
    if(frame.method==='fixture/modelUpdate') {
      send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'config_option_update',configOptions:[{id:'model-selector',category:'model',currentValue:'blocked-native',options:[{value:'blocked-native',name:'Blocked'}]}]}}});
      return result(frame.id,{});
    }
    if(frame.method==='fixture/sessionInfo') {
      send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'session_info_update',title:params.title}}});
      return result(frame.id,{});
    }
    if (frame.method === 'session/cancel') { const pending = prompts.get(params.sessionId); if (pending) { clearTimeout(pending.timer); prompts.delete(params.sessionId); result(pending.id, { stopReason: 'cancelled' }); } return; }
    if (frame.method === 'session/prompt') {
      const text = params.prompt.map(item => item.text).join('');
      if(process.env.ACP_TEST_PROGRESS==='1') {
        for(let i=0;i<2;i++)send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'usage_update',used:1200,size:200000}}});
        for(let i=0;i<2;i++)send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'plan',entries:[{content:'Check the request',status:'in_progress'},{content:'Report the result',status:'pending'}]}}});
      }
      const finish = async () => {
        if(text==='fail:response') {prompts.delete(params.sessionId);return send({id:frame.id,error:{code:-32000,message:'Provider rejected the prompt'}})}
        if(text==='fail:account-mismatch') {prompts.delete(params.sessionId);return send({id:frame.id,error:{code:-32603,message:"The current provider can't read this thread's earlier reasoning, which another provider or account encrypted. This happens after the provider changes in a thread. Switch back to the previous provider or start a new thread."}})}
        if (text.startsWith('call:')) {
          const session = sessions.get(params.sessionId);
          send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'native-call-1', title: text.slice(5), status: 'in_progress', rawInput: { prompt: 'child task' } } } });
          const output = await mcp(session.mcpServers[0], 'call-1', 'tools/call', { name: text.slice(5), arguments: { prompt: 'child task' } });
          send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'native-call-1', status: 'completed', rawOutput: output } } });
        }
        send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done:' + text } } } });
        result(frame.id, { stopReason: 'end_turn' }); prompts.delete(params.sessionId);
      };
      const timer = setTimeout(() => void finish().catch(() => send({ id: frame.id, error: { code: -32603, message: 'Fixture tool failed' } })), text.startsWith('wait') ? Number(process.env.ACP_TEST_WAIT_MS || 600) : 5);
      prompts.set(params.sessionId, { id: frame.id, timer, finish }); return;
    }
    if (frame.method === 'fixture/finish') { const pending=prompts.get(params.sessionId);if(pending){clearTimeout(pending.timer);await pending.finish();}return result(frame.id,{}); }
    result(frame.id, {});
  })().catch(() => process.exit(2));
});
