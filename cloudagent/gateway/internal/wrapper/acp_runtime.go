package wrapper

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
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

	runtimeRecoveryReattachOrRecreate = "reattach_or_recreate"
)

type ACPSessionRuntime struct {
	RuntimeID            string
	SandboxBackend       string
	OuterRuntime         string
	RuntimeRecovery      string
	AgentVersion         string
	AgentTemplateID      string
	SidecarURL           string
	SidecarSHA256        string
	SidecarSigURL        string
	SigningKeyID         string
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
	WispName             string
	WispWorkspaceID      string
	WispSMHSpaceID       string
	WispOwnsSMHSpace     bool
	WispPackageURL       string
	WispInstallDir       string
	WispClientPath       string
	WispJFSPrefix        string
	WispRootUpperSize    string
	WispLeaseID          string
	WispLeaseFence       int64
	WispLeaseUntil       time.Time
	WorkspaceID          string
	WorkspaceRuntimeID   string
	WorkspaceLeaseID     string
	WorkspaceFence       int64
	WorkspaceLeaseUntil  time.Time
	WorkspaceAttachState string
}

type ACPSessionRuntimeStartRequest struct {
	SessionID        string
	Scope            Scope
	CWD              string
	Generation       int64
	SandboxBackend   string
	OuterRuntime     string
	RuntimeRecovery  string
	AgentVersion     string
	WorkspaceVersion string
	SidecarArtifact  agentSidecarArtifact
}

type ACPSessionRuntimeUpdate struct {
	InnerSandboxID       string
	InnerSandboxDomain   string
	InnerEnvdAccessToken string
}

type ACPSessionRuntimePendingByMode struct {
	Prompt   int `json:"prompt,omitempty"`
	Steer    int `json:"steer,omitempty"`
	FollowUp int `json:"follow_up,omitempty"`
}

type ACPSessionRuntimeRunRecord struct {
	RunID            string          `json:"run_id,omitempty"`
	SessionID        string          `json:"session_id,omitempty"`
	TurnID           string          `json:"turn_id,omitempty"`
	Source           string          `json:"source,omitempty"`
	InboxMode        string          `json:"inbox_mode,omitempty"`
	Status           string          `json:"status,omitempty"`
	CreatedAtMS      int64           `json:"created_at_ms,omitempty"`
	StartedAtMS      int64           `json:"started_at_ms,omitempty"`
	CompletedAtMS    int64           `json:"completed_at_ms,omitempty"`
	ErrorCode        string          `json:"error_code,omitempty"`
	ErrorMessage     string          `json:"error_message,omitempty"`
	BlockedReason    string          `json:"blocked_reason,omitempty"`
	ReconciledReason string          `json:"reconciled_reason,omitempty"`
	Raw              json.RawMessage `json:"-"`
}

type ACPSessionRuntimeStatusSnapshot struct {
	OK                bool                           `json:"ok,omitempty"`
	SessionID         string                         `json:"session_id,omitempty"`
	Status            string                         `json:"status,omitempty"`
	RuntimeStoreLoad  string                         `json:"runtime_store_load,omitempty"`
	ActiveRunID       string                         `json:"active_run_id,omitempty"`
	PendingRunCount   int                            `json:"pending_run_count,omitempty"`
	PendingByMode     ACPSessionRuntimePendingByMode `json:"pending_by_mode,omitempty"`
	RunCount          int                            `json:"run_count,omitempty"`
	TranscriptCount   int                            `json:"transcript_count,omitempty"`
	LastUserHash      string                         `json:"last_user_hash,omitempty"`
	LastAssistantHash string                         `json:"last_assistant_hash,omitempty"`
	LastRunStatus     string                         `json:"last_run_status,omitempty"`
	RunLedgerTail     []ACPSessionRuntimeRunRecord   `json:"run_ledger_tail,omitempty"`
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

type ACPSessionWorkspaceFileManager interface {
	UploadSessionWorkspaceFile(context.Context, ACPSessionRuntime, string, []byte) error
	DownloadSessionWorkspaceFile(context.Context, ACPSessionRuntime, string) ([]byte, error)
}

type ACPSessionRuntimeManager interface {
	StartSessionRuntime(context.Context, ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error)
	EnsureSessionRuntime(context.Context, ACPSessionRuntime, ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error)
	ReattachSessionRuntime(context.Context, ACPSessionRuntime) (ACPSessionRuntime, error)
	RefreshSessionRuntime(context.Context, ACPSessionRuntime, string) error
	SessionRuntimeStatus(context.Context, ACPSessionRuntime, string) (ACPSessionRuntimeStatusSnapshot, error)
	CancelSessionRuntime(context.Context, ACPSessionRuntime, string, string) error
	CloseSessionRuntime(context.Context, ACPSessionRuntime) error
	DeleteSessionRuntime(context.Context, ACPSessionRuntime) error
}

type ACPSessionRuntimeFaultInjector interface {
	KillSessionRuntimeDaemon(context.Context, ACPSessionRuntime) error
	KillSessionRuntimeOuter(context.Context, ACPSessionRuntime) error
	KillSessionRuntimeInner(context.Context, ACPSessionRuntime) error
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
		RuntimeID:       fmt.Sprintf("fake_runtime_%s_%d", req.SessionID, req.Generation),
		OuterRuntime:    normalizeOuterRuntime(req.OuterRuntime),
		RuntimeRecovery: normalizeRuntimeRecovery(req.RuntimeRecovery, normalizeOuterRuntime(req.OuterRuntime)),
		DaemonAddr:      "fake",
		OuterSandboxID:  "fake_outer_" + randomHex(6),
	}, nil
}

func (m fakeACPSessionRuntimeManager) EnsureSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error) {
	return m.ReattachSessionRuntime(ctx, runtime)
}

func (m fakeACPSessionRuntimeManager) ReattachSessionRuntime(ctx context.Context, runtime ACPSessionRuntime) (ACPSessionRuntime, error) {
	if runtime.RuntimeID == "" && runtime.OuterSandboxID == "" {
		return ACPSessionRuntime{}, fmt.Errorf("runtime identity is missing")
	}
	return runtime, nil
}

func (m fakeACPSessionRuntimeManager) RefreshSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, sessionID string) error {
	return nil
}

func (m fakeACPSessionRuntimeManager) SessionRuntimeStatus(ctx context.Context, runtime ACPSessionRuntime, sessionID string) (ACPSessionRuntimeStatusSnapshot, error) {
	return ACPSessionRuntimeStatusSnapshot{
		OK:        true,
		SessionID: sessionID,
		Status:    "idle",
	}, nil
}

func (m fakeACPSessionRuntimeManager) CloseSessionRuntime(ctx context.Context, runtime ACPSessionRuntime) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(1 * time.Millisecond):
		return nil
	}
}

func (m fakeACPSessionRuntimeManager) DeleteSessionRuntime(ctx context.Context, runtime ACPSessionRuntime) error {
	return m.CloseSessionRuntime(ctx, runtime)
}

func (job workerJob) isACPSessionPrompt() bool {
	return job.ACPSessionID != "" || job.ACPSessionRuntime.RuntimeID != "" || job.ACPSessionRuntime.OuterSandboxID != ""
}

func (runtime ACPSessionRuntime) isWispOuterRuntime() bool {
	return runtime.OuterRuntime == outerRuntimeWisp
}

func normalizeRuntimeRecovery(value, outerRuntime string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" && normalizeOuterRuntime(outerRuntime) == outerRuntimeWisp {
		return runtimeRecoveryReattachOrRecreate
	}
	switch value {
	case runtimeRecoveryReattachOrRecreate:
		return value
	default:
		return ""
	}
}

func newACPSessionRuntimeID(sessionID string, generation int64) string {
	return fmt.Sprintf("rt_%s_%d_%s", sessionID, generation, randomHex(6))
}

func (m fakeACPSessionRuntimeManager) CancelSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, sessionID, jobID string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(1 * time.Millisecond):
		return nil
	}
}
