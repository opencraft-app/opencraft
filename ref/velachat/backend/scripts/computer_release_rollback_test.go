package scripts

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestComputerCanaryRollbackRestoresCatalogAndVersionAnnotation(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate release script test")
	}
	source, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "deploy-computer-canary.sh"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, required := range []string{
		"original_computer_release_configmap",
		"original_computer_release_version",
		`agentnetwork.io/computer-release\":\"$original_computer_release_version`,
	} {
		if !strings.Contains(text, required) {
			t.Errorf("rollback contract missing %q", required)
		}
	}
}
