package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"git.woa.com/wisp/mono2/llmgateway/internal/newapi"
)

var ErrChannelSpecNotFound = fmt.Errorf("channel spec not found")

func (s *Service) UpsertChannelSpec(ctx context.Context, spec ChannelSpec) (ChannelSpec, error) {
	spec.ID = strings.TrimSpace(spec.ID)
	spec.Name = strings.TrimSpace(spec.Name)
	spec.BaseURL = strings.TrimRight(strings.TrimSpace(spec.BaseURL), "/")
	spec.Models = strings.TrimSpace(spec.Models)
	spec.Group = strings.TrimSpace(spec.Group)
	spec.Status = strings.TrimSpace(spec.Status)
	if spec.ID == "" {
		return ChannelSpec{}, fmt.Errorf("channel id is required")
	}
	if spec.Name == "" {
		return ChannelSpec{}, fmt.Errorf("channel name is required")
	}
	if spec.Type == 0 {
		return ChannelSpec{}, fmt.Errorf("channel type is required")
	}
	if spec.Group == "" {
		spec.Group = "default"
	}
	if spec.Status == "" {
		spec.Status = ChannelSpecStatusEnabled
	}
	if spec.Status != ChannelSpecStatusEnabled && spec.Status != ChannelSpecStatusDisabled {
		return ChannelSpec{}, fmt.Errorf("unsupported channel status %q", spec.Status)
	}
	if spec.AutoBan == nil {
		autoBan := 1
		spec.AutoBan = &autoBan
	}
	if spec.IsMultiKey {
		if spec.MultiKeyMode == "" {
			spec.MultiKeyMode = "random"
		}
		if spec.MultiKeyMode != "random" && spec.MultiKeyMode != "polling" {
			return ChannelSpec{}, fmt.Errorf("unsupported multi_key_mode %q", spec.MultiKeyMode)
		}
	} else {
		spec.MultiKeyMode = ""
	}
	if existing, ok, err := s.store.GetChannelSpec(ctx, spec.ID); err != nil {
		return ChannelSpec{}, err
	} else if ok && spec.Key == "" {
		spec.Key = existing.Key
		spec.KeyHash = existing.KeyHash
	}
	if spec.Key != "" {
		spec.KeyHash = hashSecret(spec.Key)
	}
	spec.DesiredRemoteName = desiredChannelRemoteName(spec)
	spec.Fingerprint = channelSpecFingerprint(spec)
	if err := s.store.SaveChannelSpec(ctx, spec); err != nil {
		return ChannelSpec{}, err
	}
	if err := s.markChannelPendingForSyncTargets(ctx, spec); err != nil {
		return ChannelSpec{}, err
	}
	stored, _, err := s.store.GetChannelSpec(ctx, spec.ID)
	return stored, err
}

func (s *Service) ListChannelSummaries(ctx context.Context) ([]ChannelSyncSummary, error) {
	specs, err := s.store.ListChannelSpecs(ctx)
	if err != nil {
		return nil, err
	}
	summaries := make([]ChannelSyncSummary, 0, len(specs))
	for _, spec := range specs {
		states, err := s.store.ListChannelSyncStates(ctx, spec.ID)
		if err != nil {
			return nil, err
		}
		summaries = append(summaries, ChannelSyncSummary{Spec: spec, States: states})
	}
	return summaries, nil
}

func (s *Service) FetchChannelModels(ctx context.Context, input ChannelModelFetchInput) ([]string, error) {
	input.BaseURL = strings.TrimRight(strings.TrimSpace(input.BaseURL), "/")
	input.Key = strings.TrimSpace(input.Key)
	if input.Type == 0 {
		return nil, fmt.Errorf("channel type is required")
	}
	if input.BaseURL == "" {
		return nil, fmt.Errorf("base url is required")
	}
	if input.Key == "" {
		return nil, fmt.Errorf("provider key is required")
	}
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return nil, err
	}
	var lastErr error
	for _, set := range sets {
		if set.Status != SetStatusActive || !set.Setup || set.AdminUserID == 0 || set.AdminAccessToken == "" {
			continue
		}
		models, err := s.newAPIClient(set.BaseURL).FetchModels(ctx, adminAuthForSet(set), newapi.FetchModelsRequest{
			Type:    input.Type,
			BaseURL: input.BaseURL,
			Key:     input.Key,
		})
		if err == nil {
			return models, nil
		}
		lastErr = err
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("no active bootstrapped set available to fetch channel models")
}

func (s *Service) SyncChannelToSet(ctx context.Context, channelID string, setID string, opts ChannelSyncOptions) (ChannelSyncState, error) {
	spec, ok, err := s.store.GetChannelSpec(ctx, strings.TrimSpace(channelID))
	if err != nil {
		return ChannelSyncState{}, err
	}
	if !ok {
		return ChannelSyncState{}, ErrChannelSpecNotFound
	}
	return s.syncChannelSpecToSet(ctx, spec, setID, opts)
}

func (s *Service) syncChannelSpecToSet(ctx context.Context, spec ChannelSpec, setID string, opts ChannelSyncOptions) (ChannelSyncState, error) {
	set, ok, err := s.store.GetSet(ctx, strings.TrimSpace(setID))
	if err != nil {
		return ChannelSyncState{}, err
	}
	if !ok {
		return ChannelSyncState{}, fmt.Errorf("set %q not found", setID)
	}
	state, _, err := s.store.GetChannelSyncState(ctx, spec.ID, set.ID)
	if err != nil {
		return ChannelSyncState{}, err
	}
	state.ChannelID = spec.ID
	state.SetID = set.ID
	state.DesiredFingerprint = spec.Fingerprint
	state.LastCheckedAt = s.nowUTC()

	if set.Status != SetStatusActive || !set.Setup || set.AdminUserID == 0 || set.AdminAccessToken == "" {
		state.Status = ChannelSyncStatusSkipped
		state.LastError = "set is not active and bootstrapped"
		_ = s.store.SaveChannelSyncState(ctx, state)
		return state, nil
	}

	client := s.newAPIClient(set.BaseURL)
	auth := adminAuthForSet(set)
	remote, found, err := s.findRemoteChannel(ctx, client, auth, spec)
	if err != nil {
		return s.failChannelSync(ctx, state, err)
	}
	createdRemote := false
	if !found {
		if opts.CheckOnly {
			state.Status = ChannelSyncStatusPending
			state.LastError = ""
			_ = s.store.SaveChannelSyncState(ctx, state)
			return state, nil
		}
		if err := client.CreateChannel(ctx, auth, newAPIChannelFromSpec(spec, 0, true)); err != nil {
			return s.failChannelSync(ctx, state, err)
		}
		createdRemote = true
		remote, found, err = s.findRemoteChannel(ctx, client, auth, spec)
		if err != nil {
			return s.failChannelSync(ctx, state, err)
		}
		if !found {
			return s.failChannelSync(ctx, state, fmt.Errorf("new-api channel was created but could not be found by name %q", spec.DesiredRemoteName))
		}
		if err := client.UpdateChannel(ctx, auth, newAPIChannelFromSpec(spec, remote.ID, true)); err != nil {
			return s.failChannelSync(ctx, state, err)
		}
		remote, _, err = s.findRemoteChannel(ctx, client, auth, spec)
		if err != nil {
			return s.failChannelSync(ctx, state, err)
		}
	}

	remoteFingerprint := remoteChannelFingerprint(remote)
	state.RemoteChannelID = remote.ID
	state.RemoteFingerprint = remoteFingerprint
	if remoteFingerprint == spec.Fingerprint && state.LastAppliedKeyHash == spec.KeyHash {
		state.Status = ChannelSyncStatusSynced
		state.LastError = ""
		state.AppliedFingerprint = spec.Fingerprint
		state.LastSyncedAt = s.nowUTC()
		if err := s.store.SaveChannelSyncState(ctx, state); err != nil {
			return ChannelSyncState{}, err
		}
		return state, nil
	}
	if state.AppliedFingerprint != "" && remoteFingerprint != state.AppliedFingerprint && !opts.ForceDrift {
		state.Status = ChannelSyncStatusDrift
		state.LastError = "remote channel differs from last applied llmgateway state"
		_ = s.store.SaveChannelSyncState(ctx, state)
		return state, nil
	}
	if opts.CheckOnly {
		if remoteFingerprint == spec.Fingerprint && state.LastAppliedKeyHash == spec.KeyHash {
			state.Status = ChannelSyncStatusSynced
			state.LastError = ""
		} else {
			state.Status = ChannelSyncStatusPending
			state.LastError = ""
		}
		_ = s.store.SaveChannelSyncState(ctx, state)
		return state, nil
	}
	if !createdRemote && (remoteFingerprint != spec.Fingerprint || state.LastAppliedKeyHash != spec.KeyHash) {
		withKey := state.LastAppliedKeyHash != spec.KeyHash
		if err := client.UpdateChannel(ctx, auth, newAPIChannelFromSpec(spec, remote.ID, withKey)); err != nil {
			return s.failChannelSync(ctx, state, err)
		}
		remote, _, err = s.findRemoteChannel(ctx, client, auth, spec)
		if err != nil {
			return s.failChannelSync(ctx, state, err)
		}
		state.RemoteFingerprint = remoteChannelFingerprint(remote)
	}
	state.Status = ChannelSyncStatusSynced
	state.LastError = ""
	state.AppliedFingerprint = spec.Fingerprint
	state.LastAppliedKeyHash = spec.KeyHash
	state.LastSyncedAt = s.nowUTC()
	if err := s.store.SaveChannelSyncState(ctx, state); err != nil {
		return ChannelSyncState{}, err
	}
	return state, nil
}

func (s *Service) markChannelPendingForSyncTargets(ctx context.Context, spec ChannelSpec) error {
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return err
	}
	for _, set := range sets {
		if set.Status != SetStatusActive || !set.Setup {
			continue
		}
		state, _, err := s.store.GetChannelSyncState(ctx, spec.ID, set.ID)
		if err != nil {
			return err
		}
		state.ChannelID = spec.ID
		state.SetID = set.ID
		state.DesiredFingerprint = spec.Fingerprint
		if state.AppliedFingerprint != spec.Fingerprint || state.LastAppliedKeyHash != spec.KeyHash {
			state.Status = ChannelSyncStatusPending
		}
		if err := s.store.SaveChannelSyncState(ctx, state); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) findRemoteChannel(ctx context.Context, client *newapi.Client, auth newapi.AdminAuth, spec ChannelSpec) (newapi.Channel, bool, error) {
	channels, err := client.SearchChannels(ctx, auth, spec.DesiredRemoteName)
	if err != nil {
		return newapi.Channel{}, false, err
	}
	var matches []newapi.Channel
	for _, channel := range channels {
		if channel.Name == spec.DesiredRemoteName {
			matches = append(matches, channel)
		}
	}
	if len(matches) > 1 {
		return newapi.Channel{}, false, fmt.Errorf("remote channel name conflict for %q", spec.DesiredRemoteName)
	}
	if len(matches) == 0 {
		return newapi.Channel{}, false, nil
	}
	return matches[0], true, nil
}

func (s *Service) failChannelSync(ctx context.Context, state ChannelSyncState, err error) (ChannelSyncState, error) {
	state.Status = ChannelSyncStatusError
	state.LastError = err.Error()
	_ = s.store.SaveChannelSyncState(ctx, state)
	return state, err
}

func desiredChannelRemoteName(spec ChannelSpec) string {
	return fmt.Sprintf("llmgw:%s:%s", spec.ID, spec.Name)
}

func newAPIChannelFromSpec(spec ChannelSpec, remoteID int, includeKey bool) newapi.Channel {
	status := newapi.ChannelStatusEnabled
	if spec.Status == ChannelSpecStatusDisabled {
		status = newapi.ChannelStatusManuallyDisabled
	}
	channel := newapi.Channel{
		ID:                 remoteID,
		Name:               spec.DesiredRemoteName,
		Type:               spec.Type,
		Status:             status,
		Models:             spec.Models,
		Group:              spec.Group,
		BaseURL:            pointerToString(spec.BaseURL),
		ModelMapping:       pointerToString(spec.ModelMapping),
		Priority:           pointerToInt64(spec.Priority),
		Weight:             pointerToUint(spec.Weight),
		AutoBan:            cloneIntPointer(spec.AutoBan),
		Tag:                pointerToString(spec.Tag),
		Setting:            pointerToString(spec.Setting),
		ParamOverride:      pointerToString(spec.ParamOverride),
		HeaderOverride:     pointerToString(spec.HeaderOverride),
		Remark:             pointerToString(spec.Remark),
		Other:              spec.Other,
		StatusCodeMapping:  pointerToString(spec.StatusCodeMapping),
		OtherSettings:      spec.OtherSettings,
		OpenAIOrganization: pointerToString(spec.OpenAIOrganization),
		TestModel:          pointerToString(spec.TestModel),
		ChannelInfo: newapi.ChannelInfo{
			IsMultiKey:   spec.IsMultiKey,
			MultiKeyMode: spec.MultiKeyMode,
		},
	}
	if includeKey {
		channel.Key = spec.Key
	}
	return channel
}

func channelSpecFingerprint(spec ChannelSpec) string {
	return fingerprintJSON(channelFingerprintPayload{
		Name:               spec.DesiredRemoteName,
		Type:               spec.Type,
		Status:             spec.Status,
		BaseURL:            spec.BaseURL,
		Models:             spec.Models,
		Group:              spec.Group,
		ModelMapping:       spec.ModelMapping,
		Priority:           spec.Priority,
		Weight:             spec.Weight,
		Setting:            spec.Setting,
		ParamOverride:      spec.ParamOverride,
		HeaderOverride:     spec.HeaderOverride,
		Remark:             spec.Remark,
		AutoBan:            spec.AutoBan,
		Tag:                spec.Tag,
		Other:              spec.Other,
		StatusCodeMapping:  spec.StatusCodeMapping,
		OtherSettings:      spec.OtherSettings,
		OpenAIOrganization: spec.OpenAIOrganization,
		TestModel:          spec.TestModel,
		IsMultiKey:         spec.IsMultiKey,
		MultiKeyMode:       spec.MultiKeyMode,
	})
}

func remoteChannelFingerprint(channel newapi.Channel) string {
	status := ChannelSpecStatusEnabled
	if channel.Status == newapi.ChannelStatusManuallyDisabled {
		status = ChannelSpecStatusDisabled
	}
	return fingerprintJSON(channelFingerprintPayload{
		Name:               channel.Name,
		Type:               channel.Type,
		Status:             status,
		BaseURL:            derefString(channel.BaseURL),
		Models:             channel.Models,
		Group:              channel.Group,
		ModelMapping:       derefString(channel.ModelMapping),
		Priority:           derefInt64(channel.Priority),
		Weight:             derefUint(channel.Weight),
		Setting:            derefString(channel.Setting),
		ParamOverride:      derefString(channel.ParamOverride),
		HeaderOverride:     derefString(channel.HeaderOverride),
		Remark:             derefString(channel.Remark),
		AutoBan:            autoBanOrDefault(channel.AutoBan),
		Tag:                derefString(channel.Tag),
		Other:              channel.Other,
		StatusCodeMapping:  derefString(channel.StatusCodeMapping),
		OtherSettings:      channel.OtherSettings,
		OpenAIOrganization: derefString(channel.OpenAIOrganization),
		TestModel:          derefString(channel.TestModel),
		IsMultiKey:         channel.ChannelInfo.IsMultiKey,
		MultiKeyMode:       channel.ChannelInfo.MultiKeyMode,
	})
}

type channelFingerprintPayload struct {
	Name               string `json:"name"`
	Type               int    `json:"type"`
	Status             string `json:"status"`
	BaseURL            string `json:"base_url"`
	Models             string `json:"models"`
	Group              string `json:"group"`
	ModelMapping       string `json:"model_mapping,omitempty"`
	Priority           int64  `json:"priority,omitempty"`
	Weight             uint   `json:"weight,omitempty"`
	Setting            string `json:"setting,omitempty"`
	ParamOverride      string `json:"param_override,omitempty"`
	HeaderOverride     string `json:"header_override,omitempty"`
	Remark             string `json:"remark,omitempty"`
	AutoBan            *int   `json:"auto_ban,omitempty"`
	Tag                string `json:"tag,omitempty"`
	Other              string `json:"other,omitempty"`
	StatusCodeMapping  string `json:"status_code_mapping,omitempty"`
	OtherSettings      string `json:"settings,omitempty"`
	OpenAIOrganization string `json:"openai_organization,omitempty"`
	TestModel          string `json:"test_model,omitempty"`
	IsMultiKey         bool   `json:"is_multi_key,omitempty"`
	MultiKeyMode       string `json:"multi_key_mode,omitempty"`
}

func fingerprintJSON(value any) string {
	data, _ := json.Marshal(value)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func hashSecret(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func pointerToString(value string) *string {
	return &value
}

func pointerToInt64(value int64) *int64 {
	return &value
}

func pointerToUint(value uint) *uint {
	return &value
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func derefInt64(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func derefUint(value *uint) uint {
	if value == nil {
		return 0
	}
	return *value
}
