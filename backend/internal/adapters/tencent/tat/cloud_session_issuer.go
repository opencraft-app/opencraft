package tat

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	camsdk "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/cam/v20190116"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tcerr "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"

	tencenttatport "chatserver/internal/ports/tencenttat"
)

const (
	tatAPIVersion              = "2020-10-28"
	terminalBootstrapLifetime  = time.Minute
	terminalDefaultCols        = 120
	terminalDefaultRows        = 32
	terminalDefaultIdleSeconds = 3600
)

type cloudIdentity struct {
	OwnerUIN string
	AppID    int64
}

type cloudStartSession struct {
	SessionID string
	StreamURL string
}

type sessionCloud interface {
	Identity(context.Context) (cloudIdentity, error)
	StartSession(context.Context, string, string) (cloudStartSession, error)
}

// CloudSessionIssuer 直接向腾讯云签发一次性 Webshell 数据面引导信息。
// 平台不代理、不记录终端输入输出。
type CloudSessionIssuer struct {
	cloud sessionCloud
	now   func() time.Time

	identityMu sync.Mutex
	identity   cloudIdentity
}

func newCloudSessionIssuer(
	cloud sessionCloud,
	now func() time.Time,
) (*CloudSessionIssuer, error) {
	if cloud == nil || now == nil {
		return nil, errors.New("TAT PTY 云端签发器配置无效")
	}
	return &CloudSessionIssuer{cloud: cloud, now: now}, nil
}

// NewCredentialCloudSessionIssuer 使用后台受限 Secret 文件加载出的腾讯云凭据。
func NewCredentialCloudSessionIssuer(
	secretID string,
	secretKey string,
	timeout time.Duration,
) (*CloudSessionIssuer, error) {
	secretID = strings.TrimSpace(secretID)
	secretKey = strings.TrimSpace(secretKey)
	if timeout < time.Second || timeout > 5*time.Minute ||
		len(secretID) < 16 || len(secretKey) < 16 ||
		len(secretID) > 256 || len(secretKey) > 256 ||
		strings.ContainsAny(secretID, "\r\n\x00") ||
		strings.ContainsAny(secretKey, "\r\n\x00") {
		return nil, errors.New("TAT PTY 静态凭据配置无效")
	}
	return newCloudSessionIssuer(&sdkSessionCloud{
		provider: staticProvider{
			credential: common.NewCredential(secretID, secretKey),
		},
		timeout: timeout,
	}, time.Now)
}

// NewDefaultCloudSessionIssuer 使用环境变量或 CVM 实例角色凭据链。
func NewDefaultCloudSessionIssuer(timeout time.Duration) (*CloudSessionIssuer, error) {
	if timeout < time.Second || timeout > 5*time.Minute {
		return nil, errors.New("TAT PTY SDK 超时配置无效")
	}
	return newCloudSessionIssuer(&sdkSessionCloud{
		provider: common.NewProviderChain([]common.Provider{
			common.DefaultEnvProvider(),
			common.DefaultCvmRoleProvider(),
		}),
		timeout: timeout,
	}, time.Now)
}

// Issue 创建短期 bootstrap；每次调用都会生成新的 TAT Session。
func (issuer *CloudSessionIssuer) Issue(
	ctx context.Context,
	target tencenttatport.TerminalTarget,
) (tencenttatport.TerminalSession, error) {
	if issuer == nil || issuer.cloud == nil || issuer.now == nil || ctx == nil ||
		target.Validate() != nil {
		return tencenttatport.TerminalSession{},
			newError("terminal_invalid_request", false, false)
	}
	webSocketURL, validRegion := terminalForwardURL(target.Region)
	if !validRegion {
		return tencenttatport.TerminalSession{},
			newError("terminal_invalid_request", false, false)
	}
	identity, err := issuer.stableIdentity(ctx)
	if err != nil {
		return tencenttatport.TerminalSession{}, classifyTerminalCloudError(err)
	}
	started, err := issuer.cloud.StartSession(ctx, target.Region, target.InstanceID)
	if err != nil {
		return tencenttatport.TerminalSession{}, classifyTerminalCloudError(err)
	}
	if !validCloudIdentity(identity) ||
		strings.TrimSpace(started.SessionID) == "" {
		return tencenttatport.TerminalSession{},
			newError("terminal_response_invalid", false, false)
	}
	return tencenttatport.TerminalSession{
		SessionID:      strings.TrimSpace(started.SessionID),
		WebSocketURL:   webSocketURL,
		ExpiresAt:      issuer.now().UTC().Add(terminalBootstrapLifetime),
		OwnerUIN:       identity.OwnerUIN,
		AppID:          identity.AppID,
		InstanceID:     target.InstanceID,
		Cols:           terminalDefaultCols,
		Rows:           terminalDefaultRows,
		MaxIdleSeconds: terminalDefaultIdleSeconds,
	}, nil
}

func (issuer *CloudSessionIssuer) stableIdentity(
	ctx context.Context,
) (cloudIdentity, error) {
	issuer.identityMu.Lock()
	defer issuer.identityMu.Unlock()
	if validCloudIdentity(issuer.identity) {
		return issuer.identity, nil
	}
	identity, err := issuer.cloud.Identity(ctx)
	if err != nil {
		return cloudIdentity{}, err
	}
	if !validCloudIdentity(identity) {
		return cloudIdentity{}, newError("terminal_response_invalid", false, false)
	}
	identity.OwnerUIN = strings.TrimSpace(identity.OwnerUIN)
	issuer.identity = identity
	return identity, nil
}

func validCloudIdentity(identity cloudIdentity) bool {
	owner := strings.TrimSpace(identity.OwnerUIN)
	if owner == "" || identity.AppID <= 0 {
		return false
	}
	for _, character := range owner {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func terminalForwardURL(region string) (string, bool) {
	region = strings.TrimSpace(region)
	if len(region) < 3 || len(region) > 64 ||
		region[0] == '-' || region[len(region)-1] == '-' {
		return "", false
	}
	for _, character := range region {
		if character != '-' &&
			(character < 'a' || character > 'z') &&
			(character < '0' || character > '9') {
			return "", false
		}
	}
	return "wss://" + region + ".forward.tat-tc.tencent.cn/ws", true
}

func classifyTerminalCloudError(err error) error {
	var already interface {
		error
		TATCode() string
	}
	if errors.As(err, &already) && already.TATCode() == "terminal_response_invalid" {
		return err
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return newError("terminal_session_unavailable", true, false)
	}
	var sdkError *tcerr.TencentCloudSDKError
	if errors.As(err, &sdkError) {
		code := sdkError.GetCode()
		switch {
		case strings.Contains(code, "RequestLimitExceeded") ||
			strings.Contains(code, "LimitExceeded"):
			return newError("terminal_rate_limited", true, false)
		case strings.Contains(code, "AgentStatusNotOnline") ||
			strings.Contains(code, "AgentNotInstalled") ||
			strings.Contains(code, "InstanceStateNotRunning") ||
			strings.Contains(code, "AgentOffline"):
			return newError("terminal_target_offline", true, false)
		case strings.HasPrefix(code, "UnauthorizedOperation") ||
			strings.HasPrefix(code, "AuthFailure") ||
			strings.HasPrefix(code, "InvalidCredential"):
			return newError("terminal_session_rejected", false, false)
		case strings.HasPrefix(code, "ResourceNotFound"):
			return newError("terminal_target_not_found", false, false)
		case strings.HasPrefix(code, "InternalError") ||
			strings.HasPrefix(code, "FailedOperation") ||
			strings.HasPrefix(code, "ResourceUnavailable"):
			return newError("terminal_session_unavailable", true, false)
		default:
			return newError("terminal_session_unavailable", false, false)
		}
	}
	return newError("terminal_session_unavailable", true, false)
}

type sdkSessionCloud struct {
	provider common.Provider
	timeout  time.Duration
}

func (cloud *sdkSessionCloud) Identity(
	ctx context.Context,
) (cloudIdentity, error) {
	if cloud == nil || cloud.provider == nil || ctx == nil {
		return cloudIdentity{}, errors.New("腾讯云 CAM Session 配置无效")
	}
	credential, err := cloud.provider.GetCredential()
	if err != nil {
		return cloudIdentity{}, err
	}
	client, err := camsdk.NewClient(credential, "", cloud.clientProfile())
	if err != nil {
		return cloudIdentity{}, err
	}
	response, err := client.GetUserAppIdWithContext(
		ctx,
		camsdk.NewGetUserAppIdRequest(),
	)
	if err != nil {
		return cloudIdentity{}, err
	}
	if response == nil || response.Response == nil {
		return cloudIdentity{}, errors.New("腾讯云 CAM Session 响应无效")
	}
	return cloudIdentity{
		OwnerUIN: stringValue(response.Response.OwnerUin),
		AppID:    int64Value(response.Response.AppId),
	}, nil
}

func (cloud *sdkSessionCloud) StartSession(
	ctx context.Context,
	region string,
	instanceID string,
) (cloudStartSession, error) {
	var response struct {
		Response struct {
			SessionID string `json:"SessionId"`
			StreamURL string `json:"StreamUrl"`
		} `json:"Response"`
	}
	if err := cloud.send(
		ctx,
		"tat",
		region,
		tatAPIVersion,
		"StartSession",
		map[string]interface{}{"InstanceId": instanceID},
		&response,
	); err != nil {
		return cloudStartSession{}, err
	}
	return cloudStartSession{
		SessionID: response.Response.SessionID,
		StreamURL: response.Response.StreamURL,
	}, nil
}

func (cloud *sdkSessionCloud) send(
	ctx context.Context,
	service string,
	region string,
	version string,
	action string,
	parameters map[string]interface{},
	destination interface{},
) error {
	if cloud == nil || cloud.provider == nil || ctx == nil ||
		cloud.timeout < time.Second || cloud.timeout > 5*time.Minute {
		return errors.New("腾讯云 Session API 配置无效")
	}
	credential, err := cloud.provider.GetCredential()
	if err != nil {
		return err
	}
	client := common.NewCommonClient(credential, region, cloud.clientProfile())
	request := tchttp.NewCommonRequest(service, version, action)
	request.SetContext(ctx)
	if err := request.SetActionParameters(parameters); err != nil {
		return err
	}
	response := tchttp.NewCommonResponse()
	if err := client.Send(request, response); err != nil {
		return err
	}
	return json.Unmarshal(response.GetBody(), destination)
}

func (cloud *sdkSessionCloud) clientProfile() *profile.ClientProfile {
	clientProfile := profile.NewClientProfile()
	clientProfile.HttpProfile.ReqTimeout = int(cloud.timeout.Seconds())
	clientProfile.NetworkFailureMaxRetries = 0
	clientProfile.RateLimitExceededMaxRetries = 0
	clientProfile.UnsafeRetryOnConnectionFailure = false
	return clientProfile
}

func int64Value(pointer *uint64) int64 {
	if pointer == nil || *pointer > uint64(^uint64(0)>>1) {
		return 0
	}
	return int64(*pointer)
}

var _ tencenttatport.TerminalSessionIssuer = (*CloudSessionIssuer)(nil)
