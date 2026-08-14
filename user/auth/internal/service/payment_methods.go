package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/paymentmethod"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

const maxPaymentMethodContractCodeLength = 128

func (s *Service) ListPaymentMethods(ctx context.Context, token string, page, pageSize int, clientIP, clientUA string) (paymentmethod.ListResult, error) {
	if page < 1 || pageSize < 1 || pageSize > 100 {
		return paymentmethod.ListResult{}, newError("invalid_payment_method_pagination", "分页参数不合法。", http.StatusBadRequest)
	}
	session, err := s.paymentMethodSession(ctx, token)
	if err != nil {
		return paymentmethod.ListResult{}, err
	}
	credentials, err := s.paymentMethodCredentialsForUser(ctx, session.User.ID, clientIP, clientUA)
	if err != nil {
		return paymentmethod.ListResult{}, err
	}
	result, err := s.paymentMethods.List(ctx, credentials, paymentmethod.ListInput{Page: page, PageSize: pageSize})
	if err != nil {
		return paymentmethod.ListResult{}, paymentMethodProviderError(ctx, "DescribeSignInfo", err)
	}
	return result, nil
}

func (s *Service) CreatePaymentMethodSignOrder(ctx context.Context, token string, input paymentmethod.CreateSignOrderInput, clientIP, clientUA string) (paymentmethod.CreateSignOrderResult, error) {
	session, err := s.paymentMethodSession(ctx, token)
	if err != nil {
		return paymentmethod.CreateSignOrderResult{}, err
	}
	if err := s.enforcePaymentMethodSignOrderLimit(ctx, session.User.ID); err != nil {
		return paymentmethod.CreateSignOrderResult{}, err
	}
	credentials, err := s.paymentMethodCredentialsForUser(ctx, session.User.ID, clientIP, clientUA)
	if err != nil {
		return paymentmethod.CreateSignOrderResult{}, err
	}
	result, err := s.paymentMethods.CreateSignOrder(ctx, credentials, input)
	if err != nil {
		return paymentmethod.CreateSignOrderResult{}, paymentMethodProviderError(ctx, "CreateSignOrder", err)
	}
	return result, nil
}

func (s *Service) SetDefaultPaymentMethod(ctx context.Context, token, contractCode, clientIP, clientUA string) error {
	contractCode, err := validatePaymentMethodContractCode(contractCode)
	if err != nil {
		return err
	}
	session, err := s.paymentMethodSession(ctx, token)
	if err != nil {
		return err
	}
	credentials, err := s.paymentMethodCredentialsForUser(ctx, session.User.ID, clientIP, clientUA)
	if err != nil {
		return err
	}
	if err := s.paymentMethods.SetDefault(ctx, credentials, contractCode); err != nil {
		return paymentMethodProviderError(ctx, "ModifySignInfo", err)
	}
	return nil
}

func (s *Service) DeletePaymentMethod(ctx context.Context, token, contractCode, clientIP, clientUA string) error {
	contractCode, err := validatePaymentMethodContractCode(contractCode)
	if err != nil {
		return err
	}
	session, err := s.paymentMethodSession(ctx, token)
	if err != nil {
		return err
	}
	credentials, err := s.paymentMethodCredentialsForUser(ctx, session.User.ID, clientIP, clientUA)
	if err != nil {
		return err
	}
	if err := s.paymentMethods.Delete(ctx, credentials, contractCode); err != nil {
		if paymentmethod.IsDefaultCardDeleteError(err) {
			return newError(
				"default_payment_method_cannot_delete",
				"默认卡不能解绑，请先将其他卡设为默认卡。",
				http.StatusConflict,
			)
		}
		return paymentMethodProviderError(ctx, "DeleteSignInfo", err)
	}
	return nil
}

func (s *Service) paymentMethodSession(ctx context.Context, token string) (*AuthSession, error) {
	if s == nil || s.siteKind != shadowbinding.SiteKindIntl || s.paymentMethods == nil {
		return nil, newError("payment_methods_unavailable", "签约卡管理暂未开放。", http.StatusServiceUnavailable)
	}
	session, err := s.CurrentSession(ctx, token)
	if err != nil {
		return nil, err
	}
	return session, nil
}

func (s *Service) paymentMethodCredentialsForUser(ctx context.Context, userID, clientIP, clientUA string) (paymentmethod.TemporaryCredentials, error) {
	if s.shadowBinding == nil || !s.shadowBinding.Enabled() {
		return paymentmethod.TemporaryCredentials{}, newError("shadow_binding_disabled", "腾讯云账号绑定暂未启用。", http.StatusServiceUnavailable)
	}
	binding, err := s.shadowBinding.GetBindingByUserID(ctx, strings.TrimSpace(userID))
	if err != nil {
		if errors.Is(err, shadowbinding.ErrNotFound) {
			return paymentmethod.TemporaryCredentials{}, newError("shadow_binding_not_ready", "腾讯云账号绑定尚未完成。", http.StatusConflict)
		}
		return paymentmethod.TemporaryCredentials{}, err
	}
	if binding.Status != shadowbinding.StatusActive {
		return paymentmethod.TemporaryCredentials{}, newError("shadow_binding_not_ready", "腾讯云账号绑定尚未完成。", http.StatusConflict)
	}
	if binding.Uin <= 0 || binding.OwnerUin <= 0 {
		return paymentmethod.TemporaryCredentials{}, newError("shadow_binding_not_ready", "腾讯云账号绑定尚未完成。", http.StatusConflict)
	}
	credentials, err := s.shadowBinding.IssueTemporaryCredentials(ctx, binding.UserID, clientIP, clientUA)
	if err != nil {
		return paymentmethod.TemporaryCredentials{}, newError("shadow_credentials_unavailable", "腾讯云账号凭据暂不可用。", http.StatusBadGateway)
	}
	return paymentmethod.TemporaryCredentials{
		SecretID:  credentials.TmpSecretID,
		SecretKey: credentials.TmpSecretKey,
		Token:     credentials.Token,
		ExpiresAt: credentials.ExpiredTime,
	}, nil
}

func (s *Service) enforcePaymentMethodSignOrderLimit(ctx context.Context, userID string) error {
	attempts, retryAfter, err := s.store.IncrementVerificationRateLimit(ctx, VerificationRateLimitKey{
		Scope:       "payment_method:sign_order:user",
		SubjectHash: verificationSubjectHash(userID),
	}, s.now(), s.paymentMethodSignOrderWindow)
	if err != nil {
		return fmt.Errorf("increment payment method sign order rate limit: %w", err)
	}
	if attempts <= s.paymentMethodSignOrderLimit {
		return nil
	}
	return &Error{
		Code:       "payment_method_rate_limited",
		Message:    "绑卡请求过于频繁，请稍后再试。",
		Status:     http.StatusTooManyRequests,
		RetryAfter: retryAfter,
	}
}

func validatePaymentMethodContractCode(contractCode string) (string, error) {
	contractCode = strings.TrimSpace(contractCode)
	if contractCode == "" || len(contractCode) > maxPaymentMethodContractCodeLength {
		return "", newError("invalid_payment_method", "签约卡标识不合法。", http.StatusBadRequest)
	}
	return contractCode, nil
}

func paymentMethodProviderError(ctx context.Context, operation string, err error) error {
	if err == nil {
		return nil
	}
	attributes := []any{"operation", operation}
	var cloudErr *paymentmethod.CloudError
	if errors.As(err, &cloudErr) {
		attributes = append(attributes, "provider_code", cloudErr.Code, "request_id", cloudErr.RequestID)
	} else {
		attributes = append(attributes, "err", err)
	}
	slog.WarnContext(ctx, "payment method provider request failed", attributes...)
	return newError("payment_method_provider_error", "签约卡服务请求失败，请稍后重试。", http.StatusBadGateway)
}
