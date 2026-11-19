import os,sys,json,traceback,contextlib,datetime
# All SDK prints/logging stay on stderr; stdout is JSONL RPC only.
client=None
for line in sys.stdin:
 try:
  req=json.loads(line)
  with contextlib.redirect_stdout(sys.stderr):
   if req['op']=='init':
    os.environ.update({'MEMORY_DATA_DIR':req['directory'],'MEMORY_LLM_BASE_URL':req['bridge']+'/v1','MEMORY_LLM_API_KEY':'local-comparison','MEMORY_LLM_MODEL':req['model'],'MEMORY_LLM_MAX_RETRIES':'1','MEMORY_LLM_TIMEOUT':'120','MEMORY_ENABLE_GRAPH':'false','MEMORY_EMBEDDER_BASE_URL':req['embedding']+'/v1','MEMORY_EMBEDDER_API_KEY':'local-comparison','MEMORY_EMBEDDER_MODEL':'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2','MEMORY_EMBEDDING_DIMS':'384','MEMORY_LANGUAGE':'en','HY_MEMORY_READER':'hybrid','ANONYMIZED_TELEMETRY':'False'})
    from hy_memory import HyMemoryClient
    client=HyMemoryClient(mode='pro');result={'ready':True}
   elif req['op']=='add':
    result=client.add(req['messages'],user_id='subject',agent_id='assistant',session_id='conversation',scene='chat',memory_at=datetime.datetime.fromisoformat(req['timestamp'].replace('Z','+00:00')))
   elif req['op']=='search':
    result=client.search(req['query'],user_ids=['subject'],agent_ids=['assistant'],scene='chat',limit=12,layers=['l0_basic_info','l2_fact','l3_summary'],search_mode='default',rerank=False)
    result={'profile':client.get_user_profile(user_id='subject'),'retrieval':result}
   elif req['op']=='snapshot':result=client.list_memories(user_id='subject',limit=10000)
   elif req['op']=='close':
    if client:client.close()
    result={'closed':True}
   else:raise ValueError('Unknown operation')
  print(json.dumps({'id':req['id'],'ok':True,'result':result},default=str),flush=True)
  if req['op']=='close':break
 except Exception as e:
  traceback.print_exc(file=sys.stderr);print(json.dumps({'id':req.get('id'),'ok':False,'error':type(e).__name__,'message':str(e)[:300]}),flush=True)
