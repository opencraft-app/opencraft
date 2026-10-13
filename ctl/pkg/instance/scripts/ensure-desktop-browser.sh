#!/bin/bash
# Offline image-browser reuse. Explicit modes; safe skips never install packages.
set -euo pipefail
exec python3 - "${1:---check}" "${2:-agentuser}" <<'PY'
import base64,configparser,fcntl,hashlib,json,os,pwd,re,shutil,stat,subprocess,sys,tempfile
from pathlib import Path as P
MODE,USER=sys.argv[1:];NAME='vela-desktop-browser-v2'
STATE=P('/var/lib/'+NAME);LIB=P('/usr/local/lib/'+NAME);BIN=P('/usr/local/bin/'+NAME);POLICY=P('/etc/apparmor.d/'+NAME)
def emit(status,**kw): print('LV_BROWSER_JSON='+json.dumps(dict(status=status,downloads=0,package_installs=0,gui_verified=False,**kw),separators=(',',':')))
def stop(status):emit(status);sys.exit(0)
def trusted(p,allow_link=False):
 if p.is_symlink() and not allow_link:raise RuntimeError('symlinked managed path: '+str(p))
 for q in [p,*p.parents]:
  if q.exists():
   if q.is_symlink() and q!=p:raise RuntimeError('symlinked ancestor: '+str(q))
   s=q.stat()
   if s.st_uid!=0 or s.st_mode&0o022:raise RuntimeError('untrusted root path: '+str(q))
def run(args,**kw):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=20,**kw)
if MODE not in ['--check','--apply','--rollback'] or not re.fullmatch('[a-z_][a-z0-9_-]*',USER):sys.exit(64)
if os.getuid()!=0:stop('ROOT_REQUIRED')
try:u=pwd.getpwnam(USER)
except KeyError:stop('USER_MISSING')
if u.pw_uid==0 or u.pw_dir!='/home/'+USER:stop('UNSUPPORTED_USER_HOME')
# User paths are read/written only as that user, never as root, including rollback.
USER_PROGRAM=r'''
import base64,configparser,json,sys
from pathlib import Path as P
h=P.home();name='vela-desktop-browser-v2';req=json.loads(sys.stdin.read());paths=[h/'.local/share/applications'/f'{name}.desktop',h/'.local/share/xfce4/helpers'/f'{name}.desktop',h/'.config/xfce4/helpers.rc',h/'.config/mimeapps.list',h/'.local/share/applications/mimeapps.list']
for p in paths:
 if p.is_symlink() or any(q.is_symlink() for q in p.parents if q!=h.parent):raise RuntimeError('symlinked user path')
 if p.exists() and (not p.is_file() or p.stat().st_size>65536):raise RuntimeError('unsupported user config')
def snap():return {str(p):base64.b64encode(p.read_bytes()).decode() if p.exists() else None for p in paths}
if req['op']=='read':
 rc=paths[2].read_text() if paths[2].exists() else ''
 helper=next((l.split('=',1)[1].strip() for l in rc.splitlines() if l.startswith('WebBrowser=')),'')
 mime_defaults=[]
 for p in paths[3:]:
  c=configparser.ConfigParser(interpolation=None,strict=False);c.optionxform=str
  if p.exists():c.read(p)
  if c.has_section('Default Applications'):
   for m in ['text/html','x-scheme-handler/http','x-scheme-handler/https']:
    if c.has_option('Default Applications',m):mime_defaults.append(c.get('Default Applications',m))
 print(json.dumps(dict(snapshot=snap(),helper=helper,mime_defaults=mime_defaults)));sys.exit()
if req['op']=='restore':
 if snap()!=req['expected']:raise RuntimeError('user config drift; refuse rollback')
 for p in paths:
  value=req['snapshot'][str(p)]
  if value is None:
   if p.exists():p.unlink()
  else:p.write_bytes(base64.b64decode(value))
 print('{}');sys.exit()
# Validate again as the user immediately before each atomic replacement.
def write(p,text):
 p.parent.mkdir(parents=True,exist_ok=True)
 if p.is_symlink():raise RuntimeError('user config symlink')
 import tempfile,os
 fd,tmp=tempfile.mkstemp(dir=p.parent);os.write(fd,text.encode());os.close(fd);os.chmod(tmp,0o644);os.replace(tmp,p)
write(paths[0],f'[Desktop Entry]\nType=Application\nName=LightVela Web Browser\nExec=/usr/local/bin/{name} %U\nIcon=web-browser\nTerminal=false\nCategories=Network;WebBrowser;\nMimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;\n')
write(paths[1],f'[Desktop Entry]\nVersion=1.0\nType=X-XFCE-Helper\nName=LightVela Web Browser\nIcon=web-browser\nX-XFCE-Category=WebBrowser\nX-XFCE-Binaries={name};\nX-XFCE-Commands=%B;\nX-XFCE-CommandsWithParameter=%B "%s";\n')
rc=paths[2].read_text() if paths[2].exists() else '';write(paths[2],'\n'.join([l for l in rc.splitlines() if not l.startswith('WebBrowser=')]+['WebBrowser='+name])+'\n')
for p in paths[3:]:
 c=configparser.ConfigParser(interpolation=None,strict=False);c.optionxform=str
 if p.exists():c.read(p)
 if not c.has_section('Default Applications'):c.add_section('Default Applications')
 for m in ['text/html','x-scheme-handler/http','x-scheme-handler/https']:c.set('Default Applications',m,name+'.desktop')
 import io
 f=io.StringIO();c.write(f,space_around_delimiters=False);write(p,f.getvalue())
print(json.dumps(dict(snapshot=snap())))
'''
def user(op,**kw):return json.loads(run(['runuser','-u',USER,'--','env','HOME='+u.pw_dir,'python3','-c',USER_PROGRAM],input=json.dumps(dict(op=op,**kw))).stdout)
def fingerprint(p):
 if p.is_symlink():return 'link:'+os.readlink(p)
 if not p.exists():return 'absent'
 if p.is_dir():return 'dir:'+json.dumps({x.name:fingerprint(x) for x in sorted(p.iterdir())},sort_keys=True)
 return 'file:'+hashlib.sha256(p.read_bytes()).hexdigest()
ROOTS=[LIB,BIN,POLICY]
try:
 for p in [STATE,LIB,BIN,POLICY]:trusted(p)
 if MODE=='--rollback':
  if not (STATE/'manifest.json').exists():stop('NOT_MANAGED')
  lock=open(STATE/'lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  m=json.loads((STATE/'manifest.json').read_text())
  if any(fingerprint(P(p))!=v for p,v in m['after_root'].items()):stop('ROLLBACK_CONFLICT')
  user('restore',snapshot=m['before_user'],expected=m['after_user'])
  if POLICY.exists():run(['apparmor_parser','-R',str(POLICY)]);POLICY.unlink()
  BIN.unlink();shutil.rmtree(LIB);(STATE/'manifest.json').unlink();emit('ROLLED_BACK');sys.exit()
 cfg=user('read')
 managed=(STATE/'manifest.json').exists()
 if managed:
  m=json.loads((STATE/'manifest.json').read_text())
  if cfg['snapshot']!=m['after_user'] or any(fingerprint(P(p))!=v for p,v in m['after_root'].items()):stop('MANAGED_CONFIG_DRIFT')
  if not P(m['binary']).exists() or not os.path.samefile(m['binary'],LIB/'chrome'):stop('IMAGE_BROWSER_CHANGED')
  trusted(P(m['binary']))
  for resource in LIB.iterdir():trusted(resource.resolve() if resource.is_symlink() else resource)
  profiles=P('/sys/kernel/security/apparmor/profiles')
  if POLICY.exists() and (not profiles.exists() or not any(line.startswith(NAME+' ') for line in profiles.read_text().splitlines())):stop('POLICY_NOT_LOADED')
  emit('ALREADY_CONFIGURED',binary=m['binary']);sys.exit()
 # Keep existing system browsers or custom browser preferences, even if GUI viability is unknown.
 if any(shutil.which(b) for b in ['google-chrome','google-chrome-stable','chromium','chromium-browser','firefox']):stop('EXISTING_SYSTEM_BROWSER_PRESERVED')
 if cfg['helper'] not in ['', 'debian-sensible-browser']:stop('CUSTOM_BROWSER_PRESERVED')
 if any(x not in ['', 'debian-sensible-browser.desktop;','debian-sensible-browser.desktop'] for x in cfg['mime_defaults']):stop('CUSTOM_MIME_PRESERVED')
 if any(p.exists() or p.is_symlink() for p in ROOTS):stop('UNMANAGED_PATH_CONFLICT')
 candidates=sorted(P('/opt/ms-playwright').glob('chromium-[0-9]*/chrome-linux*/chrome'),key=lambda p:int(re.search(r'chromium-(\d+)',str(p)).group(1)),reverse=True)
 if not candidates:stop('IMAGE_BROWSER_MISSING')
 b=candidates[0];trusted(b)
 # All adjacent resources must remain root-controlled; no user-writable cache is allowed.
 for p in b.parent.rglob('*'):
  if p.is_symlink():trusted(p.resolve())
  else:trusted(p)
 dep=run(['ldd',str(b)])
 if 'not found' in dep.stdout:stop('DEPENDENCIES_MISSING')
 if os.stat(b).st_dev!=os.stat(LIB.parent).st_dev:stop('HARDLINK_UNSUPPORTED')
 restricted=P('/proc/sys/kernel/apparmor_restrict_unprivileged_userns');restricted=restricted.exists() and restricted.read_text().strip()=='1'
 profiles=P('/sys/kernel/security/apparmor/profiles')
 if profiles.exists() and any(line.startswith(NAME+' ') for line in profiles.read_text().splitlines()):stop('UNMANAGED_APPARMOR_PROFILE')
 if restricted and (not shutil.which('apparmor_parser') or not P('/sys/module/apparmor/parameters/enabled').exists() or P('/sys/module/apparmor/parameters/enabled').read_text().strip()!='Y'):stop('APPARMOR_UNAVAILABLE')
 if MODE=='--check':emit('ELIGIBLE',binary=str(b),isolated_launch_path=str(LIB/'chrome'));sys.exit()
 STATE.mkdir(mode=0o700,exist_ok=True);trusted(STATE);lock=open(STATE/'lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 # Repeat conflict check under lock. Never adopt foreign files or replace running browser defaults.
 if any(p.exists() or p.is_symlink() for p in ROOTS):stop('UNMANAGED_PATH_CONFLICT')
 before=cfg['snapshot'];created=[];user_after=None;policy_loaded=False
 try:
  LIB.mkdir(mode=0o755);created.append(LIB)
  # Hard link shares the existing executable's blocks; resource symlinks avoid any download/copy.
  os.link(b,LIB/'chrome')
  for p in b.parent.iterdir():
   if p.name!='chrome':os.symlink(str(p),LIB/p.name)
  if restricted:
   POLICY.write_text(f'abi <abi/4.0>,\ninclude <tunables/global>\nprofile {NAME} {LIB}/chrome flags=(unconfined) {{\n  userns,\n}}\n');POLICY.chmod(0o644);created.append(POLICY)
   run(['apparmor_parser','-Q','-T',str(POLICY)]);run(['apparmor_parser','-r',str(POLICY)]);policy_loaded=True
  BIN.write_text('#!/bin/bash\nset -euo pipefail\n[ "$(id -u)" != 0 ] || exit 1\nunset CHROME_DEVEL_SANDBOX\nexec '+str(LIB)+'/chrome --password-store=basic --no-first-run --no-default-browser-check --disable-gpu --disable-dev-shm-usage --user-data-dir="$HOME/.local/share/'+NAME+'" "$@"\n');BIN.chmod(0o755);created.append(BIN)
  # Detect user preference changes made since precheck, before modifying anything as the user.
  if user('read')['snapshot']!=before:raise RuntimeError('user config changed during apply')
  user_after=user('apply')['snapshot']
  manifest=dict(binary=str(b),before_user=before,after_user=user_after,after_root={str(p):fingerprint(p) for p in ROOTS})
  (STATE/'manifest.json').write_text(json.dumps(manifest));(STATE/'manifest.json').chmod(0o600)
 except Exception:
  # No blind user rollback after partial write; leave explicit failure for manual reconciliation.
  if user_after is not None:user('restore',snapshot=before,expected=user_after)
  elif user('read')['snapshot']!=before:
   # Preserve a usable launcher rather than deleting it under partially written defaults.
   (STATE/'partial-apply.json').write_text(json.dumps(dict(before_user=before)))
   raise RuntimeError('partial user apply; manual reconciliation required')
  if policy_loaded:run(['apparmor_parser','-R',str(POLICY)])
  for p in reversed(created):
   if p.is_dir():shutil.rmtree(p)
   elif p.exists():p.unlink()
  raise
 emit('CONFIGURED',binary=str(b),isolated_launch_path=str(LIB/'chrome'))
except BlockingIOError:stop('BUSY')
except Exception as e:
 # Exception messages never contain user config or secrets.
 emit('FAILED',error_type=type(e).__name__);sys.exit(1)
PY
