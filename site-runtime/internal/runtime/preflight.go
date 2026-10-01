package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
)

// Preflight is mandatory before binding the management socket. It checks the
// real engine, runsc, cgroups and Unix-socket transport, not only stored metadata.
// The manager is privileged and must run on a dedicated runtime host.
func (d *DockerRunner) Preflight(ctx context.Context, dataDir string) error {
	if goruntime.GOOS != "linux" || os.Geteuid() != 0 {
		return fmt.Errorf("runtime requires a dedicated Linux root manager")
	}
	info, err := dockerCommand(ctx, "info", "--format", "{{json .}}")
	if err != nil {
		return fmt.Errorf("docker prerequisite check failed")
	}
	if err = validateDockerInfo(info); err != nil {
		return err
	}
	image, err := dockerCommand(ctx, "image", "inspect", "--format", "{{.Id}}", d.image)
	if err != nil || !pinnedImage.MatchString(strings.TrimSpace(string(image))) {
		return fmt.Errorf("pinned engine image is not installed")
	}
	return probeRunner(ctx, dataDir, d)
}
func validateDockerInfo(data []byte) error {
	var info struct {
		CgroupVersion                                  string
		MemoryLimit, SwapLimit, CpuCfsQuota, PidsLimit bool
		Runtimes                                       map[string]json.RawMessage
	}
	if err := json.Unmarshal(data, &info); err != nil {
		return fmt.Errorf("invalid Docker capability response")
	}
	if info.CgroupVersion != "2" || !info.MemoryLimit || !info.SwapLimit || !info.CpuCfsQuota || !info.PidsLimit {
		return fmt.Errorf("cgroup v2 memory/swap/cpu/pids enforcement required")
	}
	if _, ok := info.Runtimes["runsc"]; !ok {
		return fmt.Errorf("runsc runtime is not registered")
	}
	return nil
}
func probeRunner(ctx context.Context, parent string, runner Runner) error {
	dir, err := os.MkdirTemp(parent, ".startup-probe-")
	if err != nil {
		return fmt.Errorf("startup store probe failed")
	}
	defer os.RemoveAll(dir)
	if err = os.Chmod(dir, 0755); err != nil {
		return err
	}
	code := `export default {async fetch(){
 let blocked=false;try {await fetch('http://169.254.169.254/')}catch{blocked=true}
 return Response.json({isolated:blocked});
 }};`
	for name, body := range map[string]string{"app.mjs": code, "entry.mjs": entryModule, "runtime.capnp": runtimeConfig} {
		if err = writeRuntimeFile(filepath.Join(dir, name), []byte(body)); err != nil {
			return err
		}
	}
	result, err := runner.Run(ctx, dir, Invocation{Method: "GET", Path: "/__startup_probe"})
	if err != nil || result.Status != 200 || string(result.Body) != `{"isolated":true}` {
		return fmt.Errorf("runtime isolation/socket startup probe failed")
	}
	return nil
}
