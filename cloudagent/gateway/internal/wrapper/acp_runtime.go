package wrapper

import (
	"context"
	"fmt"
	"time"
)

type acpRuntimeState string

const (
	acpRuntimeStateStarting  acpRuntimeState = "starting"
	acpRuntimeStateReady     acpRuntimeState = "ready"
	acpRuntimeStatePrompting acpRuntimeState = "prompting"
	acpRuntimeStateClosing   acpRuntimeState = "closing"
	acpRuntimeStateClosed    acpRuntimeState = "closed"
	acpRuntimeStateFailed    acpRuntimeState = "failed"

	acpRuntimeCWD        = "/workspace"
	acpSidecarRequestCWD = "."
)

type ACPSessionRuntime struct {
	RuntimeID            string
	SandboxBackend       string
	AgentVersion         string
	AgentTemplateID      string
	WorkspaceVersion     string
	WorkspaceTemplateID  string
	OuterSandboxID       string
	OuterSandboxDomain   string
	OuterEnvdAccessToken string
	OuterTrafficToken    string
	InnerSandboxID       string
	InnerSandboxDomain   string
	InnerEnvdAccessToken string
	SessionProxyID       string
	DaemonAddr           string
	RemoteBinary         string
}

type ACPSessionRuntimeStartRequest struct {
	SessionID        string
	Scope            Scope
	CWD              string
	History          []acpHistoryEntry
	Generation       int64
	SandboxBackend   string
	AgentVersion     string
	WorkspaceVersion string
	SidecarArtifact  agentSidecarArtifact
}

type ACPSessionRuntimeUpdate struct {
	InnerSandboxID       string
	InnerSandboxDomain   string
	InnerEnvdAccessToken string
}

type ACPSessionRuntimeEnsureRequest struct {
	SessionID  string
	Scope      Scope
	Generation int64
	Force      bool
}

type ACPSessionEnvdRuntimeManager interface {
	EnsureSessionEnvdRuntime(context.Context, ACPSessionRuntime, ACPSessionRuntimeEnsureRequest) (ACPSessionRuntimeUpdate, error)
}

type ACPSessionRuntimeManager interface {
	StartSessionRuntime(context.Context, ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error)
	ReattachSessionRuntime(context.Context, ACPSessionRuntime) (ACPSessionRuntime, error)
	CancelSessionRuntime(context.Context, ACPSessionRuntime, string) error
	CloseSessionRuntime(context.Context, ACPSessionRuntime) error
}

type fakeACPSessionRuntimeManager struct{}

func newACPSessionRuntimeManager(worker Worker) ACPSessionRuntimeManager {
	if manager, ok := worker.(ACPSessionRuntimeManager); ok {
		return manager
	}
	return fakeACPSessionRuntimeManager{}
}

func (m fakeACPSessionRuntimeManager) StartSessionRuntime(ctx context.Context, req ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error) {
	return ACPSessionRuntime{
		RuntimeID:      fmt.Sprintf("fake_runtime_%s_%d", req.SessionID, req.Generation),
		DaemonAddr:     "fake",
		OuterSandboxID: "fake_outer_" + randomHex(6),
	}, nil
}

func (m fakeACPSessionRuntimeManager) ReattachSessionRuntime(ctx context.Context, runtime ACPSessionRuntime) (ACPSessionRuntime, error) {
	if runtime.RuntimeID == "" && runtime.OuterSandboxID == "" {
		return ACPSessionRuntime{}, fmt.Errorf("runtime identity is missing")
	}
	return runtime, nil
}

func (m fakeACPSessionRuntimeManager) CloseSessionRuntime(ctx context.Context, runtime ACPSessionRuntime) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(1 * time.Millisecond):
		return nil
	}
}

func (job workerJob) isACPSessionPrompt() bool {
	return job.ACPSessionID != "" || job.ACPSessionRuntime.RuntimeID != "" || job.ACPSessionRuntime.OuterSandboxID != ""
}

func (m fakeACPSessionRuntimeManager) CancelSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, jobID string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(1 * time.Millisecond):
		return nil
	}
}
