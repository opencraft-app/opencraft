package newapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
)

var ErrNotFound = errors.New("new-api resource not found")
var errIncompleteChannelPagination = errors.New("new-api channel pagination incomplete")

const inviteCodeCollisionRetries = 5

type Client struct {
	baseURL    string
	httpClient *http.Client
}

type SetupInfo struct {
	Status       bool   `json:"status"`
	RootInit     bool   `json:"root_init"`
	DatabaseType string `json:"database_type"`
}

type SetupRequest struct {
	Username           string `json:"username"`
	Password           string `json:"password"`
	ConfirmPassword    string `json:"confirmPassword"`
	SelfUseModeEnabled bool   `json:"SelfUseModeEnabled"`
	DemoSiteEnabled    bool   `json:"DemoSiteEnabled"`
}

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type TwoFALoginRequest struct {
	Code string `json:"code"`
}

type PaymentComplianceRequest struct {
	Confirmed bool `json:"confirmed"`
}

type TwoFASetupData struct {
	Secret      string   `json:"secret"`
	QRCodeData  string   `json:"qr_code_data,omitempty"`
	BackupCodes []string `json:"backup_codes,omitempty"`
}

type EnableTwoFARequest struct {
	Code string `json:"code"`
}

type VerifyRequest struct {
	Method string `json:"method"`
	Code   string `json:"code,omitempty"`
}

type UpdateOptionRequest struct {
	Key   string `json:"key"`
	Value any    `json:"value"`
}

type Option struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type Session struct {
	UserID      int
	Username    string
	Role        int
	Status      int
	Group       string
	AccessToken string
	Require2FA  bool
}

type AdminAuth struct {
	UserID      int
	AccessToken string
}

type CreateUserRequest struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name,omitempty"`
	Role        int    `json:"role"`
}

type UpdateUserRequest struct {
	ID          int    `json:"id"`
	Username    string `json:"username"`
	Password    string `json:"password,omitempty"`
	DisplayName string `json:"display_name"`
	Role        int    `json:"role"`
	Status      int    `json:"status"`
	Group       string `json:"group"`
}

type User struct {
	ID          int        `json:"id"`
	Username    string     `json:"username"`
	DisplayName string     `json:"display_name"`
	Role        int        `json:"role"`
	Status      int        `json:"status"`
	Group       string     `json:"group"`
	Quota       int        `json:"quota"`
	DeletedAt   *time.Time `json:"DeletedAt"`
}

type CreateTokenRequest struct {
	Name               string `json:"name"`
	ExpiredTime        int64  `json:"expired_time"`
	RemainQuota        int    `json:"remain_quota"`
	UnlimitedQuota     bool   `json:"unlimited_quota"`
	ModelLimitsEnabled bool   `json:"model_limits_enabled"`
	ModelLimits        string `json:"model_limits"`
	Group              string `json:"group"`
}

type UpstreamKey struct {
	ID  int
	Key string
}

type UserToken struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type AdminCreateUserSubscriptionRequest struct {
	PlanID    int    `json:"plan_id"`
	Name      string `json:"name,omitempty"`
	RequestID string `json:"request_id"`
}

type AdminCreateSubscriptionPlanRequest struct {
	Plan AdminSubscriptionPlan `json:"plan"`
}

type AdminSubscriptionPlan struct {
	ID                      int     `json:"id,omitempty"`
	Title                   string  `json:"title"`
	Subtitle                string  `json:"subtitle,omitempty"`
	PriceAmount             float64 `json:"price_amount"`
	Currency                string  `json:"currency"`
	DurationUnit            string  `json:"duration_unit"`
	DurationValue           int     `json:"duration_value"`
	Enabled                 bool    `json:"enabled"`
	TotalAmount             int64   `json:"total_amount"`
	AllowBalancePay         bool    `json:"allow_balance_pay"`
	QuotaResetPeriod        string  `json:"quota_reset_period"`
	QuotaResetCustomSeconds int64   `json:"quota_reset_custom_seconds,omitempty"`
}

type AdminCreateSubscriptionPlanResult struct {
	ID int `json:"id"`
}

type adminSubscriptionPlanEnvelope struct {
	Plan AdminSubscriptionPlan `json:"plan"`
}

type Channel struct {
	ID                 int         `json:"id,omitempty"`
	Type               int         `json:"type"`
	Key                string      `json:"key,omitempty"`
	Status             int         `json:"status"`
	Name               string      `json:"name"`
	Weight             *uint       `json:"weight,omitempty"`
	BaseURL            *string     `json:"base_url,omitempty"`
	Models             string      `json:"models"`
	Group              string      `json:"group"`
	ModelMapping       *string     `json:"model_mapping,omitempty"`
	Priority           *int64      `json:"priority,omitempty"`
	AutoBan            *int        `json:"auto_ban,omitempty"`
	Tag                *string     `json:"tag,omitempty"`
	Setting            *string     `json:"setting,omitempty"`
	ParamOverride      *string     `json:"param_override,omitempty"`
	HeaderOverride     *string     `json:"header_override,omitempty"`
	Remark             *string     `json:"remark,omitempty"`
	Other              string      `json:"other,omitempty"`
	StatusCodeMapping  *string     `json:"status_code_mapping,omitempty"`
	OtherSettings      string      `json:"settings,omitempty"`
	OpenAIOrganization *string     `json:"openai_organization,omitempty"`
	TestModel          *string     `json:"test_model,omitempty"`
	ChannelInfo        ChannelInfo `json:"channel_info,omitempty"`
}

const (
	ChannelStatusUnknown          = 0
	ChannelStatusEnabled          = 1
	ChannelStatusManuallyDisabled = 2
	ChannelStatusAutoDisabled     = 3
)

type ChannelInfo struct {
	IsMultiKey   bool   `json:"is_multi_key"`
	MultiKeyMode string `json:"multi_key_mode,omitempty"`
}

type AddChannelRequest struct {
	Mode                      string   `json:"mode"`
	MultiKeyMode              string   `json:"multi_key_mode,omitempty"`
	BatchAddSetKeyPrefix2Name bool     `json:"batch_add_set_key_prefix_2_name,omitempty"`
	Channel                   *Channel `json:"channel"`
}

type UpdateChannelRequest struct {
	Channel
	MultiKeyMode *string `json:"multi_key_mode,omitempty"`
	KeyMode      *string `json:"key_mode,omitempty"`
}

type FetchModelsRequest struct {
	BaseURL string `json:"base_url"`
	Type    int    `json:"type"`
	Key     string `json:"key"`
}

type UserSubscription struct {
	ID            int    `json:"id"`
	Name          string `json:"name"`
	RequestID     string `json:"request_id"`
	UserID        int    `json:"user_id"`
	PlanID        int    `json:"plan_id"`
	AmountTotal   int64  `json:"amount_total"`
	AmountUsed    int64  `json:"amount_used"`
	StartTime     int64  `json:"start_time"`
	EndTime       int64  `json:"end_time"`
	Status        string `json:"status"`
	Source        string `json:"source"`
	LastResetTime int64  `json:"last_reset_time"`
	NextResetTime int64  `json:"next_reset_time"`
	UpgradeGroup  string `json:"upgrade_group"`
	PrevUserGroup string `json:"prev_user_group"`
	CreatedAt     int64  `json:"created_at"`
	UpdatedAt     int64  `json:"updated_at"`
}

func NewClient(baseURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		jar, _ := cookiejar.New(nil)
		httpClient = &http.Client{Timeout: 15 * time.Second, Jar: jar}
	} else if httpClient.Jar == nil || httpClient.Timeout == 0 {
		copied := *httpClient
		if copied.Jar == nil {
			jar, _ := cookiejar.New(nil)
			copied.Jar = jar
		}
		if copied.Timeout == 0 {
			copied.Timeout = 15 * time.Second
		}
		httpClient = &copied
	}
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		httpClient: httpClient,
	}
}

func (c *Client) GetSetup(ctx context.Context) (SetupInfo, error) {
	var resp apiResponse[SetupInfo]
	if err := c.do(ctx, http.MethodGet, "/api/setup", nil, nil, &resp); err != nil {
		return SetupInfo{}, err
	}
	if !resp.Success {
		return SetupInfo{}, fmt.Errorf("new-api setup status failed: %s", resp.Message)
	}
	return resp.Data, nil
}

func (c *Client) Setup(ctx context.Context, req SetupRequest) error {
	var resp apiResponse[json.RawMessage]
	if err := c.do(ctx, http.MethodPost, "/api/setup", nil, req, &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("new-api setup failed: %s", resp.Message)
	}
	return nil
}

func (c *Client) Login(ctx context.Context, username string, password string) (Session, error) {
	var resp apiResponse[loginData]
	if err := c.do(ctx, http.MethodPost, "/api/user/login", nil, LoginRequest{Username: username, Password: password}, &resp); err != nil {
		return Session{}, err
	}
	if !resp.Success {
		return Session{}, fmt.Errorf("new-api login failed: %s", resp.Message)
	}
	if resp.Data.Require2FA {
		return Session{Require2FA: true}, nil
	}
	return Session{
		UserID:   resp.Data.ID,
		Username: resp.Data.Username,
		Role:     resp.Data.Role,
		Status:   resp.Data.Status,
		Group:    resp.Data.Group,
	}, nil
}

func (c *Client) ResolveUserByLogin(ctx context.Context, username string, password string) (User, error) {
	sessionClient := c.isolatedSessionClient()
	session, err := sessionClient.Login(ctx, username, password)
	if err != nil {
		return User{}, err
	}
	if session.Require2FA {
		return User{}, fmt.Errorf("new-api login requires 2fa for user %q", username)
	}
	if session.UserID <= 0 {
		return User{}, fmt.Errorf("new-api login returned empty user id for user %q", username)
	}
	if session.Username != username {
		return User{}, fmt.Errorf("new-api login resolved unexpected user %q for %q", session.Username, username)
	}
	return User{
		ID:       session.UserID,
		Username: session.Username,
		Role:     session.Role,
		Status:   session.Status,
		Group:    session.Group,
	}, nil
}

func (c *Client) isolatedSessionClient() *Client {
	copied := *c.httpClient
	jar, _ := cookiejar.New(nil)
	copied.Jar = jar
	return &Client{baseURL: c.baseURL, httpClient: &copied}
}

func (c *Client) Complete2FALogin(ctx context.Context, code string) (Session, error) {
	if strings.TrimSpace(code) == "" {
		return Session{}, fmt.Errorf("new-api 2fa login code is required")
	}
	var resp apiResponse[loginData]
	if err := c.do(ctx, http.MethodPost, "/api/user/login/2fa", nil, TwoFALoginRequest{Code: code}, &resp); err != nil {
		return Session{}, err
	}
	if !resp.Success {
		return Session{}, fmt.Errorf("new-api 2fa login failed: %s", resp.Message)
	}
	return Session{
		UserID:   resp.Data.ID,
		Username: resp.Data.Username,
		Role:     resp.Data.Role,
		Status:   resp.Data.Status,
		Group:    resp.Data.Group,
	}, nil
}

func (c *Client) GenerateAccessToken(ctx context.Context, userID int) (string, error) {
	headers := map[string]string{"New-Api-User": strconv.Itoa(userID)}
	var resp apiResponse[string]
	if err := c.do(ctx, http.MethodGet, "/api/user/token", headers, nil, &resp); err != nil {
		return "", err
	}
	if !resp.Success {
		return "", fmt.Errorf("new-api generate access token failed: %s", resp.Message)
	}
	return resp.Data, nil
}

func (c *Client) ConfirmPaymentCompliance(ctx context.Context, userID int) error {
	if userID <= 0 {
		return fmt.Errorf("new-api user id is required")
	}
	var resp apiResponse[json.RawMessage]
	headers := map[string]string{"New-Api-User": strconv.Itoa(userID)}
	if err := c.do(ctx, http.MethodPost, "/api/option/payment_compliance", headers, PaymentComplianceRequest{Confirmed: true}, &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("new-api confirm payment compliance failed: %s", resp.Message)
	}
	return nil
}

func (c *Client) UpdateOption(ctx context.Context, userID int, key string, value any) error {
	if userID <= 0 {
		return fmt.Errorf("new-api user id is required")
	}
	return c.updateOption(ctx, map[string]string{"New-Api-User": strconv.Itoa(userID)}, key, value)
}

func (c *Client) GetOptions(ctx context.Context, auth AdminAuth) ([]Option, error) {
	var resp apiResponse[[]Option]
	if err := c.do(ctx, http.MethodGet, "/api/option/", adminHeaders(auth), nil, &resp); err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("new-api get options failed: %s", resp.Message)
	}
	return resp.Data, nil
}

func (c *Client) UpdateOptionWithAuth(ctx context.Context, auth AdminAuth, key string, value any) error {
	return c.updateOption(ctx, adminHeaders(auth), key, value)
}

func (c *Client) updateOption(ctx context.Context, headers map[string]string, key string, value any) error {
	value, err := normalizeOptionValue(value)
	if err != nil {
		return fmt.Errorf("encode new-api option %q: %w", key, err)
	}
	var resp apiResponse[json.RawMessage]
	if err := c.do(ctx, http.MethodPut, "/api/option/", headers, UpdateOptionRequest{Key: key, Value: value}, &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("new-api update option %q failed: %s", key, resp.Message)
	}
	return nil
}

func normalizeOptionValue(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	if raw, ok := value.(json.RawMessage); ok {
		return string(raw), nil
	}
	reflected := reflect.ValueOf(value)
	for reflected.Kind() == reflect.Pointer {
		if reflected.IsNil() {
			return nil, nil
		}
		reflected = reflected.Elem()
		value = reflected.Interface()
	}
	kind := reflected.Kind()
	if kind != reflect.Array && kind != reflect.Slice && kind != reflect.Map && kind != reflect.Struct && kind != reflect.Pointer {
		return value, nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return string(encoded), nil
}

func (c *Client) Setup2FA(ctx context.Context, userID int, accessToken string) (TwoFASetupData, error) {
	if userID <= 0 {
		return TwoFASetupData{}, fmt.Errorf("new-api user id is required")
	}
	var resp apiResponse[TwoFASetupData]
	if err := c.do(ctx, http.MethodPost, "/api/user/2fa/setup", userHeaders(userID, accessToken), nil, &resp); err != nil {
		return TwoFASetupData{}, err
	}
	if !resp.Success {
		return TwoFASetupData{}, fmt.Errorf("new-api setup 2fa failed: %s", resp.Message)
	}
	if strings.TrimSpace(resp.Data.Secret) == "" {
		return TwoFASetupData{}, fmt.Errorf("new-api setup 2fa returned empty secret")
	}
	return resp.Data, nil
}

func (c *Client) Enable2FA(ctx context.Context, userID int, accessToken string, code string) error {
	if userID <= 0 {
		return fmt.Errorf("new-api user id is required")
	}
	if strings.TrimSpace(code) == "" {
		return fmt.Errorf("new-api 2fa code is required")
	}
	var resp apiResponse[json.RawMessage]
	if err := c.do(ctx, http.MethodPost, "/api/user/2fa/enable", userHeaders(userID, accessToken), EnableTwoFARequest{Code: code}, &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("new-api enable 2fa failed: %s", resp.Message)
	}
	return nil
}

func (c *Client) Verify2FA(ctx context.Context, auth AdminAuth, code string) error {
	if auth.UserID <= 0 {
		return fmt.Errorf("new-api user id is required")
	}
	if strings.TrimSpace(code) == "" {
		return fmt.Errorf("new-api 2fa code is required")
	}
	var resp apiResponse[json.RawMessage]
	if err := c.do(ctx, http.MethodPost, "/api/verify", adminHeaders(auth), VerifyRequest{Method: "2fa", Code: code}, &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("new-api secure verification failed: %s", resp.Message)
	}
	return nil
}

func (c *Client) GetChannelKey(ctx context.Context, auth AdminAuth, channelID int, code string) (string, error) {
	if channelID <= 0 {
		return "", fmt.Errorf("new-api channel id is required")
	}
	if err := c.Verify2FA(ctx, auth, code); err != nil {
		return "", err
	}
	return c.GetVerifiedChannelKey(ctx, auth, channelID)
}

// GetVerifiedChannelKey reuses an already verified admin session. Callers that
// export many channels should verify once and fetch every key through this API.
func (c *Client) GetVerifiedChannelKey(ctx context.Context, auth AdminAuth, channelID int) (string, error) {
	if channelID <= 0 {
		return "", fmt.Errorf("new-api channel id is required")
	}
	var resp apiResponse[tokenKeyData]
	path := fmt.Sprintf("/api/channel/%d/key", channelID)
	if err := c.do(ctx, http.MethodPost, path, adminHeaders(auth), nil, &resp); err != nil {
		return "", err
	}
	if !resp.Success {
		return "", fmt.Errorf("new-api get channel key failed: %s", resp.Message)
	}
	if resp.Data.Key == "" {
		return "", fmt.Errorf("new-api get channel key returned empty key")
	}
	return resp.Data.Key, nil
}

func (c *Client) CreateUser(ctx context.Context, auth AdminAuth, req CreateUserRequest) error {
	headers := adminHeaders(auth)
	var createErr error
	for attempt := 0; attempt <= inviteCodeCollisionRetries; attempt++ {
		if attempt > 0 {
			if err := sleepBeforeRetry(ctx, attempt); err != nil {
				return err
			}
		}
		var resp apiResponse[json.RawMessage]
		if err := c.do(ctx, http.MethodPost, "/api/user/", headers, req, &resp); err != nil {
			createErr = err
		} else if !resp.Success {
			createErr = fmt.Errorf("new-api create user failed: %s", resp.Message)
		} else {
			return nil
		}
		if !isInviteCodeCollisionError(createErr) {
			return createErr
		}
	}
	return createErr
}

func (c *Client) FindUser(ctx context.Context, auth AdminAuth, username string) (User, error) {
	path := "/api/user/search?keyword=" + url.QueryEscape(username)
	var resp apiResponse[pagedUsers]
	if err := c.do(ctx, http.MethodGet, path, adminHeaders(auth), nil, &resp); err != nil {
		return User{}, err
	}
	if !resp.Success {
		return User{}, fmt.Errorf("new-api search user failed: %s", resp.Message)
	}
	for _, user := range resp.Data.Items {
		if user.Username == username {
			return User{
				ID:          user.ID,
				Username:    user.Username,
				DisplayName: user.DisplayName,
				Role:        user.Role,
				Status:      user.Status,
				Group:       user.Group,
				DeletedAt:   user.DeletedAt,
			}, nil
		}
	}
	return User{}, fmt.Errorf("%w: user %q", ErrNotFound, username)
}

func (c *Client) FindUserID(ctx context.Context, auth AdminAuth, username string) (int, error) {
	user, err := c.FindUser(ctx, auth, username)
	if err != nil {
		return 0, err
	}
	return user.ID, nil
}

// RefreshUserCache asks new-api to read the current database row and write it
// back unchanged. Its user update path rebuilds the complete Redis user cache,
// which is required after quota override because that endpoint only updates DB.
func (c *Client) RefreshUserCache(ctx context.Context, auth AdminAuth, userID int) (User, error) {
	var getResp apiResponse[User]
	path := fmt.Sprintf("/api/user/%d", userID)
	if err := c.do(ctx, http.MethodGet, path, adminHeaders(auth), nil, &getResp); err != nil {
		return User{}, err
	}
	if !getResp.Success {
		return User{}, fmt.Errorf("new-api get user failed: %s", getResp.Message)
	}
	if getResp.Data.ID != userID || getResp.Data.Username == "" {
		return User{}, fmt.Errorf("new-api get user returned invalid user %d", userID)
	}
	if err := c.updateUser(ctx, auth, getResp.Data, ""); err != nil {
		return User{}, err
	}
	return getResp.Data, nil
}

func (c *Client) UpdateUserPassword(ctx context.Context, auth AdminAuth, user User, password string) error {
	return c.updateUser(ctx, auth, user, password)
}

func (c *Client) UpdateUserGroup(ctx context.Context, auth AdminAuth, username string, group string) error {
	user, err := c.FindUser(ctx, auth, username)
	if err != nil {
		return err
	}
	user.Group = strings.TrimSpace(group)
	if err := c.updateUser(ctx, auth, user, ""); err != nil {
		return err
	}
	return nil
}

func (c *Client) updateUser(ctx context.Context, auth AdminAuth, user User, password string) error {
	if user.ID == 0 {
		return fmt.Errorf("new-api user id is required")
	}
	if user.Username == "" {
		return fmt.Errorf("new-api username is required")
	}
	if user.DisplayName == "" {
		user.DisplayName = user.Username
	}
	if user.Role == 0 {
		user.Role = 1
	}
	if user.Status == 0 {
		user.Status = 1
	}
	if user.Group == "" {
		user.Group = "default"
	}
	var resp apiResponse[json.RawMessage]
	if err := c.do(ctx, http.MethodPut, "/api/user/", adminHeaders(auth), UpdateUserRequest{
		ID:          user.ID,
		Username:    user.Username,
		Password:    password,
		DisplayName: user.DisplayName,
		Role:        user.Role,
		Status:      user.Status,
		Group:       user.Group,
	}, &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("new-api update user failed: %s", resp.Message)
	}
	return nil
}

func (c *Client) ManageQuota(ctx context.Context, auth AdminAuth, userID int, mode string, value int) error {
	req := map[string]any{
		"id":     userID,
		"action": "add_quota",
		"mode":   mode,
		"value":  value,
	}
	var resp apiResponse[json.RawMessage]
	if err := c.do(ctx, http.MethodPost, "/api/user/manage", adminHeaders(auth), req, &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("new-api manage quota failed: %s", resp.Message)
	}
	return nil
}

func (c *Client) ManageUser(ctx context.Context, auth AdminAuth, userID int, action string) error {
	req := map[string]any{
		"id":     userID,
		"action": action,
	}
	var resp apiResponse[json.RawMessage]
	if err := c.do(ctx, http.MethodPost, "/api/user/manage", adminHeaders(auth), req, &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("new-api manage user failed: %s", resp.Message)
	}
	return nil
}

func (c *Client) CreateUserToken(ctx context.Context, userID int, accessToken string, req CreateTokenRequest) (UpstreamKey, error) {
	headers := userHeaders(userID, accessToken)
	var createResp apiResponse[json.RawMessage]
	var createErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			if err := sleepBeforeRetry(ctx, attempt); err != nil {
				return UpstreamKey{}, err
			}
		}
		createResp = apiResponse[json.RawMessage]{}
		if err := c.do(ctx, http.MethodPost, "/api/token/", headers, req, &createResp); err != nil {
			createErr = err
		} else if !createResp.Success {
			createErr = fmt.Errorf("new-api create token failed: %s", createResp.Message)
		} else {
			createErr = nil
			break
		}
		if !isTransientMySQLLockError(createErr) {
			return UpstreamKey{}, createErr
		}
	}
	if createErr != nil {
		return UpstreamKey{}, createErr
	}

	tokenID, err := c.findTokenID(ctx, headers, req.Name)
	if err != nil {
		return UpstreamKey{}, err
	}
	key, err := c.getTokenKey(ctx, headers, tokenID)
	if err != nil {
		return UpstreamKey{}, err
	}
	return UpstreamKey{ID: tokenID, Key: key}, nil
}

func (c *Client) ListUserTokens(ctx context.Context, userID int, accessToken string, page int, pageSize int) ([]UserToken, int, error) {
	if userID <= 0 || strings.TrimSpace(accessToken) == "" {
		return nil, 0, fmt.Errorf("new-api user id and access token are required")
	}
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 || pageSize > 100 {
		pageSize = 100
	}
	path := fmt.Sprintf("/api/token/?p=%d&page_size=%d", page, pageSize)
	var resp apiResponse[struct {
		Items []UserToken `json:"items"`
		Total int         `json:"total"`
	}]
	if err := c.do(ctx, http.MethodGet, path, userHeaders(userID, accessToken), nil, &resp); err != nil {
		return nil, 0, err
	}
	if !resp.Success {
		return nil, 0, fmt.Errorf("new-api list user tokens failed: %s", resp.Message)
	}
	return resp.Data.Items, resp.Data.Total, nil
}

func (c *Client) DeleteUserToken(ctx context.Context, userID int, accessToken string, tokenID int) error {
	if userID <= 0 || strings.TrimSpace(accessToken) == "" || tokenID <= 0 {
		return fmt.Errorf("new-api user id, access token and token id are required")
	}
	var resp apiResponse[json.RawMessage]
	if err := c.do(ctx, http.MethodDelete, fmt.Sprintf("/api/token/%d", tokenID), userHeaders(userID, accessToken), nil, &resp); err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	}
	if !resp.Success {
		return fmt.Errorf("new-api delete user token failed: %s", resp.Message)
	}
	return nil
}

func sleepBeforeRetry(ctx context.Context, attempt int) error {
	timer := time.NewTimer(time.Duration(attempt*25) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func isTransientMySQLLockError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "error 1213") ||
		strings.Contains(message, "deadlock found") ||
		strings.Contains(message, "try restarting transaction") ||
		strings.Contains(message, "error 1205") ||
		strings.Contains(message, "lock wait timeout")
}

func isInviteCodeCollisionError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "aff_code")
}

func IsUsernameDuplicateError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "duplicate entry") && strings.Contains(message, "users.username")
}

func (c *Client) AdminCreateUserSubscription(ctx context.Context, auth AdminAuth, userID int, req AdminCreateUserSubscriptionRequest) (UserSubscription, error) {
	if userID <= 0 {
		return UserSubscription{}, fmt.Errorf("new-api user id is required")
	}
	if req.PlanID <= 0 {
		return UserSubscription{}, fmt.Errorf("new-api subscription plan id is required")
	}
	if strings.TrimSpace(req.RequestID) == "" {
		return UserSubscription{}, fmt.Errorf("new-api subscription request id is required")
	}
	var resp apiResponse[UserSubscription]
	path := fmt.Sprintf("/api/subscription/admin/users/%d/subscriptions", userID)
	if err := c.do(ctx, http.MethodPost, path, adminHeaders(auth), req, &resp); err != nil {
		return UserSubscription{}, err
	}
	if !resp.Success {
		return UserSubscription{}, fmt.Errorf("new-api create user subscription failed: %s", resp.Message)
	}
	if resp.Data.ID <= 0 {
		return UserSubscription{}, fmt.Errorf("new-api create user subscription returned an invalid subscription id")
	}
	return resp.Data, nil
}

func (c *Client) AdminCreateSubscriptionPlan(ctx context.Context, auth AdminAuth, req AdminCreateSubscriptionPlanRequest) (AdminCreateSubscriptionPlanResult, error) {
	if strings.TrimSpace(req.Plan.Title) == "" {
		return AdminCreateSubscriptionPlanResult{}, fmt.Errorf("new-api subscription plan title is required")
	}
	if req.Plan.DurationValue <= 0 {
		return AdminCreateSubscriptionPlanResult{}, fmt.Errorf("new-api subscription plan duration value is required")
	}
	var resp apiResponse[AdminCreateSubscriptionPlanResult]
	if err := c.do(ctx, http.MethodPost, "/api/subscription/admin/plans", adminHeaders(auth), req, &resp); err != nil {
		return AdminCreateSubscriptionPlanResult{}, err
	}
	if !resp.Success {
		return AdminCreateSubscriptionPlanResult{}, fmt.Errorf("new-api create subscription plan failed: %s", resp.Message)
	}
	if resp.Data.ID <= 0 {
		return AdminCreateSubscriptionPlanResult{}, fmt.Errorf("new-api create subscription plan returned empty id")
	}
	return resp.Data, nil
}

func (c *Client) AdminListSubscriptionPlans(ctx context.Context, auth AdminAuth) ([]AdminSubscriptionPlan, error) {
	var resp apiResponse[[]adminSubscriptionPlanEnvelope]
	if err := c.do(ctx, http.MethodGet, "/api/subscription/admin/plans", adminHeaders(auth), nil, &resp); err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("new-api list subscription plans failed: %s", resp.Message)
	}
	plans := make([]AdminSubscriptionPlan, 0, len(resp.Data))
	for _, item := range resp.Data {
		plans = append(plans, item.Plan)
	}
	return plans, nil
}

func (c *Client) AdminListUserSubscriptions(ctx context.Context, auth AdminAuth, userID int) ([]UserSubscription, error) {
	if userID <= 0 {
		return nil, fmt.Errorf("new-api user id is required")
	}
	var resp apiResponse[[]subscriptionSummary]
	path := fmt.Sprintf("/api/subscription/admin/users/%d/subscriptions", userID)
	if err := c.do(ctx, http.MethodGet, path, adminHeaders(auth), nil, &resp); err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("new-api list user subscriptions failed: %s", resp.Message)
	}
	subs := make([]UserSubscription, 0, len(resp.Data))
	for _, item := range resp.Data {
		if item.Subscription == nil {
			continue
		}
		subs = append(subs, *item.Subscription)
	}
	return subs, nil
}

func (c *Client) AdminInvalidateUserSubscription(ctx context.Context, auth AdminAuth, subscriptionID int) error {
	if subscriptionID <= 0 {
		return fmt.Errorf("new-api user subscription id is required")
	}
	var resp apiResponse[json.RawMessage]
	path := fmt.Sprintf("/api/subscription/admin/user_subscriptions/%d/invalidate", subscriptionID)
	if err := c.do(ctx, http.MethodPost, path, adminHeaders(auth), nil, &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("new-api invalidate user subscription failed: %s", resp.Message)
	}
	return nil
}

func (c *Client) SearchChannels(ctx context.Context, auth AdminAuth, keyword string) ([]Channel, error) {
	page, err := c.searchChannelsPage(ctx, auth, keyword, 1, 100)
	if err != nil {
		return nil, err
	}
	return page.Items, nil
}

func (c *Client) searchChannelsPage(ctx context.Context, auth AdminAuth, keyword string, page int, pageSize int) (pagedChannels, error) {
	path := "/api/channel/search?keyword=" + url.QueryEscape(keyword) +
		"&page_size=" + strconv.Itoa(pageSize) + "&p=" + strconv.Itoa(page) + "&id_sort=true"
	var resp apiResponse[pagedChannels]
	if err := c.do(ctx, http.MethodGet, path, adminHeaders(auth), nil, &resp); err != nil {
		return pagedChannels{}, err
	}
	if !resp.Success {
		return pagedChannels{}, fmt.Errorf("new-api search channels failed: %s", resp.Message)
	}
	return resp.Data, nil
}

func (c *Client) ListChannels(ctx context.Context, auth AdminAuth) ([]Channel, error) {
	return c.listChannelsOnce(ctx, auth)
}

// ListChannelsStable repeats the complete offset pagination until two adjacent
// snapshots match. This avoids exporting a mixed snapshot while channels are
// being inserted or deleted between pages.
func (c *Client) ListChannelsStable(ctx context.Context, auth AdminAuth) ([]Channel, error) {
	const maxStabilizationRuns = 5
	var previous []Channel
	for scan := 1; scan <= maxStabilizationRuns; scan++ {
		channels, err := c.listChannelsOnce(ctx, auth)
		if err != nil {
			if errors.Is(err, errIncompleteChannelPagination) {
				previous = nil
				continue
			}
			return nil, err
		}
		if scan >= 2 && reflect.DeepEqual(previous, channels) {
			return channels, nil
		}
		previous = channels
	}
	return nil, fmt.Errorf("new-api channels changed during %d complete pagination scans", maxStabilizationRuns)
}

func (c *Client) listChannelsOnce(ctx context.Context, auth AdminAuth) ([]Channel, error) {
	const pageSize = 100
	byID := make(map[int]Channel, pageSize)
	observedTotal := 0
	for page := 1; ; page++ {
		result, err := c.searchChannelsPage(ctx, auth, "", page, pageSize)
		if err != nil {
			return nil, err
		}
		for _, channel := range result.Items {
			byID[channel.ID] = channel
		}
		if result.Total > observedTotal {
			observedTotal = result.Total
		}
		if len(result.Items) == 0 || len(result.Items) < pageSize || (result.Total > 0 && page*pageSize >= result.Total) {
			break
		}
	}
	channels := make([]Channel, 0, len(byID))
	for _, channel := range byID {
		channels = append(channels, channel)
	}
	sort.Slice(channels, func(i, j int) bool { return channels[i].ID < channels[j].ID })
	if len(channels) < observedTotal {
		return nil, fmt.Errorf("%w: got %d unique channels, expected at least %d", errIncompleteChannelPagination, len(channels), observedTotal)
	}
	return channels, nil
}

func (c *Client) CreateChannel(ctx context.Context, auth AdminAuth, channel Channel) error {
	if channel.Name == "" {
		return fmt.Errorf("new-api channel name is required")
	}
	if channel.Key == "" {
		return fmt.Errorf("new-api channel key is required")
	}
	request := AddChannelRequest{Mode: "single", Channel: &channel}
	if channel.ChannelInfo.IsMultiKey {
		request.Mode = "multi_to_single"
		request.MultiKeyMode = channel.ChannelInfo.MultiKeyMode
	}
	var resp apiResponse[json.RawMessage]
	if err := c.do(ctx, http.MethodPost, "/api/channel/", adminHeaders(auth), request, &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("new-api create channel failed: %s", resp.Message)
	}
	return nil
}

func (c *Client) UpdateChannel(ctx context.Context, auth AdminAuth, channel Channel) error {
	if channel.ID == 0 {
		return fmt.Errorf("new-api channel id is required")
	}
	request := UpdateChannelRequest{Channel: channel}
	if channel.ChannelInfo.IsMultiKey {
		request.MultiKeyMode = &channel.ChannelInfo.MultiKeyMode
		if channel.Key != "" {
			keyMode := "replace"
			request.KeyMode = &keyMode
		}
	}
	var resp apiResponse[Channel]
	if err := c.do(ctx, http.MethodPut, "/api/channel/", adminHeaders(auth), request, &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("new-api update channel failed: %s", resp.Message)
	}
	return nil
}

func (c *Client) DeleteChannel(ctx context.Context, auth AdminAuth, channelID int) error {
	if channelID <= 0 {
		return fmt.Errorf("new-api channel id is required")
	}
	var resp apiResponse[json.RawMessage]
	if err := c.do(ctx, http.MethodDelete, fmt.Sprintf("/api/channel/%d", channelID), adminHeaders(auth), nil, &resp); err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("new-api delete channel failed: %s", resp.Message)
	}
	return nil
}

func (c *Client) FetchModels(ctx context.Context, auth AdminAuth, req FetchModelsRequest) ([]string, error) {
	var resp apiResponse[[]string]
	if err := c.do(ctx, http.MethodPost, "/api/channel/fetch_models", adminHeaders(auth), req, &resp); err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("new-api fetch models failed: %s", resp.Message)
	}
	return resp.Data, nil
}

func (c *Client) findTokenID(ctx context.Context, headers map[string]string, name string) (int, error) {
	path := "/api/token/search?keyword=" + url.QueryEscape(name)
	var resp apiResponse[pagedTokens]
	if err := c.do(ctx, http.MethodGet, path, headers, nil, &resp); err != nil {
		return 0, err
	}
	if !resp.Success {
		return 0, fmt.Errorf("new-api search token failed: %s", resp.Message)
	}
	for _, token := range resp.Data.Items {
		if token.Name == name {
			return token.ID, nil
		}
	}
	return 0, fmt.Errorf("new-api token %q not found", name)
}

func (c *Client) getTokenKey(ctx context.Context, headers map[string]string, tokenID int) (string, error) {
	var resp apiResponse[tokenKeyData]
	if err := c.do(ctx, http.MethodPost, fmt.Sprintf("/api/token/%d/key", tokenID), headers, nil, &resp); err != nil {
		return "", err
	}
	if !resp.Success {
		return "", fmt.Errorf("new-api get token key failed: %s", resp.Message)
	}
	if resp.Data.Key == "" {
		return "", fmt.Errorf("new-api returned empty token key")
	}
	return resp.Data.Key, nil
}

func (c *Client) do(ctx context.Context, method string, path string, headers map[string]string, body any, out any) error {
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		if resp.StatusCode == http.StatusNotFound {
			return fmt.Errorf("%w: new-api %s %s returned %d", ErrNotFound, method, path, resp.StatusCode)
		}
		return fmt.Errorf("new-api %s %s returned %d", method, path, resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return err
	}
	return nil
}

func (c *Client) DoRaw(ctx context.Context, method string, path string, rawQuery string, headers http.Header, body []byte) (*http.Response, []byte, error) {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	target := c.baseURL + path
	if rawQuery != "" {
		target += "?" + rawQuery
	}
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.Header = headers.Clone()
	req.ContentLength = int64(len(body))
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp, nil, err
	}
	return resp, raw, nil
}

func adminHeaders(auth AdminAuth) map[string]string {
	return userHeaders(auth.UserID, auth.AccessToken)
}

func userHeaders(userID int, accessToken string) map[string]string {
	headers := map[string]string{"New-Api-User": strconv.Itoa(userID)}
	if accessToken != "" {
		headers["Authorization"] = "Bearer " + accessToken
	}
	return headers
}

type apiResponse[T any] struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    T      `json:"data"`
}

type loginData struct {
	ID         int    `json:"id"`
	Username   string `json:"username"`
	Role       int    `json:"role"`
	Status     int    `json:"status"`
	Group      string `json:"group"`
	Require2FA bool   `json:"require_2fa"`
}

type pagedUsers struct {
	Items []struct {
		ID          int        `json:"id"`
		Username    string     `json:"username"`
		DisplayName string     `json:"display_name"`
		Role        int        `json:"role"`
		Status      int        `json:"status"`
		Group       string     `json:"group"`
		DeletedAt   *time.Time `json:"DeletedAt"`
	} `json:"items"`
}

type pagedChannels struct {
	Items []Channel `json:"items"`
	Total int       `json:"total"`
}

type pagedTokens struct {
	Items []struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	} `json:"items"`
}

type tokenKeyData struct {
	Key string `json:"key"`
}

type subscriptionSummary struct {
	Subscription *UserSubscription `json:"subscription"`
}
