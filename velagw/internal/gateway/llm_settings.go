package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode"

	"git.woa.com/wisp/mono2/llmgateway/internal/newapi"
)

const (
	newAPIChannelTypeOpenAI    = 1
	newAPIChannelTypeAnthropic = 14
	newAPIDefaultGroup         = "default"
)

func (s *Service) GetUserLLMSettings(ctx context.Context, externalUserID string) (UserLLMSettings, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return UserLLMSettings{}, fmt.Errorf("external user id is required")
	}
	settings, ok, err := s.store.GetUserLLMSettings(ctx, externalUserID)
	if err != nil {
		return UserLLMSettings{}, err
	}
	if !ok {
		settings = UserLLMSettings{
			ExternalUserID: externalUserID,
			Routing:        UserLLMRouting{Mode: LLMRoutePlatformFirst},
			Providers:      []UserLLMProvider{},
		}
	}
	settings = normalizeUserLLMSettings(settings, UserLLMSettings{})
	return sanitizeUserLLMSettings(settings), nil
}

func (s *Service) SaveUserLLMSettings(ctx context.Context, externalUserID string, settings UserLLMSettings) (UserLLMSettings, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return UserLLMSettings{}, fmt.Errorf("external user id is required")
	}
	existing, ok, err := s.store.GetUserLLMSettings(ctx, externalUserID)
	if err != nil {
		return UserLLMSettings{}, err
	}
	if !ok {
		existing = UserLLMSettings{}
	}
	settings.ExternalUserID = externalUserID
	settings.BYOKGroup = existing.BYOKGroup
	settings.BYOKUpstreamKey = existing.BYOKUpstreamKey
	settings.BYOKUpstreamKeyID = existing.BYOKUpstreamKeyID
	settings.LastSyncedAt = existing.LastSyncedAt
	settings.LastSyncError = existing.LastSyncError
	settings.CreatedAt = existing.CreatedAt
	settings = normalizeUserLLMSettings(settings, existing)
	if err := validateUserLLMSettingsInput(settings); err != nil {
		return UserLLMSettings{}, err
	}
	if err := s.store.SaveUserLLMSettings(ctx, settings); err != nil {
		return UserLLMSettings{}, err
	}
	s.invalidateUserLLMSettingsTrafficCache(externalUserID)
	if err := s.refreshUserTrafficRoutes(ctx, externalUserID); err != nil {
		return UserLLMSettings{}, err
	}
	saved, _, err := s.store.GetUserLLMSettings(ctx, externalUserID)
	if err != nil {
		return UserLLMSettings{}, err
	}
	return sanitizeUserLLMSettings(saved), nil
}

func (s *Service) EnqueueUserLLMSettingsSync(ctx context.Context, externalUserID string) (UserLLMSettingsSyncResult, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return UserLLMSettingsSyncResult{}, fmt.Errorf("external user id is required")
	}
	settings, ok, err := s.store.GetUserLLMSettings(ctx, externalUserID)
	if err != nil {
		return UserLLMSettingsSyncResult{}, err
	}
	if !ok {
		return UserLLMSettingsSyncResult{}, fmt.Errorf("llm settings for user %q not found", externalUserID)
	}
	binding, ok, err := s.store.GetUserBinding(ctx, externalUserID)
	if err != nil {
		return UserLLMSettingsSyncResult{}, err
	}
	if !ok {
		return UserLLMSettingsSyncResult{}, fmt.Errorf("user %q is not bound to a new-api set", externalUserID)
	}
	settings = normalizeUserLLMSettings(settings, settings)
	for index := range settings.Providers {
		if !settings.Providers[index].Enabled {
			continue
		}
		settings.Providers[index].SyncStatus = LLMProviderSyncPending
		settings.Providers[index].LastSyncError = ""
	}
	settings.LastSyncError = ""
	enabled := false
	for _, provider := range settings.Providers {
		if provider.Enabled {
			enabled = true
			break
		}
	}
	if !enabled {
		settings.BYOKGroup = ""
		settings.BYOKUpstreamKey = ""
		settings.BYOKUpstreamKeyID = 0
	}
	task, err := s.store.SaveBYOKSyncIntent(ctx, BYOKSyncIntent{
		Settings: settings,
		Task: BYOKSyncTask{
			ExternalUserID: externalUserID,
			SetID:          binding.SetID,
			Status:         BYOKSyncTaskStatusPending,
			NextRunAt:      s.nowUTC(),
		},
		GroupName: byokGroupForUser(externalUserID),
		Enabled:   enabled,
	})
	if err != nil {
		return UserLLMSettingsSyncResult{}, err
	}
	sanitized := sanitizeUserLLMSettings(settings)
	group := ""
	if enabled {
		group = byokGroupForUser(externalUserID)
	}
	return UserLLMSettingsSyncResult{
		UserID:           externalUserID,
		SetID:            binding.SetID,
		BYOKGroup:        group,
		Providers:        sanitized.Providers,
		Status:           task.Status,
		RequestedVersion: task.RequestedVersion,
		LastSyncedAt:     settings.LastSyncedAt,
	}, nil
}

func (s *Service) SyncUserLLMSettings(ctx context.Context, externalUserID string) (UserLLMSettingsSyncResult, error) {
	if _, err := s.EnqueueUserLLMSettingsSync(ctx, externalUserID); err != nil {
		return UserLLMSettingsSyncResult{}, err
	}
	task, ok, err := s.store.GetBYOKSyncTask(ctx, strings.TrimSpace(externalUserID))
	if err != nil {
		return UserLLMSettingsSyncResult{}, err
	}
	if !ok {
		return UserLLMSettingsSyncResult{}, fmt.Errorf("BYOK sync task for user %q not found", externalUserID)
	}
	owner := fmt.Sprintf("direct-byok/%s/%d", externalUserID, s.nowUTC().UnixNano())
	task, acquired, err := s.store.TryAcquireBYOKSyncTask(ctx, externalUserID, owner, 5*time.Minute, s.nowUTC())
	if err != nil {
		return UserLLMSettingsSyncResult{}, err
	}
	if !acquired {
		return UserLLMSettingsSyncResult{}, fmt.Errorf("BYOK sync task for user %q is already running", externalUserID)
	}
	var result UserLLMSettingsSyncResult
	err = s.runAcquiredBYOKSyncTask(ctx, task, 5*time.Minute, func(taskCtx context.Context, userID string) error {
		binding, ok, err := s.store.GetUserBinding(taskCtx, userID)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("user %q is not bound to a new-api set", userID)
		}
		set, ok, err := s.store.GetSet(taskCtx, binding.SetID)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("set %q not found", binding.SetID)
		}
		if _, err := s.reconcileSetGroupRatios(taskCtx, set); err != nil {
			return err
		}
		result, err = s.syncUserLLMSettings(taskCtx, userID)
		return err
	})
	return result, err
}

func (s *Service) syncUserLLMSettings(ctx context.Context, externalUserID string) (UserLLMSettingsSyncResult, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return UserLLMSettingsSyncResult{}, fmt.Errorf("external user id is required")
	}
	settings, ok, err := s.store.GetUserLLMSettings(ctx, externalUserID)
	if err != nil {
		return UserLLMSettingsSyncResult{}, err
	}
	if !ok {
		return UserLLMSettingsSyncResult{}, fmt.Errorf("llm settings for user %q not found", externalUserID)
	}
	settings = normalizeUserLLMSettings(settings, settings)

	binding, ok, err := s.store.GetUserBinding(ctx, externalUserID)
	if err != nil {
		return UserLLMSettingsSyncResult{}, err
	}
	if !ok {
		return UserLLMSettingsSyncResult{}, fmt.Errorf("user %q is not bound to a new-api set", externalUserID)
	}
	set, ok, err := s.store.GetSet(ctx, binding.SetID)
	if err != nil {
		return UserLLMSettingsSyncResult{}, err
	}
	if !ok {
		return UserLLMSettingsSyncResult{}, fmt.Errorf("set %q not found", binding.SetID)
	}
	if set.AdminUserID == 0 || set.AdminAccessToken == "" {
		return UserLLMSettingsSyncResult{}, fmt.Errorf("set %q is not bootstrapped", set.ID)
	}

	client := s.newAPIClient(set.BaseURL)
	auth := adminAuthForSet(set)
	group := byokGroupForUser(externalUserID)
	hasEnabledProvider := false
	for _, provider := range settings.Providers {
		if provider.Enabled {
			hasEnabledProvider = true
			break
		}
	}
	if !hasEnabledProvider {
		if err := client.UpdateUserGroup(ctx, auth, binding.Username, newAPIDefaultGroup); err != nil {
			settings.LastSyncError = err.Error()
			_ = s.store.SaveUserLLMSettings(ctx, settings)
			return UserLLMSettingsSyncResult{}, err
		}
		settings.BYOKGroup = ""
		settings.BYOKUpstreamKey = ""
		settings.BYOKUpstreamKeyID = 0
		settings.LastSyncedAt = s.nowUTC()
		settings.LastSyncError = ""
		if err := s.store.SaveUserLLMSettings(ctx, settings); err != nil {
			return UserLLMSettingsSyncResult{}, err
		}
		s.invalidateUserLLMSettingsTrafficCache(externalUserID)
		if err := s.refreshUserTrafficRoutes(ctx, externalUserID); err != nil {
			return UserLLMSettingsSyncResult{}, err
		}
		return UserLLMSettingsSyncResult{
			UserID:       externalUserID,
			SetID:        set.ID,
			Providers:    sanitizeUserLLMSettings(settings).Providers,
			LastSyncedAt: settings.LastSyncedAt,
		}, nil
	}

	for index := range settings.Providers {
		provider := &settings.Providers[index]
		if !provider.Enabled {
			continue
		}
		if err := s.syncUserLLMProvider(ctx, client, auth, externalUserID, group, index, len(settings.Providers), provider); err != nil {
			provider.SyncStatus = LLMProviderSyncError
			provider.LastSyncError = err.Error()
			settings.LastSyncError = err.Error()
			_ = s.store.SaveUserLLMSettings(ctx, settings)
			return UserLLMSettingsSyncResult{}, err
		}
		provider.SyncStatus = LLMProviderSyncSynced
		provider.LastSyncError = ""
	}

	if err := client.UpdateUserGroup(ctx, auth, binding.Username, group); err != nil {
		settings.LastSyncError = err.Error()
		_ = s.store.SaveUserLLMSettings(ctx, settings)
		return UserLLMSettingsSyncResult{}, err
	}

	if settings.BYOKUpstreamKey == "" || settings.BYOKUpstreamKeyID == 0 {
		upstreamKey, err := s.createBYOKUpstreamToken(ctx, client, binding, group)
		if err != nil {
			settings.LastSyncError = err.Error()
			_ = s.store.SaveUserLLMSettings(ctx, settings)
			return UserLLMSettingsSyncResult{}, err
		}
		settings.BYOKUpstreamKey = upstreamKey.Key
		settings.BYOKUpstreamKeyID = upstreamKey.ID
	}
	settings.BYOKGroup = group
	settings.LastSyncedAt = s.nowUTC()
	settings.LastSyncError = ""
	if err := s.store.SaveUserLLMSettings(ctx, settings); err != nil {
		return UserLLMSettingsSyncResult{}, err
	}
	s.invalidateUserLLMSettingsTrafficCache(externalUserID)
	if err := s.refreshUserTrafficRoutes(ctx, externalUserID); err != nil {
		return UserLLMSettingsSyncResult{}, err
	}
	sanitized := sanitizeUserLLMSettings(settings)
	return UserLLMSettingsSyncResult{
		UserID:            externalUserID,
		SetID:             set.ID,
		BYOKGroup:         group,
		BYOKUpstreamKeyID: settings.BYOKUpstreamKeyID,
		Providers:         sanitized.Providers,
		LastSyncedAt:      settings.LastSyncedAt,
	}, nil
}

func byokSyncBackoff(attempts int) time.Duration {
	if attempts <= 0 {
		return time.Minute
	}
	if attempts > 6 {
		attempts = 6
	}
	return time.Duration(attempts) * time.Minute
}

func (s *Service) syncUserLLMProvider(ctx context.Context, client *newapi.Client, auth newapi.AdminAuth, externalUserID string, group string, index int, providerCount int, provider *UserLLMProvider) error {
	if strings.TrimSpace(provider.APIKey) == "" {
		return fmt.Errorf("provider %q api key is required", provider.ID)
	}
	channelType, err := channelTypeForLLMProviderProtocol(provider.Protocol)
	if err != nil {
		return err
	}
	models, modelMapping, err := providerModelsAndMapping(provider)
	if err != nil {
		return err
	}
	remoteName := byokProviderRemoteName(externalUserID, provider.ID)
	priority := byokProviderPriority(index, providerCount)
	weight := uint(100)
	autoBan := 1
	baseURL := provider.BaseURL
	mapping := modelMapping
	remark := "managed by llmgateway byok"
	channel := newapi.Channel{
		Type:         channelType,
		Key:          provider.APIKey,
		Status:       1,
		Name:         remoteName,
		Weight:       &weight,
		BaseURL:      &baseURL,
		Models:       models,
		Group:        group,
		ModelMapping: &mapping,
		Priority:     &priority,
		AutoBan:      &autoBan,
		Remark:       &remark,
	}
	if provider.RemoteChannelID > 0 {
		channel.ID = provider.RemoteChannelID
		if err := client.UpdateChannel(ctx, auth, channel); err == nil {
			return nil
		}
		// 远端对象可能被人工删除；仅在按 ID 更新失败时回退到确定性名称查找。
		channel.ID = 0
	}
	existing, ok, err := findNewAPIChannelByName(ctx, client, auth, remoteName)
	if err != nil {
		return err
	}
	if ok {
		channel.ID = existing.ID
		provider.RemoteChannelID = existing.ID
		return client.UpdateChannel(ctx, auth, channel)
	}
	if err := client.CreateChannel(ctx, auth, channel); err != nil {
		return err
	}
	created, ok, err := findNewAPIChannelByName(ctx, client, auth, remoteName)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("new-api BYOK channel was created but could not be found by name %q", remoteName)
	}
	channel.ID = created.ID
	provider.RemoteChannelID = created.ID
	// AddChannel does not always refresh new-api's in-memory channel routing cache.
	return client.UpdateChannel(ctx, auth, channel)
}

func byokProviderPriority(index int, providerCount int) int64 {
	if providerCount <= 0 {
		providerCount = 1
	}
	if index < 0 {
		index = 0
	}
	priority := providerCount - index
	if priority < 1 {
		priority = 1
	}
	return int64(priority * 10)
}

func (s *Service) createBYOKUpstreamToken(ctx context.Context, client *newapi.Client, binding UserBinding, group string) (newapi.UpstreamKey, error) {
	if binding.UpstreamUserID == 0 {
		return newapi.UpstreamKey{}, fmt.Errorf("upstream user id is required")
	}
	if binding.Username == "" || binding.Password == "" {
		return newapi.UpstreamKey{}, fmt.Errorf("upstream username and password are required")
	}
	session, err := client.Login(ctx, binding.Username, binding.Password)
	if err != nil {
		return newapi.UpstreamKey{}, err
	}
	userAccessToken, err := client.GenerateAccessToken(ctx, binding.UpstreamUserID, session.AccessToken)
	if err != nil {
		return newapi.UpstreamKey{}, err
	}
	return client.CreateUserToken(ctx, binding.UpstreamUserID, userAccessToken, newapi.CreateTokenRequest{
		Name:           byokTokenRemoteName(binding.ExternalUserID),
		ExpiredTime:    -1,
		UnlimitedQuota: true,
		Group:          group,
	})
}

func normalizeUserLLMSettings(settings UserLLMSettings, existing UserLLMSettings) UserLLMSettings {
	settings.ExternalUserID = strings.TrimSpace(settings.ExternalUserID)
	settings.Routing.Mode = normalizeLLMRouteMode(settings.Routing.Mode)
	existingProviders := map[string]UserLLMProvider{}
	for _, provider := range existing.Providers {
		existingProviders[provider.ID] = provider
	}
	for index := range settings.Providers {
		provider := &settings.Providers[index]
		provider.ID = strings.TrimSpace(provider.ID)
		if provider.ID == "" {
			provider.ID = fmt.Sprintf("provider-%d", index+1)
		}
		provider.Name = strings.TrimSpace(provider.Name)
		if provider.Name == "" {
			provider.Name = provider.ID
		}
		provider.Protocol = normalizeLLMProviderProtocol(provider.Protocol)
		provider.BaseURL = strings.TrimRight(strings.TrimSpace(provider.BaseURL), "/")
		if existingProvider, ok := existingProviders[provider.ID]; ok {
			if strings.TrimSpace(provider.APIKey) == "" {
				provider.APIKey = existingProvider.APIKey
			}
			if provider.RemoteChannelID == 0 {
				provider.RemoteChannelID = existingProvider.RemoteChannelID
			}
		}
		if provider.APIKey != "" {
			provider.KeyHash = hashExternalKey(provider.APIKey)
		}
		if provider.ModelMappings == nil {
			provider.ModelMappings = map[string]string{}
		}
		if provider.SyncStatus == "" {
			provider.SyncStatus = LLMProviderSyncPending
		}
	}
	return settings
}

func normalizeLLMRouteMode(mode string) string {
	switch strings.TrimSpace(mode) {
	case LLMRouteBYOKFirst:
		return LLMRouteBYOKFirst
	case LLMRoutePlatformFirst, "":
		return LLMRoutePlatformFirst
	default:
		return LLMRoutePlatformFirst
	}
}

func normalizeLLMProviderProtocol(protocol string) string {
	switch strings.TrimSpace(protocol) {
	case LLMProviderProtocolAnthropic:
		return LLMProviderProtocolAnthropic
	case LLMProviderProtocolOpenAICompatible, "":
		return LLMProviderProtocolOpenAICompatible
	default:
		return strings.TrimSpace(protocol)
	}
}

func channelTypeForLLMProviderProtocol(protocol string) (int, error) {
	switch normalizeLLMProviderProtocol(protocol) {
	case LLMProviderProtocolOpenAICompatible:
		return newAPIChannelTypeOpenAI, nil
	case LLMProviderProtocolAnthropic:
		return newAPIChannelTypeAnthropic, nil
	default:
		return 0, fmt.Errorf("unsupported provider protocol %q", protocol)
	}
}

func providerModelsAndMapping(provider *UserLLMProvider) (string, string, error) {
	if len(provider.ModelMappings) == 0 {
		return "", "", fmt.Errorf("provider %q model mappings are required", provider.ID)
	}
	models := make([]string, 0, len(provider.ModelMappings))
	for virtualModel, upstreamModel := range provider.ModelMappings {
		virtualModel = strings.TrimSpace(virtualModel)
		upstreamModel = strings.TrimSpace(upstreamModel)
		if virtualModel == "" || upstreamModel == "" {
			return "", "", fmt.Errorf("provider %q has empty model mapping", provider.ID)
		}
		models = append(models, virtualModel)
	}
	sort.Strings(models)
	raw, err := json.Marshal(provider.ModelMappings)
	if err != nil {
		return "", "", err
	}
	return strings.Join(models, ","), string(raw), nil
}

func findNewAPIChannelByName(ctx context.Context, client *newapi.Client, auth newapi.AdminAuth, name string) (newapi.Channel, bool, error) {
	channels, err := client.SearchChannels(ctx, auth, name)
	if err != nil {
		return newapi.Channel{}, false, err
	}
	for _, channel := range channels {
		if channel.Name == name {
			return channel, true, nil
		}
	}
	return newapi.Channel{}, false, nil
}

func byokGroupForUser(externalUserID string) string {
	return "byok_" + byokUserRemoteID(externalUserID)
}

func byokProviderRemoteName(externalUserID string, providerID string) string {
	providerID = safeIdentifier(providerID)
	if len(providerID) > 16 {
		providerID = providerID[:16]
	}
	return "llmgw-byok-" + byokUserRemoteID(externalUserID) + "-" + providerID
}

func byokTokenRemoteName(externalUserID string) string {
	return "llmgw-byok-" + byokUserRemoteID(externalUserID)
}

func byokUserRemoteID(externalUserID string) string {
	hash := hashExternalKey(strings.TrimSpace(externalUserID))
	if len(hash) > 16 {
		return hash[:16]
	}
	return hash
}

func safeIdentifier(value string) string {
	value = strings.TrimSpace(value)
	var builder strings.Builder
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			builder.WriteRune(unicode.ToLower(r))
			continue
		}
		builder.WriteByte('_')
	}
	result := strings.Trim(builder.String(), "_")
	if result == "" {
		return "user"
	}
	return result
}

func sanitizeUserLLMSettings(settings UserLLMSettings) UserLLMSettings {
	settings.BYOKUpstreamKey = ""
	if settings.Providers != nil {
		providers := make([]UserLLMProvider, len(settings.Providers))
		copy(providers, settings.Providers)
		settings.Providers = providers
	}
	for index := range settings.Providers {
		settings.Providers[index].APIKey = ""
	}
	return settings
}

func validateUserLLMSettingsInput(settings UserLLMSettings) error {
	for _, provider := range settings.Providers {
		if provider.BaseURL != "" {
			if _, err := url.ParseRequestURI(provider.BaseURL); err != nil {
				return fmt.Errorf("invalid provider base url %q: %w", provider.BaseURL, err)
			}
		}
	}
	return nil
}
