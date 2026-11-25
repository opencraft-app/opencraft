"""Run the preview operator with an exclusive, process-scoped local lock."""
import fcntl
import os
from pathlib import Path
import sys

if len(sys.argv) < 3:
    raise SystemExit("Expected <preview-state> <operation>")
state = Path(sys.argv[1]).expanduser().resolve()
state.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
lock = os.open(str(state) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit("Another deployment is operating on this preview state")
os.set_inheritable(lock, True)
entry = Path(__file__).resolve().with_name("deploy-preview.ts")
os.execvp("node", ["node", "--use-env-proxy", "--import", "tsx", str(entry), str(state), *sys.argv[2:]])
