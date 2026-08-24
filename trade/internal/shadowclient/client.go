// Package shadowclient 封装 trade → account-binding resolver 的内部反向调用。
//
// 设计稿对齐（trade-purchase-flow-design.md §3.5.5 / Q12 / Q30 / Q42）：
//   - jifei 协议层鉴权用的是 (uin, app_id) 这一对腾讯云"实体身份"
//   - lightclaw 业务层 user_id 是脱敏的 externalUserId
//   - lightclaw-auth shadowbinding 维护 externalUserId ↔ (uin, owner_uin, app_id) 的绑定关系
//
// trade 用法：
//   - 询价 (inquiry.Service.Quote) / 下单 (placeorder.Service.PlaceOrder) 在 ctl
//     入参未显式提供 uin / app_id 时，调本 client 反查 account binding 拿到这一对身份；
//   - ctl 在 8B-2 改造完成后会逐步迁移为 "只传 externalUserId"，trade 内部强制
//     用 shadowclient 反查（不再接受 ctl 端透传 uin/appId）。
//
// 协议层：
//   - 鉴权：Authorization: Bearer <internalServiceToken>
//     与 ctl ↔ ai-gateway 现有内部服务间 token 同源
//   - 反查端点：GET /internal/shadow/binding?external_user_id=<userID>
//     返回 {user_id, uin, owner_uin, app_id, ...}
//
// 注意：包名和 endpoint 保留 shadow 兼容命名，但服务端实现已经内化到 lightclaw-auth。
// trade 仅需调整 cfg.AccountBindingInternalBaseURL 即可切换后端，无需改 trade 调用代码。
package shadowclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	defaultBindingRequestTimeout    = 4 * time.Second
	defaultCredentialRequestTimeout = 20 * time.Second
)

// Client 是 account-binding 内部反向调用契约。
//
// 抽象成 interface 便于上层 service / handler 注入 mock 做单元测试，
// 也允许后续替换 HTTP → tRPC / connect-go 实现而不破坏调用方。
type Client interface {
	// GetBindingByExternalUserID 调 GET /internal/shadow/binding?external_user_id=xxx
	//
	// 返回 externalUserId → (uin / owner_uin / app_id) 绑定。
	// 没有绑定时返回 ErrBindingNotFound（不是 5xx）。
	GetBindingByExternalUserID(ctx context.Context, externalUserID string) (*Binding, error)
}

type BillingRecoveryClient interface {
	Client
	GetBindingStateByExternalUserID(ctx context.Context, externalUserID string) (*Binding, error)
	RetryBillingAccountByExternalUserID(ctx context.Context, externalUserID string) (*Binding, error)
}

// CredentialClient exchanges an external user binding for short-lived shadow
// account credentials. Keep this separate from Client so binding-only callers
// and their test fakes do not gain access to secrets.
type CredentialClient interface {
	GetTemporaryCredentialsByExternalUserID(ctx context.Context, externalUserID string) (*TemporaryCredentials, error)
}

// PaymentContextClient resolves both short-lived credentials and card binding
// state in one auth call for international create-order payment URLs.
type PaymentContextClient interface {
	GetPaymentContextByExternalUserID(ctx context.Context, externalUserID string) (*PaymentContext, error)
}

type ResolverClient interface {
	Client
	CredentialClient
	PaymentContextClient
}

type TemporaryCredentials struct {
	Uin       string
	OwnerUin  string
	SecretID  string
	SecretKey string
	Token     string
	ExpiredAt time.Time
}

type PaymentContext struct {
	Credentials      TemporaryCredentials
	HasPaymentMethod bool
}

// Binding 镜像 internal shadowbinding 反查响应。
//
// 字段语义：
//   - UserID：业务层 externalUserId（与请求入参一致，回显方便审计）
//   - Uin：jifei 协议层 ownerUin / uin（**string 形态**，与 trade 内部一致）
//   - OwnerUin：jifei 协议层 ownerUin（多数场景与 Uin 相同；预留分账场景）
//   - AppID：jifei 协议层 appId（string 形态）
//
// 注意：历史 shadow 内部 storage.Binding 的 Uin / OwnerUin / AppID 是 int64；
// trade 内部统一 string 形态（与 jifei goodsDetail map / trade_order 列对齐），
// 故本 client 在反序列化层做一次 int64 → string 转换。
type Binding struct {
	UserID           string `json:"user_id"`
	Uin              string `json:"uin"`
	OwnerUin         string `json:"owner_uin"`
	AppID            string `json:"app_id"`
	Status           string `json:"status,omitempty"`
	LastErrorCode    string `json:"last_error_code,omitempty"`
	LastErrorMessage string `json:"last_error_message,omitempty"`
}

// ErrBindingNotFound 在 resolver 返回 404（externalUserId 未绑定）时返回。
//
// trade 业务层应将其映射为"用户未绑定云账号，引导前往实名 / 绑定"流程，
// 不应作为 5xx 上报。
var ErrBindingNotFound = errors.New("shadowclient: binding not found")

var ErrBillingAccountOpenFailed = errors.New("shadowclient: billing account open failed")

// ErrUnauthorized 在 resolver 返回 401 时返回，通常意味着 internalServiceToken
// 与服务端配置不一致 — 属于配置错而非业务错。
var ErrUnauthorized = errors.New("shadowclient: unauthorized")

// Error 是 resolver HTTP 错误响应的强类型化封装，用于 4xx/5xx 排障。
type Error struct {
	HTTPStatus int    // 上游 HTTP status
	Code       string // shadow errcode（如 "BINDING_NOT_FOUND"）
	Message    string // 人类可读消息
	RequestID  string // shadow 侧 request_id，用于跨服务日志串联
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("shadow http %d code=%s message=%q request_id=%s",
		e.HTTPStatus, e.Code, e.Message, e.RequestID)
}

// envelope 反序列化 resolver 的标准响应框架（与 ctl 同款 {code, message, request_id, data}）。
type envelope struct {
	Code      string          `json:"code"`
	Message   string          `json:"message"`
	RequestID string          `json:"request_id,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

// rawBinding 是 internal endpoint 实际返回的 binding 形态（int64 字段）。
//
// 兼容两种返回形态：
//  1. shadow 直接返 storage.Binding（int64 字段）— 走 numeric → string 转换
//  2. shadow 已自行返 string 形态（与 Binding 完全对齐）— 走直接 unmarshal 兜底
//
// 反序列化策略：先按 int64 解；任何字段失败时转 fallback 走 string 解。
type rawBinding struct {
	UserID           string `json:"user_id"`
	Uin              int64  `json:"uin"`
	OwnerUin         int64  `json:"owner_uin"`
	AppID            int64  `json:"app_id"`
	Status           string `json:"status,omitempty"`
	LastErrorCode    string `json:"last_error_code,omitempty"`
	LastErrorMessage string `json:"last_error_message,omitempty"`
}

// httpClient 是 Client 的标准 HTTP 实现。
type httpClient struct {
	baseURL              string
	token                string
	httpClient           *http.Client
	credentialHTTPClient *http.Client
}

// Options 可选配置。空值走默认。
type Options struct {
	// HTTPClient 自定义底层客户端（注入 tracing transport 用）；
	// 默认为 &http.Client{Timeout: 4s}（与 ctlclient 一致，落 shadow 反查在询价/下单
	// 同步链路里，预算 4s 足够）。
	HTTPClient *http.Client
	// CredentialHTTPClient has a longer default timeout because one auth call
	// performs the CAM and STS exchanges sequentially.
	CredentialHTTPClient *http.Client
}

// New 构造 shadowclient.Client。
//
// 必填参数：
//   - baseURL：account-binding resolver 内部接入地址，当前由 lightclaw-auth 提供
//   - internalServiceToken：内部服务间互信 token（与 ctlclient 同源）
//
// 空 baseURL 不在 New 期 panic（保持与 ctlclient 一致行为）；调用时由 do() 报错。
func New(baseURL, internalServiceToken string, opts ...Options) ResolverClient {
	c := &httpClient{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:   strings.TrimSpace(internalServiceToken),
	}
	if len(opts) > 0 && opts[0].HTTPClient != nil {
		c.httpClient = opts[0].HTTPClient
	} else {
		c.httpClient = &http.Client{Timeout: defaultBindingRequestTimeout}
	}
	if len(opts) > 0 && opts[0].CredentialHTTPClient != nil {
		c.credentialHTTPClient = opts[0].CredentialHTTPClient
	} else if len(opts) > 0 && opts[0].HTTPClient != nil {
		c.credentialHTTPClient = opts[0].HTTPClient
	} else {
		c.credentialHTTPClient = &http.Client{Timeout: defaultCredentialRequestTimeout}
	}
	return c
}

func (c *httpClient) GetTemporaryCredentialsByExternalUserID(ctx context.Context, externalUserID string) (*TemporaryCredentials, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return nil, fmt.Errorf("shadowclient: externalUserID is required")
	}
	if c.baseURL == "" {
		return nil, fmt.Errorf("shadowclient: baseURL is empty")
	}
	payload, err := json.Marshal(map[string]string{
		"external_user_id": externalUserID,
		"client_ua":        "lightvela-trade",
	})
	if err != nil {
		return nil, fmt.Errorf("shadowclient: marshal credentials request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/shadow/credentials", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("shadowclient: build credentials request: %w", err)
	}
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.credentialHTTPClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("shadowclient: do credentials request: %w", err)
	}
	defer resp.Body.Close()
	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("shadowclient: read credentials response: %w", err)
	}
	var env envelope
	envParseErr := json.Unmarshal(rawBody, &env)
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("%w: status=%d code=%s message=%q request_id=%s",
			ErrUnauthorized, resp.StatusCode, env.Code, env.Message, env.RequestID)
	}
	if resp.StatusCode >= http.StatusBadRequest {
		if envParseErr != nil {
			return nil, &Error{HTTPStatus: resp.StatusCode, Message: "invalid error response"}
		}
		return nil, &Error{HTTPStatus: resp.StatusCode, Code: env.Code, Message: env.Message, RequestID: env.RequestID}
	}
	if envParseErr != nil || len(env.Data) == 0 || string(env.Data) == "null" {
		return nil, errors.New("shadowclient: invalid credentials response envelope")
	}
	var raw struct {
		Uin          int64  `json:"uin"`
		OwnerUin     int64  `json:"owner_uin"`
		TmpSecretID  string `json:"tmp_secret_id"`
		TmpSecretKey string `json:"tmp_secret_key"`
		Token        string `json:"token"`
		ExpiredAt    string `json:"expired_at"`
	}
	if err := json.Unmarshal(env.Data, &raw); err != nil {
		return nil, errors.New("shadowclient: invalid temporary credentials payload")
	}
	expiredAt, err := time.Parse(time.RFC3339, strings.TrimSpace(raw.ExpiredAt))
	if raw.Uin == 0 || raw.OwnerUin == 0 || strings.TrimSpace(raw.TmpSecretID) == "" ||
		strings.TrimSpace(raw.TmpSecretKey) == "" || strings.TrimSpace(raw.Token) == "" || err != nil {
		return nil, errors.New("shadowclient: temporary credentials are incomplete")
	}
	if !expiredAt.After(time.Now()) {
		return nil, errors.New("shadowclient: temporary credentials are expired")
	}
	return &TemporaryCredentials{
		Uin:       strconv.FormatInt(raw.Uin, 10),
		OwnerUin:  strconv.FormatInt(raw.OwnerUin, 10),
		SecretID:  raw.TmpSecretID,
		SecretKey: raw.TmpSecretKey,
		Token:     raw.Token,
		ExpiredAt: expiredAt,
	}, nil
}

func (c *httpClient) GetPaymentContextByExternalUserID(ctx context.Context, externalUserID string) (*PaymentContext, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return nil, fmt.Errorf("shadowclient: externalUserID is required")
	}
	if c.baseURL == "" {
		return nil, fmt.Errorf("shadowclient: baseURL is empty")
	}
	payload, err := json.Marshal(map[string]string{
		"external_user_id": externalUserID,
		"client_ua":        "lightvela-trade",
	})
	if err != nil {
		return nil, fmt.Errorf("shadowclient: marshal payment context request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/payment-methods/context", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("shadowclient: build payment context request: %w", err)
	}
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.credentialHTTPClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("shadowclient: do payment context request: %w", err)
	}
	defer resp.Body.Close()
	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("shadowclient: read payment context response: %w", err)
	}
	var env envelope
	envParseErr := json.Unmarshal(rawBody, &env)
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("%w: status=%d code=%s message=%q request_id=%s",
			ErrUnauthorized, resp.StatusCode, env.Code, env.Message, env.RequestID)
	}
	if resp.StatusCode >= http.StatusBadRequest {
		if envParseErr != nil {
			return nil, &Error{HTTPStatus: resp.StatusCode, Message: "invalid error response"}
		}
		return nil, &Error{HTTPStatus: resp.StatusCode, Code: env.Code, Message: env.Message, RequestID: env.RequestID}
	}
	if envParseErr != nil || len(env.Data) == 0 || string(env.Data) == "null" {
		return nil, errors.New("shadowclient: invalid payment context response envelope")
	}
	var data struct {
		HasPaymentMethod *bool  `json:"has_payment_method"`
		Uin              int64  `json:"uin"`
		OwnerUin         int64  `json:"owner_uin"`
		TmpSecretID      string `json:"tmp_secret_id"`
		TmpSecretKey     string `json:"tmp_secret_key"`
		Token            string `json:"token"`
		ExpiredAt        string `json:"expired_at"`
	}
	if err := json.Unmarshal(env.Data, &data); err != nil || data.HasPaymentMethod == nil {
		return nil, errors.New("shadowclient: invalid payment context payload")
	}
	expiredAt, err := time.Parse(time.RFC3339, strings.TrimSpace(data.ExpiredAt))
	if data.Uin == 0 || data.OwnerUin == 0 || strings.TrimSpace(data.TmpSecretID) == "" ||
		strings.TrimSpace(data.TmpSecretKey) == "" || strings.TrimSpace(data.Token) == "" || err != nil {
		return nil, errors.New("shadowclient: payment context credentials are incomplete")
	}
	if !expiredAt.After(time.Now()) {
		return nil, errors.New("shadowclient: payment context credentials are expired")
	}
	return &PaymentContext{
		Credentials: TemporaryCredentials{
			Uin:       strconv.FormatInt(data.Uin, 10),
			OwnerUin:  strconv.FormatInt(data.OwnerUin, 10),
			SecretID:  data.TmpSecretID,
			SecretKey: data.TmpSecretKey,
			Token:     data.Token,
			ExpiredAt: expiredAt,
		},
		HasPaymentMethod: *data.HasPaymentMethod,
	}, nil
}

func (c *httpClient) GetBindingByExternalUserID(ctx context.Context, externalUserID string) (*Binding, error) {
	if strings.TrimSpace(externalUserID) == "" {
		return nil, fmt.Errorf("shadowclient: externalUserID is required")
	}
	if c.baseURL == "" {
		return nil, fmt.Errorf("shadowclient: baseURL is empty")
	}

	q := url.Values{}
	q.Set("external_user_id", externalUserID)
	endpoint := c.baseURL + "/internal/shadow/binding?" + q.Encode()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("shadowclient: build request: %w", err)
	}
	httpReq.Header.Set("Accept", "application/json")
	if c.token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("shadowclient: do request: %w", err)
	}
	defer resp.Body.Close()

	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("shadowclient: read response: %w", err)
	}

	var env envelope
	envParseErr := json.Unmarshal(rawBody, &env)

	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return nil, fmt.Errorf("%w: status=%d code=%s message=%q request_id=%s",
			ErrUnauthorized, resp.StatusCode, env.Code, env.Message, env.RequestID)
	case resp.StatusCode == http.StatusNotFound:
		return nil, fmt.Errorf("%w: externalUserID=%s code=%s message=%q request_id=%s",
			ErrBindingNotFound, externalUserID, env.Code, env.Message, env.RequestID)
	case resp.StatusCode >= 400:
		if envParseErr != nil {
			return nil, &Error{
				HTTPStatus: resp.StatusCode,
				Code:       "",
				Message:    truncate(rawBody, 256),
			}
		}
		return nil, &Error{
			HTTPStatus: resp.StatusCode,
			Code:       env.Code,
			Message:    env.Message,
			RequestID:  env.RequestID,
		}
	}

	// 2xx 路径
	if envParseErr != nil {
		return nil, fmt.Errorf("shadowclient: parse success envelope: %w body=%s",
			envParseErr, truncate(rawBody, 256))
	}
	if len(env.Data) == 0 || string(env.Data) == "null" {
		return nil, fmt.Errorf("shadowclient: empty data field in success envelope: body=%s",
			truncate(rawBody, 256))
	}

	// 优先按 int64 形态解（shadow storage.Binding 原生形态）
	// 判定"成功解析"必须 uin 或 app_id 非零，单独 user_id 不足以认定身份完整。
	var raw rawBinding
	if err := json.Unmarshal(env.Data, &raw); err == nil && (raw.Uin != 0 || raw.AppID != 0) {
		return &Binding{
			UserID:   raw.UserID,
			Uin:      strconv.FormatInt(raw.Uin, 10),
			OwnerUin: strconv.FormatInt(raw.OwnerUin, 10),
			AppID:    strconv.FormatInt(raw.AppID, 10),
		}, nil
	}

	// 回退按 string 形态解（如果 shadow 已经在端侧做了 stringify）
	var b Binding
	if err := json.Unmarshal(env.Data, &b); err != nil {
		return nil, fmt.Errorf("shadowclient: unmarshal binding data: %w body=%s",
			err, truncate(env.Data, 256))
	}
	if b.Uin == "" && b.AppID == "" {
		return nil, fmt.Errorf("shadowclient: binding payload missing uin/app_id: body=%s",
			truncate(env.Data, 256))
	}
	return &b, nil
}

func (c *httpClient) GetBindingStateByExternalUserID(ctx context.Context, externalUserID string) (*Binding, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return nil, fmt.Errorf("shadowclient: externalUserID is required")
	}
	q := url.Values{}
	q.Set("external_user_id", externalUserID)
	return c.doBindingStateRequest(ctx, http.MethodGet, "/internal/shadow/binding/state?"+q.Encode(), nil)
}

func (c *httpClient) RetryBillingAccountByExternalUserID(ctx context.Context, externalUserID string) (*Binding, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return nil, fmt.Errorf("shadowclient: externalUserID is required")
	}
	payload, err := json.Marshal(map[string]string{"external_user_id": externalUserID})
	if err != nil {
		return nil, fmt.Errorf("shadowclient: marshal billing retry request: %w", err)
	}
	return c.doBindingStateRequest(ctx, http.MethodPost, "/internal/shadow/binding/retry", payload)
}

func (c *httpClient) doBindingStateRequest(ctx context.Context, method, path string, payload []byte) (*Binding, error) {
	if c.baseURL == "" {
		return nil, fmt.Errorf("shadowclient: baseURL is empty")
	}
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return nil, fmt.Errorf("shadowclient: build binding state request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("shadowclient: do binding state request: %w", err)
	}
	defer resp.Body.Close()
	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("shadowclient: read binding state response: %w", err)
	}
	var env envelope
	if err := json.Unmarshal(rawBody, &env); err != nil {
		return nil, &Error{HTTPStatus: resp.StatusCode, Message: truncate(rawBody, 256)}
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("%w: status=%d code=%s message=%q request_id=%s",
			ErrUnauthorized, resp.StatusCode, env.Code, env.Message, env.RequestID)
	}
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%w: code=%s message=%q request_id=%s",
			ErrBindingNotFound, env.Code, env.Message, env.RequestID)
	}
	if resp.StatusCode >= http.StatusBadRequest {
		return nil, &Error{HTTPStatus: resp.StatusCode, Code: env.Code, Message: env.Message, RequestID: env.RequestID}
	}
	var raw rawBinding
	if err := json.Unmarshal(env.Data, &raw); err != nil || strings.TrimSpace(raw.UserID) == "" {
		return nil, fmt.Errorf("shadowclient: invalid binding state payload: body=%s", truncate(env.Data, 256))
	}
	return &Binding{
		UserID:           raw.UserID,
		Uin:              strconv.FormatInt(raw.Uin, 10),
		OwnerUin:         strconv.FormatInt(raw.OwnerUin, 10),
		AppID:            strconv.FormatInt(raw.AppID, 10),
		Status:           raw.Status,
		LastErrorCode:    raw.LastErrorCode,
		LastErrorMessage: raw.LastErrorMessage,
	}, nil
}

func ResolveBindingWithBillingRetry(ctx context.Context, client Client, externalUserID string, allowFailedBilling bool) (*Binding, error) {
	binding, err := client.GetBindingByExternalUserID(ctx, externalUserID)
	if err == nil {
		return binding, nil
	}
	if !errors.Is(err, ErrBindingNotFound) {
		return nil, err
	}
	recovery, ok := client.(BillingRecoveryClient)
	if !ok {
		return nil, err
	}
	state, stateErr := recovery.GetBindingStateByExternalUserID(ctx, externalUserID)
	if stateErr != nil {
		return nil, stateErr
	}
	if !isBillingAccountOpenFailure(state) || !hasRegisteredIdentity(state) {
		return nil, err
	}
	retried, retryErr := recovery.RetryBillingAccountByExternalUserID(ctx, externalUserID)
	if retryErr == nil && strings.EqualFold(strings.TrimSpace(retried.Status), "active") {
		return retried, nil
	}
	if allowFailedBilling {
		if retryErr == nil && hasRegisteredIdentity(retried) {
			return retried, nil
		}
		return state, nil
	}
	if retryErr != nil {
		return nil, fmt.Errorf("%w: %v", ErrBillingAccountOpenFailed, retryErr)
	}
	return nil, fmt.Errorf("%w: externalUserID=%s status=%s code=%s",
		ErrBillingAccountOpenFailed, externalUserID, retried.Status, retried.LastErrorCode)
}

func isBillingAccountOpenFailure(binding *Binding) bool {
	return binding != nil && strings.EqualFold(strings.TrimSpace(binding.Status), "failed") &&
		strings.TrimSpace(binding.LastErrorCode) == "billing_account_open_failed"
}

func hasRegisteredIdentity(binding *Binding) bool {
	return binding != nil && strings.TrimSpace(binding.Uin) != "" && binding.Uin != "0" &&
		strings.TrimSpace(binding.AppID) != "" && binding.AppID != "0"
}

// truncate 截断 byte slice 用于 error 日志，避免巨型 body 干扰排障。
func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "...(truncated)"
}
