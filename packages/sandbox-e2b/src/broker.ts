/** ASCII framing preserves arbitrary stdout/stderr bytes over the SDK's text callbacks.
 * This process is transport only: no Bot identity, memory, model or API credentials. */
export const brokerSource = String.raw`import base64,json,os,signal,subprocess,sys,threading
lock=threading.Lock()
child=None
def emit(value):
    with lock:
        sys.stdout.write(json.dumps(value,separators=(',',':'))+'\n')
        sys.stdout.flush()
def stop():
    if child is not None:
        try: os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError: pass
def output(pipe,stream):
    try:
        while True:
            data=os.read(pipe.fileno(),32768)
            if not data: break
            emit({'type':'output','stream':stream,'data':base64.b64encode(data).decode('ascii')})
    except BaseException:
        stop()
def wait(readers):
    code=child.wait()
    for reader in readers: reader.join()
    emit({'type':'exit','code':code if code>=0 else None,'signal':signal.Signals(-code).name if code<0 else None})
    os._exit(0)
try:
    for line in iter(lambda:sys.stdin.buffer.readline(400001),b''):
        if len(line)>400000 or not line.endswith(b'\n'): raise ValueError()
        message=json.loads(line)
        kind=message['type']
        if kind=='start' and child is None:
            command=message['command']
            child=subprocess.Popen(command['command'],cwd=command['cwd'],env={**os.environ,**command['env']},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
            emit({'type':'started'})
            readers=[threading.Thread(target=output,args=(child.stdout,'stdout'),daemon=True),threading.Thread(target=output,args=(child.stderr,'stderr'),daemon=True)]
            for reader in readers: reader.start()
            threading.Thread(target=wait,args=(readers,),daemon=True).start()
        elif kind=='stdin' and child is not None:
            child.stdin.write(base64.b64decode(message['data'],validate=True))
            child.stdin.flush()
        elif kind=='eof' and child is not None:
            child.stdin.close()
        elif kind=='terminate' and child is not None:
            stop()
        else:
            raise ValueError()
    stop()
except BaseException:
    try: emit({'type':'error'})
    finally: stop()
    os._exit(2)
`;
