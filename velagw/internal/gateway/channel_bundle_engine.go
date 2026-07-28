package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/newapi"
	"git.woa.com/wisp/mono2/llmgateway/internal/observability"
	"go.opentelemetry.io/otel/attribute"
	otellog "go.opentelemetry.io/otel/log"
)

var ErrChannelBundleNotFound = errors.New("channel bundle not found")
var ErrChannelBundleLocked = errors.New("channel bundle is locked")

const channelBundleOperationLockTTL = 30 * time.Minute

func (s *Service) UpsertChannelBundle(ctx context.Context, bundle ChannelBundle) (ChannelBundle, error) {
	if strings.TrimSpace(bundle.ID) == "" {
		return s.upsertChannelBundle(ctx, bundle, false)
	}
	owner, err := s.acquireChannelBundleOperationLock(ctx, bundle.ID, "save")
	if err != nil {
		return ChannelBundle{}, err
	}
	defer s.releaseChannelBundleOperationLock(bundle.ID, owner)
	return s.upsertChannelBundle(ctx, bundle, false)
}

func (s *Service) upsertChannelBundle(ctx context.Context, bundle ChannelBundle, forceRevision bool) (ChannelBundle, error) {
	existing, exists, err := s.store.GetChannelBundle(ctx, strings.TrimSpace(bundle.ID))
	if err != nil {
		return ChannelBundle{}, err
	}
	if exists {
		bundle = preserveChannelBundleSecrets(bundle, existing)
	}
	normalized, err := normalizeChannelBundle(bundle)
	if err != nil {
		return ChannelBundle{}, err
	}
	if err := s.store.SaveChannelBundle(ctx, normalized); err != nil {
		return ChannelBundle{}, err
	}
	if _, _, err := s.saveChannelBundleRevision(ctx, normalized, forceRevision); err != nil {
		return ChannelBundle{}, err
	}
	if err := s.markChannelBundlePendingForSyncTargets(ctx, normalized); err != nil {
		return ChannelBundle{}, err
	}
	stored, _, err := s.store.GetChannelBundle(ctx, normalized.ID)
	return stored, err
}

func (s *Service) saveChannelBundleRevision(ctx context.Context, bundle ChannelBundle, force bool) (ChannelBundleRevision, bool, error) {
	if !force {
		revisions, err := s.store.ListChannelBundleRevisions(ctx, bundle.ID)
		if err != nil {
			return ChannelBundleRevision{}, false, err
		}
		for _, revision := range revisions {
			if revision.Fingerprint == bundle.Fingerprint {
				return revision, false, nil
			}
		}
	}
	now := s.nowUTC()
	fingerprintPrefix := bundle.Fingerprint
	if len(fingerprintPrefix) > 12 {
		fingerprintPrefix = fingerprintPrefix[:12]
	}
	revision := ChannelBundleRevision{
		RevisionID:  fmt.Sprintf("rev-%s-%d-%s", bundle.ID, now.UnixNano(), fingerprintPrefix),
		BundleID:    bundle.ID,
		Name:        bundle.Name,
		Description: bundle.Description,
		SourceSetID: bundle.SourceSetID,
		Spec:        redactedChannelBundleSpec(bundle.Spec),
		Fingerprint: bundle.Fingerprint,
		CreatedAt:   now,
	}
	if err := s.store.SaveChannelBundleRevision(ctx, revision); err != nil {
		return ChannelBundleRevision{}, false, err
	}
	stored, ok, err := s.store.GetChannelBundleRevision(ctx, revision.BundleID, revision.RevisionID)
	if err != nil {
		return ChannelBundleRevision{}, false, err
	}
	if !ok {
		return ChannelBundleRevision{}, false, fmt.Errorf("channel bundle revision %q was not persisted", revision.RevisionID)
	}
	s.emitCommittedTransition(ctx, observability.ScopeConfigConsistency, "llmgateway.config.state_changed",
		"channel_bundle_revision", stored.RevisionID, "", "created",
		attribute.String("llmgateway.channel_bundle.id", stored.BundleID),
		attribute.String("llmgateway.channel_bundle.revision.id", stored.RevisionID),
		attribute.Int("llmgateway.channel_bundle.revision.version", stored.Version),
		attribute.String("llmgateway.channel_bundle.revision.fingerprint", stored.Fingerprint),
	)
	return stored, true, nil
}

func (s *Service) ListChannelBundles(ctx context.Context) ([]ChannelBundle, error) {
	return s.store.ListChannelBundles(ctx)
}

func (s *Service) ImportChannelBundleFromSet(ctx context.Context, input ImportChannelBundleInput) (ChannelBundle, error) {
	bundle, err := s.channelBundleSnapshotFromSet(ctx, input)
	if err != nil {
		return ChannelBundle{}, err
	}
	return s.UpsertChannelBundle(ctx, bundle)
}

func (s *Service) channelBundleSnapshotFromSet(ctx context.Context, input ImportChannelBundleInput) (ChannelBundle, error) {
	input.SourceSetID = strings.TrimSpace(input.SourceSetID)
	input.ID = strings.TrimSpace(input.ID)
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	if input.SourceSetID == "" {
		return ChannelBundle{}, fmt.Errorf("source_set_id is required")
	}
	if input.ID == "" {
		return ChannelBundle{}, fmt.Errorf("channel bundle id is required")
	}
	if input.Name == "" {
		return ChannelBundle{}, fmt.Errorf("channel bundle name is required")
	}
	set, ok, err := s.store.GetSet(ctx, input.SourceSetID)
	if err != nil {
		return ChannelBundle{}, err
	}
	if !ok {
		return ChannelBundle{}, fmt.Errorf("set %q not found", input.SourceSetID)
	}
	if set.Status != SetStatusActive || !set.Setup || set.AdminUserID == 0 || set.AdminAccessToken == "" {
		return ChannelBundle{}, fmt.Errorf("set %q is not active and bootstrapped", set.ID)
	}
	client := s.newAPIClient(set.BaseURL)
	auth := adminAuthForSet(set)
	const maxSnapshotAttempts = 3
	for attempt := 1; attempt <= maxSnapshotAttempts; attempt++ {
		remotes, err := client.ListChannelsStable(ctx, auth)
		if err != nil {
			return ChannelBundle{}, err
		}
		remotes = platformChannelSnapshot(remotes)
		remoteOptions, err := client.GetOptions(ctx, auth)
		if err != nil {
			return ChannelBundle{}, err
		}
		options, err := importedChannelBundleOptions(remoteOptions)
		if err != nil {
			return ChannelBundle{}, err
		}
		keys, err := s.fetchChannelSnapshotKeys(ctx, client, auth, set, remotes, input.IncludeDisabled)
		if err != nil {
			return ChannelBundle{}, err
		}

		remotesAfter, err := client.ListChannelsStable(ctx, auth)
		if err != nil {
			return ChannelBundle{}, err
		}
		remotesAfter = platformChannelSnapshot(remotesAfter)
		remoteOptionsAfter, err := client.GetOptions(ctx, auth)
		if err != nil {
			return ChannelBundle{}, err
		}
		optionsAfter, err := importedChannelBundleOptions(remoteOptionsAfter)
		if err != nil {
			return ChannelBundle{}, err
		}
		keysAfter, err := s.fetchChannelSnapshotKeys(ctx, client, auth, set, remotesAfter, input.IncludeDisabled)
		if err != nil {
			return ChannelBundle{}, err
		}
		if !reflect.DeepEqual(remotes, remotesAfter) || !reflect.DeepEqual(options, optionsAfter) || !reflect.DeepEqual(keys, keysAfter) {
			continue
		}
		channels := make([]ChannelBundleChannel, 0, len(remotes))
		usedIDs := map[string]int{}
		for _, remote := range remotes {
			if !input.IncludeDisabled && remote.Status != newapi.ChannelStatusEnabled {
				continue
			}
			channels = append(channels, channelBundleChannelFromRemote(remote, keys[remote.ID], usedIDs))
		}
		return normalizeChannelBundle(ChannelBundle{
			ID:          input.ID,
			Name:        input.Name,
			Description: input.Description,
			SourceSetID: set.ID,
			Spec: ChannelBundleSpec{
				Version:  1,
				Kind:     ChannelBundleKind,
				Options:  options,
				Channels: channels,
			},
		})
	}
	return ChannelBundle{}, fmt.Errorf("new-api desired configuration changed during %d snapshot attempts", maxSnapshotAttempts)
}

func platformChannelSnapshot(channels []newapi.Channel) []newapi.Channel {
	platform := make([]newapi.Channel, 0, len(channels))
	for _, channel := range channels {
		if strings.HasPrefix(channel.Name, "llmgw-byok-") {
			continue
		}
		private := false
		for _, group := range strings.Split(channel.Group, ",") {
			if isBYOKGroup(group) {
				private = true
				break
			}
		}
		if !private {
			platform = append(platform, channel)
		}
	}
	return platform
}

func (s *Service) fetchChannelSnapshotKeys(ctx context.Context, client *newapi.Client, auth newapi.AdminAuth, set Set, channels []newapi.Channel, includeDisabled bool) (map[int]string, error) {
	keys := make(map[int]string, len(channels))
	requiresSecureFetch := false
	for _, channel := range channels {
		if !includeDisabled && channel.Status != newapi.ChannelStatusEnabled {
			continue
		}
		if channel.Key == "" && channel.ID > 0 {
			requiresSecureFetch = true
			break
		}
	}
	if requiresSecureFetch {
		if strings.TrimSpace(set.AdminTOTPSecret) == "" {
			return nil, fmt.Errorf("set %q has no managed totp secret", set.ID)
		}
		code, err := generateTOTPCode(set.AdminTOTPSecret, s.nowUTC())
		if err != nil {
			return nil, err
		}
		if err := client.Verify2FA(ctx, auth, code); err != nil {
			return nil, err
		}
	}
	for _, channel := range channels {
		if !includeDisabled && channel.Status != newapi.ChannelStatusEnabled {
			continue
		}
		key := channel.Key
		if key == "" && channel.ID > 0 {
			var err error
			key, err = client.GetVerifiedChannelKey(ctx, auth, channel.ID)
			if err != nil {
				return nil, fmt.Errorf("fetch channel key for %q failed: %w", channel.Name, err)
			}
		}
		keys[channel.ID] = key
	}
	return keys, nil
}

var importedChannelBundleOptionKeys = map[string]bool{
	"AudioCompletionRatio":           true,
	"AudioRatio":                     true,
	"AutoGroups":                     true,
	"AutomaticDisableChannelEnabled": true,
	"AutomaticDisableKeywords":       true,
	"AutomaticDisableStatusCodes":    true,
	"AutomaticEnableChannelEnabled":  true,
	"AutomaticRetryStatusCodes":      true,
	"CacheRatio":                     true,
	"ChannelDisableThreshold":        true,
	"CompletionRatio":                true,
	"CreateCacheRatio":               true,
	"DefaultUseAutoGroup":            true,
	"GroupGroupRatio":                true,
	"GroupRatio":                     true,
	"ImageRatio":                     true,
	"ModelPrice":                     true,
	"ModelRatio":                     true,
	"PreConsumedQuota":               true,
	"QuotaPerUnit":                   true,
	"RetryTimes":                     true,
	"SelfUseModeEnabled":             true,
	"UserUsableGroups":               true,
	"billing_setting.billing_expr":   true,
	"billing_setting.billing_mode":   true,
	"group_ratio_setting.group_special_usable_group": true,
	"quota_setting.enable_free_model_pre_consume":    true,
	"tool_price_setting.prices":                      true,
}

var importedChannelBundleOptionPrefixes = []string{
	"channel_affinity_setting.",
	"claude.",
	"gemini.",
	"global.",
	"grok.",
	"qwen.",
}

func isImportedChannelBundleOption(key string) bool {
	if importedChannelBundleOptionKeys[key] {
		return true
	}
	for _, prefix := range importedChannelBundleOptionPrefixes {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}

func importedChannelBundleOptions(remote []newapi.Option) ([]ChannelBundleOption, error) {
	options := make([]ChannelBundleOption, 0, len(importedChannelBundleOptionKeys))
	for _, option := range remote {
		if !isImportedChannelBundleOption(option.Key) {
			continue
		}
		value, err := sanitizeImportedChannelBundleOption(option.Key, option.Value)
		if err != nil {
			return nil, fmt.Errorf("decode remote %s: %w", option.Key, err)
		}
		options = append(options, ChannelBundleOption{Key: option.Key, Value: value})
	}
	sort.Slice(options, func(i, j int) bool { return options[i].Key < options[j].Key })
	return options, nil
}

func sanitizeImportedChannelBundleOption(key string, value string) (any, error) {
	switch key {
	case newAPIGroupRatioOptionKey:
		ratios, err := decodeGroupRatios(value)
		if err != nil {
			return nil, err
		}
		return withoutBYOKGroupRatios(ratios), nil
	case "UserUsableGroups":
		groups := map[string]string{}
		if err := json.Unmarshal([]byte(value), &groups); err != nil {
			return nil, err
		}
		for group := range groups {
			if isBYOKGroup(group) {
				delete(groups, group)
			}
		}
		return groups, nil
	case "AutoGroups":
		var groups []string
		if err := json.Unmarshal([]byte(value), &groups); err != nil {
			return nil, err
		}
		platformGroups := groups[:0]
		for _, group := range groups {
			if !isBYOKGroup(group) {
				platformGroups = append(platformGroups, group)
			}
		}
		return platformGroups, nil
	case "GroupGroupRatio":
		ratios := map[string]map[string]float64{}
		if err := json.Unmarshal([]byte(value), &ratios); err != nil {
			return nil, err
		}
		for userGroup, usingGroups := range ratios {
			if isBYOKGroup(userGroup) {
				delete(ratios, userGroup)
				continue
			}
			for usingGroup := range usingGroups {
				if isBYOKGroup(usingGroup) {
					delete(usingGroups, usingGroup)
				}
			}
		}
		return ratios, nil
	case "group_ratio_setting.group_special_usable_group":
		groups := map[string]map[string]string{}
		if err := json.Unmarshal([]byte(value), &groups); err != nil {
			return nil, err
		}
		for userGroup, changes := range groups {
			if isBYOKGroup(userGroup) {
				delete(groups, userGroup)
				continue
			}
			for operation, targetGroup := range changes {
				if isBYOKGroup(targetGroup) {
					delete(changes, operation)
				}
			}
		}
		return groups, nil
	default:
		return value, nil
	}
}

func (s *Service) PlanChannelBundleForSet(ctx context.Context, bundleID string, setID string, opts ChannelBundlePlanOptions) (ChannelBundlePlan, error) {
	bundle, ok, err := s.store.GetChannelBundle(ctx, strings.TrimSpace(bundleID))
	if err != nil {
		return ChannelBundlePlan{}, err
	}
	if !ok {
		return ChannelBundlePlan{}, ErrChannelBundleNotFound
	}
	return s.planChannelBundleSnapshotForSet(ctx, bundle, setID, opts)
}

func (s *Service) planChannelBundleSnapshotForSet(ctx context.Context, bundle ChannelBundle, setID string, opts ChannelBundlePlanOptions) (ChannelBundlePlan, error) {
	set, ok, err := s.store.GetSet(ctx, strings.TrimSpace(setID))
	if err != nil {
		return ChannelBundlePlan{}, err
	}
	if !ok {
		return ChannelBundlePlan{}, fmt.Errorf("set %q not found", setID)
	}
	state, _, err := s.store.GetChannelBundleSyncState(ctx, bundle.ID, set.ID)
	if err != nil {
		return ChannelBundlePlan{}, err
	}
	previousStatus := state.Status
	state.BundleID = bundle.ID
	state.SetID = set.ID
	state.DesiredFingerprint = bundle.Fingerprint
	state.LastCheckedAt = s.nowUTC()

	plan := ChannelBundlePlan{
		BundleID:           bundle.ID,
		SetID:              set.ID,
		DesiredFingerprint: bundle.Fingerprint,
		Desired:            redactedChannelBundleSpec(bundle.Spec),
	}
	if set.Status != SetStatusActive || !set.Setup || set.AdminUserID == 0 || set.AdminAccessToken == "" {
		state.Status = ChannelSyncStatusSkipped
		state.LastError = "set is not active and bootstrapped"
		plan.Status = state.Status
		plan.LastError = state.LastError
		plan.State = state
		if err := s.store.SaveChannelBundleSyncState(ctx, state); err != nil {
			return ChannelBundlePlan{}, err
		}
		s.emitChannelBundleSyncTransition(ctx, previousStatus, state)
		return plan, nil
	}

	client := s.newAPIClient(set.BaseURL)
	auth := adminAuthForSet(set)
	if err := s.addChannelBundleOptionPlan(ctx, client, auth, bundle, state, opts, &plan); err != nil {
		return ChannelBundlePlan{}, s.failChannelBundlePlan(ctx, state, err)
	}
	desired := channelBundleDesiredSpecs(bundle)
	remoteChannels, err := client.ListChannels(ctx, auth)
	if err != nil {
		return ChannelBundlePlan{}, s.failChannelBundlePlan(ctx, state, err)
	}
	remoteChannels, err = s.includeDesiredRemoteChannels(ctx, client, auth, remoteChannels, desired)
	if err != nil {
		return ChannelBundlePlan{}, s.failChannelBundlePlan(ctx, state, err)
	}
	actualChannels := channelBundleSpecFromRemoteChannels(remoteChannels)
	plan.Actual.Version = actualChannels.Version
	plan.Actual.Kind = actualChannels.Kind
	plan.Actual.Channels = actualChannels.Channels

	remoteByName := map[string]newapi.Channel{}
	remoteNameCounts := map[string]int{}
	remoteResources := map[string]int{}
	for _, remote := range remoteChannels {
		remoteNameCounts[remote.Name]++
		if remoteNameCounts[remote.Name] == 1 {
			remoteByName[remote.Name] = remote
		}
	}

	desiredNames := map[string]bool{}
	previousRemoteResources := channelBundleRemoteResourceNames(state.RemoteResourcesJSON)
	for _, spec := range desired {
		desiredNames[spec.DesiredRemoteName] = true
		if remoteNameCounts[spec.DesiredRemoteName] > 1 {
			plan.Steps = append(plan.Steps, ChannelBundleStep{
				Kind:          ChannelBundleStepUpdateChannel,
				ResourceID:    spec.ID,
				Action:        ChannelSyncStatusConflict,
				RequiresForce: true,
				Reason:        "remote channel name conflict",
			})
			plan.Diff.Changed = append(plan.Diff.Changed, ChannelBundleResourceDiff{ID: spec.ID, Name: spec.Name, RemoteName: spec.DesiredRemoteName, Reason: "remote channel name conflict"})
			continue
		}
		remote, ok := remoteByName[spec.DesiredRemoteName]
		if !ok {
			plan.Steps = append(plan.Steps, ChannelBundleStep{Kind: ChannelBundleStepCreateChannel, ResourceID: spec.ID, Action: "create"})
			plan.Diff.Added = append(plan.Diff.Added, ChannelBundleResourceDiff{ID: spec.ID, Name: spec.Name, RemoteName: spec.DesiredRemoteName, Reason: "missing remote channel"})
			continue
		}
		channelState, _, err := s.store.GetChannelSyncState(ctx, spec.ID, set.ID)
		if err != nil {
			return ChannelBundlePlan{}, err
		}
		remoteFingerprint := remoteChannelFingerprint(remote)
		if remoteFingerprint != spec.Fingerprint || channelState.LastAppliedKeyHash != spec.KeyHash {
			if channelState.AppliedFingerprint != "" && remoteFingerprint != channelState.AppliedFingerprint && !opts.ForceDrift {
				plan.Steps = append(plan.Steps, ChannelBundleStep{
					Kind:          ChannelBundleStepUpdateChannel,
					ResourceID:    spec.ID,
					RemoteID:      remote.ID,
					Action:        ChannelSyncStatusDrift,
					RequiresForce: true,
					Reason:        "remote channel differs from last applied llmgateway state",
				})
				plan.Diff.Changed = append(plan.Diff.Changed, ChannelBundleResourceDiff{ID: spec.ID, Name: spec.Name, RemoteID: remote.ID, RemoteName: spec.DesiredRemoteName, Reason: "remote channel differs from last applied llmgateway state"})
				continue
			}
			plan.Steps = append(plan.Steps, ChannelBundleStep{Kind: ChannelBundleStepUpdateChannel, ResourceID: spec.ID, RemoteID: remote.ID, Action: "update"})
			plan.Diff.Changed = append(plan.Diff.Changed, ChannelBundleResourceDiff{ID: spec.ID, Name: spec.Name, RemoteID: remote.ID, RemoteName: spec.DesiredRemoteName, Reason: "remote differs from desired state"})
			continue
		}
		plan.Steps = append(plan.Steps, ChannelBundleStep{Kind: ChannelBundleStepNoop, ResourceID: spec.ID, RemoteID: remote.ID, Action: "noop"})
		plan.Diff.Synced = append(plan.Diff.Synced, ChannelBundleResourceDiff{ID: spec.ID, Name: spec.Name, RemoteID: remote.ID, RemoteName: spec.DesiredRemoteName})
		remoteResources[spec.DesiredRemoteName] = remote.ID
	}
	for _, remote := range remoteChannels {
		if !strings.HasPrefix(remote.Name, "llmgw:") || desiredNames[remote.Name] || !previousRemoteResources[remote.Name] {
			continue
		}
		plan.Diff.Extra = append(plan.Diff.Extra, ChannelBundleResourceDiff{RemoteID: remote.ID, RemoteName: remote.Name, Reason: "remote channel is not in bundle"})
		remoteResources[remote.Name] = remote.ID
	}
	sortChannelBundlePlan(&plan)

	plan.ActualFingerprint = channelBundleActualStateFingerprint(plan.Actual)
	state.ActualFingerprint = plan.ActualFingerprint
	state.DiffJSON = mustCompactJSON(plan.Diff)
	state.RemoteResourcesJSON = mustCompactJSON(remoteResources)
	state.LastError = ""
	state.Status = channelBundlePlanStatus(plan)
	plan.Status = state.Status
	plan.State = state
	if err := s.store.SaveChannelBundleSyncState(ctx, state); err != nil {
		return ChannelBundlePlan{}, err
	}
	s.emitChannelBundleSyncTransition(ctx, previousStatus, state)
	return plan, nil
}

func (s *Service) addChannelBundleOptionPlan(ctx context.Context, client *newapi.Client, auth newapi.AdminAuth, bundle ChannelBundle, state ChannelBundleSyncState, opts ChannelBundlePlanOptions, plan *ChannelBundlePlan) error {
	if len(bundle.Spec.Options) == 0 {
		return nil
	}
	remoteOptions, err := client.GetOptions(ctx, auth)
	if err != nil {
		return err
	}
	remoteByKey := make(map[string]string, len(remoteOptions))
	for _, option := range remoteOptions {
		remoteByKey[option.Key] = option.Value
	}
	var appliedOptions map[string]ChannelBundleOption
	if strings.TrimSpace(state.AppliedFingerprint) != "" {
		applied, err := s.appliedChannelBundleRevision(ctx, bundle, state.AppliedFingerprint)
		if err != nil {
			return err
		}
		appliedOptions = make(map[string]ChannelBundleOption, len(applied.Spec.Options))
		for _, option := range applied.Spec.Options {
			appliedOptions[option.Key] = option
		}
	}
	for _, desired := range bundle.Spec.Options {
		remoteValue, exists := remoteByKey[desired.Key]
		if exists {
			plan.Actual.Options = append(plan.Actual.Options, ChannelBundleOption{Key: desired.Key, Value: remoteValue})
		}
		if exists && channelBundleOptionValuesEqualForKey(desired.Key, remoteValue, desired.Value) {
			plan.Steps = append(plan.Steps, ChannelBundleStep{Kind: ChannelBundleStepNoop, ResourceID: desired.Key, Action: "noop"})
			plan.Diff.Synced = append(plan.Diff.Synced, ChannelBundleResourceDiff{ID: desired.Key, Name: desired.Key})
			continue
		}
		requiresForce := false
		if appliedOptions != nil {
			applied, managedBefore := appliedOptions[desired.Key]
			requiresForce = (managedBefore && (!exists || !channelBundleOptionValuesEqualForKey(desired.Key, remoteValue, applied.Value))) || (!managedBefore && exists)
		}
		action := "update"
		if requiresForce && !opts.ForceDrift {
			action = ChannelSyncStatusDrift
		}
		plan.Steps = append(plan.Steps, ChannelBundleStep{
			Kind: ChannelBundleStepUpdateOption, ResourceID: desired.Key, Action: action,
			RequiresForce: requiresForce && !opts.ForceDrift, Reason: "remote global option differs from desired state",
		})
		plan.Diff.Changed = append(plan.Diff.Changed, ChannelBundleResourceDiff{ID: desired.Key, Name: desired.Key, Reason: "remote global option differs from desired state"})
	}
	return nil
}

func (s *Service) includeDesiredRemoteChannels(ctx context.Context, client *newapi.Client, auth newapi.AdminAuth, remoteChannels []newapi.Channel, desired []ChannelSpec) ([]newapi.Channel, error) {
	seenByID := map[int]bool{}
	seenByName := map[string]bool{}
	for _, remote := range remoteChannels {
		if remote.ID != 0 {
			seenByID[remote.ID] = true
		}
		seenByName[remote.Name] = true
	}
	for _, spec := range desired {
		if seenByName[spec.DesiredRemoteName] {
			continue
		}
		matches, err := client.SearchChannels(ctx, auth, spec.DesiredRemoteName)
		if err != nil {
			return nil, err
		}
		for _, match := range matches {
			if match.ID != 0 && seenByID[match.ID] {
				continue
			}
			remoteChannels = append(remoteChannels, match)
			if match.ID != 0 {
				seenByID[match.ID] = true
			}
			seenByName[match.Name] = true
		}
	}
	return remoteChannels, nil
}

func (s *Service) ApplyChannelBundleToSet(ctx context.Context, bundleID string, setID string, opts ChannelBundleApplyOptions) (ChannelBundleSyncState, error) {
	owner, err := s.acquireChannelBundleOperationLock(ctx, bundleID, "apply")
	if err != nil {
		return ChannelBundleSyncState{}, err
	}
	defer s.releaseChannelBundleOperationLock(bundleID, owner)
	return s.applyChannelBundleToSet(ctx, bundleID, setID, opts)
}

func (s *Service) applyChannelBundleToSet(ctx context.Context, bundleID string, setID string, opts ChannelBundleApplyOptions) (ChannelBundleSyncState, error) {
	bundle, ok, err := s.store.GetChannelBundle(ctx, strings.TrimSpace(bundleID))
	if err != nil {
		return ChannelBundleSyncState{}, err
	}
	if !ok {
		return ChannelBundleSyncState{}, ErrChannelBundleNotFound
	}
	return s.applyChannelBundleSnapshotToSet(ctx, bundle, setID, opts)
}

func (s *Service) applyChannelBundleSnapshotToSet(ctx context.Context, bundle ChannelBundle, setID string, opts ChannelBundleApplyOptions) (ChannelBundleSyncState, error) {
	plan, err := s.planChannelBundleSnapshotForSet(ctx, bundle, setID, ChannelBundlePlanOptions{ForceDrift: opts.ForceDrift})
	if err != nil {
		state, _, _ := s.store.GetChannelBundleSyncState(ctx, bundle.ID, setID)
		state.BundleID = bundle.ID
		state.SetID = setID
		state.DesiredFingerprint = bundle.Fingerprint
		return s.failChannelBundleApply(ctx, state, bundle, err)
	}
	if plan.Status == ChannelSyncStatusSkipped || plan.Status == ChannelSyncStatusConflict || (plan.Status == ChannelSyncStatusDrift && !opts.ForceDrift) {
		return plan.State, nil
	}
	if err := s.applyChannelBundleOptions(ctx, bundle, setID); err != nil {
		state, _, _ := s.store.GetChannelBundleSyncState(ctx, bundle.ID, setID)
		return s.failChannelBundleApply(ctx, state, bundle, err)
	}
	remoteResources := map[string]int{}
	for _, spec := range channelBundleDesiredSpecs(bundle) {
		if err := s.saveCurrentBundleChannelSpec(ctx, bundle, spec); err != nil {
			state, _, _ := s.store.GetChannelBundleSyncState(ctx, bundle.ID, setID)
			return s.failChannelBundleApply(ctx, state, bundle, err)
		}
		channelState, err := s.syncChannelSpecToSet(ctx, spec, setID, ChannelSyncOptions{ForceDrift: opts.ForceDrift})
		if err != nil {
			state, _, _ := s.store.GetChannelBundleSyncState(ctx, bundle.ID, setID)
			return s.failChannelBundleApply(ctx, state, bundle, err)
		}
		if channelState.Status != ChannelSyncStatusSynced {
			state, _, _ := s.store.GetChannelBundleSyncState(ctx, bundle.ID, setID)
			state.Status = channelState.Status
			state.LastError = channelState.LastError
			state.DesiredFingerprint = bundle.Fingerprint
			if err := s.store.SaveChannelBundleSyncState(ctx, state); err != nil {
				return ChannelBundleSyncState{}, err
			}
			return state, nil
		}
		remoteResources[spec.DesiredRemoteName] = channelState.RemoteChannelID
	}
	state, _, err := s.store.GetChannelBundleSyncState(ctx, bundle.ID, setID)
	if err != nil {
		return ChannelBundleSyncState{}, err
	}
	previousStatus := state.Status
	state.Status = ChannelSyncStatusSynced
	state.LastError = ""
	state.DesiredFingerprint = bundle.Fingerprint
	state.AppliedFingerprint = bundle.Fingerprint
	state.RemoteResourcesJSON = mustCompactJSON(remoteResources)
	state.LastSyncedAt = s.nowUTC()
	if err := s.store.SaveChannelBundleSyncState(ctx, state); err != nil {
		return ChannelBundleSyncState{}, err
	}
	s.emitChannelBundleSyncTransition(ctx, previousStatus, state)
	return state, nil
}

func (s *Service) saveCurrentBundleChannelSpec(ctx context.Context, bundle ChannelBundle, spec ChannelSpec) error {
	current, ok, err := s.store.GetChannelBundle(ctx, bundle.ID)
	if err != nil || !ok || current.Fingerprint != bundle.Fingerprint {
		return err
	}
	_, err = s.UpsertChannelSpec(ctx, spec)
	return err
}

func (s *Service) acquireChannelBundleOperationLock(ctx context.Context, bundleID string, purpose string) (string, error) {
	bundleID = strings.TrimSpace(bundleID)
	purpose = strings.TrimSpace(purpose)
	if bundleID == "" {
		return "", fmt.Errorf("channel bundle id is required")
	}
	if purpose == "" {
		purpose = "operation"
	}
	owner := fmt.Sprintf("%s-%d", purpose, time.Now().UTC().UnixNano())
	lock, ok, err := s.store.TryAcquireChannelBundleLock(ctx, bundleID, owner, purpose, channelBundleOperationLockTTL, time.Now().UTC())
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("%w: bundle %s is held by %s for %s until %s", ErrChannelBundleLocked, bundleID, lock.Owner, lock.Purpose, lock.LeaseUntil.UTC().Format(time.RFC3339))
	}
	return owner, nil
}

func (s *Service) releaseChannelBundleOperationLock(bundleID string, owner string) {
	releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.store.ReleaseChannelBundleLock(releaseCtx, bundleID, owner); err != nil {
		// Best effort: the lease will expire even if release fails.
		return
	}
}

func (s *Service) applyChannelBundleOptions(ctx context.Context, bundle ChannelBundle, setID string) error {
	if len(bundle.Spec.Options) == 0 {
		return nil
	}
	set, ok, err := s.store.GetSet(ctx, strings.TrimSpace(setID))
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("set %q not found", setID)
	}
	if set.Status != SetStatusActive || !set.Setup || set.AdminUserID == 0 || set.AdminAccessToken == "" {
		return fmt.Errorf("set %q is not active and bootstrapped", set.ID)
	}
	client := s.newAPIClient(set.BaseURL)
	var groupRatioOption *ChannelBundleOption
	for _, option := range bundle.Spec.Options {
		if option.Key == newAPIGroupRatioOptionKey {
			optionCopy := option
			groupRatioOption = &optionCopy
			continue
		}
		if err := s.updateSetOption(ctx, client, set, option.Key, option.Value); err != nil {
			return fmt.Errorf("sync option %s to set %s failed: %w", option.Key, set.ID, err)
		}
	}
	if groupRatioOption != nil {
		ratios, err := decodeGroupRatios(groupRatioOption.Value)
		if err != nil {
			return fmt.Errorf("parse desired new-api %s failed: %w", groupRatioOption.Key, err)
		}
		if _, err := s.store.ReplacePlatformGroupRatios(ctx, set.ID, bundle.ID, ratios); err != nil {
			return fmt.Errorf("persist option %s for set %s failed: %w", groupRatioOption.Key, set.ID, err)
		}
		if _, err := s.reconcileSetGroupRatios(ctx, set); err != nil {
			return fmt.Errorf("sync option %s to set %s failed: %w", groupRatioOption.Key, set.ID, err)
		}
	}
	return nil
}

func (s *Service) updateSetOption(ctx context.Context, client *newapi.Client, set Set, key string, value any) error {
	username := strings.TrimSpace(set.AdminUsername)
	if username == "" {
		username = strings.TrimSpace(s.options.RootUsername)
	}
	password := strings.TrimSpace(s.options.RootPassword)
	if username != "" && password != "" {
		session, err := client.Login(ctx, username, password)
		if err != nil {
			return err
		}
		if session.Require2FA && strings.TrimSpace(set.AdminTOTPSecret) != "" {
			code, err := generateTOTPCode(set.AdminTOTPSecret, s.nowUTC())
			if err != nil {
				return err
			}
			session, err = client.Complete2FALogin(ctx, session.TwoFAFlowToken, code)
			if err != nil {
				return err
			}
		}
		if session.UserID > 0 {
			return client.UpdateOption(ctx, session.UserID, key, value)
		}
	}
	return client.UpdateOptionWithAuth(ctx, adminAuthForSet(set), key, value)
}

func (s *Service) markChannelBundlePendingForSyncTargets(ctx context.Context, bundle ChannelBundle) error {
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return err
	}
	for _, set := range sets {
		if set.Status != SetStatusActive || !set.Setup {
			continue
		}
		state, _, err := s.store.GetChannelBundleSyncState(ctx, bundle.ID, set.ID)
		if err != nil {
			return err
		}
		state.BundleID = bundle.ID
		state.SetID = set.ID
		state.DesiredFingerprint = bundle.Fingerprint
		if state.AppliedFingerprint != bundle.Fingerprint {
			state.Status = ChannelSyncStatusPending
		}
		if err := s.store.SaveChannelBundleSyncState(ctx, state); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) failChannelBundlePlan(ctx context.Context, state ChannelBundleSyncState, err error) error {
	previousStatus := state.Status
	state.Status = ChannelSyncStatusError
	state.LastError = err.Error()
	if saveErr := s.store.SaveChannelBundleSyncState(ctx, state); saveErr == nil {
		s.emitChannelBundleSyncTransition(ctx, previousStatus, state)
		s.emitOperationFailure(ctx, observability.ScopeConfigConsistency, "llmgateway.config.operation_failed", "channel_bundle_check_failed",
			attribute.String("llmgateway.channel_bundle.id", state.BundleID),
			attribute.String("llmgateway.set.id", state.SetID),
		)
	}
	return err
}

func (s *Service) failChannelBundleApply(ctx context.Context, state ChannelBundleSyncState, target ChannelBundle, applyErr error) (ChannelBundleSyncState, error) {
	previousStatus := state.Status
	stable, verifyErr := s.remoteStillMatchesAppliedBundle(ctx, state, target)
	resultErr := applyErr
	state.DesiredFingerprint = target.Fingerprint
	state.LastCheckedAt = s.nowUTC()
	state.LastError = applyErr.Error()
	if stable {
		state.Status = ChannelSyncStatusPending
		s.markFailedTargetChannelsPending(ctx, target, state.SetID, applyErr)
	} else {
		state.Status = ChannelSyncStatusError
		if verifyErr != nil {
			state.LastError = fmt.Sprintf("%s; unable to verify previous applied revision: %v", applyErr, verifyErr)
		} else {
			state.LastError = fmt.Sprintf("%s; remote no longer matches previous applied revision", applyErr)
		}
		if err := s.isolateSetAfterUnsafeBundle(ctx, state.SetID, target.ID, state.LastError); err != nil {
			resultErr = errors.Join(resultErr, err)
		}
	}
	if err := s.store.SaveChannelBundleSyncState(ctx, state); err != nil {
		resultErr = errors.Join(resultErr, err)
	} else {
		s.emitChannelBundleSyncTransition(ctx, previousStatus, state)
		s.emitOperationFailure(ctx, observability.ScopeConfigConsistency, "llmgateway.config.operation_failed", "channel_bundle_apply_failed",
			attribute.String("llmgateway.channel_bundle.id", state.BundleID),
			attribute.String("llmgateway.set.id", state.SetID),
		)
	}
	return state, resultErr
}

func (s *Service) emitChannelBundleSyncTransition(ctx context.Context, previousStatus string, state ChannelBundleSyncState) {
	s.emitCommittedTransition(ctx, observability.ScopeConfigConsistency, "llmgateway.config.state_changed",
		"channel_bundle_sync", state.BundleID+"/"+state.SetID, previousStatus, state.Status,
		attribute.String("llmgateway.channel_bundle.id", state.BundleID),
		attribute.String("llmgateway.set.id", state.SetID),
		attribute.String("llmgateway.channel_bundle.desired_fingerprint", state.DesiredFingerprint),
		attribute.String("llmgateway.channel_bundle.applied_fingerprint", state.AppliedFingerprint),
		attribute.String("llmgateway.channel_bundle.actual_fingerprint", state.ActualFingerprint),
	)
	if previousStatus != ChannelSyncStatusDrift && state.Status == ChannelSyncStatusDrift {
		s.emitTelemetryEvent(ctx, observability.ScopeConfigConsistency, observability.Event{
			Name: "llmgateway.config.drift_detected", Severity: otellog.SeverityWarn,
			Attributes: []attribute.KeyValue{
				attribute.String("llmgateway.channel_bundle.id", state.BundleID),
				attribute.String("llmgateway.set.id", state.SetID),
				attribute.String("llmgateway.channel_bundle.desired_fingerprint", state.DesiredFingerprint),
				attribute.String("llmgateway.channel_bundle.applied_fingerprint", state.AppliedFingerprint),
				attribute.String("llmgateway.channel_bundle.actual_fingerprint", state.ActualFingerprint),
				attribute.String("llmgateway.outcome", "blocked"),
			},
		})
	}
}

func (s *Service) isolateSetAfterUnsafeBundle(ctx context.Context, setID string, bundleID string, reason string) error {
	set, ok, err := s.store.GetSet(ctx, setID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("set %q not found while isolating unsafe channel bundle", setID)
	}
	set.AdmissionStatus = SetAdmissionStatusFailed
	set.AdmissionError = fmt.Sprintf("channel bundle %q unsafe after failed release: %s", bundleID, reason)
	set.AdmissionCheckedAt = s.nowUTC()
	return s.store.SaveSet(ctx, set)
}

func (s *Service) remoteStillMatchesAppliedBundle(ctx context.Context, state ChannelBundleSyncState, target ChannelBundle) (bool, error) {
	if strings.TrimSpace(state.AppliedFingerprint) == "" {
		return false, fmt.Errorf("no previous applied revision")
	}
	current, ok, err := s.store.GetChannelBundle(ctx, target.ID)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, ErrChannelBundleNotFound
	}
	applied, err := s.appliedChannelBundleRevision(ctx, current, state.AppliedFingerprint)
	if err != nil {
		return false, err
	}
	set, ok, err := s.store.GetSet(ctx, state.SetID)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, fmt.Errorf("set %q not found", state.SetID)
	}
	client := s.newAPIClient(set.BaseURL)
	auth := adminAuthForSet(set)

	if len(applied.Spec.Options) > 0 || len(target.Spec.Options) > 0 {
		remoteOptions, err := client.GetOptions(ctx, auth)
		if err != nil {
			return false, err
		}
		remoteByKey := make(map[string]string, len(remoteOptions))
		for _, option := range remoteOptions {
			remoteByKey[option.Key] = option.Value
		}
		appliedOptions := make(map[string]any, len(applied.Spec.Options))
		for _, option := range applied.Spec.Options {
			appliedOptions[option.Key] = option.Value
			remoteValue, exists := remoteByKey[option.Key]
			if !exists || !channelBundleOptionValuesEqualForKey(option.Key, remoteValue, option.Value) {
				return false, nil
			}
		}
		for _, option := range target.Spec.Options {
			if _, managedBefore := appliedOptions[option.Key]; managedBefore {
				continue
			}
			if remoteValue, exists := remoteByKey[option.Key]; exists && channelBundleOptionValuesEqualForKey(option.Key, remoteValue, option.Value) {
				return false, nil
			}
		}
	}

	appliedSpecs := channelBundleDesiredSpecs(applied)
	targetSpecs := channelBundleDesiredSpecs(target)
	allDesired := append(append([]ChannelSpec(nil), appliedSpecs...), targetSpecs...)
	remoteChannels, err := client.ListChannels(ctx, auth)
	if err != nil {
		return false, err
	}
	remoteChannels, err = s.includeDesiredRemoteChannels(ctx, client, auth, remoteChannels, allDesired)
	if err != nil {
		return false, err
	}
	remoteByName := map[string][]newapi.Channel{}
	for _, remote := range remoteChannels {
		remoteByName[remote.Name] = append(remoteByName[remote.Name], remote)
	}
	appliedByID := make(map[string]ChannelSpec, len(appliedSpecs))
	appliedNames := make(map[string]bool, len(appliedSpecs))
	for _, spec := range appliedSpecs {
		appliedByID[spec.ID] = spec
		appliedNames[spec.DesiredRemoteName] = true
		matches := remoteByName[spec.DesiredRemoteName]
		if len(matches) != 1 || remoteChannelFingerprint(matches[0]) != spec.Fingerprint {
			return false, nil
		}
	}
	for _, spec := range targetSpecs {
		if previous, ok := appliedByID[spec.ID]; ok && previous.KeyHash != spec.KeyHash {
			return false, fmt.Errorf("channel %q key changed and cannot be verified through new-api", spec.ID)
		}
		if !appliedNames[spec.DesiredRemoteName] && len(remoteByName[spec.DesiredRemoteName]) > 0 {
			return false, nil
		}
	}
	return true, nil
}

func (s *Service) markFailedTargetChannelsPending(ctx context.Context, target ChannelBundle, setID string, applyErr error) {
	for _, spec := range channelBundleDesiredSpecs(target) {
		state, ok, err := s.store.GetChannelSyncState(ctx, spec.ID, setID)
		if err != nil || !ok || state.AppliedFingerprint == "" {
			continue
		}
		state.Status = ChannelSyncStatusPending
		state.DesiredFingerprint = spec.Fingerprint
		state.LastError = applyErr.Error()
		_ = s.store.SaveChannelSyncState(ctx, state)
	}
}

func channelBundleOptionValuesEqual(remote string, desired any) bool {
	return comparableChannelBundleOptionValue(remote) == comparableChannelBundleOptionValue(desired)
}

func channelBundleOptionValuesEqualForKey(key string, remote string, desired any) bool {
	if key != newAPIGroupRatioOptionKey {
		return channelBundleOptionValuesEqual(remote, desired)
	}
	remoteRatios, err := decodeGroupRatios(remote)
	if err != nil {
		return false
	}
	desiredRatios, err := decodeGroupRatios(desired)
	if err != nil {
		return false
	}
	return comparableChannelBundleOptionValue(withoutBYOKGroupRatios(remoteRatios)) == comparableChannelBundleOptionValue(withoutBYOKGroupRatios(desiredRatios))
}

func comparableChannelBundleOptionValue(value any) string {
	var raw []byte
	if text, ok := value.(string); ok {
		raw = []byte(strings.TrimSpace(text))
	} else {
		raw, _ = json.Marshal(value)
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return strings.TrimSpace(string(raw))
	}
	canonical, err := json.Marshal(decoded)
	if err != nil {
		return strings.TrimSpace(string(raw))
	}
	return string(canonical)
}

func normalizeChannelBundle(bundle ChannelBundle) (ChannelBundle, error) {
	bundle.ID = strings.TrimSpace(bundle.ID)
	bundle.Name = strings.TrimSpace(bundle.Name)
	bundle.Description = strings.TrimSpace(bundle.Description)
	bundle.SourceSetID = strings.TrimSpace(bundle.SourceSetID)
	if bundle.ID == "" {
		return ChannelBundle{}, fmt.Errorf("channel bundle id is required")
	}
	if bundle.Name == "" {
		return ChannelBundle{}, fmt.Errorf("channel bundle name is required")
	}
	if bundle.Spec.Version == 0 {
		bundle.Spec.Version = 1
	}
	if strings.TrimSpace(bundle.Spec.Kind) == "" {
		bundle.Spec.Kind = ChannelBundleKind
	}
	if bundle.Spec.Kind != ChannelBundleKind {
		return ChannelBundle{}, fmt.Errorf("unsupported channel bundle kind %q", bundle.Spec.Kind)
	}
	seenOptions := make(map[string]bool, len(bundle.Spec.Options))
	for i := range bundle.Spec.Options {
		option, err := normalizeChannelBundleOption(bundle.Spec.Options[i])
		if err != nil {
			return ChannelBundle{}, err
		}
		if seenOptions[option.Key] {
			return ChannelBundle{}, fmt.Errorf("duplicate channel bundle option %q", option.Key)
		}
		seenOptions[option.Key] = true
		bundle.Spec.Options[i] = option
	}
	sort.Slice(bundle.Spec.Options, func(i, j int) bool {
		return bundle.Spec.Options[i].Key < bundle.Spec.Options[j].Key
	})
	seenChannels := make(map[string]bool, len(bundle.Spec.Channels))
	for i := range bundle.Spec.Channels {
		channel, err := normalizeChannelBundleChannel(bundle.Spec.Channels[i])
		if err != nil {
			return ChannelBundle{}, err
		}
		if seenChannels[channel.ID] {
			return ChannelBundle{}, fmt.Errorf("duplicate channel bundle channel %q", channel.ID)
		}
		seenChannels[channel.ID] = true
		bundle.Spec.Channels[i] = channel
	}
	sort.Slice(bundle.Spec.Channels, func(i, j int) bool {
		return bundle.Spec.Channels[i].ID < bundle.Spec.Channels[j].ID
	})
	bundle.Fingerprint = channelBundleFingerprint(bundle.Spec)
	return bundle, nil
}

func normalizeChannelBundleOption(option ChannelBundleOption) (ChannelBundleOption, error) {
	option.Key = strings.TrimSpace(option.Key)
	if option.Key == "" {
		return ChannelBundleOption{}, fmt.Errorf("option key is required")
	}
	if option.Key == newAPIGroupRatioOptionKey {
		ratios, err := decodeGroupRatios(option.Value)
		if err != nil {
			return ChannelBundleOption{}, fmt.Errorf("invalid %s option: %w", newAPIGroupRatioOptionKey, err)
		}
		for group := range ratios {
			if isBYOKGroup(group) {
				return ChannelBundleOption{}, fmt.Errorf("group %q uses reserved %s prefix", group, byokGroupPrefix)
			}
		}
	}
	return option, nil
}

func normalizeChannelBundleChannel(channel ChannelBundleChannel) (ChannelBundleChannel, error) {
	channel.ID = strings.TrimSpace(channel.ID)
	channel.Name = strings.TrimSpace(channel.Name)
	channel.BaseURL = strings.TrimRight(strings.TrimSpace(channel.BaseURL), "/")
	channel.Models = strings.TrimSpace(channel.Models)
	channel.Group = strings.TrimSpace(channel.Group)
	channel.Status = strings.TrimSpace(channel.Status)
	if channel.ID == "" {
		return ChannelBundleChannel{}, fmt.Errorf("channel id is required")
	}
	if channel.Name == "" {
		return ChannelBundleChannel{}, fmt.Errorf("channel name is required")
	}
	if channel.Type == 0 {
		return ChannelBundleChannel{}, fmt.Errorf("channel type is required")
	}
	if channel.Group == "" {
		channel.Group = "default"
	}
	if channel.Status == "" {
		channel.Status = ChannelSpecStatusEnabled
	}
	if channel.Status != ChannelSpecStatusEnabled && channel.Status != ChannelSpecStatusDisabled {
		return ChannelBundleChannel{}, fmt.Errorf("channel %q has unsupported status %q", channel.ID, channel.Status)
	}
	if channel.AutoBan == nil {
		autoBan := 1
		channel.AutoBan = &autoBan
	}
	if channel.IsMultiKey {
		if channel.MultiKeyMode == "" {
			channel.MultiKeyMode = "random"
		}
		if channel.MultiKeyMode != "random" && channel.MultiKeyMode != "polling" {
			return ChannelBundleChannel{}, fmt.Errorf("channel %q has unsupported multi_key_mode %q", channel.ID, channel.MultiKeyMode)
		}
	} else {
		channel.MultiKeyMode = ""
	}
	if channel.Key != "" {
		channel.KeyHash = hashSecret(channel.Key)
	}
	return channel, nil
}

func channelBundleChannelFromRemote(remote newapi.Channel, key string, usedIDs map[string]int) ChannelBundleChannel {
	id, name := channelBundleIDAndNameFromRemote(remote)
	id = uniqueChannelBundleID(id, remote.ID, usedIDs)
	status := ChannelSpecStatusEnabled
	if remote.Status == newapi.ChannelStatusManuallyDisabled {
		status = ChannelSpecStatusDisabled
	}
	channel := ChannelBundleChannel{
		ID:                 id,
		Name:               name,
		Type:               remote.Type,
		Key:                key,
		BaseURL:            derefString(remote.BaseURL),
		Models:             remote.Models,
		Group:              remote.Group,
		ModelMapping:       derefString(remote.ModelMapping),
		Priority:           derefInt64(remote.Priority),
		Weight:             derefUint(remote.Weight),
		Status:             status,
		Setting:            derefString(remote.Setting),
		ParamOverride:      derefString(remote.ParamOverride),
		HeaderOverride:     derefString(remote.HeaderOverride),
		Remark:             derefString(remote.Remark),
		AutoBan:            autoBanOrDefault(remote.AutoBan),
		Tag:                derefString(remote.Tag),
		Other:              remote.Other,
		StatusCodeMapping:  derefString(remote.StatusCodeMapping),
		OtherSettings:      remote.OtherSettings,
		OpenAIOrganization: derefString(remote.OpenAIOrganization),
		TestModel:          derefString(remote.TestModel),
		IsMultiKey:         remote.ChannelInfo.IsMultiKey,
		MultiKeyMode:       remote.ChannelInfo.MultiKeyMode,
	}
	if channel.Group == "" {
		channel.Group = "default"
	}
	return channel
}

func channelBundleIDAndNameFromRemote(remote newapi.Channel) (string, string) {
	name := strings.TrimSpace(remote.Name)
	parts := strings.SplitN(name, ":", 3)
	if len(parts) == 3 && parts[0] == "llmgw" && strings.TrimSpace(parts[1]) != "" {
		displayName := strings.TrimSpace(parts[2])
		if displayName == "" {
			displayName = strings.TrimSpace(parts[1])
		}
		return strings.TrimSpace(parts[1]), displayName
	}
	return slugChannelBundleID(name), name
}

var channelBundleIDCleaner = regexp.MustCompile(`[^a-z0-9_-]+`)

func slugChannelBundleID(name string) string {
	id := strings.ToLower(strings.TrimSpace(name))
	id = channelBundleIDCleaner.ReplaceAllString(id, "-")
	id = strings.Trim(id, "-_")
	if id == "" {
		return "channel"
	}
	return id
}

func uniqueChannelBundleID(id string, remoteID int, usedIDs map[string]int) string {
	if id == "" {
		id = "channel"
	}
	count := usedIDs[id]
	usedIDs[id] = count + 1
	if count == 0 {
		return id
	}
	if remoteID > 0 {
		return id + "-" + strconv.Itoa(remoteID)
	}
	return fmt.Sprintf("%s-%d", id, count+1)
}

func preserveChannelBundleSecrets(next ChannelBundle, existing ChannelBundle) ChannelBundle {
	existingByID := map[string]ChannelBundleChannel{}
	for _, channel := range existing.Spec.Channels {
		existingByID[channel.ID] = channel
	}
	for i := range next.Spec.Channels {
		if next.Spec.Channels[i].Key != "" {
			continue
		}
		if existingChannel, ok := existingByID[next.Spec.Channels[i].ID]; ok {
			next.Spec.Channels[i].Key = existingChannel.Key
			next.Spec.Channels[i].KeyHash = existingChannel.KeyHash
		}
	}
	return next
}

func restoreChannelBundleRevisionSecrets(revisionSpec ChannelBundleSpec, currentSpec ChannelBundleSpec) (ChannelBundleSpec, error) {
	currentByID := map[string]ChannelBundleChannel{}
	for _, channel := range currentSpec.Channels {
		currentByID[channel.ID] = channel
	}
	restored := ChannelBundleSpec{
		Version:  revisionSpec.Version,
		Kind:     revisionSpec.Kind,
		Options:  append([]ChannelBundleOption(nil), revisionSpec.Options...),
		Channels: append([]ChannelBundleChannel(nil), revisionSpec.Channels...),
	}
	for i := range restored.Channels {
		channel := &restored.Channels[i]
		if channel.Key != "" {
			channel.KeyHash = hashSecret(channel.Key)
			continue
		}
		current, ok := currentByID[channel.ID]
		if !ok || current.Key == "" {
			if channel.KeyHash == "" {
				continue
			}
			return ChannelBundleSpec{}, fmt.Errorf("channel bundle revision requires secret for channel %q; re-import the channel bundle from a golden set or save the channel key before rollback", channel.ID)
		}
		currentKeyHash := hashSecret(current.Key)
		if channel.KeyHash != "" && channel.KeyHash != currentKeyHash {
			return ChannelBundleSpec{}, fmt.Errorf("current secret for channel %q does not match the selected revision", channel.ID)
		}
		channel.Key = current.Key
		channel.KeyHash = currentKeyHash
	}
	return restored, nil
}

func channelBundleDesiredSpecs(bundle ChannelBundle) []ChannelSpec {
	specs := make([]ChannelSpec, 0, len(bundle.Spec.Channels))
	for _, channel := range bundle.Spec.Channels {
		spec := channelSpecFromBundleChannel(channel)
		specs = append(specs, spec)
	}
	sort.Slice(specs, func(i, j int) bool { return specs[i].ID < specs[j].ID })
	return specs
}

func redactedChannelBundleSpec(spec ChannelBundleSpec) ChannelBundleSpec {
	redacted := ChannelBundleSpec{
		Version:  spec.Version,
		Kind:     spec.Kind,
		Options:  append([]ChannelBundleOption(nil), spec.Options...),
		Channels: make([]ChannelBundleChannel, 0, len(spec.Channels)),
	}
	for _, channel := range spec.Channels {
		channel.Key = ""
		redacted.Channels = append(redacted.Channels, channel)
	}
	return redacted
}

func channelBundleSpecFromRemoteChannels(channels []newapi.Channel) ChannelBundleSpec {
	usedIDs := map[string]int{}
	spec := ChannelBundleSpec{
		Version:  1,
		Kind:     ChannelBundleKind,
		Channels: make([]ChannelBundleChannel, 0, len(channels)),
	}
	for _, remote := range channels {
		if !strings.HasPrefix(remote.Name, "llmgw:") {
			continue
		}
		spec.Channels = append(spec.Channels, channelBundleChannelFromRemote(remote, "", usedIDs))
	}
	sort.Slice(spec.Channels, func(i, j int) bool { return spec.Channels[i].ID < spec.Channels[j].ID })
	return spec
}

func channelSpecFromBundleChannel(channel ChannelBundleChannel) ChannelSpec {
	spec := ChannelSpec{
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
		AutoBan:            autoBanOrDefault(channel.AutoBan),
		Tag:                channel.Tag,
		Other:              channel.Other,
		StatusCodeMapping:  channel.StatusCodeMapping,
		OtherSettings:      channel.OtherSettings,
		OpenAIOrganization: channel.OpenAIOrganization,
		TestModel:          channel.TestModel,
		IsMultiKey:         channel.IsMultiKey,
		MultiKeyMode:       channel.MultiKeyMode,
	}
	if spec.Key != "" {
		spec.KeyHash = hashSecret(spec.Key)
	}
	spec.DesiredRemoteName = desiredChannelRemoteName(spec)
	spec.Fingerprint = channelSpecFingerprint(spec)
	return spec
}

func channelBundleFingerprint(spec ChannelBundleSpec) string {
	type optionPayload struct {
		Key   string `json:"key"`
		Value any    `json:"value"`
	}
	type channelPayload struct {
		ID                 string `json:"id"`
		Name               string `json:"name"`
		Type               int    `json:"type"`
		KeyHash            string `json:"key_hash,omitempty"`
		BaseURL            string `json:"base_url"`
		Models             string `json:"models"`
		Group              string `json:"group"`
		ModelMapping       string `json:"model_mapping,omitempty"`
		Priority           int64  `json:"priority,omitempty"`
		Weight             uint   `json:"weight,omitempty"`
		Status             string `json:"status"`
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
	payload := struct {
		Version  int              `json:"version"`
		Kind     string           `json:"kind"`
		Options  []optionPayload  `json:"options,omitempty"`
		Channels []channelPayload `json:"channels"`
	}{Version: spec.Version, Kind: spec.Kind}
	for _, option := range spec.Options {
		payload.Options = append(payload.Options, optionPayload{Key: option.Key, Value: option.Value})
	}
	for _, channel := range spec.Channels {
		payload.Channels = append(payload.Channels, channelPayload{
			ID:                 channel.ID,
			Name:               channel.Name,
			Type:               channel.Type,
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
			AutoBan:            autoBanOrDefault(channel.AutoBan),
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
	return fingerprintJSON(payload)
}

func channelBundleActualFingerprint(channels []newapi.Channel) string {
	payload := make([]channelFingerprintPayload, 0)
	for _, channel := range channels {
		if !strings.HasPrefix(channel.Name, "llmgw:") {
			continue
		}
		status := ChannelSpecStatusEnabled
		if channel.Status == newapi.ChannelStatusManuallyDisabled {
			status = ChannelSpecStatusDisabled
		}
		payload = append(payload, channelFingerprintPayload{
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
	sort.Slice(payload, func(i, j int) bool { return payload[i].Name < payload[j].Name })
	return fingerprintJSON(payload)
}

func channelBundleActualStateFingerprint(spec ChannelBundleSpec) string {
	return fingerprintJSON(spec)
}

func channelBundlePlanStatus(plan ChannelBundlePlan) string {
	for _, step := range plan.Steps {
		if step.Action == ChannelSyncStatusConflict {
			return ChannelSyncStatusConflict
		}
	}
	for _, step := range plan.Steps {
		if step.Action == ChannelSyncStatusDrift {
			return ChannelSyncStatusDrift
		}
	}
	if len(plan.Diff.Added) > 0 || len(plan.Diff.Changed) > 0 {
		return ChannelSyncStatusPending
	}
	if len(plan.Diff.Extra) > 0 {
		return ChannelSyncStatusDrift
	}
	return ChannelSyncStatusSynced
}

func sortChannelBundlePlan(plan *ChannelBundlePlan) {
	sort.Slice(plan.Steps, func(i, j int) bool {
		if plan.Steps[i].ResourceID != plan.Steps[j].ResourceID {
			return plan.Steps[i].ResourceID < plan.Steps[j].ResourceID
		}
		return plan.Steps[i].Kind < plan.Steps[j].Kind
	})
	sortBundleDiffs(plan.Diff.Added)
	sortBundleDiffs(plan.Diff.Changed)
	sortBundleDiffs(plan.Diff.Extra)
	sortBundleDiffs(plan.Diff.Synced)
}

func sortBundleDiffs(items []ChannelBundleResourceDiff) {
	sort.Slice(items, func(i, j int) bool {
		left := items[i].ID
		if left == "" {
			left = items[i].RemoteName
		}
		right := items[j].ID
		if right == "" {
			right = items[j].RemoteName
		}
		return left < right
	})
}

func mustCompactJSON(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(data)
}

func channelBundleRemoteResourceNames(raw string) map[string]bool {
	names := map[string]bool{}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return names
	}
	var resources map[string]int
	if err := json.Unmarshal([]byte(raw), &resources); err != nil {
		return names
	}
	for name := range resources {
		if name != "" {
			names[name] = true
		}
	}
	return names
}
