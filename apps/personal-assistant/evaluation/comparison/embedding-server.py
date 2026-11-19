import json,sys,os,hashlib
from http.server import HTTPServer,BaseHTTPRequestHandler
from fastembed import TextEmbedding
cache=sys.argv[1]
model=TextEmbedding('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',cache_dir=cache,threads=2)
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a): pass
 def do_POST(self):
  try:
   b=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
   texts=b['input'] if isinstance(b['input'],list) else [b['input']]
   vectors=list(model.embed(texts))
   payload={'object':'list','model':'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2','data':[{'object':'embedding','index':i,'embedding':v.tolist()} for i,v in enumerate(vectors)],'usage':{'prompt_tokens':0,'total_tokens':0}}
   raw=json.dumps(payload).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(raw)
  except Exception as e:
   self.send_response(500);self.end_headers();self.wfile.write(json.dumps({'error':type(e).__name__}).encode())
server=HTTPServer(('127.0.0.1',0),Handler)
print(json.dumps({'port':server.server_port,'model':'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2','dimensions':384,'inputTokenLimit':128}),flush=True)
server.serve_forever()
