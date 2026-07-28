package provider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	cbs "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/cbs/v20170312"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tcerrors "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
	cvm "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/cvm/v20170312"

	"cvm-mock-e2b/internal/blueprint"
	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/provider/tencentbundle"
)

// TencentConfig holds required parameters for CVM operations.
type TencentConfig struct {
	SecretID               string
	SecretKey              string
	Endpoint               string
	VPCEndpoint            string
	TATEndpoint            string
	CBSEndpoint            string // optional, defaults to cbs.tencentcloudapi.com (D-4.2b: trade pass destroy snapshot flow)
	Region                 string
	InstanceType           string
	KeyPairID              string
	InstancePassword       string
	AddressType            string
	PublicEgressMbps       int64
	TerminalTimeoutSeconds int
	// IngressProxyBaseURL enables verifying private addresses via ingressproxy ip-backdoor.
	// Example: http://ingressproxy-router (must have PROXY_ENABLE_IP_BACKDOOR=true).
	IngressProxyBaseURL string
}

// NewTencentCloudProviderFromEnv builds provider using environment variables.
// Required: TENCENT_SECRET_ID, TENCENT_SECRET_KEY, TENCENT_REGION, TENCENT_INSTANCE_TYPE
// Pool-level network and security_groups are required on each pool row.
// Optional: TENCENT_KEY_PAIR_ID
func NewTencentCloudProviderFromEnv() (*TencentCloudProvider, error) {
	cfg := TencentConfig{
		SecretID:               os.Getenv("TENCENT_SECRET_ID"),
		SecretKey:              os.Getenv("TENCENT_SECRET_KEY"),
		Endpoint:               strings.TrimSpace(os.Getenv("TENCENT_CVM_ENDPOINT")),
		VPCEndpoint:            strings.TrimSpace(os.Getenv("TENCENT_VPC_ENDPOINT")),
		TATEndpoint:            strings.TrimSpace(os.Getenv("TENCENT_TAT_ENDPOINT")),
		Region:                 os.Getenv("TENCENT_REGION"),
		InstanceType:           os.Getenv("TENCENT_INSTANCE_TYPE"),
		KeyPairID:              os.Getenv("TENCENT_KEY_PAIR_ID"),
		InstancePassword:       os.Getenv("TENCENT_INSTANCE_PASSWORD"),
		TerminalTimeoutSeconds: DefaultTerminalTimeoutSeconds,
		IngressProxyBaseURL:    strings.TrimSpace(os.Getenv("INGRESSPROXY_BASE_URL")),
	}
	if raw := strings.TrimSpace(os.Getenv("TENCENT_TAT_TERMINAL_TIMEOUT_SECONDS")); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil {
			return nil, fmt.Errorf("invalid TENCENT_TAT_TERMINAL_TIMEOUT_SECONDS %q: %w", raw, err)
		}
		if v <= 0 {
			return nil, fmt.Errorf("invalid TENCENT_TAT_TERMINAL_TIMEOUT_SECONDS %q: must be > 0", raw)
		}
		cfg.TerminalTimeoutSeconds = v
	}
	if mbps := strings.TrimSpace(os.Getenv("TENCENT_PUBLIC_EGRESS_MBPS")); mbps != "" {
		v, err := strconv.ParseInt(mbps, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid TENCENT_PUBLIC_EGRESS_MBPS %q: %w", mbps, err)
		}
		if v < 0 {
			return nil, fmt.Errorf("invalid TENCENT_PUBLIC_EGRESS_MBPS %q: must be >= 0", mbps)
		}
		cfg.PublicEgressMbps = v
	}
	addrType := strings.ToLower(os.Getenv("TENCENT_ADDRESS_TYPE"))
	if addrType == "" {
		addrType = "private"
	}
	if addrType != "private" && addrType != "public" {
		return nil, fmt.Errorf("invalid TENCENT_ADDRESS_TYPE %q: must be 'private' or 'public'", addrType)
	}
	cfg.AddressType = addrType
	if cfg.SecretID == "" || cfg.SecretKey == "" || cfg.Region == "" || cfg.InstanceType == "" {
		return nil, errors.New("missing required Tencent Cloud env: need TENCENT_SECRET_ID, TENCENT_SECRET_KEY, TENCENT_REGION, TENCENT_INSTANCE_TYPE")
	}
	return NewTencentCloudProvider(cfg)
}

// TencentCloudProvider implements CloudProvider with Tencent Cloud SDK.
type TencentCloudProvider struct {
	client    *cvm.Client
	cbsClient *cbs.Client
	cred      *common.Credential
	cfg       TencentConfig

	startTerminalSessionFunc func(context.Context, string, string) (TerminalSession, error)
	tatForwardURLFunc        func(string) string
	tatAuthDelay             time.Duration
}

const (
	envdHealthPort = "49983"
	envdHealthPath = "/health"
)

const (
	healthLogEvery = 10

	verifyTotalTimeout  = 60 * time.Second
	verifyPerReqTimeout = 8 * time.Second
	verifyInterval      = 5 * time.Second

	downTotalTimeout  = 90 * time.Second
	downPerReqTimeout = 600 * time.Millisecond
)

type envdProcessStartRequest struct {
	Process struct {
		Cmd  string   `json:"cmd"`
		Args []string `json:"args"`
	} `json:"process"`
}

func isHealthyStatus(code int) bool {
	return code == http.StatusOK || code == http.StatusNoContent
}

// waitHealth waits until /health reaches the desired state (up/down) at least once.
// For "up": require status 200/204.
// For "down": treat any non-200/204 or any transport error as down.
func waitHealth(ctx context.Context, verifyURL, hostOverride string, wantUp bool, totalTimeout, perReqTimeout, interval time.Duration, logEvery int) error {
	start := time.Now()
	deadline := start.Add(totalTimeout)
	client := &http.Client{Timeout: perReqTimeout}
	attempt := 0

	for {
		attempt++
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, verifyURL, nil)
		if err != nil {
			return err
		}
		if hostOverride != "" {
			req.Host = hostOverride
		}

		resp, err := client.Do(req)
		if err == nil {
			_ = resp.Body.Close()
			if wantUp {
				if isHealthyStatus(resp.StatusCode) {
					return nil
				}
				err = fmt.Errorf("unexpected health status=%d", resp.StatusCode)
			} else {
				// Down-gate: anything other than OK/NoContent is considered down.
				if !isHealthyStatus(resp.StatusCode) {
					return nil
				}
				err = fmt.Errorf("health still up status=%d", resp.StatusCode)
			}
		} else if !wantUp {
			// Transport error counts as down for down-gate purposes.
			return nil
		}

		if time.Now().After(deadline) {
			if wantUp {
				return fmt.Errorf("verify health timeout url=%s host=%s: %w", verifyURL, hostOverride, err)
			}
			return fmt.Errorf("did not observe health down url=%s host=%s within %s: %w", verifyURL, hostOverride, time.Since(start), err)
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
}

// waitDownProbeInterval is used for best-effort detection that a reinstall has actually started.
// Keep it coarse to reduce load; readiness itself is handled by VerifyInstance.
const waitDownProbeInterval = 2 * time.Second

const (
	rateLimitCode                   = "RequestLimitExceeded"
	rateLimitBackoffMin             = 200 * time.Millisecond
	rateLimitBackoffMax             = 5 * time.Second
	accountService                  = "account"
	accountVersion                  = "2018-12-25"
	accountEndpoint                 = "account.tencentcloudapi.com"
	accountRegion                   = "ap-guangzhou"
	tatService                      = "tat"
	tatVersion                      = "2020-10-28"
	defaultTerminalCols             = 120
	defaultTerminalRows             = 32
	defaultTerminalUsername         = "agentuser"
	defaultTerminalWorkingDirectory = "/home/agentuser"
)

const DefaultTerminalTimeoutSeconds = 3600

func isRateLimitErr(err error) bool {
	sdk, ok := err.(*tcerrors.TencentCloudSDKError)
	return ok && sdk.Code == rateLimitCode
}

func rateLimitBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	d := rateLimitBackoffMin
	for i := 1; i < attempt; i++ {
		if d >= rateLimitBackoffMax {
			d = rateLimitBackoffMax
			break
		}
		d *= 2
		if d > rateLimitBackoffMax {
			d = rateLimitBackoffMax
			break
		}
	}
	// +/- 20% jitter to avoid synchronized retries across workers.
	j := float64(d) * 0.2
	delta := time.Duration((rand.Float64()*2 - 1) * j)
	if d+delta <= 0 {
		return d
	}
	return d + delta
}

func retryRateLimit(ctx context.Context, op string, fn func() error) error {
	for attempt := 1; ; attempt++ {
		err := fn()
		if err == nil {
			return nil
		}
		if !isRateLimitErr(err) {
			return err
		}
		backoff := rateLimitBackoff(attempt)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
	}
}

func (p *TencentCloudProvider) buildHealthTarget(address string) (verifyURL string, hostOverride string, err error) {
	if address == "" {
		return "", "", errors.New("missing address for verification")
	}
	// Probe instance health directly. In private mode, workers can reach the CVM
	// over the VPC, so there is no need to add ingressproxy as an extra hop.
	verifyURL = fmt.Sprintf("http://%s:%s%s", address, envdHealthPort, envdHealthPath)
	return verifyURL, "", nil
}

func (p *TencentCloudProvider) buildEnvdProcessTarget(address string) (targetURL string, hostOverride string, err error) {
	if address == "" {
		return "", "", errors.New("missing address for envd process target")
	}
	targetURL = fmt.Sprintf("http://%s:%s/process.Process/Start", address, envdHealthPort)
	return targetURL, "", nil
}

// NewTencentCloudProvider constructs provider from config.
func NewTencentCloudProvider(cfg TencentConfig) (*TencentCloudProvider, error) {
	if cfg.TerminalTimeoutSeconds <= 0 {
		cfg.TerminalTimeoutSeconds = DefaultTerminalTimeoutSeconds
	}
	cred := common.NewCredential(cfg.SecretID, cfg.SecretKey)
	httpProfile := profile.NewHttpProfile()
	if cfg.Endpoint != "" {
		httpProfile.Endpoint = cfg.Endpoint
	} else {
		httpProfile.Endpoint = "cvm.tencentcloudapi.com"
	}
	clientProfile := profile.NewClientProfile()
	clientProfile.HttpProfile = httpProfile

	client, err := cvm.NewClient(cred, cfg.Region, clientProfile)
	if err != nil {
		return nil, err
	}

	// Build a separate cbs client for trade pass destroy snapshot flow (D-4.2b).
	// We deliberately use a fresh ClientProfile so cbs's HttpProfile.Endpoint can be
	// overridden independently of cvm's (e.g. internal vs external endpoints).
	cbsHTTPProfile := profile.NewHttpProfile()
	if cfg.CBSEndpoint != "" {
		cbsHTTPProfile.Endpoint = cfg.CBSEndpoint
	} else {
		cbsHTTPProfile.Endpoint = "cbs.tencentcloudapi.com"
	}
	cbsClientProfile := profile.NewClientProfile()
	cbsClientProfile.HttpProfile = cbsHTTPProfile
	cbsCli, err := cbs.NewClient(cred, cfg.Region, cbsClientProfile)
	if err != nil {
		return nil, fmt.Errorf("init cbs client: %w", err)
	}

	return &TencentCloudProvider{client: client, cbsClient: cbsCli, cred: cred, cfg: cfg}, nil
}

func (p *TencentCloudProvider) CreateInstance(ctx context.Context, pool core.Pool) (string, string, error) {
	image := pool.BaseImage
	if !strings.HasPrefix(image, "img-") {
		return "", "", errors.New("missing image id for create")
	}
	if strings.TrimSpace(pool.VpcID) == "" || strings.TrimSpace(pool.SubnetID) == "" || strings.TrimSpace(pool.Zone) == "" {
		return "", "", errors.New("missing pool network config: need vpc_id, subnet_id, zone")
	}
	req := cvm.NewRunInstancesRequest()
	req.InstanceChargeType = common.StringPtr("POSTPAID_BY_HOUR")
	req.InstanceCount = common.Int64Ptr(1)
	instanceType := strings.TrimSpace(pool.InstanceType)
	if instanceType == "" {
		instanceType = p.cfg.InstanceType
	}
	req.InstanceType = common.StringPtr(instanceType)
	req.ImageId = common.StringPtr(image)
	req.Placement = &cvm.Placement{Zone: common.StringPtr(pool.Zone)}
	req.VirtualPrivateCloud = &cvm.VirtualPrivateCloud{
		VpcId:    common.StringPtr(pool.VpcID),
		SubnetId: common.StringPtr(pool.SubnetID),
	}
	req.EnhancedService = &cvm.EnhancedService{
		// Do not attach Tencent Cloud security service to sandbox CVMs.
		SecurityService: &cvm.RunSecurityServiceEnabled{
			Enabled: common.BoolPtr(false),
		},
	}
	// SystemDisk 大小由 pool 自描述（设计稿 .tmp/bundle-instance-spec-design.md §10 Q11=a）。
	// pool.SystemDiskSize > 0 时显式下发 SystemDisk.DiskSize；0 时不设，走腾讯云默认 50G
	// （与现网行为兼容，Q-COMPAT 兼容期 fallback）。
	if pool.SystemDiskSize > 0 {
		req.SystemDisk = &cvm.SystemDisk{
			DiskSize: common.Int64Ptr(int64(pool.SystemDiskSize)),
		}
	}
	publicIP := p.cfg.AddressType == "public"
	assignPublicEgress := publicIP || p.cfg.PublicEgressMbps > 0
	if assignPublicEgress {
		bandwidth := p.cfg.PublicEgressMbps
		if bandwidth <= 0 {
			bandwidth = 10
		}
		req.InternetAccessible = &cvm.InternetAccessible{
			InternetChargeType:      common.StringPtr("TRAFFIC_POSTPAID_BY_HOUR"),
			InternetMaxBandwidthOut: common.Int64Ptr(bandwidth),
			PublicIpAssigned:        common.BoolPtr(true),
		}
	} else {
		// 不申请公网 IP，避免“未配置公网IP，不支持设置带宽”错误。
		req.InternetAccessible = &cvm.InternetAccessible{
			PublicIpAssigned: common.BoolPtr(false),
		}
	}
	securityGroups, err := poolSecurityGroups(pool)
	if err != nil {
		return "", "", err
	}
	sgs := make([]*string, 0, len(securityGroups))
	for _, sg := range securityGroups {
		sgs = append(sgs, common.StringPtr(sg))
	}
	req.SecurityGroupIds = sgs
	if password := strings.TrimSpace(p.cfg.InstancePassword); password != "" {
		req.LoginSettings = &cvm.LoginSettings{
			Password: common.StringPtr(password),
		}
	} else if keyPairID := strings.TrimSpace(p.cfg.KeyPairID); keyPairID != "" {
		req.LoginSettings = &cvm.LoginSettings{
			KeyIds: []*string{common.StringPtr(keyPairID)},
		}
	}
	req.InstanceName = common.StringPtr(fmt.Sprintf("pool-%s-%d", pool.ID, time.Now().Unix()))
	req.SetContext(ctx)

	var resp *cvm.RunInstancesResponse
	if err := retryRateLimit(ctx, "RunInstances", func() error {
		r, e := p.client.RunInstances(req)
		if e != nil {
			return e
		}
		resp = r
		return nil
	}); err != nil {
		return "", "", err
	}
	if len(resp.Response.InstanceIdSet) == 0 {
		return "", "", errors.New("no instance id returned from RunInstances")
	}
	cloudID := *resp.Response.InstanceIdSet[0]
	addr, err := p.waitForAddress(ctx, cloudID, 180*time.Second)
	if err != nil {
		return cloudID, "", err
	}
	return cloudID, addr, nil
}

func poolSecurityGroups(pool core.Pool) ([]string, error) {
	securityGroups := make([]string, 0, len(pool.SecurityGroups))
	for _, sg := range pool.SecurityGroups {
		trimmed := strings.TrimSpace(sg)
		if trimmed == "" {
			continue
		}
		securityGroups = append(securityGroups, trimmed)
	}
	if len(securityGroups) == 0 {
		return nil, fmt.Errorf("pool %s missing security_groups", strings.TrimSpace(pool.ID))
	}
	return securityGroups, nil
}

func (p *TencentCloudProvider) ReinstallInstance(ctx context.Context, cloudID string, imageID string) error {
	// 使用 ResetInstance 触发系统盘重装，镜像 ID 可由调用方传入覆盖池配置。
	req := cvm.NewResetInstanceRequest()
	req.InstanceId = common.StringPtr(cloudID)
	targetImage := imageID
	if targetImage == "" || !strings.HasPrefix(targetImage, "img-") {
		return errors.New("missing image id for reinstall")
	}
	req.ImageId = common.StringPtr(targetImage)
	req.SetContext(ctx)
	deadline := time.Now().Add(120 * time.Second)
	for {
		err := retryRateLimit(ctx, "ResetInstance", func() error {
			_, e := p.client.ResetInstance(req)
			return e
		})
		if err == nil {
			return nil
		}
		if sdk, ok := err.(*tcerrors.TencentCloudSDKError); ok && sdk.Code == "OperationDenied.InstanceOperationInProgress" {
			if time.Now().After(deadline) {
				return fmt.Errorf("reinstall %s timeout while waiting for pending operation: %w", cloudID, err)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(5 * time.Second):
			}
			continue
		}
		return err
	}
}

func (p *TencentCloudProvider) DescribeInstance(ctx context.Context, cloudID string) (string, error) {
	req := cvm.NewDescribeInstancesStatusRequest()
	req.InstanceIds = []*string{common.StringPtr(cloudID)}
	req.SetContext(ctx)
	var resp *cvm.DescribeInstancesStatusResponse
	if err := retryRateLimit(ctx, "DescribeInstancesStatus", func() error {
		r, e := p.client.DescribeInstancesStatus(req)
		if e != nil {
			return e
		}
		resp = r
		return nil
	}); err != nil {
		return "", err
	}
	if len(resp.Response.InstanceStatusSet) == 0 {
		return "", errors.New("instance not found")
	}
	return *resp.Response.InstanceStatusSet[0].InstanceState, nil
}

func (p *TencentCloudProvider) TerminateInstance(ctx context.Context, cloudID string) error {
	req := cvm.NewTerminateInstancesRequest()
	req.InstanceIds = []*string{common.StringPtr(cloudID)}
	req.SetContext(ctx)
	deadline := time.Now().Add(120 * time.Second)
	for {
		err := retryRateLimit(ctx, "TerminateInstances", func() error {
			_, e := p.client.TerminateInstances(req)
			return e
		})
		if err == nil {
			break
		}
		if sdk, ok := err.(*tcerrors.TencentCloudSDKError); ok {
			if sdk.Code == "InvalidInstanceId.NotFound" {
				return nil
			}
			if sdk.Code == "OperationDenied.InstanceOperationInProgress" {
				if time.Now().After(deadline) {
					return fmt.Errorf("terminate %s timeout while waiting for pending operation: %w", cloudID, err)
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(5 * time.Second):
				}
				continue
			}
		}
		return err
	}
	// Confirm termination by polling status until not found or terminated.
	statusReq := cvm.NewDescribeInstancesStatusRequest()
	statusReq.InstanceIds = []*string{common.StringPtr(cloudID)}
	statusReq.SetContext(ctx)
	pollDeadline := time.Now().Add(60 * time.Second)
	for {
		var resp *cvm.DescribeInstancesStatusResponse
		err := retryRateLimit(ctx, "DescribeInstancesStatus", func() error {
			r, e := p.client.DescribeInstancesStatus(statusReq)
			if e != nil {
				return e
			}
			resp = r
			return nil
		})
		if err != nil {
			if sdk, ok := err.(*tcerrors.TencentCloudSDKError); ok && sdk.Code == "InvalidInstanceId.NotFound" {
				return nil
			}
			return err
		}
		if len(resp.Response.InstanceStatusSet) == 0 {
			return nil // not found -> terminated
		}
		state := *resp.Response.InstanceStatusSet[0].InstanceState
		if strings.EqualFold(state, "TERMINATED") || strings.EqualFold(state, "SHUTDOWN") {
			return nil
		}
		if time.Now().After(pollDeadline) {
			return fmt.Errorf("terminate %s timeout; last state=%s", cloudID, state)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

// StopInstance shuts down the instance with StoppedMode=STOP_CHARGING so that
// CPU/memory billing is released while system disk and data remain intact.
// Used by trade pass isolation flow (Q26-D 修订版 / Q33=a 拍板 2026-05-14 22:37).
func (p *TencentCloudProvider) StopInstance(ctx context.Context, cloudID string) error {
	req := cvm.NewStopInstancesRequest()
	req.InstanceIds = []*string{common.StringPtr(cloudID)}
	req.StoppedMode = common.StringPtr("STOP_CHARGING")
	req.SetContext(ctx)
	deadline := time.Now().Add(120 * time.Second)
	for {
		err := retryRateLimit(ctx, "StopInstances", func() error {
			_, e := p.client.StopInstances(req)
			return e
		})
		if err == nil {
			break
		}
		if sdk, ok := err.(*tcerrors.TencentCloudSDKError); ok {
			if sdk.Code == "InvalidInstanceId.NotFound" {
				return fmt.Errorf("stop %s: instance not found: %w", cloudID, err)
			}
			// Already stopped is success-equivalent.
			if sdk.Code == "UnsupportedOperation.InstanceStateStopped" ||
				sdk.Code == "InvalidInstanceState.Stopped" {
				return nil
			}
			if sdk.Code == "OperationDenied.InstanceOperationInProgress" {
				if time.Now().After(deadline) {
					return fmt.Errorf("stop %s timeout while waiting for pending operation: %w", cloudID, err)
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(5 * time.Second):
				}
				continue
			}
		}
		return err
	}
	// Confirm by polling status until STOPPED.
	statusReq := cvm.NewDescribeInstancesStatusRequest()
	statusReq.InstanceIds = []*string{common.StringPtr(cloudID)}
	statusReq.SetContext(ctx)
	pollDeadline := time.Now().Add(180 * time.Second)
	for {
		var resp *cvm.DescribeInstancesStatusResponse
		err := retryRateLimit(ctx, "DescribeInstancesStatus", func() error {
			r, e := p.client.DescribeInstancesStatus(statusReq)
			if e != nil {
				return e
			}
			resp = r
			return nil
		})
		if err != nil {
			return err
		}
		if len(resp.Response.InstanceStatusSet) == 0 {
			return fmt.Errorf("stop %s: instance disappeared during stop polling", cloudID)
		}
		state := *resp.Response.InstanceStatusSet[0].InstanceState
		if strings.EqualFold(state, "STOPPED") {
			return nil
		}
		if time.Now().After(pollDeadline) {
			return fmt.Errorf("stop %s timeout; last state=%s", cloudID, state)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

// StartInstance boots a previously stopped instance back to RUNNING.
// Reserved for renewal/restore flows that follow trade pass isolation.
func (p *TencentCloudProvider) StartInstance(ctx context.Context, cloudID string) error {
	req := cvm.NewStartInstancesRequest()
	req.InstanceIds = []*string{common.StringPtr(cloudID)}
	req.SetContext(ctx)
	deadline := time.Now().Add(120 * time.Second)
	for {
		err := retryRateLimit(ctx, "StartInstances", func() error {
			_, e := p.client.StartInstances(req)
			return e
		})
		if err == nil {
			break
		}
		if sdk, ok := err.(*tcerrors.TencentCloudSDKError); ok {
			if sdk.Code == "InvalidInstanceId.NotFound" {
				return fmt.Errorf("start %s: instance not found: %w", cloudID, err)
			}
			// Already running is success-equivalent.
			if sdk.Code == "UnsupportedOperation.InstanceStateRunning" ||
				sdk.Code == "InvalidInstanceState.Running" {
				return nil
			}
			if sdk.Code == "OperationDenied.InstanceOperationInProgress" {
				if time.Now().After(deadline) {
					return fmt.Errorf("start %s timeout while waiting for pending operation: %w", cloudID, err)
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(5 * time.Second):
				}
				continue
			}
		}
		return err
	}
	// Confirm by polling status until RUNNING.
	statusReq := cvm.NewDescribeInstancesStatusRequest()
	statusReq.InstanceIds = []*string{common.StringPtr(cloudID)}
	statusReq.SetContext(ctx)
	pollDeadline := time.Now().Add(180 * time.Second)
	for {
		var resp *cvm.DescribeInstancesStatusResponse
		err := retryRateLimit(ctx, "DescribeInstancesStatus", func() error {
			r, e := p.client.DescribeInstancesStatus(statusReq)
			if e != nil {
				return e
			}
			resp = r
			return nil
		})
		if err != nil {
			return err
		}
		if len(resp.Response.InstanceStatusSet) == 0 {
			return fmt.Errorf("start %s: instance disappeared during start polling", cloudID)
		}
		state := *resp.Response.InstanceStatusSet[0].InstanceState
		if strings.EqualFold(state, "RUNNING") {
			return nil
		}
		if time.Now().After(pollDeadline) {
			return fmt.Errorf("start %s timeout; last state=%s", cloudID, state)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

// CreateInstanceSnapshot creates a CBS snapshot of the instance system disk.
//
// Q4 / Q9 / Q25 ✅ 拍板 (.tmp/trade-pass-destroy-design.md sec5.2):
//  1. cbs.DescribeDisks(Filters=[instance-id=<cloudID>, disk-usage=SYSTEM_DISK], Limit=1)
//  2. If empty disk set → return ErrInstanceNoSystemDisk so ctl can skip stages 1+2.
//  3. cbs.CreateSnapshot(DiskId, SnapshotName, Deadline=req.Deadline.RFC3339, DiskUsage=SYSTEM_DISK)
//  4. Return resulting SnapshotId.
//
// retryRateLimit reuses the cvm-side rate-limit/backoff wrapper; cbs SDK shares
// the tcerrors model so 429-class codes propagate identically.
func (p *TencentCloudProvider) CreateInstanceSnapshot(ctx context.Context, req CreateInstanceSnapshotRequest) (string, error) {
	cloudID := strings.TrimSpace(req.CloudID)
	if cloudID == "" {
		return "", errors.New("CreateInstanceSnapshot: CloudID is required")
	}
	if req.Deadline.IsZero() {
		return "", errors.New("CreateInstanceSnapshot: Deadline is required")
	}
	if p.cbsClient == nil {
		return "", errors.New("CreateInstanceSnapshot: cbs client not initialized")
	}

	// Step 1: cbs.DescribeDisks 反查系统盘 ID.
	descReq := cbs.NewDescribeDisksRequest()
	descReq.Filters = []*cbs.Filter{
		{Name: common.StringPtr("instance-id"), Values: []*string{common.StringPtr(cloudID)}},
		{Name: common.StringPtr("disk-usage"), Values: []*string{common.StringPtr("SYSTEM_DISK")}},
	}
	descReq.Limit = common.Uint64Ptr(1)
	descReq.SetContext(ctx)

	var descResp *cbs.DescribeDisksResponse
	if err := retryRateLimit(ctx, "cbs:DescribeDisks", func() error {
		r, e := p.cbsClient.DescribeDisksWithContext(ctx, descReq)
		if e != nil {
			return e
		}
		descResp = r
		return nil
	}); err != nil {
		return "", fmt.Errorf("cbs DescribeDisks for instance %s: %w", cloudID, err)
	}

	if descResp == nil || descResp.Response == nil || len(descResp.Response.DiskSet) == 0 {
		// Q10 联动：no system disk → ctl child-task skips stages 1+2.
		return "", ErrInstanceNoSystemDisk
	}
	disk := descResp.Response.DiskSet[0]
	if disk == nil || disk.DiskId == nil || strings.TrimSpace(*disk.DiskId) == "" {
		return "", fmt.Errorf("cbs DescribeDisks for instance %s: returned disk has empty DiskId", cloudID)
	}
	diskID := *disk.DiskId

	// Step 2: cbs.CreateSnapshot.
	// 命名格式（用户拍板 2026-05-25）: {PassID}-{InstanceID(safeNamePart, 24)}
	// PassID 由 trade 生成（形如 pass-xxxxxxxx），原样保留仅做非法字符替换；
	// InstanceID 由 ctl 生成（形如 ins-<32 hex>），截断到 24 字符防止超 cbs 60 字符限制。
	snapName := fmt.Sprintf("%s-%s",
		sanitizeNamePart(req.PassID), safeNamePart(req.InstanceID))

	createReq := cbs.NewCreateSnapshotRequest()
	createReq.DiskId = common.StringPtr(diskID)
	createReq.SnapshotName = common.StringPtr(snapName)
	// cbs Deadline expects RFC3339 ("2006-01-02T15:04:05Z").
	createReq.Deadline = common.StringPtr(req.Deadline.UTC().Format(time.RFC3339))
	createReq.DiskUsage = common.StringPtr("SYSTEM_DISK")
	createReq.SetContext(ctx)

	// ClientToken 幂等保护（用户拍板 2026-05-25）：
	// 取值 {PassID}-{InstanceID}，长度 ≈ 50 字符（PassID ~13 + "-" + InstanceID 36），< 64 字符上限。
	// 配合 ctl 子 task markRetryable 重投：子 task 多次重试 / payload.SnapshotID 写回前的窗口期 race /
	// 父 task 重派失败子 task —— 都用同一个 ClientToken，cbs 后端去重，永远只创建 1 个 snapshot 资源。
	// InstanceID 在 ctl 全局唯一不复用（实例销毁本质是重装），跨用户 / 跨重装场景天然不冲突。
	// 注：cbs SDK Go 结构体未暴露 ClientToken 字段（公开 API 文档未透出，但联调实测幂等生效），
	// 通过 GetParams() 直接塞 K-V，SDK 序列化时一并上行。
	createReq.GetParams()["ClientToken"] = req.PassID + "-" + req.InstanceID

	var createResp *cbs.CreateSnapshotResponse
	if err := retryRateLimit(ctx, "cbs:CreateSnapshot", func() error {
		r, e := p.cbsClient.CreateSnapshotWithContext(ctx, createReq)
		if e != nil {
			return e
		}
		createResp = r
		return nil
	}); err != nil {
		return "", fmt.Errorf("cbs CreateSnapshot for disk %s: %w", diskID, err)
	}

	if createResp == nil || createResp.Response == nil || createResp.Response.SnapshotId == nil ||
		strings.TrimSpace(*createResp.Response.SnapshotId) == "" {
		return "", fmt.Errorf("cbs CreateSnapshot for disk %s: empty SnapshotId in response", diskID)
	}
	return *createResp.Response.SnapshotId, nil
}

// DescribeInstanceSnapshot polls cbs.DescribeSnapshots and maps SnapshotState to
// the abstract SnapshotStatus exposed to ctl.
//
// State mapping (Q9 ✅ 拍板):
//   - NORMAL                                              → SnapshotStatusReady
//   - CREATING                                            → SnapshotStatusInProgress
//   - ERROR / ROLLBACKING_FAILED / TORECYCLE / anything else terminal → SnapshotStatusFailed
//   - empty result set                                    → ErrSnapshotNotFound
func (p *TencentCloudProvider) DescribeInstanceSnapshot(ctx context.Context, snapshotID string) (SnapshotStatus, string, error) {
	id := strings.TrimSpace(snapshotID)
	if id == "" {
		return "", "", errors.New("DescribeInstanceSnapshot: snapshotID is required")
	}
	if p.cbsClient == nil {
		return "", "", errors.New("DescribeInstanceSnapshot: cbs client not initialized")
	}

	req := cbs.NewDescribeSnapshotsRequest()
	req.SnapshotIds = []*string{common.StringPtr(id)}
	req.SetContext(ctx)

	var resp *cbs.DescribeSnapshotsResponse
	if err := retryRateLimit(ctx, "cbs:DescribeSnapshots", func() error {
		r, e := p.cbsClient.DescribeSnapshotsWithContext(ctx, req)
		if e != nil {
			return e
		}
		resp = r
		return nil
	}); err != nil {
		return "", "", fmt.Errorf("cbs DescribeSnapshots for %s: %w", id, err)
	}
	if resp == nil || resp.Response == nil || len(resp.Response.SnapshotSet) == 0 {
		return "", "", ErrSnapshotNotFound
	}
	snap := resp.Response.SnapshotSet[0]
	if snap == nil || snap.SnapshotState == nil {
		return "", "", fmt.Errorf("cbs DescribeSnapshots for %s: missing SnapshotState", id)
	}
	state := strings.ToUpper(strings.TrimSpace(*snap.SnapshotState))
	switch state {
	case "NORMAL":
		return SnapshotStatusReady, "", nil
	case "CREATING":
		return SnapshotStatusInProgress, "", nil
	default:
		// All other terminal cbs states (ERROR / ROLLBACKING_FAILED / TORECYCLE / ...)
		// are reported as failed; the caller (ctl) treats failed as terminal and lets
		// the parent task re-dispatch a new child task per Q16 拍板.
		return SnapshotStatusFailed, "cbs SnapshotState=" + state, nil
	}
}

// safeNamePart sanitizes user-provided ID fragments for use in cbs SnapshotName
// (cbs limits to [A-Za-z0-9_-], 1..60 chars). Anything outside the allowed set
// is replaced by '_'; the result is capped to 24 chars so the composite name
// stays under cbs's limit.
func safeNamePart(in string) string {
	in = strings.TrimSpace(in)
	if in == "" {
		return "unknown"
	}
	const maxFrag = 24
	if len(in) > maxFrag {
		in = in[:maxFrag]
	}
	return sanitizeChars(in)
}

// sanitizeNamePart 与 safeNamePart 行为一致，但**不截断**。
// 用于 PassID 等本身长度可控（trade pass id ≤ ~14 字符）且用户明确要求保留全字符的字段。
func sanitizeNamePart(in string) string {
	in = strings.TrimSpace(in)
	if in == "" {
		return "unknown"
	}
	return sanitizeChars(in)
}

// sanitizeChars 把 in 中除 [A-Za-z0-9_-] 以外的字节替换为 '_'。
func sanitizeChars(in string) string {
	b := make([]byte, 0, len(in))
	for i := 0; i < len(in); i++ {
		c := in[i]
		switch {
		case c >= 'A' && c <= 'Z',
			c >= 'a' && c <= 'z',
			c >= '0' && c <= '9',
			c == '-', c == '_':
			b = append(b, c)
		default:
			b = append(b, '_')
		}
	}
	return string(b)
}

func (p *TencentCloudProvider) waitForAddress(ctx context.Context, instanceID string, timeout time.Duration) (string, error) {
	req := cvm.NewDescribeInstancesRequest()
	req.InstanceIds = []*string{common.StringPtr(instanceID)}
	req.SetContext(ctx)

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var resp *cvm.DescribeInstancesResponse
		if err := retryRateLimit(ctx, "DescribeInstances", func() error {
			r, e := p.client.DescribeInstances(req)
			if e != nil {
				return e
			}
			resp = r
			return nil
		}); err != nil {
			return "", err
		}
		if len(resp.Response.InstanceSet) > 0 {
			inst := resp.Response.InstanceSet[0]
			if p.cfg.AddressType == "public" {
				if len(inst.PublicIpAddresses) > 0 {
					return *inst.PublicIpAddresses[0], nil
				}
			} else {
				if len(inst.PrivateIpAddresses) > 0 {
					return *inst.PrivateIpAddresses[0], nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return "", fmt.Errorf("timeout waiting for %s IP", p.cfg.AddressType)
}

func (p *TencentCloudProvider) VerifyInstance(ctx context.Context, address string) error {
	verifyURL, hostOverride, err := p.buildHealthTarget(address)
	if err != nil {
		return err
	}
	if err := waitHealth(ctx, verifyURL, hostOverride, true, verifyTotalTimeout, verifyPerReqTimeout, verifyInterval, healthLogEvery); err != nil {
		return err
	}
	return nil
}

func (p *TencentCloudProvider) ProvisionCapacityBundle(ctx context.Context, req CapacityBundleProvisionRequest) (core.CapacityBundle, error) {
	return tencentbundle.ProvisionCapacityBundle(ctx, func(region string) tencentbundle.CommonSender {
		return p.newVPCCommonClient(region)
	}, retryRateLimit, tencentbundle.BundleRequest{
		TemplateClassID:        req.TemplateClassID,
		Region:                 firstNonEmpty(req.Region, p.cfg.Region),
		Zone:                   req.Zone,
		NetworkTemplateID:      req.NetworkTemplateID,
		SourceVpcID:            req.SourceVpcID,
		SourceSubnetID:         req.SourceSubnetID,
		SourceSecurityGroupIDs: req.SourceSecurityGroupIDs,
	})
}

func (p *TencentCloudProvider) ProvisionVPCShard(ctx context.Context, req VPCShardProvisionRequest) (VPCShardProvisionResult, error) {
	result, err := tencentbundle.ApplyVPCShardPlan(ctx, func(region string) tencentbundle.CommonSender {
		return p.newVPCCommonClient(region)
	}, retryRateLimit, tencentbundle.VPCShardPlan{
		TemplateClassID:             req.TemplateClassID,
		SKUID:                       req.SKUID,
		BlueprintFingerprint:        req.BlueprintFingerprint,
		NetworkTemplateID:           req.NetworkTemplateID,
		SecurityGroupRuleTemplateID: req.SecurityGroupRuleTemplateID,
		Region:                      firstNonEmpty(req.Region, p.cfg.Region),
		VpcCIDR:                     req.VpcCIDR,
		SupportSubnet: tencentbundle.VPCShardSubnetPlan{
			Name:    req.SupportSubnet.Name,
			CIDR:    req.SupportSubnet.CIDR,
			Zone:    req.SupportSubnet.Zone,
			Role:    req.SupportSubnet.Role,
			Ordinal: req.SupportSubnet.Ordinal,
		},
		WorkloadSubnets: convertVPCShardSubnetPlans(req.WorkloadSubnets),
		NATShape:        req.NATShape,
		RouteShape:      req.RouteShape,
		Tags:            req.Tags,
	})
	if err != nil {
		if applyErr, ok := err.(*tencentbundle.VPCShardApplyError); ok {
			return VPCShardProvisionResult{}, &VPCShardProvisionError{
				Err:           applyErr,
				LastStep:      applyErr.Step,
				PartialResult: convertPartialVPCShardProvisionResult(time.Now().UTC(), req, applyErr.PartialResult),
			}
		}
		return VPCShardProvisionResult{}, err
	}
	return convertPartialVPCShardProvisionResult(time.Now().UTC(), req, result), nil
}

func convertPartialVPCShardProvisionResult(now time.Time, req VPCShardProvisionRequest, result tencentbundle.VPCShardApplyResult) VPCShardProvisionResult {
	supportSubnet := core.VPCShardSubnet{
		SubnetID:         result.SupportSubnetID,
		Zone:             req.SupportSubnet.Zone,
		Role:             core.VPCShardSubnetRoleSupport,
		Ordinal:          req.SupportSubnet.Ordinal,
		ReservationState: core.VPCShardSubnetReservationAvailable,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	workloads := make([]core.VPCShardSubnet, 0, len(req.WorkloadSubnets))
	for _, spec := range req.WorkloadSubnets {
		subnetID := result.WorkloadSubnetIDs[spec.Name]
		workloads = append(workloads, core.VPCShardSubnet{
			SubnetID:         subnetID,
			Zone:             spec.Zone,
			Role:             core.VPCShardSubnetRoleWorkload,
			Ordinal:          spec.Ordinal,
			ReservationState: core.VPCShardSubnetReservationAvailable,
			CreatedAt:        now,
			UpdatedAt:        now,
		})
	}
	cleanupResources := make([]core.VPCShardCleanupResource, 0, 1+len(workloads))
	if strings.TrimSpace(result.VpcID) != "" {
		cleanupResources = append(cleanupResources, core.VPCShardCleanupResource{
			ID:           fmt.Sprintf("vpscleanup-vpc-%d", now.UnixNano()),
			ResourceType: core.VPCShardCleanupResourceTypeVPC,
			ResourceID:   result.VpcID,
			CreatedAt:    now,
		})
	}
	for idx, subnet := range workloads {
		if strings.TrimSpace(subnet.SubnetID) == "" {
			continue
		}
		cleanupResources = append(cleanupResources, core.VPCShardCleanupResource{
			ID:           fmt.Sprintf("vpscleanup-subnet-%d-%d", idx, now.UnixNano()),
			ResourceType: core.VPCShardCleanupResourceTypeSubnet,
			ResourceID:   subnet.SubnetID,
			CreatedAt:    now,
		})
	}
	if strings.TrimSpace(supportSubnet.SubnetID) != "" {
		cleanupResources = append(cleanupResources, core.VPCShardCleanupResource{
			ID:           fmt.Sprintf("vpscleanup-support-subnet-%d", now.UnixNano()),
			ResourceType: core.VPCShardCleanupResourceTypeSubnet,
			ResourceID:   supportSubnet.SubnetID,
			CreatedAt:    now,
		})
	}
	for name, natID := range result.NATGatewayIDs {
		if strings.TrimSpace(natID) == "" {
			continue
		}
		cleanupResources = append(cleanupResources, core.VPCShardCleanupResource{
			ID:           fmt.Sprintf("vpscleanup-nat-%s-%d", shortID(name), now.UnixNano()),
			ResourceType: core.VPCShardCleanupResourceTypeNATGateway,
			ResourceID:   natID,
			CreatedAt:    now,
		})
	}
	for name, routeTableID := range result.RouteTableIDs {
		if strings.TrimSpace(routeTableID) == "" {
			continue
		}
		cleanupResources = append(cleanupResources, core.VPCShardCleanupResource{
			ID:           fmt.Sprintf("vpscleanup-rt-%s-%d", shortID(name), now.UnixNano()),
			ResourceType: core.VPCShardCleanupResourceTypeRouteTable,
			ResourceID:   routeTableID,
			CreatedAt:    now,
		})
	}
	return VPCShardProvisionResult{
		VpcID:            result.VpcID,
		SupportSubnet:    supportSubnet,
		WorkloadSubnets:  workloads,
		CleanupResources: cleanupResources,
	}
}

func (p *TencentCloudProvider) ExportVPCShardBlueprint(ctx context.Context, region string, sourceVpcID string) (VPCShardBlueprintExport, error) {
	region = firstNonEmpty(strings.TrimSpace(region), p.cfg.Region)
	sourceVpcID = strings.TrimSpace(sourceVpcID)
	if sourceVpcID == "" {
		return VPCShardBlueprintExport{}, errors.New("missing source vpc id")
	}
	_, vpcCIDR, err := p.describeVPC(ctx, region, sourceVpcID)
	if err != nil {
		return VPCShardBlueprintExport{}, err
	}
	subnets, err := p.describeSubnets(ctx, region, sourceVpcID)
	if err != nil {
		return VPCShardBlueprintExport{}, err
	}
	supportID, workloadIDs := exportedBlueprintSubnetIDsFromEnv()
	if supportID == "" {
		return VPCShardBlueprintExport{}, errors.New("missing support subnet id for blueprint export")
	}
	byID := map[string]describedSubnet{}
	for _, subnet := range subnets {
		byID[subnet.ID] = subnet
	}
	support, ok := byID[supportID]
	if !ok {
		return VPCShardBlueprintExport{}, fmt.Errorf("support subnet %s not found in vpc %s", supportID, sourceVpcID)
	}
	workloads := make([]VPCShardSubnetSpec, 0, len(workloadIDs))
	for idx, subnetID := range workloadIDs {
		subnet, ok := byID[subnetID]
		if !ok {
			continue
		}
		workloads = append(workloads, VPCShardSubnetSpec{
			Name:    firstNonEmpty(strings.TrimSpace(subnet.Name), fmt.Sprintf("workload-%d", idx+1)),
			CIDR:    subnet.CIDR,
			Zone:    subnet.Zone,
			Role:    core.VPCShardSubnetRoleWorkload,
			Ordinal: idx + 1,
		})
	}
	if len(workloads) == 0 {
		return VPCShardBlueprintExport{}, errors.New("no workload subnets selected for blueprint export")
	}
	natGateways, err := p.describeNatGateways(ctx, region, sourceVpcID)
	if err != nil {
		return VPCShardBlueprintExport{}, err
	}
	subnetTargets := map[string]string{
		support.ID: "support",
	}
	for idx, subnetID := range workloadIDs {
		if strings.TrimSpace(subnetID) == "" {
			continue
		}
		subnetTargets[subnetID] = fmt.Sprintf("workload:%d", idx+1)
	}
	natShape, natNamesByID := buildExportNATShape(natGateways, subnetTargets)
	routeTables, err := p.describeRouteTables(ctx, region, sourceVpcID)
	if err != nil {
		return VPCShardBlueprintExport{}, err
	}
	routeShape, err := buildExportRouteShape(routeTables, natNamesByID, subnetTargets)
	if err != nil {
		return VPCShardBlueprintExport{}, err
	}
	return VPCShardBlueprintExport{
		SchemaVersion:     "v1alpha1",
		SourceRegion:      region,
		NetworkTemplateID: deriveExportedNetworkTemplateID(vpcCIDR, support, workloads),
		VPCCIDR:           vpcCIDR,
		SupportSubnet: VPCShardSubnetSpec{
			Name:    firstNonEmpty(strings.TrimSpace(support.Name), "support"),
			CIDR:    support.CIDR,
			Zone:    support.Zone,
			Role:    core.VPCShardSubnetRoleSupport,
			Ordinal: 0,
		},
		WorkloadSubnets: workloads,
		NATShape:        natShape,
		RouteShape:      routeShape,
	}, nil
}

func deriveExportedNetworkTemplateID(vpcCIDR string, support describedSubnet, workloads []VPCShardSubnetSpec) string {
	value := strings.TrimSpace(vpcCIDR) + "|" + strings.TrimSpace(support.CIDR) + "|" + strings.TrimSpace(support.Zone)
	for _, subnet := range workloads {
		value += "|" + strings.TrimSpace(subnet.CIDR) + "|" + strings.TrimSpace(subnet.Zone)
	}
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "/", "-")
	value = strings.ReplaceAll(value, ":", "-")
	value = strings.ReplaceAll(value, ".", "-")
	value = strings.ReplaceAll(value, "|", "-")
	return "exported-" + shortID(value)
}

type describedSubnet struct {
	ID   string
	Name string
	CIDR string
	Zone string
}

type describedNatGateway struct {
	ID       string
	Name     string
	Zone     string
	SubnetID string
}

type describedRouteTable struct {
	ID           string
	Name         string
	Main         bool
	Associations []describedRouteAssociation
	Routes       []describedRoute
}

type describedRouteAssociation struct {
	SubnetID string
}

type describedRoute struct {
	Destination     string
	DestinationIPv6 string
	GatewayType     string
	GatewayID       string
	Enabled         bool
}

func (p *TencentCloudProvider) describeVPC(ctx context.Context, region, vpcID string) (string, string, error) {
	req := tchttp.NewCommonRequest("vpc", "2017-03-12", "DescribeVpcs")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"VpcIds": []string{vpcID},
	}); err != nil {
		return "", "", err
	}
	resp := tchttp.NewCommonResponse()
	if err := retryRateLimit(ctx, "VPC.DescribeVpcs", func() error {
		return p.newVPCCommonClient(region).Send(req, resp)
	}); err != nil {
		return "", "", err
	}
	var payload struct {
		Response struct {
			VpcSet []struct {
				VpcName   string `json:"VpcName"`
				CidrBlock string `json:"CidrBlock"`
			} `json:"VpcSet"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return "", "", err
	}
	if len(payload.Response.VpcSet) == 0 {
		return "", "", fmt.Errorf("vpc %s not found", vpcID)
	}
	return strings.TrimSpace(payload.Response.VpcSet[0].VpcName), strings.TrimSpace(payload.Response.VpcSet[0].CidrBlock), nil
}

func (p *TencentCloudProvider) describeSubnets(ctx context.Context, region, vpcID string) ([]describedSubnet, error) {
	req := tchttp.NewCommonRequest("vpc", "2017-03-12", "DescribeSubnets")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"Filters": []map[string]interface{}{
			{"Name": "vpc-id", "Values": []string{vpcID}},
		},
		"Limit": 100,
	}); err != nil {
		return nil, err
	}
	resp := tchttp.NewCommonResponse()
	if err := retryRateLimit(ctx, "VPC.DescribeSubnets", func() error {
		return p.newVPCCommonClient(region).Send(req, resp)
	}); err != nil {
		return nil, err
	}
	var payload struct {
		Response struct {
			SubnetSet []struct {
				SubnetID         string `json:"SubnetId"`
				SubnetName       string `json:"SubnetName"`
				CidrBlock        string `json:"CidrBlock"`
				Zone             string `json:"Zone"`
				AvailabilityZone string `json:"AvailabilityZone"`
			} `json:"SubnetSet"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return nil, err
	}
	items := make([]describedSubnet, 0, len(payload.Response.SubnetSet))
	for _, subnet := range payload.Response.SubnetSet {
		items = append(items, describedSubnet{
			ID:   strings.TrimSpace(subnet.SubnetID),
			Name: strings.TrimSpace(subnet.SubnetName),
			CIDR: strings.TrimSpace(subnet.CidrBlock),
			Zone: firstNonEmpty(strings.TrimSpace(subnet.Zone), strings.TrimSpace(subnet.AvailabilityZone)),
		})
	}
	return items, nil
}

func (p *TencentCloudProvider) describeNatGateways(ctx context.Context, region, vpcID string) ([]describedNatGateway, error) {
	req := tchttp.NewCommonRequest("vpc", "2017-03-12", "DescribeNatGateways")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"Filters": []map[string]interface{}{
			{"Name": "vpc-id", "Values": []string{vpcID}},
		},
		"Limit": 100,
	}); err != nil {
		return nil, err
	}
	resp := tchttp.NewCommonResponse()
	if err := retryRateLimit(ctx, "VPC.DescribeNatGateways", func() error {
		return p.newVPCCommonClient(region).Send(req, resp)
	}); err != nil {
		return nil, err
	}
	var payload struct {
		Response struct {
			NatGatewaySet []struct {
				NatGatewayID   string `json:"NatGatewayId"`
				NatGatewayName string `json:"NatGatewayName"`
				Zone           string `json:"Zone"`
				SubnetID       string `json:"SubnetId"`
			} `json:"NatGatewaySet"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return nil, err
	}
	items := make([]describedNatGateway, 0, len(payload.Response.NatGatewaySet))
	for idx, gateway := range payload.Response.NatGatewaySet {
		items = append(items, describedNatGateway{
			ID:       strings.TrimSpace(gateway.NatGatewayID),
			Name:     firstNonEmpty(strings.TrimSpace(gateway.NatGatewayName), fmt.Sprintf("nat-%d", idx+1)),
			Zone:     strings.TrimSpace(gateway.Zone),
			SubnetID: strings.TrimSpace(gateway.SubnetID),
		})
	}
	return items, nil
}

func (p *TencentCloudProvider) describeRouteTables(ctx context.Context, region, vpcID string) ([]describedRouteTable, error) {
	req := tchttp.NewCommonRequest("vpc", "2017-03-12", "DescribeRouteTables")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"Filters": []map[string]interface{}{
			{"Name": "vpc-id", "Values": []string{vpcID}},
		},
		"Limit":          100,
		"NeedRouterInfo": true,
	}); err != nil {
		return nil, err
	}
	resp := tchttp.NewCommonResponse()
	if err := retryRateLimit(ctx, "VPC.DescribeRouteTables", func() error {
		return p.newVPCCommonClient(region).Send(req, resp)
	}); err != nil {
		return nil, err
	}
	var payload struct {
		Response struct {
			RouteTableSet []struct {
				RouteTableID   string `json:"RouteTableId"`
				RouteTableName string `json:"RouteTableName"`
				Main           bool   `json:"Main"`
				AssociationSet []struct {
					SubnetID string `json:"SubnetId"`
				} `json:"AssociationSet"`
				RouteSet []struct {
					DestinationCidrBlock     string `json:"DestinationCidrBlock"`
					DestinationIpv6CidrBlock string `json:"DestinationIpv6CidrBlock"`
					GatewayType              string `json:"GatewayType"`
					GatewayID                string `json:"GatewayId"`
					Enabled                  bool   `json:"Enabled"`
				} `json:"RouteSet"`
			} `json:"RouteTableSet"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return nil, err
	}
	items := make([]describedRouteTable, 0, len(payload.Response.RouteTableSet))
	for idx, table := range payload.Response.RouteTableSet {
		item := describedRouteTable{
			ID:   strings.TrimSpace(table.RouteTableID),
			Name: firstNonEmpty(strings.TrimSpace(table.RouteTableName), fmt.Sprintf("route-table-%d", idx+1)),
			Main: table.Main,
		}
		for _, assoc := range table.AssociationSet {
			item.Associations = append(item.Associations, describedRouteAssociation{SubnetID: strings.TrimSpace(assoc.SubnetID)})
		}
		for _, route := range table.RouteSet {
			item.Routes = append(item.Routes, describedRoute{
				Destination:     strings.TrimSpace(route.DestinationCidrBlock),
				DestinationIPv6: strings.TrimSpace(route.DestinationIpv6CidrBlock),
				GatewayType:     strings.TrimSpace(route.GatewayType),
				GatewayID:       strings.TrimSpace(route.GatewayID),
				Enabled:         route.Enabled,
			})
		}
		items = append(items, item)
	}
	return items, nil
}

func buildExportNATShape(gateways []describedNatGateway, subnetTargets map[string]string) (blueprint.StaticNATShape, map[string]string) {
	namesByID := make(map[string]string, len(gateways))
	items := make([]blueprint.StaticNATGateway, 0, len(gateways))
	mode := "none"
	switch len(gateways) {
	case 0:
		mode = "none"
	case 1:
		mode = "single"
	default:
		mode = "multi"
	}
	for idx, gateway := range gateways {
		name := firstNonEmpty(strings.TrimSpace(gateway.Name), fmt.Sprintf("nat-%d", idx+1))
		namesByID[gateway.ID] = name
		items = append(items, blueprint.StaticNATGateway{
			Name:   name,
			Zone:   strings.TrimSpace(gateway.Zone),
			Subnet: strings.TrimSpace(subnetTargets[gateway.SubnetID]),
		})
	}
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].Name < items[j].Name
	})
	return blueprint.StaticNATShape{
		Mode:     mode,
		Gateways: items,
	}, namesByID
}

func buildExportRouteShape(routeTables []describedRouteTable, natNamesByID map[string]string, subnetTargets map[string]string) (blueprint.StaticRouteShape, error) {
	explicitTargets := map[string]struct{}{}
	items := make([]blueprint.StaticRouteTable, 0, len(routeTables))
	mainTableIndex := -1
	for idx, table := range routeTables {
		item := blueprint.StaticRouteTable{
			Name: table.Name,
			Main: table.Main,
		}
		if table.Main && mainTableIndex == -1 {
			mainTableIndex = idx
		}
		for _, assoc := range table.Associations {
			target := strings.TrimSpace(subnetTargets[assoc.SubnetID])
			if target == "" {
				continue
			}
			explicitTargets[target] = struct{}{}
			item.Associations = append(item.Associations, blueprint.StaticRouteAssociation{Target: target})
		}
		for _, route := range table.Routes {
			destination := firstNonEmpty(strings.TrimSpace(route.Destination), strings.TrimSpace(route.DestinationIPv6))
			if destination == "" {
				continue
			}
			nextHopType := strings.ToUpper(strings.TrimSpace(route.GatewayType))
			nextHopRef, err := deIDedNextHopRef(nextHopType, route.GatewayID, natNamesByID)
			if err != nil {
				return blueprint.StaticRouteShape{}, fmt.Errorf("route table %s: %w", table.Name, err)
			}
			item.Routes = append(item.Routes, blueprint.StaticRoute{
				Destination: destination,
				NextHopType: nextHopType,
				NextHopRef:  nextHopRef,
				Enabled:     route.Enabled,
			})
		}
		if len(item.Routes) > 0 || len(item.Associations) > 0 || table.Main {
			items = append(items, item)
		}
	}
	if mainTableIndex >= 0 {
		for _, target := range subnetTargets {
			if target == "" {
				continue
			}
			if _, ok := explicitTargets[target]; ok {
				continue
			}
			for idx := range items {
				if items[idx].Main {
					items[idx].Associations = append(items[idx].Associations, blueprint.StaticRouteAssociation{Target: target})
					break
				}
			}
		}
	}
	if len(items) == 0 {
		return blueprint.StaticRouteShape{}, errors.New("no route-table semantics exported")
	}
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].Name < items[j].Name
	})
	return blueprint.StaticRouteShape{RouteTables: items}, nil
}

func deIDedNextHopRef(nextHopType, gatewayID string, natNamesByID map[string]string) (string, error) {
	switch strings.ToUpper(strings.TrimSpace(nextHopType)) {
	case "LOCAL":
		return "local", nil
	case "NAT":
		name := strings.TrimSpace(natNamesByID[strings.TrimSpace(gatewayID)])
		if name == "" {
			return "", fmt.Errorf("nat next hop %q missing de-IDed mapping", gatewayID)
		}
		return name, nil
	default:
		return "", fmt.Errorf("unsupported de-IDed next hop type %q", nextHopType)
	}
}

func exportedBlueprintSubnetIDsFromEnv() (support string, workloads []string) {
	support = firstNonEmpty(
		strings.TrimSpace(os.Getenv("SANDBOX_SUPPORT_SUBNET_ID")),
		strings.TrimSpace(os.Getenv("NETWORK_SUPPORT_SUBNET_ID")),
	)
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" || value == support {
			return
		}
		for _, existing := range workloads {
			if existing == value {
				return
			}
		}
		workloads = append(workloads, value)
	}
	for _, key := range []string{
		"SANDBOX_POOL_C0_SUBNET_ID",
		"SANDBOX_POOL_C1_SUBNET_ID",
		"SANDBOX_POOL_C2_SUBNET_ID",
		"SANDBOX_POOL_C3_SUBNET_ID",
		"SANDBOX_POOL_C4_SUBNET_ID",
		"SANDBOX_POOL_C5_SUBNET_ID",
		"NETWORK_SUBNET_POOL_A_ID",
		"NETWORK_SUBNET_POOL_B_ID",
		"NETWORK_SUBNET_POOL_C_ID",
		"NETWORK_SUBNET_POOL_D_ID",
		"NETWORK_SUBNET_POOL_E_ID",
		"NETWORK_SUBNET_POOL_F_ID",
	} {
		add(os.Getenv(key))
	}
	return support, workloads
}

// WaitForInstanceHealthDown best-effort waits until /health is NOT healthy at least once.
// This helps avoid marking CLEAN immediately after requesting reinstall while the old system is still serving /health.
func (p *TencentCloudProvider) WaitForInstanceHealthDown(ctx context.Context, address string) error {
	verifyURL, hostOverride, err := p.buildHealthTarget(address)
	if err != nil {
		return err
	}
	if err := waitHealth(ctx, verifyURL, hostOverride, false, downTotalTimeout, downPerReqTimeout, waitDownProbeInterval, healthLogEvery); err != nil {
		return err
	}
	return nil
}

// HupEnvd sends SIGHUP to envd inside the instance.
// Best-effort: this is used to reduce false-positive health checks during reset.
func (p *TencentCloudProvider) HupEnvd(ctx context.Context, address string) error {
	if address == "" {
		return errors.New("missing address for envd hup")
	}
	url, host, err := p.buildEnvdProcessTarget(address)
	if err != nil {
		return err
	}

	var body envdProcessStartRequest
	body.Process.Cmd = "/bin/bash"
	body.Process.Args = []string{"-l", "-c", "pkill -1 envd || true"}
	b, _ := json.Marshal(body)

	// Keep it short; we only need the request to reach envd.
	reqCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url, strings.NewReader(string(b)))
	if err != nil {
		return err
	}
	req.Host = host
	req.Header.Set("Content-Type", "application/connect+json")
	req.Header.Set("Accept", "application/connect+json")
	req.Header.Set("Connect-Protocol-Version", "1")
	// Match sandboxcli auth convention: Basic base64("root:")
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("root:")))

	client := &http.Client{
		Timeout: 2 * time.Second,
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 2 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ForceAttemptHTTP2:     false,
			MaxIdleConns:          10,
			IdleConnTimeout:       30 * time.Second,
			TLSHandshakeTimeout:   2 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		// envd might die quickly; treat errors as non-fatal signal failure.
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("hup envd failed status=%d body=%q", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}

func (p *TencentCloudProvider) RunCommand(ctx context.Context, region, instanceID, script string) (CommandInvocation, error) {
	region = p.resolveRegion(region)
	if strings.TrimSpace(instanceID) == "" {
		return CommandInvocation{}, errors.New("missing instance id for tat command")
	}
	script = strings.TrimSpace(script)
	if script == "" {
		return CommandInvocation{}, errors.New("missing bash script")
	}

	req := tchttp.NewCommonRequest(tatService, tatVersion, "RunCommand")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"CommandName":      fmt.Sprintf("sandbox-%s", shortID(instanceID)),
		"CommandType":      "SHELL",
		"Content":          base64.StdEncoding.EncodeToString([]byte(script)),
		"InstanceIds":      []string{instanceID},
		"WorkingDirectory": "/root",
		"Username":         "root",
		"Timeout":          60,
		"SaveCommand":      false,
	}); err != nil {
		return CommandInvocation{}, err
	}

	resp := tchttp.NewCommonResponse()
	client := p.newCommonClient(region, p.cfg.TATEndpoint)
	if err := retryRateLimit(ctx, "TAT.RunCommand", func() error {
		return client.Send(req, resp)
	}); err != nil {
		return CommandInvocation{}, err
	}

	var payload struct {
		Response struct {
			CommandID    string `json:"CommandId"`
			InvocationID string `json:"InvocationId"`
			RequestID    string `json:"RequestId"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return CommandInvocation{}, err
	}
	if payload.Response.InvocationID == "" {
		return CommandInvocation{}, errors.New("tat RunCommand returned empty invocation id")
	}
	return CommandInvocation{
		CommandID:    payload.Response.CommandID,
		InvocationID: payload.Response.InvocationID,
		InstanceID:   instanceID,
		Region:       region,
		Status:       defaultInvocationStatus,
	}, nil
}

func (p *TencentCloudProvider) StartTerminalSession(ctx context.Context, region, instanceID string) (TerminalSession, error) {
	region = p.resolveRegion(region)
	instanceID = strings.TrimSpace(instanceID)
	if instanceID == "" {
		return TerminalSession{}, errors.New("missing instance id for tat session")
	}

	accountInfo, err := p.getAccountInfo(ctx)
	if err != nil {
		return TerminalSession{}, err
	}

	req := tchttp.NewCommonRequest(tatService, tatVersion, "StartSession")
	req.SetContext(ctx)
	if err := req.SetActionParameters(startTerminalSessionParameters(instanceID)); err != nil {
		return TerminalSession{}, err
	}

	resp := tchttp.NewCommonResponse()
	client := p.newCommonClient(region, p.cfg.TATEndpoint)
	if err := retryRateLimit(ctx, "TAT.StartSession", func() error {
		return client.Send(req, resp)
	}); err != nil {
		return TerminalSession{}, err
	}

	var payload struct {
		Response struct {
			SessionID string `json:"SessionId"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return TerminalSession{}, err
	}
	if strings.TrimSpace(payload.Response.SessionID) == "" {
		return TerminalSession{}, errors.New("tat StartSession returned empty session id")
	}

	return TerminalSession{
		SessionID:      payload.Response.SessionID,
		Region:         region,
		InstanceID:     instanceID,
		OwnerUin:       accountInfo.OwnerUin,
		LoginUin:       accountInfo.LoginUin,
		AppID:          accountInfo.AppID,
		WsURL:          fmt.Sprintf("wss://%s.forward.tat-tc.tencent.cn/ws", region),
		Cols:           defaultTerminalCols,
		Rows:           defaultTerminalRows,
		TimeoutSeconds: p.cfg.TerminalTimeoutSeconds,
		Username:       defaultTerminalUsername,
		WorkingDir:     defaultTerminalWorkingDirectory,
	}, nil
}

func startTerminalSessionParameters(instanceID string) map[string]interface{} {
	return map[string]interface{}{
		"InstanceId": instanceID,
	}
}

func (p *TencentCloudProvider) GetCommandInvocation(ctx context.Context, region, invocationID, instanceID string) (CommandResult, error) {
	region = p.resolveRegion(region)
	if strings.TrimSpace(invocationID) == "" {
		return CommandResult{}, errors.New("missing invocation id")
	}
	if strings.TrimSpace(instanceID) == "" {
		return CommandResult{}, errors.New("missing instance id")
	}

	req := tchttp.NewCommonRequest(tatService, tatVersion, "DescribeInvocationTasks")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"HideOutput": false,
		"Filters": []map[string]interface{}{
			{"Name": "invocation-id", "Values": []string{invocationID}},
			{"Name": "instance-id", "Values": []string{instanceID}},
		},
		"Limit": 1,
	}); err != nil {
		return CommandResult{}, err
	}

	resp := tchttp.NewCommonResponse()
	client := p.newCommonClient(region, p.cfg.TATEndpoint)
	if err := retryRateLimit(ctx, "TAT.DescribeInvocationTasks", func() error {
		return client.Send(req, resp)
	}); err != nil {
		return CommandResult{}, err
	}

	var payload struct {
		Response struct {
			InvocationTaskSet []struct {
				CommandID    string `json:"CommandId"`
				InvocationID string `json:"InvocationId"`
				TaskStatus   string `json:"TaskStatus"`
				InstanceID   string `json:"InstanceId"`
				StartTime    string `json:"StartTime"`
				EndTime      string `json:"EndTime"`
				ErrorInfo    string `json:"ErrorInfo"`
				TaskResult   struct {
					ExitCode      int64  `json:"ExitCode"`
					Output        string `json:"Output"`
					OutputURL     string `json:"OutputUrl"`
					Dropped       int64  `json:"Dropped"`
					ExecutionTime string `json:"ExecutionTime"`
				} `json:"TaskResult"`
			} `json:"InvocationTaskSet"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return CommandResult{}, err
	}
	if len(payload.Response.InvocationTaskSet) == 0 {
		return CommandResult{}, ErrInvocationNotFound
	}
	task := payload.Response.InvocationTaskSet[0]
	output := decodeMaybeBase64(task.TaskResult.Output)
	return CommandResult{
		CommandInvocation: CommandInvocation{
			CommandID:    task.CommandID,
			InvocationID: task.InvocationID,
			InstanceID:   task.InstanceID,
			Region:       region,
			Status:       task.TaskStatus,
		},
		ExitCode:      task.TaskResult.ExitCode,
		Output:        output,
		ErrorInfo:     task.ErrorInfo,
		OutputURL:     task.TaskResult.OutputURL,
		Dropped:       task.TaskResult.Dropped,
		StartTime:     task.StartTime,
		EndTime:       task.EndTime,
		ExecutionTime: task.TaskResult.ExecutionTime,
	}, nil
}

const defaultInvocationStatus = "PENDING"

func (p *TencentCloudProvider) resolveRegion(region string) string {
	if strings.TrimSpace(region) != "" {
		return strings.TrimSpace(region)
	}
	return strings.TrimSpace(p.cfg.Region)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func convertVPCShardSubnetPlans(specs []VPCShardSubnetSpec) []tencentbundle.VPCShardSubnetPlan {
	items := make([]tencentbundle.VPCShardSubnetPlan, 0, len(specs))
	for _, spec := range specs {
		items = append(items, tencentbundle.VPCShardSubnetPlan{
			Name:    spec.Name,
			CIDR:    spec.CIDR,
			Zone:    spec.Zone,
			Role:    spec.Role,
			Ordinal: spec.Ordinal,
		})
	}
	return items
}

func (p *TencentCloudProvider) deleteSecurityGroup(ctx context.Context, region, securityGroupID string) error {
	return tencentbundle.DeleteSecurityGroup(ctx, func(region string) tencentbundle.CommonSender {
		return p.newVPCCommonClient(region)
	}, retryRateLimit, region, securityGroupID)
}

func (p *TencentCloudProvider) DeleteSecurityGroup(ctx context.Context, region, securityGroupID string) error {
	return p.deleteSecurityGroup(ctx, region, securityGroupID)
}

func (p *TencentCloudProvider) ListManagedPendingSecurityGroupShards(ctx context.Context, region string) ([]ManagedSecurityGroupShard, error) {
	region = p.resolveRegion(region)
	items, err := tencentbundle.DescribeManagedPendingSecurityGroupShards(ctx, func(region string) tencentbundle.CommonSender {
		return p.newVPCCommonClient(region)
	}, retryRateLimit, region)
	if err != nil {
		return nil, err
	}
	result := make([]ManagedSecurityGroupShard, 0, len(items))
	for _, item := range items {
		result = append(result, ManagedSecurityGroupShard{
			ID:                    item.ID,
			Region:                item.Region,
			Description:           item.Description,
			SourceSecurityGroupID: item.SourceSecurityGroupID,
			TemplateClassID:       item.TemplateClassID,
			State:                 item.State,
			CreatedAt:             item.CreatedAt,
		})
	}
	return result, nil
}

func (p *TencentCloudProvider) newVPCCommonClient(region string) *common.Client {
	httpProfile := profile.NewHttpProfile()
	if strings.TrimSpace(p.cfg.VPCEndpoint) != "" {
		httpProfile.Endpoint = strings.TrimSpace(p.cfg.VPCEndpoint)
	} else {
		httpProfile.Endpoint = "vpc.tencentcloudapi.com"
	}
	clientProfile := profile.NewClientProfile()
	clientProfile.HttpProfile = httpProfile
	return common.NewCommonClient(p.cred, region, clientProfile)
}

func (p *TencentCloudProvider) newCommonClient(region, endpoint string) *common.Client {
	httpProfile := profile.NewHttpProfile()
	if strings.TrimSpace(endpoint) != "" {
		httpProfile.Endpoint = strings.TrimSpace(endpoint)
	} else {
		httpProfile.Endpoint = "tat.tencentcloudapi.com"
	}
	clientProfile := profile.NewClientProfile()
	clientProfile.HttpProfile = httpProfile
	return common.NewCommonClient(p.cred, region, clientProfile)
}

type tencentAccountInfo struct {
	OwnerUin string
	LoginUin string
	AppID    int64
}

func (p *TencentCloudProvider) getAccountInfo(ctx context.Context) (tencentAccountInfo, error) {
	req := tchttp.NewCommonRequest(accountService, accountVersion, "DescribeAccountInfo")
	req.SetContext(ctx)

	resp := tchttp.NewCommonResponse()
	client := p.newCommonClient(accountRegion, accountEndpoint)
	if err := retryRateLimit(ctx, "Account.DescribeAccountInfo", func() error {
		return client.Send(req, resp)
	}); err != nil {
		return tencentAccountInfo{}, err
	}

	var payload struct {
		Response struct {
			OwnerUin int64 `json:"OwnerUin"`
			LoginUin int64 `json:"LoginUin"`
			AppID    int64 `json:"AppId"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return tencentAccountInfo{}, err
	}

	return tencentAccountInfo{
		OwnerUin: strconv.FormatInt(payload.Response.OwnerUin, 10),
		LoginUin: strconv.FormatInt(payload.Response.LoginUin, 10),
		AppID:    payload.Response.AppID,
	}, nil
}

func decodeMaybeBase64(v string) string {
	if strings.TrimSpace(v) == "" {
		return ""
	}
	decoded, err := base64.StdEncoding.DecodeString(v)
	if err != nil {
		return v
	}
	return string(decoded)
}

func shortID(v string) string {
	if len(v) <= 12 {
		return v
	}
	return v[:12]
}
