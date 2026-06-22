package wrapper

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
)

func runtimeHostProbeSandbox(ctx context.Context, host RuntimeHost, sandboxID string) (RuntimeHostSandboxProbe, error) {
	probe := RuntimeHostSandboxProbe{
		SandboxID: sandboxID,
		CheckedAt: time.Now().UTC(),
	}
	if host == nil {
		probe.Status = "host_nil"
		return probe, nil
	}
	prober, ok := host.(RuntimeHostSandboxProber)
	if !ok {
		probe.Status = "unsupported"
		return probe, nil
	}
	return prober.ProbeSandbox(ctx, sandboxID)
}

func runtimeHostProbeConfirmsNotWritable(probe RuntimeHostSandboxProbe, err error) bool {
	if err != nil {
		return false
	}
	status := strings.ToLower(strings.TrimSpace(probe.Status))
	if status == "" || status == "unsupported" || status == "host_nil" || status == "empty_id" {
		return false
	}
	if !probe.Exists && status == "not_found" {
		return true
	}
	return strings.Contains(status, "stopped")
}

func logRuntimeHostSandboxProbe(ctx context.Context, host RuntimeHost, runtime ACPSessionRuntime, target string, phase string, sandboxID string) {
	probe, err := runtimeHostProbeSandbox(ctx, host, sandboxID)
	logRuntimeHostSandboxProbeResult(probe, err, runtime, target, phase, sandboxID)
}

func logRuntimeHostSandboxProbeResult(probe RuntimeHostSandboxProbe, err error, runtime ACPSessionRuntime, target string, phase string, sandboxID string) {
	fields := []string{
		"timeline source=go event=acp_runtime_host_probe",
		"phase=" + quoteTimelineField(phase),
		"target=" + quoteTimelineField(target),
		"runtime_id=" + quoteTimelineField(runtime.RuntimeID),
		"workspace_runtime_id=" + quoteTimelineField(runtime.WorkspaceRuntimeID),
		"outer_sandbox_id=" + quoteTimelineField(runtime.OuterSandboxID),
		"inner_sandbox_id=" + quoteTimelineField(runtime.InnerSandboxID),
		"sandbox_id=" + quoteTimelineField(sandboxID),
		"exists=" + fmt.Sprintf("%t", probe.Exists),
		"status=" + quoteTimelineField(probe.Status),
		"domain=" + quoteTimelineField(probe.Domain),
		"detail=" + quoteTimelineField(probe.Detail),
	}
	if err != nil {
		fields = append(fields, "error="+quoteTimelineField(err.Error()))
	}
	fmt.Fprintln(os.Stderr, strings.Join(fields, " "))
}
