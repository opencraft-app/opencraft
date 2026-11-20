/** Runs in the selected sandbox. Descriptor-relative traversal refuses symlinks
 * and special files. Caller authorization and mount trust remain Host concerns. */
export const workspaceFileHelper = String.raw`import os,sys,json,stat,base64,secrets
MAX=1024*1024
fds=[]
def opened(fd):
    fds.append(fd)
    return fd
def directory(parent,name):
    return opened(os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent))
def execute():
    value=json.loads(sys.stdin.buffer.read(1500001))
    root=value['root']
    parts=value['relative'].split('/') if value['relative'] else []
    if any(p in ('','.','..') or '/' in p or '\\' in p for p in parts):raise ValueError()
    # Reject symlinks in every root component as well, not only the final root.
    fd=opened(os.open('/',os.O_RDONLY|os.O_DIRECTORY))
    for part in root.split('/')[1:]:fd=directory(fd,part)
    if value['method']=='fs/createDirectory':
        if not parts:
            if value.get('recursive'):return {}
            raise ValueError()
        parent=fd
        if value.get('recursive'):
            for part in parts:
                try:os.mkdir(part,0o700,dir_fd=parent)
                except FileExistsError:pass
                parent=directory(parent,part)
        else:
            for part in parts[:-1]:parent=directory(parent,part)
            os.mkdir(parts[-1],0o700,dir_fd=parent)
        return {}
    parent=fd
    for part in parts[:-1]:parent=directory(parent,part)
    name=parts[-1] if parts else '.'
    method=value['method']
    if method=='fs/readDirectory':
        target=directory(parent,name)
        entries=[]
        with os.scandir(target) as scan:
            for e in scan:
                if len(entries)>=2000:raise ValueError()
                entries.append(dict(fileName=e.name,isDirectory=e.is_dir(follow_symlinks=False),isFile=e.is_file(follow_symlinks=False)))
        return dict(entries=entries)
    if method=='fs/getMetadata':
        s=os.stat(name,dir_fd=parent,follow_symlinks=False)
        return dict(isDirectory=stat.S_ISDIR(s.st_mode),isFile=stat.S_ISREG(s.st_mode),isSymlink=stat.S_ISLNK(s.st_mode),createdAtMs=0,modifiedAtMs=s.st_mtime*1000)
    if method=='fs/readFile':
        file=opened(os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent))
        s=os.fstat(file)
        if not stat.S_ISREG(s.st_mode) or s.st_size>MAX:raise ValueError()
        data=bytearray()
        while True:
            chunk=os.read(file,min(65536,MAX+1-len(data)))
            if not chunk:break
            data.extend(chunk)
            if len(data)>MAX:raise ValueError()
        return dict(dataBase64=base64.b64encode(data).decode())
    if method=='fs/writeFile':
        if not parts:raise ValueError()
        mode=0o600
        try:
            s=os.stat(name,dir_fd=parent,follow_symlinks=False)
            if not stat.S_ISREG(s.st_mode):raise ValueError()
            mode=stat.S_IMODE(s.st_mode)&0o777
        except FileNotFoundError:pass
        data=base64.b64decode(value['dataBase64'],validate=True)
        if len(data)>MAX:raise ValueError()
        temporary='.opencraft-write-'+secrets.token_hex(16)
        file=opened(os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent))
        try:
            view=memoryview(data)
            while len(view):view=view[os.write(file,view):]
            os.fchmod(file,mode)
            os.fsync(file)
            os.replace(temporary,name,src_dir_fd=parent,dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            try:os.unlink(temporary,dir_fd=parent)
            except FileNotFoundError:pass
        return {}
    raise ValueError()
try:print(json.dumps(execute(),separators=(',',':')))
except Exception:print('{"error":"workspace_file_rejected"}')
finally:
    for fd in reversed(fds):
        try:os.close(fd)
        except OSError:pass
`;
