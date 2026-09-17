package instance

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestShellUserCommandWithoutUser(t *testing.T) {
	command := "printf '%s\\n' 'unchanged'"
	for _, user := range []string{"", " \t\n"} {
		if got := shellUserCommand(user, command); got != command {
			t.Fatalf("empty user changed command: %q", got)
		}
	}
}

func TestShellUserCommandLongScript(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Fatal(err)
	}
	for _, currentUser := range []string{"agentuser", "root"} {
		t.Run(currentUser, func(t *testing.T) {
			directory := t.TempDir()
			// Stub only user lookup and sudo; execute the command with real bash/env.
			for name, script := range map[string]string{
				"id": "#!/bin/sh\nprintf '%s\\n' \"$TEST_CURRENT_USER\"\n",
				"sudo": `#!/bin/sh
[ "$1" = '-u' ] && [ "$2" = 'agentuser' ] && [ "$3" = '-H' ] || exit 90
shift 3
printf 'sudo\n' > "$TEST_SUDO_LOG"
exec "$@"
`,
			} {
				if err := os.WriteFile(filepath.Join(directory, name), []byte(script), 0700); err != nil {
					t.Fatal(err)
				}
			}
			// Large enough to reproduce the previous doubled-argument regression.
			command := "# " + strings.Repeat("x", 70*1024) + `
IFS= read -r input
cat <<'MODEL_CONFIG'
literal 'single' "double" $HOME $(printf unexpected) ` + "`printf unexpected`" + ` \
MODEL_CONFIG
printf '%s\n' "$input" "$HOME" "$USER" "$HERMES_HOME" "$PATH"
printf 'stderr-marker\n' >&2
exit 23
`
			wrapped := shellUserCommand(" agentuser ", command)
			if len(wrapped)+1 > 128*1024 {
				t.Fatalf("wrapped command exceeds Linux 4 KiB-page single-argument limit: %d bytes", len(wrapped)+1)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, bash, "-c", wrapped)
			testPath := directory + string(os.PathListSeparator) + os.Getenv("PATH")
			cmd.Env = []string{
				"PATH=" + testPath,
				"HOME=/home/agentuser",
				"USER=agentuser",
				"HERMES_HOME=/home/agentuser/.hermes/profiles/sales",
				"TEST_CURRENT_USER=" + currentUser,
				"TEST_SUDO_LOG=" + filepath.Join(directory, "sudo.log"),
			}
			cmd.Stdin = strings.NewReader("stdin 'quoted' $literal\n")
			var stdout, stderr bytes.Buffer
			cmd.Stdout, cmd.Stderr = &stdout, &stderr
			err := cmd.Run()
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) || exitErr.ExitCode() != 23 {
				t.Fatalf("expected command exit 23, got %v; stderr=%q", err, stderr.String())
			}
			want := "literal 'single' \"double\" $HOME $(printf unexpected) `printf unexpected` \\\n" +
				"stdin 'quoted' $literal\n/home/agentuser\nagentuser\n/home/agentuser/.hermes/profiles/sales\n" + testPath + "\n"
			if stdout.String() != want || stderr.String() != "stderr-marker\n" {
				t.Fatalf("command IO changed: stdout=%q stderr=%q", stdout.String(), stderr.String())
			}
			_, logErr := os.Stat(filepath.Join(directory, "sudo.log"))
			if currentUser == "root" && logErr != nil {
				t.Fatalf("different user did not invoke sudo: %v", logErr)
			}
			if currentUser == "agentuser" && !os.IsNotExist(logErr) {
				t.Fatalf("current user unexpectedly invoked sudo: %v", logErr)
			}
		})
	}
}
