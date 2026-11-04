import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const sessions = new Map(), prompts = new Map();
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const result = (id, value) => send({ id, result: value });
const trace = frame => { if (process.env.ACP_TEST_TRACE) appendFileSync(process.env.ACP_TEST_TRACE, JSON.stringify({ method: frame.method, pid: process.pid, sessionId: frame.params?.sessionId, build: process.env.ACP_TEST_BUILD }) + '\n'); };
const mcp = async (server, id, method, params = {}) => {
  const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  if (!response.ok) throw new Error('MCP request failed');
  return (await response.json()).result;
};
createInterface({ input: process.stdin }).on('line', line => {
  void (async () => {
    const frame = JSON.parse(line); trace(frame); const params = frame.params ?? {};
    if (frame.method === 'initialize') return result(frame.id, { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: process.env.ACP_TEST_NO_RESUME ? {} : { resume: {} } } });
    if (frame.method === 'session/new') {
      const sessionId = `native-${sessions.size + 1}`;
      for (const server of params.mcpServers) { await mcp(server, 'init', 'initialize'); await mcp(server, 'list', 'tools/list'); }
      sessions.set(sessionId, params); return result(frame.id, { sessionId, ...(process.env.ACP_TEST_MODELS ? {...(process.env.ACP_TEST_MODEL_CONFIG_ID ? {configOptions:[{id:process.env.ACP_TEST_MODEL_CONFIG_ID,category:'model',currentValue:'default-native',options:[{value:'default-native',name:'Default'},{value:'allowed-native',name:'Allowed'}]}]} : {}),models:{currentModelId:"default-native",availableModels:[{modelId:"default-native",name:"Default"},{modelId:"allowed-native",name:"Allowed"}]}} : {}) });
    }
    if (frame.method === 'session/resume') { sessions.set(params.sessionId, params); return result(frame.id, process.env.ACP_TEST_MODELS ? {...(process.env.ACP_TEST_MODEL_CONFIG_ID ? {configOptions:[{id:process.env.ACP_TEST_MODEL_CONFIG_ID,category:'model',currentValue:'default-native',options:[{value:'default-native',name:'Default'},{value:'allowed-native',name:'Allowed'}]}]} : {}),models:{currentModelId:'default-native',availableModels:[{modelId:'default-native',name:'Default'}]}} : {}); }
    if (frame.method === 'session/set_config_option') {
      if(process.env.ACP_TEST_MODEL_CONFIG_ID && (!sessions.has(params.sessionId) || params.configId!==process.env.ACP_TEST_MODEL_CONFIG_ID)) return send({id:frame.id,error:{code:-32602,message:'Unknown session or config id'}});
      return result(frame.id,{configOptions:process.env.ACP_TEST_MODEL_CONFIG_ID ? [{id:process.env.ACP_TEST_MODEL_CONFIG_ID,category:'model',currentValue:params.value,options:[{value:'default-native',name:'Default'},{value:'allowed-native',name:'Allowed'}]}] : []});
    }
    if(frame.method==='fixture/modelUpdate') {
      send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'config_option_update',configOptions:[{id:'model-selector',category:'model',currentValue:'blocked-native',options:[{value:'blocked-native',name:'Blocked'}]}]}}});
      return result(frame.id,{});
    }
    if (frame.method === 'session/cancel') { const pending = prompts.get(params.sessionId); if (pending) { clearTimeout(pending.timer); prompts.delete(params.sessionId); result(pending.id, { stopReason: 'cancelled' }); } return; }
    if (frame.method === 'session/prompt') {
      const text = params.prompt.map(item => item.text).join('');
      const finish = async () => {
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
