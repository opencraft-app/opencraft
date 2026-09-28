package instance

import "regexp"

// The web clients' ACLI commands are raw debug/exec commands. Guard both old
// and new browsers at the execution boundary, not only in their FE claim hook.
var whatsappMutationCommand = regexp.MustCompile(`\bacli\s+(?:gateway\s+qr-url|channel\s+delete)\s+--platform\s+(?:'whatsapp'|"whatsapp"|whatsapp)(?:\s|$)`)

const guardWhatsAppCommandScript = `import fcntl
import json
import os
from pathlib import Path
import shlex
import sys

command, instance_id = sys.argv[1:3]
args = shlex.split(command)
is_scan = args[:3] == ["acli", "gateway", "qr-url"]
home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
root = home / ".lightvela" / "channel-bindings"
root.mkdir(parents=True, exist_ok=True)
with (root / "whatsapp-qr.lock").open("a") as scan_lock:
    try:
        fcntl.flock(scan_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("WhatsApp scan or disconnect already in progress", file=sys.stderr)
        sys.exit(75)
    if is_scan:
        # A cached old FE may skip claim. Fail closed if another Bot now owns
        # the channel or its reservation disappeared while this request waited.
        try:
            agent = args[args.index("--agent") + 1]
            profile_id = "default" if agent in ("main", "default") else agent
            bot_id = instance_id if profile_id == "default" else agent
            with (root / "whatsapp.lock").open("a") as binding_lock:
                fcntl.flock(binding_lock.fileno(), fcntl.LOCK_EX)
                current = json.loads((root / "whatsapp.json").read_text(encoding="utf-8"))
                if current.get("bot_id") != bot_id or current.get("profile_id") != profile_id:
                    raise ValueError("owner mismatch")
        except (IndexError, ValueError, OSError, KeyError, json.JSONDecodeError):
            print("WhatsApp binding is not owned by this Bot", file=sys.stderr)
            sys.exit(76)
    # Keep the same open-file-description lock in the shell/ACLI process even
    # if the CTL request or its Python launcher is interrupted.
    os.set_inheritable(scan_lock.fileno(), True)
    os.execv("/bin/bash", ["/bin/bash", "-lc", command])
`

func guardWhatsAppDebugCommand(command, instanceID string) string {
	if !whatsappMutationCommand.MatchString(command) {
		return command
	}
	return buildHermesPythonCommand(guardWhatsAppCommandScript, command, instanceID)
}
