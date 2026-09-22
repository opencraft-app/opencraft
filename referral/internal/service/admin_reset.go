package service

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"git.woa.com/wisp/mono/referral/internal/ctlclient"
	"git.woa.com/wisp/mono/referral/internal/domain"
)

type creditRevoker interface {
	Revoke(context.Context, ctlclient.RevokeRequest) error
}

type AttributionResetInput struct {
	InviteeUserID         string `json:"-"`
	ExpectedAttributionID string `json:"expected_attribution_id"`
	IdempotencyKey        string `json:"idempotency_key"`
	Operator              string `json:"operator"`
	Reason                string `json:"reason"`
}

func (s *Service) PreviewAttributionReset(ctx context.Context, inviteeUserID, attributionID string) (*domain.AttributionResetPreview, error) {
	if s.adminStore == nil {
		return nil, fmt.Errorf("referral admin store is not configured")
	}
	preview, err := s.adminStore.AttributionResetPreview(ctx, strings.TrimSpace(inviteeUserID), strings.TrimSpace(attributionID))
	if err != nil {
		return nil, err
	}
	preview.Resettable = true
	preview.BlockReason = ""
	if err := validateAttributionResetPreview(preview); err != nil {
		preview.Resettable = false
		preview.BlockReason = err.Error()
	}
	return preview, nil
}

func (s *Service) ResetAttribution(ctx context.Context, input AttributionResetInput) (*domain.AttributionResetResult, error) {
	input.InviteeUserID = strings.TrimSpace(input.InviteeUserID)
	input.ExpectedAttributionID = strings.TrimSpace(input.ExpectedAttributionID)
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	input.Operator = strings.TrimSpace(input.Operator)
	input.Reason = strings.TrimSpace(input.Reason)
	if input.InviteeUserID == "" || input.ExpectedAttributionID == "" || input.IdempotencyKey == "" || input.Operator == "" || input.Reason == "" {
		return nil, fmt.Errorf("invitee_user_id, expected_attribution_id, idempotency_key, operator and reason are required")
	}
	if len(input.IdempotencyKey) > 191 || len(input.Operator) > 128 || len(input.Reason) > 512 {
		return nil, fmt.Errorf("attribution reset input exceeds maximum length")
	}
	if s.adminStore == nil || s.creditRevoker == nil {
		return nil, fmt.Errorf("referral attribution reset is not configured")
	}
	if existing, err := s.adminStore.AttributionResetResult(ctx, input.IdempotencyKey); err != nil {
		return nil, err
	} else if existing != nil {
		if existing.InviteeUserID != input.InviteeUserID || existing.AttributionID != input.ExpectedAttributionID {
			return nil, domain.ErrAttributionResetConflict
		}
		return existing, nil
	}

	preview, err := s.PreviewAttributionReset(ctx, input.InviteeUserID, input.ExpectedAttributionID)
	if err != nil {
		return nil, err
	}
	if preview.Attribution.ID != input.ExpectedAttributionID {
		return nil, domain.ErrAttributionResetConflict
	}
	if !preview.Resettable {
		return nil, fmt.Errorf("%w: %s", domain.ErrAttributionResetConflict, preview.BlockReason)
	}
	grouped := make(map[string][]string)
	for _, reward := range preview.Rewards {
		if strings.TrimSpace(reward.SubscriptionName) == "" {
			continue
		}
		grouped[reward.BeneficiaryUserID] = append(grouped[reward.BeneficiaryUserID], reward.SubscriptionName)
	}
	users := make([]string, 0, len(grouped))
	for userID := range grouped {
		users = append(users, userID)
	}
	sort.Strings(users)
	for _, userID := range users {
		names := grouped[userID]
		sort.Strings(names)
		if err := s.creditRevoker.Revoke(ctx, ctlclient.RevokeRequest{UserID: userID, SubscriptionNames: names}); err != nil {
			return nil, fmt.Errorf("revoke referral credit for %s: %w", userID, err)
		}
	}
	return s.adminStore.CompleteAttributionReset(ctx, *preview, input.IdempotencyKey, input.Operator, input.Reason, s.now().UTC())
}

func validateAttributionResetPreview(preview *domain.AttributionResetPreview) error {
	if preview == nil || strings.TrimSpace(preview.Attribution.ID) == "" {
		return domain.ErrAttributionNotFound
	}
	for _, reward := range preview.Rewards {
		if strings.TrimSpace(reward.SubscriptionName) != "" && strings.TrimSpace(reward.BeneficiaryUserID) == "" {
			return fmt.Errorf("%w: reward %s has a subscription without beneficiary", domain.ErrAttributionResetConflict, reward.ID)
		}
		switch reward.Status {
		case domain.RewardStatusCancelled:
			if strings.TrimSpace(reward.SubscriptionName) != "" && !strings.HasPrefix(strings.TrimSpace(reward.SubscriptionName), "free-credit:") {
				return fmt.Errorf("%w: cancelled reward %s has an invalid subscription name", domain.ErrAttributionResetConflict, reward.ID)
			}
		case domain.RewardStatusGranted:
			if strings.TrimSpace(reward.BeneficiaryUserID) == "" || !strings.HasPrefix(strings.TrimSpace(reward.SubscriptionName), "free-credit:") {
				return fmt.Errorf("%w: granted reward %s has no exact free-credit subscription", domain.ErrAttributionResetConflict, reward.ID)
			}
		default:
			return fmt.Errorf("%w: reward %s is in status %s", domain.ErrAttributionResetConflict, reward.ID, reward.Status)
		}
	}
	return nil
}
