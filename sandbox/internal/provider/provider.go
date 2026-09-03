package provider

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"cvm-mock-e2b/internal/blueprint"
	"cvm-mock-e2b/internal/core"
)

// CloudProvider abstracts calls to the cloud vendor.
type CloudProvider interface {
	CreateInstance(ctx context.Context, pool core.Pool) (cloudID string, address string, err error)
	ReinstallInstance(ctx context.Context, cloudID string, imageID string) error
	DescribeInstance(ctx context.Context, cloudID string) (status string, err error)
	TerminateInstance(ctx context.Context, cloudID string) error
	// VerifyInstance confirms that the cloud instance is ready for control-plane
	// delivery. The identifier is the cloud instance ID, never an IP address.
	VerifyInstance(ctx context.Context, cloudID string) error
	// StopInstance shuts down the instance while preserving system disk data.
	// Used by trade pass isolation flow (Q26-D 修订版 / Q33=a 拍板 2026-05-14 22:37).
	// On Tencent Cloud this maps to StopInstances with StoppedMode=STOP_CHARGING
	// to release CPU/memory billing while keeping disks intact.
	StopInstance(ctx context.Context, cloudID string) error
	// StartInstance boots a previously stopped instance back to RUNNING.
	// Reserved for renewal/restore flows that follow trade pass isolation.
	StartInstance(ctx context.Context, cloudID string) error

	// CreateInstanceSnapshot creates a CBS snapshot of the instance system disk.
	// Used by trade pass destroy flow (Q4 / Q9 / Q25 ✅ 拍板, see .tmp/trade-pass-destroy-design.md sec5.2).
	//
	// Implementation contract (Q25 ✅ 拍板):
	//   1. Look up the system disk ID via cbs.DescribeDisks with filters
	//      (instance-id=<cloudID>, disk-usage=SYSTEM_DISK), Limit=1.
	//   2. If DescribeDisks returns empty → return ErrInstanceNoSystemDisk
	//      (ctl child-task will skip snapshot stages 1+2 per Q10 联动).
	//   3. Otherwise call cbs.CreateSnapshot with DiskId, SnapshotName, Deadline,
	//      DiskUsage=SYSTEM_DISK and return the resulting SnapshotId.
	//
	// Idempotency (Q4-b 拍板): no provider-side dedupe key; ctl gates duplicate
	// calls via payload.SnapshotID nil-check.
	CreateInstanceSnapshot(ctx context.Context, req CreateInstanceSnapshotRequest) (snapshotID string, err error)

	// DescribeInstanceSnapshot polls the status of a snapshot previously created
	// via CreateInstanceSnapshot. Maps cbs SnapshotState into the abstract status.
	//
	// State mapping (Q9 ✅ 拍板, see .tmp/trade-pass-destroy-design.md sec5.2):
	//   - cbs SnapshotState=NORMAL                            → SnapshotStatusReady
	//   - cbs SnapshotState ∈ {ERROR, ROLLBACKING_FAILED, ...} → SnapshotStatusFailed
	//   - cbs SnapshotState=CREATING                          → SnapshotStatusInProgress
	DescribeInstanceSnapshot(ctx context.Context, snapshotID string) (SnapshotStatus, string, error)
}

// CreateInstanceSnapshotRequest is the input for CloudProvider.CreateInstanceSnapshot.
//
// Field semantics (sec5.2 of .tmp/trade-pass-destroy-design.md):
//   - CloudID: cvm InstanceId (e.g. ins-xxx) used as filter for cbs.DescribeDisks.
//   - PassID / InstanceID / UserID: only used for snapshot naming + audit tags.
//   - Deadline: passed verbatim to cbs.CreateSnapshot.Deadline (RFC3339).
//     Caller (sandbox handler) is responsible for now+retentionSeconds calculation;
//     CloudProvider keeps no clock awareness so it stays unit-test friendly.
//
// Resource owner uin/appID 不再透传：sandbox 调 cbs SDK 用的是 sandbox 服务自身
// 配置的腾讯云 AK/SK，资源 owner 由该 AK/SK 自动决定，无需 ctl 传入。
type CreateInstanceSnapshotRequest struct {
	CloudID    string    // cvm InstanceId (ins-xxx); MUST be non-empty.
	PassID     string    // trade pass id (used in snapshot name).
	InstanceID string    // ctl-side instance id (used in snapshot name).
	UserID     string    // ctl-side user id (audit / tagging).
	Deadline   time.Time // snapshot expiration; cbs Deadline = this value (RFC3339 on the wire).
}

// SnapshotStatus is the abstract status returned by DescribeInstanceSnapshot.
type SnapshotStatus string

const (
	// SnapshotStatusInProgress: cbs snapshot is still being created (CREATING).
	SnapshotStatusInProgress SnapshotStatus = "in_progress"
	// SnapshotStatusReady: cbs snapshot reached terminal state NORMAL (success).
	SnapshotStatusReady SnapshotStatus = "ready"
	// SnapshotStatusFailed: cbs snapshot reached a terminal failure state (ERROR / ROLLBACKING_FAILED / ...).
	SnapshotStatusFailed SnapshotStatus = "failed"
)

// ErrInstanceNoSystemDisk is returned by CloudProvider.CreateInstanceSnapshot when
// cbs.DescribeDisks returns an empty disk set for the target instance. Per Q25 + Q10
// 拍板, ctl child-task should skip snapshot stages 1+2 and proceed directly to stage 3
// (sandbox.DeleteSandbox).
var ErrInstanceNoSystemDisk = errors.New("provider: instance has no system disk; snapshot skipped")

// ErrSnapshotNotFound is returned by CloudProvider.DescribeInstanceSnapshot when
// cbs.DescribeSnapshots returns an empty result for the queried snapshot id.
var ErrSnapshotNotFound = errors.New("provider: snapshot not found")

// InstanceSpec is the billable shape of an existing cloud instance, as read
// back from the vendor rather than from our own pool metadata.
type InstanceSpec struct {
	InstanceType     string
	SystemDiskSize   int // GiB
	State            string
	StopChargingMode string
}

// InstanceSpecResizer is the optional capability behind the same-SP upgrade
// (变配) flow: growing an already-delivered instance in place instead of
// reprovisioning it.
//
// The caller drives the ordering (stop → resize compute → resize disk → start)
// and owns the operation ledger; the provider only exposes single steps and
// makes each one safe to re-issue.
type InstanceSpecResizer interface {
	// StopInstanceForResize retains compute allocation/billing during the
	// temporary shutdown. Ordinary pause/isolation still uses StopInstance.
	StopInstanceForResize(ctx context.Context, cloudID string) error
	// DescribeInstanceSpec reports the currently effective spec so the caller
	// can skip steps a previous attempt already applied.
	DescribeInstanceSpec(ctx context.Context, cloudID string) (InstanceSpec, error)
	// ResizeInstanceType changes CPU/memory, ensuring resize-safe shutdown.
	// Re-issuing with the already-effective type is a no-op.
	ResizeInstanceType(ctx context.Context, cloudID string, instanceType string) error
	// ResizeSystemDisk grows the system disk to sizeGB. Cloud disks cannot
	// shrink, so callers must only ever pass a larger size; passing the
	// current size is a no-op.
	ResizeSystemDisk(ctx context.Context, cloudID string, sizeGB int) error
}

func (m *MockCloudProvider) StopInstanceForResize(ctx context.Context, cloudID string) error {
	return m.StopInstance(ctx, cloudID)
}

type CapacityBundleProvisionRequest struct {
	TemplateClassID        string
	Region                 string
	Zone                   string
	NetworkTemplateID      string
	SourceVpcID            string
	SourceSubnetID         string
	SourceSecurityGroupIDs []string
}

// CapacityBundleProvisioner is the slow-plane capability for automatically
// creating a usable capacity bundle.
type CapacityBundleProvisioner interface {
	ProvisionCapacityBundle(ctx context.Context, req CapacityBundleProvisionRequest) (core.CapacityBundle, error)
}

type ManagedSecurityGroupShard struct {
	ID                    string
	Region                string
	Description           string
	SourceSecurityGroupID string
	TemplateClassID       string
	State                 string
	CreatedAt             time.Time
}

// SecurityGroupShardJanitor is an optional capability for providers that can
// enumerate and delete managed SG shards for background orphan reconciliation.
type SecurityGroupShardJanitor interface {
	ListManagedPendingSecurityGroupShards(ctx context.Context, region string) ([]ManagedSecurityGroupShard, error)
	DeleteSecurityGroup(ctx context.Context, region, securityGroupID string) error
}

type VPCShardSubnetSpec struct {
	Name    string
	CIDR    string
	Zone    string
	Role    core.VPCShardSubnetRole
	Ordinal int
}

type VPCShardProvisionRequest struct {
	BlueprintSnapshotID         string
	TemplateClassID             string
	SKUID                       string
	BlueprintFingerprint        string
	NetworkTemplateID           string
	SecurityGroupRuleTemplateID string
	Region                      string
	VpcCIDR                     string
	SupportSubnet               VPCShardSubnetSpec
	WorkloadSubnets             []VPCShardSubnetSpec
	NATShape                    blueprint.StaticNATShape
	RouteShape                  blueprint.StaticRouteShape
	Tags                        map[string]string
}

type VPCShardProvisionResult struct {
	VpcID            string
	SupportSubnet    core.VPCShardSubnet
	WorkloadSubnets  []core.VPCShardSubnet
	CleanupResources []core.VPCShardCleanupResource
}

type VPCShardProvisionError struct {
	Err           error
	LastStep      string
	PartialResult VPCShardProvisionResult
}

func (e *VPCShardProvisionError) Error() string {
	if e == nil || e.Err == nil {
		return "vpc shard provision failed"
	}
	if strings.TrimSpace(e.LastStep) == "" {
		return e.Err.Error()
	}
	return fmt.Sprintf("vpc shard provision failed at %s: %v", e.LastStep, e.Err)
}

func (e *VPCShardProvisionError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

type VPCShardBlueprintExport struct {
	SchemaVersion     string
	SourceRegion      string
	NetworkTemplateID string
	VPCCIDR           string
	SupportSubnet     VPCShardSubnetSpec
	WorkloadSubnets   []VPCShardSubnetSpec
	NATShape          blueprint.StaticNATShape
	RouteShape        blueprint.StaticRouteShape
}

// VPCShardBlueprintExporter is an offline/export-time capability only. Its
// output must be materialized into a repo-committed static blueprint artifact,
// not consumed as a runtime live fallback.
type VPCShardBlueprintExporter interface {
	ExportVPCShardBlueprint(ctx context.Context, region string, sourceVpcID string) (VPCShardBlueprintExport, error)
}

// VPCShardProvisioner is the slow-plane capability for creating a new VPC shard
// and its fixed subnet package from the static exported blueprint contract.
type VPCShardProvisioner interface {
	ProvisionVPCShard(ctx context.Context, req VPCShardProvisionRequest) (VPCShardProvisionResult, error)
}

type CommandInvocation struct {
	CommandID    string `json:"commandID"`
	InvocationID string `json:"invocationID"`
	InstanceID   string `json:"instanceID"`
	Region       string `json:"region"`
	Status       string `json:"status"`
}

type CommandResult struct {
	CommandInvocation
	ExitCode      int64  `json:"exitCode"`
	Output        string `json:"output"`
	ErrorInfo     string `json:"errorInfo,omitempty"`
	OutputURL     string `json:"outputURL,omitempty"`
	Dropped       int64  `json:"dropped,omitempty"`
	StartTime     string `json:"startTime,omitempty"`
	EndTime       string `json:"endTime,omitempty"`
	ExecutionTime string `json:"executionTime,omitempty"`
}

type CommandInvocationMetadata struct {
	CommandInvocation
	ExitCode      int64  `json:"exitCode"`
	StartTime     string `json:"startTime,omitempty"`
	EndTime       string `json:"endTime,omitempty"`
	ExecutionTime string `json:"executionTime,omitempty"`
}

var ErrInvocationNotFound = errors.New("command invocation not found")

// CommandRunner is an optional capability for cloud providers that can execute remote commands.
type CommandRunner interface {
	RunCommand(ctx context.Context, region, instanceID, script string) (CommandInvocation, error)
	GetCommandInvocation(ctx context.Context, region, invocationID, instanceID string) (CommandResult, error)
}

// CommandInvoker invokes an existing TAT command with runtime parameters. The
// command content remains managed in Tencent TAT, so callers never need to put
// secret parameter values in scripts, logs, or task payloads.
type CommandInvoker interface {
	InvokeCommand(ctx context.Context, region, instanceID, commandID string, parameters map[string]string) (CommandInvocation, error)
	GetCommandInvocationMetadata(ctx context.Context, region, invocationID, instanceID string) (CommandInvocationMetadata, error)
}

// InstanceDeliveryVerifier can reject a stale TAT agent heartbeat from a
// previous OS generation after a create or reinstall operation.
type InstanceDeliveryVerifier interface {
	VerifyInstanceDelivery(ctx context.Context, cloudID string, notBefore time.Time) error
}

// VerifyInstanceDelivery uses generation-aware verification when the provider
// supports it and falls back to the CloudProvider contract for other providers.
func VerifyInstanceDelivery(ctx context.Context, cp CloudProvider, cloudID string, notBefore time.Time) error {
	if cp == nil {
		return errors.New("provider: missing cloud provider")
	}
	if verifier, ok := cp.(InstanceDeliveryVerifier); ok {
		return verifier.VerifyInstanceDelivery(ctx, cloudID, notBefore)
	}
	return cp.VerifyInstance(ctx, cloudID)
}

type TerminalSession struct {
	SessionID      string `json:"sessionId"`
	Region         string `json:"region"`
	InstanceID     string `json:"instanceId"`
	OwnerUin       string `json:"ownerUin"`
	LoginUin       string `json:"loginUin"`
	AppID          int64  `json:"appId"`
	WsURL          string `json:"wsUrl"`
	Cols           int    `json:"cols"`
	Rows           int    `json:"rows"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	Username       string `json:"username,omitempty"`
	WorkingDir     string `json:"workingDirectory,omitempty"`
}

// TerminalSessionStarter is an optional capability for cloud providers that can
// bootstrap a TAT PTY session for browser/websocket clients.
type TerminalSessionStarter interface {
	StartTerminalSession(ctx context.Context, region, instanceID string) (TerminalSession, error)
}

const (
	TerminalCommandEventStarted = "started"
	TerminalCommandEventOutput  = "output"

	TerminalCommandErrorTimeout  = "TIMEOUT"
	TerminalCommandErrorCanceled = "CANCELED"
	TerminalCommandErrorProtocol = "PROTOCOL_ERROR"
)

type TerminalCommandStreamRequest struct {
	Region           string
	InstanceID       string
	Command          string
	Username         string
	WorkingDirectory string
	TimeoutSeconds   int
}

type TerminalCommandStreamEvent struct {
	Type        string
	ExecutionID string
	Index       int
	Chunk       string
}

type TerminalCommandResult struct {
	ExecutionID string
	ExitCode    int
}

type TerminalCommandStreamError struct {
	Code    string
	Message string
}

func (e *TerminalCommandStreamError) Error() string {
	if e == nil || strings.TrimSpace(e.Message) == "" {
		return "tat terminal command stream failed"
	}
	return e.Message
}

// TerminalCommandStreamer is the internal server-side TAT PTY command stream
// capability. Implementations invoke emit after PtyReady and for ordered output.
type TerminalCommandStreamer interface {
	StreamTerminalCommand(ctx context.Context, req TerminalCommandStreamRequest, emit func(TerminalCommandStreamEvent) error) (TerminalCommandResult, error)
}

// MockCloudProvider simulates a provider with sleeps.
//
// For trade pass destroy flow (D-4.2b), MockCloudProvider keeps an in-memory
// map of "fake snapshots" keyed by snapshot id; each CreateInstanceSnapshot call
// returns a generated id and is observable via DescribeInstanceSnapshot. To keep
// the mock behavior deterministic and free from sleeps, the snapshot enters
// SnapshotStatusReady immediately on creation.
// It also keeps a per-instance spec so the same-SP upgrade flow can be driven
// end to end without a cloud account; unseen instances start from the default
// spec below.
type MockCloudProvider struct {
	snapMu    sync.Mutex
	snapshots map[string]SnapshotStatus

	specMu sync.Mutex
	specs  map[string]InstanceSpec
}

func NewMockCloudProvider() *MockCloudProvider {
	return &MockCloudProvider{
		snapshots: make(map[string]SnapshotStatus),
		specs:     make(map[string]InstanceSpec),
	}
}

// mockDefaultSpec is what the mock reports for an instance it has never seen a
// resize for; it mirrors the smallest bundle spec (2C4G 50G).
var mockDefaultSpec = InstanceSpec{InstanceType: "S5.MEDIUM4", SystemDiskSize: 50, State: "STOPPED"}

func (m *MockCloudProvider) DescribeInstanceSpec(_ context.Context, cloudID string) (InstanceSpec, error) {
	if strings.TrimSpace(cloudID) == "" {
		return InstanceSpec{}, errors.New("DescribeInstanceSpec: cloudID is required")
	}
	m.specMu.Lock()
	defer m.specMu.Unlock()
	if spec, ok := m.specs[cloudID]; ok {
		return spec, nil
	}
	return mockDefaultSpec, nil
}

func (m *MockCloudProvider) ResizeInstanceType(ctx context.Context, cloudID, instanceType string) error {
	spec, err := m.DescribeInstanceSpec(ctx, cloudID)
	if err != nil {
		return err
	}
	spec.InstanceType = instanceType
	m.specMu.Lock()
	m.specs[cloudID] = spec
	m.specMu.Unlock()
	return nil
}

func (m *MockCloudProvider) ResizeSystemDisk(ctx context.Context, cloudID string, sizeGB int) error {
	spec, err := m.DescribeInstanceSpec(ctx, cloudID)
	if err != nil {
		return err
	}
	if spec.SystemDiskSize > sizeGB {
		return fmt.Errorf("ResizeSystemDisk %s: cloud disks cannot shrink (%dG -> %dG)",
			cloudID, spec.SystemDiskSize, sizeGB)
	}
	spec.SystemDiskSize = sizeGB
	m.specMu.Lock()
	m.specs[cloudID] = spec
	m.specMu.Unlock()
	return nil
}

func (m *MockCloudProvider) CreateInstance(_ context.Context, pool core.Pool) (string, string, error) {
	// For demo, cloudID is derived from time; address is synthetic.
	now := time.Now().UnixNano()
	return fmt.Sprintf("cvm-%d", now), fmt.Sprintf("10.99.%d.%d", now%250, (now/10)%250), nil
}

func (m *MockCloudProvider) ReinstallInstance(ctx context.Context, cloudID string, _ string) error {
	// Simulate reinstall delay.
	select {
	case <-time.After(300 * time.Millisecond):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *MockCloudProvider) DescribeInstance(_ context.Context, cloudID string) (string, error) {
	// Simplified: always running.
	return "RUNNING", nil
}

func (m *MockCloudProvider) TerminateInstance(ctx context.Context, cloudID string) error {
	select {
	case <-time.After(100 * time.Millisecond):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *MockCloudProvider) StopInstance(ctx context.Context, cloudID string) error {
	// Simulate cvm StopInstances latency.
	select {
	case <-time.After(150 * time.Millisecond):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *MockCloudProvider) StartInstance(ctx context.Context, cloudID string) error {
	// Simulate cvm StartInstances latency.
	select {
	case <-time.After(150 * time.Millisecond):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// CreateInstanceSnapshot mock: deterministically generate a snapshot id and mark
// it as ready immediately. Special-case empty CloudID → ErrInstanceNoSystemDisk
// so unit tests of the Q10/Q25 联动分支 can exercise the no-disk path.
func (m *MockCloudProvider) CreateInstanceSnapshot(_ context.Context, req CreateInstanceSnapshotRequest) (string, error) {
	if strings.TrimSpace(req.CloudID) == "" {
		return "", ErrInstanceNoSystemDisk
	}
	id := "snap-mock-" + uuid.New().String()
	m.snapMu.Lock()
	defer m.snapMu.Unlock()
	if m.snapshots == nil {
		m.snapshots = make(map[string]SnapshotStatus)
	}
	m.snapshots[id] = SnapshotStatusReady
	return id, nil
}

// DescribeInstanceSnapshot mock: lookup the in-memory map; unknown id maps to
// ErrSnapshotNotFound. The returned reason string is empty for ready snapshots.
func (m *MockCloudProvider) DescribeInstanceSnapshot(_ context.Context, snapshotID string) (SnapshotStatus, string, error) {
	m.snapMu.Lock()
	defer m.snapMu.Unlock()
	status, ok := m.snapshots[snapshotID]
	if !ok {
		return "", "", ErrSnapshotNotFound
	}
	return status, "", nil
}

func (m *MockCloudProvider) VerifyInstance(_ context.Context, _ string) error {
	return nil
}

func (m *MockCloudProvider) ProvisionCapacityBundle(_ context.Context, req CapacityBundleProvisionRequest) (core.CapacityBundle, error) {
	now := time.Now().UTC()
	suffix := fmt.Sprintf("%d", now.UnixNano())
	zone := strings.TrimSpace(req.Zone)
	if zone == "" {
		zone = "mock-zone"
	}
	region := strings.TrimSpace(req.Region)
	if region == "" {
		region = "mock-region"
	}
	return core.CapacityBundle{
		ID:                  "bundle-" + suffix,
		Region:              region,
		Zone:                zone,
		VpcID:               "vpc-" + suffix,
		SubnetID:            "subnet-" + suffix,
		SecurityGroupIDs:    []string{"sg-" + suffix},
		NetworkTemplateID:   strings.TrimSpace(req.NetworkTemplateID),
		Status:              core.CapacityBundleStatusWarm,
		BootstrapGeneration: 1,
		LineageTags: map[string]string{
			"template_class_id": strings.TrimSpace(req.TemplateClassID),
			"provisioner":       "mock",
		},
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

func (m *MockCloudProvider) ProvisionVPCShard(_ context.Context, req VPCShardProvisionRequest) (VPCShardProvisionResult, error) {
	now := time.Now().UTC()
	suffix := fmt.Sprintf("%d", now.UnixNano())
	support := core.VPCShardSubnet{
		ID:               "vpsubnet-support-" + suffix,
		VPCShardID:       "vpshard-" + suffix,
		SubnetID:         "subnet-support-" + suffix,
		Zone:             strings.TrimSpace(req.SupportSubnet.Zone),
		Role:             core.VPCShardSubnetRoleSupport,
		Ordinal:          req.SupportSubnet.Ordinal,
		ReservationState: core.VPCShardSubnetReservationAvailable,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	workloads := make([]core.VPCShardSubnet, 0, len(req.WorkloadSubnets))
	for idx, subnet := range req.WorkloadSubnets {
		workloads = append(workloads, core.VPCShardSubnet{
			ID:               fmt.Sprintf("vpsubnet-workload-%d-%s", idx, suffix),
			VPCShardID:       "vpshard-" + suffix,
			SubnetID:         fmt.Sprintf("subnet-workload-%d-%s", idx, suffix),
			Zone:             strings.TrimSpace(subnet.Zone),
			Role:             core.VPCShardSubnetRoleWorkload,
			Ordinal:          subnet.Ordinal,
			ReservationState: core.VPCShardSubnetReservationAvailable,
			CreatedAt:        now,
			UpdatedAt:        now,
		})
	}
	return VPCShardProvisionResult{
		VpcID:           "vpc-" + suffix,
		SupportSubnet:   support,
		WorkloadSubnets: workloads,
		CleanupResources: []core.VPCShardCleanupResource{
			{ID: "vpscleanup-vpc-" + suffix, ResourceType: core.VPCShardCleanupResourceTypeVPC, ResourceID: "vpc-" + suffix, CreatedAt: now},
		},
	}, nil
}

func (m *MockCloudProvider) ExportVPCShardBlueprint(_ context.Context, region string, _ string) (VPCShardBlueprintExport, error) {
	return VPCShardBlueprintExport{
		SchemaVersion:     "v1alpha1",
		SourceRegion:      firstNonEmpty(strings.TrimSpace(region), "mock-region"),
		NetworkTemplateID: "mock-network-template",
		VPCCIDR:           "10.0.0.0/16",
		SupportSubnet: VPCShardSubnetSpec{
			Name:    "support",
			CIDR:    "10.0.0.0/24",
			Zone:    "mock-zone-a",
			Role:    core.VPCShardSubnetRoleSupport,
			Ordinal: 0,
		},
		WorkloadSubnets: []VPCShardSubnetSpec{
			{Name: "workload-a", CIDR: "10.0.1.0/24", Zone: "mock-zone-a", Role: core.VPCShardSubnetRoleWorkload, Ordinal: 1},
		},
		NATShape: blueprint.StaticNATShape{
			Mode: "single",
			Gateways: []blueprint.StaticNATGateway{
				{Name: "nat-main", Zone: "mock-zone-a", Subnet: "support"},
			},
		},
		RouteShape: blueprint.StaticRouteShape{
			RouteTables: []blueprint.StaticRouteTable{
				{
					Name: "rt-main",
					Main: true,
					Associations: []blueprint.StaticRouteAssociation{
						{Target: "support"},
						{Target: "workload:1"},
					},
					Routes: []blueprint.StaticRoute{
						{Destination: "10.0.0.0/16", NextHopType: "LOCAL", NextHopRef: "local", Enabled: true},
						{Destination: "0.0.0.0/0", NextHopType: "NAT", NextHopRef: "nat-main", Enabled: true},
					},
				},
			},
		},
	}, nil
}

// ResolveFromEnv selects the provider implementation from CLOUD_PROVIDER.
// Empty value defaults to mock for local development.
func ResolveFromEnv() (CloudProvider, error) {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("CLOUD_PROVIDER"))) {
	case "", "mock":
		return NewMockCloudProvider(), nil
	case "tencent":
		return NewTencentCloudProviderFromEnv()
	default:
		return nil, fmt.Errorf("unsupported cloud provider %q", os.Getenv("CLOUD_PROVIDER"))
	}
}
