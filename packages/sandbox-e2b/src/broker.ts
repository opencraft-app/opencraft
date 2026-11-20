/** ASCII framing preserves arbitrary stdout/stderr bytes over the SDK's text callbacks.
 * This process is transport only: no Bot identity, memory, model or API credentials. */
export const brokerSource = String.raw`import base64,errno,fcntl,json,os,pty,signal,struct,subprocess,sys,termios,threading
lock=threading.Lock()
child=None
master=None
def size(fd,value):
    cols,rows=value["cols"],value["rows"]
    if type(cols) is not int or type(rows) is not int or not (0<cols<=1000 and 0<rows<=1000): raise ValueError()
    fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",rows,cols,0,0))
def terminal_session():
    os.setsid()
    fcntl.ioctl(0,termios.TIOCSCTTY,0)
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
            try: data=os.read(pipe if type(pipe) is int else pipe.fileno(),32768)
            except OSError as error:
                if pipe==master and error.errno==errno.EIO: break
                raise
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
            if command.get('terminal'):
                master,slave=pty.openpty()
                size(slave,command['terminal'])
                try:
                    child=subprocess.Popen(command['command'],cwd=command['cwd'],env={**os.environ,'TERM':'xterm-256color',**command['env']},stdin=slave,stdout=slave,stderr=slave,preexec_fn=terminal_session)
                finally: os.close(slave)
            else:
                child=subprocess.Popen(command['command'],cwd=command['cwd'],env={**os.environ,**command['env']},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
            emit({'type':'started'})
            readers=([threading.Thread(target=output,args=(master,'stdout'),daemon=True)] if master is not None else [threading.Thread(target=output,args=(child.stdout,'stdout'),daemon=True),threading.Thread(target=output,args=(child.stderr,'stderr'),daemon=True)])
            for reader in readers: reader.start()
            threading.Thread(target=wait,args=(readers,),daemon=True).start()
        elif kind=='stdin' and child is not None:
            data=base64.b64decode(message['data'],validate=True)
            if master is not None:
                while data:
                    count=os.write(master,data)
                    if count<=0: raise OSError()
                    data=data[count:]
            else:
                child.stdin.write(data)
                child.stdin.flush()
        elif kind=='resize' and master is not None:
            size(master,message['size'])
        elif kind=='eof' and child is not None and master is None:
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
