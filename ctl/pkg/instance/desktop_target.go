package instance

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
)

const desktopTargetVerifyPath = "/usr/local/libexec/opencraft/desktop-target-verify.py"

//go:embed desktop_target_verify.py
var desktopTargetVerifySource string

// renderDesktopTargetVerifyCommand runs the verifier inside the sandbox under
// root. The observer key and the HMAC proof never leave the machine: the script
// reads the root-only key, challenges the loopback proxy, checks the MAC itself
// and prints only the resulting incarnation.
func renderDesktopTargetVerifyCommand() string {
	// The staging directory does not exist on images that never ran desktop
	// preparation, so create it before mktemp (same as the observer installer).
	// /usr/bin/python3 is absolute because sudo resets PATH and the agent's venv
	// python3 is not the interpreter this script is meant to run under.
	return fmt.Sprintf(`set -eu
test -x /usr/bin/python3
sudo -n install -d -o root -g root -m 0755 /usr/local/libexec/opencraft
verify_tmp=$(sudo -n mktemp /usr/local/libexec/opencraft/.desktop-target-verify.XXXXXX)
trap 'sudo -n rm -f -- "$verify_tmp" "$verify_tmp.next"' EXIT
sudo -n tee "$verify_tmp" >/dev/null <<'DESKTOP_TARGET_VERIFY'
%s
DESKTOP_TARGET_VERIFY
# Replace the inode, not just its mode: an old writable descriptor must not be
# able to modify the new root-owned verifier.
sudo -n install -o root -g root -m 0700 "$verify_tmp" "$verify_tmp.next"
sudo -n mv -f -- "$verify_tmp.next" %s
sudo -n /usr/bin/python3 -B %s`, desktopTargetVerifySource, desktopTargetVerifyPath, desktopTargetVerifyPath)
}

// parseDesktopIncarnation reads the verifier's single JSON line. Only a
// successful verification yields an incarnation; anything else is a failure.
func parseDesktopIncarnation(output string) (string, bool) {
	line := ""
	for _, candidate := range strings.Split(output, "\n") {
		candidate = strings.TrimSpace(candidate)
		if strings.HasPrefix(candidate, "{") {
			line = candidate
		}
	}
	if line == "" {
		return "", false
	}
	var payload struct {
		Verified    bool   `json:"verified"`
		Incarnation string `json:"incarnation"`
		ReadOnly    bool   `json:"readOnly"`
	}
	if err := json.Unmarshal([]byte(line), &payload); err != nil {
		return "", false
	}
	if !payload.Verified || !payload.ReadOnly || len(payload.Incarnation) != 64 {
		return "", false
	}
	for _, character := range payload.Incarnation {
		if !strings.ContainsRune("0123456789abcdef", character) {
			return "", false
		}
	}
	return payload.Incarnation, true
}

// verifyDesktopIncarnation proves which physical machine and desktop instance
// the viewer would be attached to. Preparation generation is never accepted as
// proof: it is a CTL-side orchestration counter, not a physical identity.
func (l *logic) verifyDesktopIncarnation(ctx pctx.Context, session *desktopSession, sandboxID string) (string, error) {
	op := session.operationMutex()
	op.Lock()
	defer op.Unlock()
	return l.verifyDesktopIncarnationLocked(ctx, session, sandboxID)
}

func (l *logic) verifyDesktopIncarnationLocked(ctx pctx.Context, session *desktopSession, sandboxID string) (string, error) {
	result, err := l.execDesktopInstallCommandLocked(ctx, session, sandboxID, renderDesktopTargetVerifyCommand())
	if err != nil {
		return "", err
	}
	if !sandboxCommandSucceeded(result) {
		return "", errcode.ErrDesktopNotConfigured
	}
	// Different adapters surface the payload on Output or Stdout.
	incarnation, ok := parseDesktopIncarnation(result.Output)
	if !ok {
		incarnation, ok = parseDesktopIncarnation(result.Stdout)
	}
	if !ok {
		return "", errcode.ErrDesktopNotConfigured
	}
	return incarnation, nil
}
