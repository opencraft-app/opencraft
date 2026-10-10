package tencentim

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"
	"unicode/utf8"

	tencentimport "chatserver/internal/ports/tencentim"
)

const (
	accountImportPath = "/v4/im_open_login_svc/account_import"
	accountKickPath   = "/v4/im_open_login_svc/kick"
	accountDeletePath = "/v4/im_open_login_svc/account_delete"
	maxResponseBytes  = 1 << 20
)

type restEnvelope struct {
	ActionStatus string `json:"ActionStatus"`
	ErrorCode    int    `json:"ErrorCode"`
	ErrorInfo    string `json:"ErrorInfo"`
}

// RESTConfig 配置腾讯云 IM 服务端 REST API。
type RESTConfig struct {
	SDKAppID        int
	AdminUserID     string
	BaseURL         string
	HTTPClient      *http.Client
	Random          io.Reader
	AdminSignatures tencentimport.UserSigIssuer
	AdminSigTTL     time.Duration
}

// RESTIdentityProvisioner 通过 account_import 幂等导入普通 IM 账号。
type RESTIdentityProvisioner struct {
	config RESTConfig
	base   *url.URL
}

// NewRESTIdentityProvisioner 创建账号导入适配器。
func NewRESTIdentityProvisioner(
	config RESTConfig,
) (*RESTIdentityProvisioner, error) {
	base, err := validateRESTConfig(config)
	if err != nil {
		return nil, err
	}
	config.HTTPClient = redirectSafeHTTPClient(config.HTTPClient)
	return &RESTIdentityProvisioner{config: config, base: base}, nil
}

// EnsureIdentity 幂等导入一个普通 Human 或 Agent 账号。
func (client *RESTIdentityProvisioner) EnsureIdentity(
	ctx context.Context,
	identity tencentimport.Identity,
) error {
	if client == nil || ctx == nil ||
		!imUserIDPattern.MatchString(identity.UserID) ||
		utf8.RuneCountInString(identity.Nick) > 100 ||
		len(identity.Nick) > 500 {
		return newRESTError("tencent_invalid_identity", false)
	}
	body := struct {
		UserID string `json:"UserID"`
		Nick   string `json:"Nick,omitempty"`
	}{
		UserID: identity.UserID,
		Nick:   identity.Nick,
	}
	var result restEnvelope
	if err := client.post(ctx, accountImportPath, body, &result); err != nil {
		return err
	}
	if result.ActionStatus == "OK" && result.ErrorCode == 0 {
		return nil
	}
	return newRESTError(
		"tencent_"+strconv.Itoa(result.ErrorCode),
		retryableTencentCode(result.ErrorCode),
	)
}

// KickIdentity 使目标账号所有历史 UserSig 和当前登录状态失效。
func (client *RESTIdentityProvisioner) KickIdentity(
	ctx context.Context,
	userID string,
) error {
	if client == nil || ctx == nil || !imUserIDPattern.MatchString(userID) {
		return newRESTError("tencent_invalid_identity", false)
	}
	body := struct {
		UserID string `json:"UserID"`
	}{UserID: userID}
	var result restEnvelope
	if err := client.post(ctx, accountKickPath, body, &result); err != nil {
		return err
	}
	if result.ActionStatus == "OK" && result.ErrorCode == 0 ||
		result.ErrorCode == 70107 {
		return nil
	}
	return newRESTError(
		"tencent_"+strconv.Itoa(result.ErrorCode),
		retryableTencentCode(result.ErrorCode),
	)
}

// DeleteIdentity 永久删除一个普通 IM 账号，并检查单账号 ResultItem。
func (client *RESTIdentityProvisioner) DeleteIdentity(
	ctx context.Context,
	userID string,
) error {
	if client == nil || ctx == nil || !imUserIDPattern.MatchString(userID) {
		return newRESTError("tencent_invalid_identity", false)
	}
	body := struct {
		DeleteItem []struct {
			UserID string `json:"UserID"`
		} `json:"DeleteItem"`
	}{
		DeleteItem: []struct {
			UserID string `json:"UserID"`
		}{{UserID: userID}},
	}
	var result struct {
		restEnvelope
		ResultItem []struct {
			UserID     string `json:"UserID"`
			ResultCode int    `json:"ResultCode"`
			ResultInfo string `json:"ResultInfo"`
		} `json:"ResultItem"`
	}
	if err := client.post(ctx, accountDeletePath, body, &result); err != nil {
		return err
	}
	if result.ErrorCode != 0 || result.ActionStatus != "OK" {
		if result.ErrorCode == 70107 {
			return nil
		}
		return newRESTError(
			"tencent_"+strconv.Itoa(result.ErrorCode),
			retryableTencentCode(result.ErrorCode),
		)
	}
	if len(result.ResultItem) != 1 || result.ResultItem[0].UserID != userID {
		return newRESTError("tencent_response_invalid", true)
	}
	code := result.ResultItem[0].ResultCode
	if code == 0 || code == 70107 {
		return nil
	}
	return newRESTError(
		"tencent_"+strconv.Itoa(code),
		retryableTencentCode(code),
	)
}

func (client *RESTIdentityProvisioner) post(
	ctx context.Context,
	path string,
	body any,
	result any,
) error {
	adminSig, err := client.config.AdminSignatures.Issue(
		ctx,
		client.config.AdminUserID,
		client.config.AdminSigTTL,
	)
	if err != nil {
		return newRESTError("tencent_admin_signature_failed", false)
	}
	randomBytes := make([]byte, 4)
	if _, err := io.ReadFull(client.config.Random, randomBytes); err != nil {
		return newRESTError("tencent_random_failed", false)
	}
	endpoint := *client.base
	endpoint.Path += path
	query := endpoint.Query()
	query.Set("sdkappid", strconv.Itoa(client.config.SDKAppID))
	query.Set("identifier", client.config.AdminUserID)
	query.Set("usersig", adminSig.Value)
	query.Set(
		"random",
		strconv.FormatUint(
			uint64(binary.BigEndian.Uint32(randomBytes)),
			10,
		),
	)
	query.Set("contenttype", "json")
	endpoint.RawQuery = query.Encode()
	var encoded bytes.Buffer
	if err := json.NewEncoder(&encoded).Encode(body); err != nil {
		return newRESTError("tencent_request_encode_failed", false)
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint.String(),
		&encoded,
	)
	if err != nil {
		return newRESTError("tencent_request_invalid", false)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := client.config.HTTPClient.Do(request)
	if err != nil {
		return newRESTError("tencent_network_error", true)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		retryable := response.StatusCode == http.StatusTooManyRequests ||
			response.StatusCode >= 500
		return newRESTError(
			"tencent_http_"+strconv.Itoa(response.StatusCode),
			retryable,
		)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxResponseBytes))
	if err := decoder.Decode(result); err != nil {
		return newRESTError("tencent_response_invalid", true)
	}
	return nil
}

func secureRESTScheme(endpoint *url.URL) bool {
	if endpoint.Scheme == "https" {
		return true
	}
	if endpoint.Scheme != "http" {
		return false
	}
	host := endpoint.Hostname()
	ip := net.ParseIP(host)
	return host == "localhost" || ip != nil && ip.IsLoopback()
}

func retryableTencentCode(code int) bool {
	switch code {
	case 30006, 30007, 30008, 40006, 70169, 70202, 70500:
		return true
	case 40601, 70398, 70399, 70402, 70403, 71000:
		return false
	default:
		return true
	}
}

type restError struct {
	code      string
	retryable bool
}

func newRESTError(code string, retryable bool) error {
	return &restError{code: code, retryable: retryable}
}

func (failure *restError) Error() string {
	return fmt.Sprintf("腾讯云 IM 操作失败（%s）", failure.code)
}

func (failure *restError) TencentCode() string {
	return failure.code
}

func (failure *restError) Retryable() bool {
	return failure.retryable
}

var (
	_ tencentimport.IdentityProvisioner   = (*RESTIdentityProvisioner)(nil)
	_ tencentimport.IdentityDeprovisioner = (*RESTIdentityProvisioner)(nil)
	_ error                               = (*restError)(nil)
)
