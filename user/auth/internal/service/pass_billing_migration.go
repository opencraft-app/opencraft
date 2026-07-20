package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

type PassBillingMigrationNotifier interface {
	NotifyShadowBound(ctx context.Context, binding shadowbinding.Binding) error
}

type PassBillingMigrationNotifierConfig struct {
	BaseURL string
	Token   string
	Timeout time.Duration
}

type httpPassBillingMigrationNotifier struct {
	baseURL string
	token   string
	client  *http.Client
}

func NewHTTPPassBillingMigrationNotifier(cfg PassBillingMigrationNotifierConfig) PassBillingMigrationNotifier {
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	token := strings.TrimSpace(cfg.Token)
	if baseURL == "" || token == "" {
		return nil
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &httpPassBillingMigrationNotifier{
		baseURL: baseURL,
		token:   token,
		client:  &http.Client{Timeout: timeout},
	}
}

func (n *httpPassBillingMigrationNotifier) NotifyShadowBound(ctx context.Context, binding shadowbinding.Binding) error {
	if n == nil {
		return nil
	}
	if strings.TrimSpace(binding.UserID) == "" || binding.Uin <= 0 || binding.AppID <= 0 || binding.Status != shadowbinding.StatusActive {
		return nil
	}
	body, err := json.Marshal(map[string]interface{}{
		"user_id": binding.UserID,
		"uin":     binding.Uin,
		"app_id":  binding.AppID,
	})
	if err != nil {
		return fmt.Errorf("marshal pass billing migration request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.baseURL+"/internal/ctl/passes/billing-migration", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build pass billing migration request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+n.token)

	resp, err := n.client.Do(req)
	if err != nil {
		return fmt.Errorf("call ctl pass billing migration: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("ctl pass billing migration status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

func (s *Service) notifyPassBillingMigration(ctx context.Context, binding shadowbinding.Binding) {
	if s == nil || s.passBillingMigrationNotifier == nil {
		return
	}
	if binding.Status != shadowbinding.StatusActive || binding.UserID == "" || binding.Uin <= 0 || binding.AppID <= 0 {
		return
	}
	notifyCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := s.passBillingMigrationNotifier.NotifyShadowBound(notifyCtx, binding); err != nil {
		slog.WarnContext(ctx, "pass billing migration notification failed",
			"user_id", binding.UserID,
			"uin", binding.Uin,
			"app_id", binding.AppID,
			"err", err)
	}
}
