// Package shadow 提供 shadow 服务的 HTTP 适配器，用于查询用户绑定信息。
package shadow

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"go.uber.org/zap"
)

// Binding shadow 服务的绑定信息
type Binding struct {
	UserID          string `json:"user_id"`
	ShadowUserName  string `json:"shadow_user_name"`
	Uin             int64  `json:"uin"`
	OwnerUin        int64  `json:"owner_uin"`
	AppID           int64  `json:"app_id"`
	InstanceID      string `json:"instance_id"`
	CountryCode     string `json:"country_code"`
	PhoneNumber     string `json:"phone_number"`
	CreatedAt       string `json:"created_at"`
}

// Adapter shadow 服务适配器接口
type Adapter interface {
	// GetBindingByUserID 查询指定用户的绑定信息
	GetBindingByUserID(userID string) (*Binding, error)
}

// Config shadow 适配器配置
type Config struct {
	BaseURL string `toml:"base_url"`
	Token   string `toml:"token"`
	Timeout int    `toml:"timeout"` // 请求超时（秒），默认 10
}

type adapter struct {
	config *Config
	client *http.Client
	logger *zap.Logger
}

// NewShadowAdapter 创建 shadow 适配器
func NewShadowAdapter(cfg *Config, logger *zap.Logger) Adapter {
	if cfg == nil {
		cfg = &Config{}
	}
	timeout := time.Duration(cfg.Timeout) * time.Second
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &adapter{
		config: cfg,
		client: &http.Client{Timeout: timeout},
		logger: logger,
	}
}

type bindingResponse struct {
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Data    *Binding `json:"data"`
}

func (a *adapter) GetBindingByUserID(userID string) (*Binding, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("shadow adapter: base_url not configured")
	}

	url := fmt.Sprintf("%s/internal/shadow/binding?user_id=%s", a.config.BaseURL, userID)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("shadow adapter: build request: %w", err)
	}
	if a.config.Token != "" {
		req.Header.Set("Authorization", "Bearer "+a.config.Token)
	}

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("shadow adapter: request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("shadow adapter: unexpected status %d", resp.StatusCode)
	}

	var result bindingResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("shadow adapter: decode response: %w", err)
	}

	return result.Data, nil
}
