package provider

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"cvm-mock-e2b/internal/blueprint"
	"cvm-mock-e2b/internal/core"
)

// CloudProvider abstracts calls to the cloud vendor.
type CloudProvider interface {
	CreateInstance(ctx context.Context, pool core.Pool) (cloudID string, address string, err error)
	ReinstallInstance(ctx context.Context, cloudID string, imageID string) error
	DescribeInstance(ctx context.Context, cloudID string) (status string, err error)
	TerminateInstance(ctx context.Context, cloudID string) error
	VerifyInstance(ctx context.Context, address string) error
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

var ErrInvocationNotFound = errors.New("command invocation not found")

// CommandRunner is an optional capability for cloud providers that can execute remote commands.
type CommandRunner interface {
	RunCommand(ctx context.Context, region, instanceID, script string) (CommandInvocation, error)
	GetCommandInvocation(ctx context.Context, region, invocationID, instanceID string) (CommandResult, error)
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
}

// TerminalSessionStarter is an optional capability for cloud providers that can
// bootstrap a TAT PTY session for browser/websocket clients.
type TerminalSessionStarter interface {
	StartTerminalSession(ctx context.Context, region, instanceID string) (TerminalSession, error)
}

// EnvdHupper is an optional capability for providers that can signal envd inside the instance.
// It's intentionally not part of CloudProvider to keep the core interface minimal.
type EnvdHupper interface {
	HupEnvd(ctx context.Context, address string) error
}

// BestEffortHupEnvd triggers envd SIGHUP if the provider supports it.
// This is used as a pre-reset step to reduce false-positive /health probes during reset.
func BestEffortHupEnvd(ctx context.Context, cp CloudProvider, address string) error {
	if address == "" || cp == nil {
		return nil
	}
	h, ok := cp.(EnvdHupper)
	if !ok {
		return nil
	}
	return h.HupEnvd(ctx, address)
}

// MockCloudProvider simulates a provider with sleeps.
type MockCloudProvider struct{}

func NewMockCloudProvider() *MockCloudProvider {
	return &MockCloudProvider{}
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
