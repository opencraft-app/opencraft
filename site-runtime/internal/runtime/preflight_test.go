package runtime

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type failingProbe struct{}

func (failingProbe) Run(context.Context, string, Invocation) (Result, error) {
	return Result{}, errors.New("fixture unavailable")
}
func TestStartupProbeFailsClosedAndCleansArtifacts(t *testing.T) {
	dir := t.TempDir()
	if err := probeRunner(context.Background(), dir, failingProbe{}); err == nil {
		t.Fatal("failed runner passed startup")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("probe retained artifacts: %v %d", err, len(entries))
	}
}

type probeReader struct{ t *testing.T }

func (p probeReader) Run(_ context.Context, dir string, in Invocation) (Result, error) {
	p.t.Helper()
	for _, name := range []string{"app.mjs", "entry.mjs", "runtime.capnp"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			p.t.Fatal(err)
		}
	}
	if in.Method != "GET" || in.Path != "/__startup_probe" {
		p.t.Fatal("probe must execute application, not only health handler")
	}
	return Result{Status: 200, Body: []byte(`{"isolated":true}`)}, nil
}
func TestStartupProbeExecutesTrustedApplication(t *testing.T) {
	if err := probeRunner(context.Background(), t.TempDir(), probeReader{t}); err != nil {
		t.Fatal(err)
	}
}
func TestDockerPrerequisitesRejectMissingHardLimits(t *testing.T) {
	good := []byte(`{"CgroupVersion":"2","MemoryLimit":true,"SwapLimit":true,"CpuCfsQuota":true,"PidsLimit":true,"Runtimes":{"runsc":{}}}`)
	if err := validateDockerInfo(good); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{`{}`, `{"CgroupVersion":"2","MemoryLimit":true,"SwapLimit":true,"CpuCfsQuota":true,"PidsLimit":true,"Runtimes":{"runc":{}}}`, `{"CgroupVersion":"2","MemoryLimit":true,"SwapLimit":false,"CpuCfsQuota":true,"PidsLimit":true,"Runtimes":{"runsc":{}}}`} {
		if err := validateDockerInfo([]byte(bad)); err == nil {
			t.Fatal("unsafe Docker prerequisites accepted")
		}
	}
}
