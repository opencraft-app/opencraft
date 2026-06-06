package wrapper

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	warmRuntimePoolStateCreating   = "creating"
	warmRuntimePoolStateReady      = "ready"
	warmRuntimePoolStateClaimed    = "claimed"
	warmRuntimePoolStateConsumed   = "consumed"
	warmRuntimePoolStateDiscarding = "discarding"
	warmRuntimePoolStateDiscarded  = "discarded"
	warmRuntimePoolStateFailed     = "failed"
)

var ErrWarmRuntimePoolMiss = errors.New("warm runtime pool miss")

type RuntimePool interface {
	ClaimWarmRuntime(context.Context, WarmRuntimeClaimRequest) (WarmRuntimeClaim, error)
	ConsumeWarmRuntime(context.Context, WarmRuntimeClaim) error
	DiscardWarmRuntime(context.Context, WarmRuntimeClaim, string) error
}

type WarmRuntimePoolStore interface {
	RuntimePool
	ReserveWarmRuntimeItem(context.Context, WarmRuntimeReserveRequest) (WarmRuntimeItem, bool, error)
	UpsertWarmRuntimeItem(context.Context, WarmRuntimeItem) error
	MarkWarmRuntimeItemReady(context.Context, string, WarmRuntimeHost) error
	MarkWarmRuntimeItemState(context.Context, string, string, string) error
	ListWarmRuntimeItems(context.Context, WarmRuntimeListRequest) ([]WarmRuntimeItem, error)
}

type WarmRuntimeReserveRequest struct {
	PoolKey      string
	OwnerID      string
	WorkflowID   string
	RunID        string
	DesiredReady int
}

type WarmRuntimeClaimRequest struct {
	PoolKey     string
	OwnerID     string
	SessionID   string
	Generation  int64
	TTL         time.Duration
	MaxReadyAge time.Duration
}

type WarmRuntimeClaim struct {
	ItemID      string
	PoolKey     string
	OwnerID     string
	SessionID   string
	Generation  int64
	ClaimedAt   time.Time
	LeaseUntil  time.Time
	Fence       int64
	Host        WarmRuntimeHost
	SourceState string
}

type WarmRuntimeItem struct {
	ItemID      string
	PoolKey     string
	State       string
	OwnerID     string
	SessionID   string
	Generation  int64
	Fence       int64
	LeaseUntil  time.Time
	DesiredTTL  time.Duration
	Host        WarmRuntimeHost
	LastError   string
	WorkflowID  string
	RunID       string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	ClaimedAt   time.Time
	DiscardedAt time.Time
}

type WarmRuntimeHost struct {
	SandboxBackend       string `json:"sandbox_backend,omitempty"`
	OuterTemplateID      string `json:"outer_template_id,omitempty"`
	InnerTemplateID      string `json:"inner_template_id,omitempty"`
	OuterSandboxID       string `json:"outer_sandbox_id,omitempty"`
	OuterSandboxDomain   string `json:"outer_sandbox_domain,omitempty"`
	OuterEnvdAccessToken string `json:"outer_envd_access_token,omitempty"`
	OuterTrafficToken    string `json:"outer_traffic_token,omitempty"`
	InnerSandboxID       string `json:"inner_sandbox_id,omitempty"`
	InnerSandboxDomain   string `json:"inner_sandbox_domain,omitempty"`
	InnerEnvdAccessToken string `json:"inner_envd_access_token,omitempty"`
	WispPackageURL       string `json:"wisp_package_url,omitempty"`
	OuterWispInstallDir  string `json:"outer_wisp_install_dir,omitempty"`
	OuterWispClientPath  string `json:"outer_wisp_client_path,omitempty"`
	InnerWispInstallDir  string `json:"inner_wisp_install_dir,omitempty"`
	InnerWispClientPath  string `json:"inner_wisp_client_path,omitempty"`
	AgentVersion         string `json:"agent_version,omitempty"`
	WorkspaceVersion     string `json:"workspace_version,omitempty"`
	SidecarURL           string `json:"sidecar_url,omitempty"`
	SidecarSHA256        string `json:"sidecar_sha256,omitempty"`
	SidecarSigURL        string `json:"sidecar_sig_url,omitempty"`
	SigningKeyID         string `json:"signing_key_id,omitempty"`
}

type WarmRuntimeListRequest struct {
	PoolKey string
	State   string
	Limit   int
}

type RuntimePoolKeySpec struct {
	BackendName       string `json:"backend_name"`
	OuterRuntime      string `json:"outer_runtime"`
	OuterTemplateID   string `json:"outer_template_id"`
	InnerTemplateID   string `json:"inner_template_id"`
	AgentVersion      string `json:"agent_version"`
	WorkspaceVersion  string `json:"workspace_version"`
	SidecarURL        string `json:"sidecar_url"`
	SidecarSHA256     string `json:"sidecar_sha256"`
	SidecarSigURL     string `json:"sidecar_sig_url"`
	SigningKeyID      string `json:"signing_key_id"`
	WispPackageURL    string `json:"wisp_package_url"`
	WispRootUpperSize string `json:"wisp_root_upper_size"`
	WispJFSPrefix     string `json:"wisp_jfs_prefix"`
}

func warmRuntimePoolKey(spec RuntimePoolKeySpec) string {
	spec.BackendName = strings.ToLower(strings.TrimSpace(spec.BackendName))
	spec.OuterRuntime = normalizeOuterRuntime(spec.OuterRuntime)
	spec.OuterTemplateID = strings.TrimSpace(spec.OuterTemplateID)
	spec.InnerTemplateID = strings.TrimSpace(spec.InnerTemplateID)
	spec.AgentVersion = normalizeRuntimeVersion(spec.AgentVersion, defaultAgentVersion)
	spec.WorkspaceVersion = normalizeRuntimeVersion(spec.WorkspaceVersion, defaultWorkspaceVersion)
	spec.SidecarURL = strings.TrimSpace(spec.SidecarURL)
	spec.SidecarSHA256 = strings.TrimSpace(spec.SidecarSHA256)
	spec.SidecarSigURL = strings.TrimSpace(spec.SidecarSigURL)
	spec.SigningKeyID = strings.TrimSpace(spec.SigningKeyID)
	spec.WispPackageURL = strings.TrimSpace(spec.WispPackageURL)
	spec.WispRootUpperSize = strings.TrimSpace(spec.WispRootUpperSize)
	spec.WispJFSPrefix = strings.TrimSpace(spec.WispJFSPrefix)
	raw, _ := json.Marshal(spec)
	sum := sha256.Sum256(raw)
	return "runtime_pool.v1." + hex.EncodeToString(sum[:12])
}

func warmRuntimePoolKeyForRuntime(runtime ACPSessionRuntime, backend agentSidecarBackend) string {
	return warmRuntimePoolKey(RuntimePoolKeySpec{
		BackendName:       backend.name,
		OuterRuntime:      runtime.OuterRuntime,
		OuterTemplateID:   firstNonEmpty(runtime.AgentTemplateID, backend.outerTemplateID),
		InnerTemplateID:   firstNonEmpty(runtime.WorkspaceTemplateID, backend.innerTemplateID),
		AgentVersion:      runtime.AgentVersion,
		WorkspaceVersion:  runtime.WorkspaceVersion,
		SidecarURL:        runtime.SidecarURL,
		SidecarSHA256:     runtime.SidecarSHA256,
		SidecarSigURL:     runtime.SidecarSigURL,
		SigningKeyID:      runtime.SigningKeyID,
		WispPackageURL:    runtime.WispPackageURL,
		WispRootUpperSize: runtime.WispRootUpperSize,
		WispJFSPrefix:     runtime.WispJFSPrefix,
	})
}

func warmRuntimeClaimTTL(ttl time.Duration) time.Duration {
	if ttl <= 0 {
		return defaultWorkspaceLeaseTTL
	}
	return ttl
}

func warmRuntimeReadyTTL(ttl time.Duration) time.Duration {
	if ttl <= 0 {
		return defaultWorkspaceLeaseTTL
	}
	return ttl
}

func validateWarmRuntimeHost(host WarmRuntimeHost) error {
	if strings.TrimSpace(host.SandboxBackend) == "" {
		return fmt.Errorf("warm runtime host sandbox backend is required")
	}
	if strings.TrimSpace(host.OuterSandboxID) == "" || strings.TrimSpace(host.OuterEnvdAccessToken) == "" {
		return fmt.Errorf("warm runtime host outer sandbox identity is required")
	}
	if strings.TrimSpace(host.InnerSandboxID) == "" || strings.TrimSpace(host.InnerEnvdAccessToken) == "" {
		return fmt.Errorf("warm runtime host inner sandbox identity is required")
	}
	if strings.TrimSpace(host.WispPackageURL) == "" {
		return fmt.Errorf("warm runtime host wisp package url is required")
	}
	if strings.TrimSpace(host.OuterWispInstallDir) == "" || strings.TrimSpace(host.OuterWispClientPath) == "" {
		return fmt.Errorf("warm runtime host outer wisp client is required")
	}
	if strings.TrimSpace(host.InnerWispInstallDir) == "" || strings.TrimSpace(host.InnerWispClientPath) == "" {
		return fmt.Errorf("warm runtime host inner wisp client is required")
	}
	return nil
}
