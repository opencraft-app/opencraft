//go:build darwin

package install

import (
	"bytes"
	"encoding/xml"
	"path/filepath"
	"strings"
	"testing"
)

func TestRenderLaunchAgentUsesCanonicalDaemonAndContainsNoCredential(t *testing.T) {
	t.Parallel()

	root := filepath.Join(t.TempDir(), "Vela & Computer")
	spec := LaunchSpec{
		Label:            launchAgentLabel,
		ProgramPath:      filepath.Join(root, "bin", ProgramName),
		InstallationRoot: root,
		StateDirectory:   filepath.Join(root, "state"),
	}
	content, err := renderLaunchAgent(spec)
	if err != nil {
		t.Fatal(err)
	}
	decoder := xml.NewDecoder(bytes.NewReader(content))
	for {
		if _, err := decoder.Token(); err != nil {
			if err.Error() == "EOF" {
				break
			}
			t.Fatalf("invalid plist XML: %v", err)
		}
	}
	text := string(content)
	for _, required := range []string{
		launchAgentLabel,
		strings.ReplaceAll(filepath.Join(root, "bin", ProgramName), "&", "&amp;"),
		"<string>daemon</string>",
		"<string>run</string>",
		"<string>--state-dir</string>",
		strings.ReplaceAll(filepath.Join(root, "state", "logs", "computer.stdout.log"), "&", "&amp;"),
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("LaunchAgent plist is missing %q", required)
		}
	}
	for _, forbidden := range []string{"credential", "Enrollment", "Secret", "token"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("LaunchAgent plist contains secret-shaped field %q", forbidden)
		}
	}
}
