package service

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"git.woa.com/wisp/mono/referral/internal/domain"
	"git.woa.com/wisp/mono/referral/internal/events"
	"git.woa.com/wisp/mono/referral/internal/store"
)

const referralAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

type Service struct {
	store         store.Store
	now           func() time.Time
	publicBaseURL string
}

type Me struct {
	Code         string    `json:"code"`
	URL          string    `json:"url"`
	CampaignID   string    `json:"campaign_id"`
	CampaignName string    `json:"campaign_name"`
	StartsAt     time.Time `json:"starts_at"`
	EndsAt       time.Time `json:"ends_at"`
}

func New(st store.Store, publicBaseURL string) *Service {
	return &Service{store: st, now: time.Now, publicBaseURL: strings.TrimRight(strings.TrimSpace(publicBaseURL), "/")}
}

func (s *Service) ResolveCode(ctx context.Context, code string) (*domain.CodeResolution, error) {
	return s.store.ResolveCode(ctx, code, s.now().UTC())
}

func (s *Service) IssueCode(ctx context.Context, userID string) (*Me, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, fmt.Errorf("user_id is required")
	}
	campaign, err := s.store.ActiveCampaign(ctx, s.now().UTC())
	if err != nil {
		return nil, err
	}
	if existing, err := s.store.CodeForOwner(ctx, campaign.ID, userID); err == nil {
		return s.me(campaign, existing), nil
	} else if !errors.Is(err, domain.ErrCodeNotFound) {
		return nil, err
	}

	for attempt := 0; attempt < 8; attempt++ {
		codeValue, err := generateCode(10)
		if err != nil {
			return nil, err
		}
		code := &domain.Code{Code: codeValue, CampaignID: campaign.ID, OwnerUserID: userID, CreatedAt: s.now().UTC()}
		if err := s.store.CreateCode(ctx, code); err == nil {
			return s.me(campaign, code), nil
		} else if !errors.Is(err, domain.ErrCodeConflict) {
			return nil, err
		}
		if existing, lookupErr := s.store.CodeForOwner(ctx, campaign.ID, userID); lookupErr == nil {
			return s.me(campaign, existing), nil
		}
	}
	return nil, fmt.Errorf("allocate unique referral code")
}

func (s *Service) Me(ctx context.Context, userID string) (*Me, error) {
	userID = strings.TrimSpace(userID)
	campaign, err := s.store.ActiveCampaign(ctx, s.now().UTC())
	if err != nil {
		return nil, err
	}
	code, err := s.store.CodeForOwner(ctx, campaign.ID, userID)
	if err != nil {
		return nil, err
	}
	return s.me(campaign, code), nil
}

func (s *Service) Stats(ctx context.Context, userID string) (domain.Stats, error) {
	return s.store.StatsForUser(ctx, strings.TrimSpace(userID))
}

func (s *Service) Ingest(ctx context.Context, raw []byte) error {
	event, err := events.Decode(raw)
	if err != nil {
		return err
	}
	switch event.EventType {
	case events.TypeUserRegistered:
		var payload events.UserRegistered
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			return fmt.Errorf("decode user.registered.v1: %w", err)
		}
		return s.store.RecordRegistration(ctx, event, payload)
	case events.TypeUserReferralClaimed:
		var payload events.UserReferralClaimed
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			return fmt.Errorf("decode user.referral_claimed.v1: %w", err)
		}
		return s.store.RecordClaim(ctx, event, payload)
	case events.TypePassFirstPaid:
		var payload events.PassFirstPaid
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			return fmt.Errorf("decode pass.first_paid.v1: %w", err)
		}
		return s.store.RecordFirstPaid(ctx, event, payload)
	case events.TypePassRefunded:
		var payload events.PassRefunded
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			return fmt.Errorf("decode pass.refunded.v1: %w", err)
		}
		return s.store.RecordRefunded(ctx, event, payload)
	default:
		return fmt.Errorf("unsupported referral event type %q", event.EventType)
	}
}

func (s *Service) me(campaign *domain.Campaign, code *domain.Code) *Me {
	return &Me{
		Code:         code.Code,
		URL:          s.publicBaseURL + "/?ref=" + code.Code,
		CampaignID:   campaign.ID,
		CampaignName: campaign.Name,
		StartsAt:     campaign.StartsAt,
		EndsAt:       campaign.EndsAt,
	}
}

func generateCode(length int) (string, error) {
	if length <= 0 {
		return "", fmt.Errorf("referral code length must be positive")
	}
	raw := make([]byte, length)
	if _, err := cryptorand.Read(raw); err != nil {
		return "", err
	}
	for i := range raw {
		raw[i] = referralAlphabet[int(raw[i])%len(referralAlphabet)]
	}
	return string(raw), nil
}
