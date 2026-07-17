package gateway

import (
	"context"
	"fmt"
	"strings"
)

func (s *Service) ExportDesiredConfigFromSet(ctx context.Context, input ImportChannelBundleInput) (DesiredConfig, error) {
	// Disaster recovery snapshots must retain manually disabled channels too.
	input.IncludeDisabled = true
	bundle, err := s.channelBundleSnapshotFromSet(ctx, input)
	if err != nil {
		return DesiredConfig{}, err
	}
	return DesiredConfig{
		APIVersion:     DesiredConfigAPIVersion,
		Kind:           DesiredConfigKind,
		ExportedAt:     s.nowUTC(),
		SourceSetID:    bundle.SourceSetID,
		GlobalOptions:  append([]ChannelBundleOption(nil), bundle.Spec.Options...),
		ChannelBundles: []DesiredConfigChannelBundle{desiredConfigBundleFromChannelBundle(bundle)},
	}, nil
}

func (s *Service) ImportDesiredConfig(ctx context.Context, config DesiredConfig) ([]ChannelBundle, error) {
	if strings.TrimSpace(config.APIVersion) != DesiredConfigAPIVersion {
		return nil, fmt.Errorf("unsupported desired config api_version %q", config.APIVersion)
	}
	if strings.TrimSpace(config.Kind) != DesiredConfigKind {
		return nil, fmt.Errorf("unsupported desired config kind %q", config.Kind)
	}
	if len(config.ChannelBundles) != 1 {
		return nil, fmt.Errorf("desired config requires exactly one channel bundle")
	}

	normalized := make([]ChannelBundle, 0, len(config.ChannelBundles))
	seenBundleIDs := map[string]bool{}
	for _, archived := range config.ChannelBundles {
		if seenBundleIDs[strings.TrimSpace(archived.ID)] {
			return nil, fmt.Errorf("duplicate desired config channel bundle %q", archived.ID)
		}
		seenBundleIDs[strings.TrimSpace(archived.ID)] = true
		bundle, err := normalizeChannelBundle(channelBundleFromDesiredConfig(config, archived))
		if err != nil {
			return nil, err
		}
		for _, channel := range bundle.Spec.Channels {
			if strings.TrimSpace(channel.Key) == "" {
				return nil, fmt.Errorf("desired config channel %q requires a plaintext key", channel.ID)
			}
		}
		normalized = append(normalized, bundle)
	}

	imported := make([]ChannelBundle, 0, len(normalized))
	for _, bundle := range normalized {
		stored, err := s.UpsertChannelBundle(ctx, bundle)
		if err != nil {
			return nil, err
		}
		imported = append(imported, stored)
	}
	return imported, nil
}

func desiredConfigBundleFromChannelBundle(bundle ChannelBundle) DesiredConfigChannelBundle {
	archived := DesiredConfigChannelBundle{
		ID:          bundle.ID,
		Name:        bundle.Name,
		Description: bundle.Description,
		Channels:    make([]DesiredConfigChannel, 0, len(bundle.Spec.Channels)),
	}
	for _, channel := range bundle.Spec.Channels {
		archived.Channels = append(archived.Channels, DesiredConfigChannel{
			ID:                 channel.ID,
			Name:               channel.Name,
			Type:               channel.Type,
			Key:                channel.Key,
			KeyHash:            channel.KeyHash,
			BaseURL:            channel.BaseURL,
			Models:             channel.Models,
			Group:              channel.Group,
			ModelMapping:       channel.ModelMapping,
			Priority:           channel.Priority,
			Weight:             channel.Weight,
			Status:             channel.Status,
			Setting:            channel.Setting,
			ParamOverride:      channel.ParamOverride,
			HeaderOverride:     channel.HeaderOverride,
			Remark:             channel.Remark,
			AutoBan:            cloneIntPointer(channel.AutoBan),
			Tag:                channel.Tag,
			Other:              channel.Other,
			StatusCodeMapping:  channel.StatusCodeMapping,
			OtherSettings:      channel.OtherSettings,
			OpenAIOrganization: channel.OpenAIOrganization,
			TestModel:          channel.TestModel,
			IsMultiKey:         channel.IsMultiKey,
			MultiKeyMode:       channel.MultiKeyMode,
		})
	}
	return archived
}

func channelBundleFromDesiredConfig(config DesiredConfig, archived DesiredConfigChannelBundle) ChannelBundle {
	bundle := ChannelBundle{
		ID:          archived.ID,
		Name:        archived.Name,
		Description: archived.Description,
		SourceSetID: config.SourceSetID,
		Spec: ChannelBundleSpec{
			Version:  1,
			Kind:     ChannelBundleKind,
			Options:  append([]ChannelBundleOption(nil), config.GlobalOptions...),
			Channels: make([]ChannelBundleChannel, 0, len(archived.Channels)),
		},
	}
	for _, channel := range archived.Channels {
		bundle.Spec.Channels = append(bundle.Spec.Channels, ChannelBundleChannel{
			ID:                 channel.ID,
			Name:               channel.Name,
			Type:               channel.Type,
			Key:                channel.Key,
			KeyHash:            channel.KeyHash,
			BaseURL:            channel.BaseURL,
			Models:             channel.Models,
			Group:              channel.Group,
			ModelMapping:       channel.ModelMapping,
			Priority:           channel.Priority,
			Weight:             channel.Weight,
			Status:             channel.Status,
			Setting:            channel.Setting,
			ParamOverride:      channel.ParamOverride,
			HeaderOverride:     channel.HeaderOverride,
			Remark:             channel.Remark,
			AutoBan:            cloneIntPointer(channel.AutoBan),
			Tag:                channel.Tag,
			Other:              channel.Other,
			StatusCodeMapping:  channel.StatusCodeMapping,
			OtherSettings:      channel.OtherSettings,
			OpenAIOrganization: channel.OpenAIOrganization,
			TestModel:          channel.TestModel,
			IsMultiKey:         channel.IsMultiKey,
			MultiKeyMode:       channel.MultiKeyMode,
		})
	}
	return bundle
}

func cloneIntPointer(value *int) *int {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func autoBanOrDefault(value *int) *int {
	if value != nil {
		return cloneIntPointer(value)
	}
	defaultValue := 1
	return &defaultValue
}
