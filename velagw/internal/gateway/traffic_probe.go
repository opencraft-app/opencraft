package gateway

import (
	"context"
	"fmt"
	"strings"
)

const APIKeyPurposeTrafficProbe = "traffic_probe"

type TrafficProbeKeyResult struct {
	Binding APIKeyBinding
	Created bool
}

type DirectTrafficProbeTarget struct {
	UserID      string
	KeyID       string
	SetID       string
	BaseURL     string
	UpstreamKey string
}

func (s *Service) ResolveDirectTrafficProbeTargetForUser(ctx context.Context, userID string) (DirectTrafficProbeTarget, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return DirectTrafficProbeTarget{}, fmt.Errorf("user_id is required")
	}
	bindings, err := s.store.ListAPIKeyBindingsByUser(ctx, userID)
	if err != nil {
		return DirectTrafficProbeTarget{}, err
	}
	for _, binding := range bindings {
		if binding.Status != APIKeyStatusActive || binding.UpstreamKey == "" {
			continue
		}
		set, ok, err := s.store.GetSet(ctx, binding.SetID)
		if err != nil {
			return DirectTrafficProbeTarget{}, err
		}
		if !ok {
			continue
		}
		baseURL := trafficBaseURLForSet(set)
		if baseURL == "" {
			continue
		}
		return DirectTrafficProbeTarget{
			UserID: userID, KeyID: binding.ExternalKeyID, SetID: binding.SetID,
			BaseURL: baseURL, UpstreamKey: binding.UpstreamKey,
		}, nil
	}
	return DirectTrafficProbeTarget{}, fmt.Errorf("active api key for user %q not found", userID)
}

func (s *Service) GetOrCreateTrafficProbeKey(ctx context.Context, externalUserID string) (TrafficProbeKeyResult, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return TrafficProbeKeyResult{}, fmt.Errorf("user_id is required")
	}
	binding, err := s.createExternalKey(ctx, externalUserID, "")
	if err != nil {
		return TrafficProbeKeyResult{}, err
	}
	return TrafficProbeKeyResult{Binding: binding, Created: true}, nil
}

func (s *Service) findTrafficProbeKey(ctx context.Context, externalUserID string) (APIKeyBinding, bool, error) {
	bindings, err := s.store.ListAPIKeyBindingsByUser(ctx, externalUserID)
	if err != nil {
		return APIKeyBinding{}, false, err
	}
	for _, binding := range bindings {
		if binding.Purpose == APIKeyPurposeTrafficProbe && binding.UpstreamKey != "" && binding.Status == APIKeyStatusActive {
			return binding, true, nil
		}
	}
	return APIKeyBinding{}, false, nil
}

func (s *Service) ResolveDirectTrafficProbeTarget(ctx context.Context, externalKey string) (DirectTrafficProbeTarget, error) {
	externalKey = strings.TrimSpace(externalKey)
	if externalKey == "" {
		return DirectTrafficProbeTarget{}, fmt.Errorf("api_key is required")
	}
	binding, ok, err := s.store.GetAPIKeyBindingByExternalKey(ctx, externalKey)
	if err != nil {
		return DirectTrafficProbeTarget{}, err
	}
	if !ok {
		return DirectTrafficProbeTarget{}, fmt.Errorf("external key not found")
	}
	if strings.TrimSpace(binding.SetID) == "" || strings.TrimSpace(binding.UpstreamKey) == "" {
		return DirectTrafficProbeTarget{}, fmt.Errorf("external key route is incomplete")
	}
	set, ok, err := s.store.GetSet(ctx, binding.SetID)
	if err != nil {
		return DirectTrafficProbeTarget{}, err
	}
	if !ok {
		return DirectTrafficProbeTarget{}, fmt.Errorf("set %q not found", binding.SetID)
	}
	baseURL := strings.TrimRight(strings.TrimSpace(set.TrafficBaseURL), "/")
	if baseURL == "" {
		baseURL = strings.TrimRight(strings.TrimSpace(set.BaseURL), "/")
	}
	if baseURL == "" {
		return DirectTrafficProbeTarget{}, fmt.Errorf("set %q traffic base url is empty", binding.SetID)
	}
	return DirectTrafficProbeTarget{
		UserID:      binding.UserID,
		KeyID:       binding.ExternalKeyID,
		SetID:       binding.SetID,
		BaseURL:     baseURL,
		UpstreamKey: binding.UpstreamKey,
	}, nil
}
