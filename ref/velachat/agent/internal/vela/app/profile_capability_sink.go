package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"velachat/agent/internal/hermes"
	"velachat/agent/internal/runtimeapi"
	rootstate "velachat/agent/internal/state"
	"velachat/agent/internal/vela/daemon"
	"velachat/agent/internal/vela/platform"
)

const maximumProfileCapabilityItems = 2000

type profileCapabilitySubmitter interface {
	Submit(
		context.Context,
		string,
		string,
		platform.ComputerAgentProfileCapabilityResult,
	) error
}

type computerProfileCapabilitySink struct {
	computerID         string
	stateRoot          string
	runtimeFuture      *runtimeSnapshotFuture
	workspaceDirectory func(string) (string, error)
	submitter          profileCapabilitySubmitter
	now                func() time.Time
	retryDelay         func(int) time.Duration

	mu       sync.Mutex
	active   map[string]struct{}
	cursorMu sync.Mutex
}

func (sink *computerProfileCapabilitySink) Refresh(
	ctx context.Context,
	assignment daemon.AgentAssignment,
) {
	if sink == nil || ctx == nil || assignment.ProfileCapabilityRefresh == nil {
		return
	}
	refresh := assignment.ProfileCapabilityRefresh
	if !sink.begin(refresh.RefreshID) {
		return
	}
	defer sink.finish(refresh.RefreshID)

	result := sink.discover(ctx, assignment)
	submitContext := ctx
	if !refresh.RequestedAt.IsZero() {
		var cancel context.CancelFunc
		submitContext, cancel = context.WithDeadline(
			ctx, refresh.RequestedAt.Add(2*time.Minute),
		)
		defer cancel()
	}
	for attempt := 1; ; attempt++ {
		if err := sink.submitter.Submit(
			submitContext, assignment.AgentID, refresh.RefreshID, result,
		); err == nil {
			return
		}
		delay := time.Second << min(attempt-1, 4)
		if sink.retryDelay != nil {
			delay = sink.retryDelay(attempt)
		}
		timer := time.NewTimer(delay)
		select {
		case <-submitContext.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (sink *computerProfileCapabilitySink) begin(refreshID string) bool {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if sink.active == nil {
		sink.active = make(map[string]struct{})
	}
	if _, active := sink.active[refreshID]; active {
		return false
	}
	sink.active[refreshID] = struct{}{}
	return true
}

func (sink *computerProfileCapabilitySink) finish(refreshID string) {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	delete(sink.active, refreshID)
}

func (sink *computerProfileCapabilitySink) discover(
	ctx context.Context,
	assignment daemon.AgentAssignment,
) platform.ComputerAgentProfileCapabilityResult {
	refresh := assignment.ProfileCapabilityRefresh
	now := time.Now
	if sink.now != nil {
		now = sink.now
	}
	base := platform.ComputerAgentProfileCapabilityResult{
		SchemaVersion:            1,
		Status:                   "failed",
		ContextGeneration:        refresh.ContextGeneration,
		AuthorityContextKey:      refresh.AuthorityContextKey,
		RuntimeKind:              refresh.RuntimeKind,
		RuntimeContextGeneration: 1,
		ObservedThroughSequence:  0,
		Models:                   failedModelSection("runtime_unavailable"),
		Skills:                   failedSkillSection("runtime_unavailable"),
		ObservedAt:               now().UTC(),
	}
	failure := "runtime_unavailable"
	base.ErrorCode = &failure

	workspace, err := sink.workspaceDirectory(assignment.AgentID)
	if err != nil {
		return failedCapabilityResult(base, "profile_not_ready")
	}
	snapshot, err := sink.runtimeFuture.Wait(ctx)
	if err != nil {
		return base
	}
	resolved, ok := snapshot.ResolveInternalRuntime(refresh.RuntimeKind)
	if !ok {
		resolved, ok = snapshot.ResolveRuntime(refresh.RuntimeKind)
	}
	if !ok || resolved.NewDriver == nil {
		return base
	}
	driver, err := resolved.NewDriver()
	if err != nil || driver == nil {
		return base
	}
	discoverer, ok := driver.(runtimeapi.ProfileCapabilityDiscoverer)
	if !ok {
		return base
	}
	capabilities, err := discoverer.DiscoverProfileCapabilities(
		ctx,
		runtimeapi.ProfileCapabilityRequest{
			AgentID: assignment.AgentID, WorkingDirectory: workspace,
			ForceReload: refresh.ForceReload,
		},
	)
	if err != nil {
		if errors.Is(err, hermes.ErrManagedProfileRuntimeBusy) {
			return failedCapabilityResult(base, "runtime_busy")
		}
		return failedCapabilityResult(base, "discovery_failed")
	}
	profileHome := filepath.Clean(strings.TrimSpace(capabilities.ProfileHome))
	if profileHome == "." || profileHome == "" {
		profileHome = "runtime:" + refresh.RuntimeKind
	}
	profileDigest := sha256.Sum256([]byte(profileHome))
	profileFingerprint := base64.RawURLEncoding.EncodeToString(profileDigest[:])
	runtimeGeneration, eventSequence, err := sink.advanceCapabilityCursor(
		assignment.AgentID,
		refresh.AuthorityContextKey,
		profileFingerprint,
		workspace,
	)
	if err != nil {
		return failedCapabilityResult(base, "discovery_failed")
	}
	base.Status = "succeeded"
	base.ErrorCode = nil
	base.RuntimeContextGeneration = runtimeGeneration
	base.ObservedThroughSequence = eventSequence
	base.Subject = &platform.ProfileCapabilitySubject{
		ComputerID: sink.computerID, RuntimeKind: refresh.RuntimeKind,
		ProfileKind:        capabilities.ProfileKind,
		ProfileFingerprint: profileFingerprint,
		WorkspacePath:      workspace, ContextGeneration: refresh.ContextGeneration,
		AuthorityContextKey:      refresh.AuthorityContextKey,
		RuntimeContextGeneration: runtimeGeneration,
		ObservedThroughSequence:  eventSequence,
	}
	base.Source = &platform.ProfileCapabilitySource{
		Protocol:       capabilities.Protocol,
		RuntimeVersion: fallbackRuntimeVersion(capabilities.RuntimeVersion),
		DiscoveryMode:  "short_lived_process", ForceReload: refresh.ForceReload,
	}
	base.Models = normalizeCapabilityModels(capabilities.Models)
	base.Skills = normalizeCapabilitySkills(capabilities.Skills)
	return base
}

type profileCapabilityCursor struct {
	SchemaVersion            int    `json:"schemaVersion"`
	AuthorityContextKey      string `json:"authorityContextKey"`
	ProfileFingerprint       string `json:"profileFingerprint"`
	WorkspacePath            string `json:"workspacePath"`
	RuntimeContextGeneration int64  `json:"runtimeContextGeneration"`
	EventSequence            int64  `json:"eventSequence"`
}

func (sink *computerProfileCapabilitySink) advanceCapabilityCursor(
	agentID string,
	authorityContextKey string,
	profileFingerprint string,
	workspacePath string,
) (int64, int64, error) {
	if sink.stateRoot == "" || !filepath.IsAbs(sink.stateRoot) {
		return 0, 0, errors.New("Profile capability cursor state root 无效")
	}
	sink.cursorMu.Lock()
	defer sink.cursorMu.Unlock()
	store := rootstate.New(sink.stateRoot)
	path := filepath.Join("agents", agentID, "profile-capability.cursor.json")
	cursor := profileCapabilityCursor{}
	err := store.Read(path, &cursor)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return 0, 0, err
	}
	if errors.Is(err, os.ErrNotExist) || cursor.SchemaVersion != 1 ||
		cursor.AuthorityContextKey != authorityContextKey {
		cursor = profileCapabilityCursor{
			SchemaVersion: 1, AuthorityContextKey: authorityContextKey,
			ProfileFingerprint: profileFingerprint, WorkspacePath: workspacePath,
			RuntimeContextGeneration: 1,
		}
	} else if cursor.ProfileFingerprint != profileFingerprint ||
		cursor.WorkspacePath != workspacePath {
		cursor.ProfileFingerprint = profileFingerprint
		cursor.WorkspacePath = workspacePath
		cursor.RuntimeContextGeneration++
		cursor.EventSequence = 0
	}
	if err := store.Write(path, cursor); err != nil {
		return 0, 0, err
	}
	return cursor.RuntimeContextGeneration, cursor.EventSequence, nil
}

func failedCapabilityResult(
	result platform.ComputerAgentProfileCapabilityResult,
	code string,
) platform.ComputerAgentProfileCapabilityResult {
	result.ErrorCode = &code
	modelCode := "model_discovery_failed"
	skillCode := "skill_discovery_failed"
	if code == "runtime_unavailable" || code == "profile_not_ready" {
		modelCode = "runtime_unavailable"
		skillCode = "runtime_unavailable"
	}
	result.Models = failedModelSection(modelCode)
	result.Skills = failedSkillSection(skillCode)
	return result
}

func failedModelSection(code string) platform.ProfileCapabilityModelSection {
	return platform.ProfileCapabilityModelSection{
		Status: "failed", Items: []platform.ProfileCapabilityModel{},
		Warnings: []platform.ProfileCapabilityWarning{}, ErrorCode: &code,
	}
}

func failedSkillSection(code string) platform.ProfileCapabilitySkillSection {
	return platform.ProfileCapabilitySkillSection{
		Status: "failed", Items: []platform.ProfileCapabilitySkill{},
		Warnings: []platform.ProfileCapabilityWarning{}, ErrorCode: &code,
	}
}

func normalizeCapabilityModels(
	models runtimeapi.ModelResult,
) platform.ProfileCapabilityModelSection {
	items := models.Models
	truncated := len(items) > maximumProfileCapabilityItems
	if truncated {
		items = items[:maximumProfileCapabilityItems]
	}
	result := platform.ProfileCapabilityModelSection{
		Status: "succeeded", Items: make([]platform.ProfileCapabilityModel, 0, len(items)),
		Warnings: []platform.ProfileCapabilityWarning{}, Truncated: truncated,
	}
	if value := trimCapabilityText(models.Default, 200); value != "" {
		result.EffectiveDefaultModelID = &value
	}
	for _, model := range items {
		id := trimCapabilityText(model.ID, 200)
		if id == "" {
			continue
		}
		label := trimCapabilityText(model.Label, 200)
		if label == "" {
			label = id
		}
		item := platform.ProfileCapabilityModel{
			ID: id, Label: label,
			SupportedReasoningEfforts: boundedStrings(model.SupportedReasoningEfforts, 16, 50),
			ServiceTiers:              boundedStrings(model.ServiceTiers, 16, 50),
		}
		item.Verified = optionalCapabilityText(model.Verified, 50)
		item.DefaultReasoningEffort = optionalCapabilityText(model.DefaultReasoningEffort, 50)
		item.DefaultServiceTier = optionalCapabilityText(model.DefaultServiceTier, 50)
		result.Items = append(result.Items, item)
	}
	if truncated {
		result.Warnings = append(result.Warnings, platform.ProfileCapabilityWarning{Code: "catalog_truncated"})
	}
	return result
}

func normalizeCapabilitySkills(
	skills []runtimeapi.Skill,
) platform.ProfileCapabilitySkillSection {
	truncated := len(skills) > maximumProfileCapabilityItems
	if truncated {
		skills = skills[:maximumProfileCapabilityItems]
	}
	result := platform.ProfileCapabilitySkillSection{
		Status: "succeeded", Items: make([]platform.ProfileCapabilitySkill, 0, len(skills)),
		Warnings: []platform.ProfileCapabilityWarning{}, Truncated: truncated,
	}
	for _, skill := range skills {
		id := trimCapabilityText(skill.ID, 200)
		name := trimCapabilityText(skill.Name, 200)
		if id == "" || name == "" {
			continue
		}
		missing := boundedStrings(skill.MissingDependencyTypes, 8, 50)
		result.Items = append(result.Items, platform.ProfileCapabilitySkill{
			ID: id, Name: name, Description: trimCapabilityText(skill.Description, 500),
			DisplayName:      optionalCapabilityText(skill.DisplayName, 200),
			ShortDescription: optionalCapabilityText(skill.ShortDescription, 300),
			Enabled:          skill.Enabled, Availability: normalizedAvailability(skill.Availability),
			Scope:                  normalizedSkillScope(skill.Scope),
			MissingDependencyCount: len(missing), MissingDependencyTypes: missing,
		})
	}
	if truncated {
		result.Warnings = append(result.Warnings, platform.ProfileCapabilityWarning{Code: "catalog_truncated"})
	}
	return result
}

func trimCapabilityText(value string, maximum int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > maximum {
		value = string(runes[:maximum])
	}
	return value
}

func optionalCapabilityText(value string, maximum int) *string {
	value = trimCapabilityText(value, maximum)
	if value == "" {
		return nil
	}
	return &value
}

func boundedStrings(values []string, maximumItems int, maximumRunes int) []string {
	result := make([]string, 0, min(len(values), maximumItems))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = trimCapabilityText(value, maximumRunes)
		if value == "" {
			continue
		}
		if _, duplicate := seen[value]; duplicate {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
		if len(result) == maximumItems {
			break
		}
	}
	return result
}

func normalizedAvailability(value string) string {
	if value == "unavailable" {
		return value
	}
	return "available"
}

func normalizedSkillScope(value string) string {
	switch value {
	case "project", "user", "admin", "system", "profile", "external":
		return value
	default:
		return "unknown"
	}
}

func fallbackRuntimeVersion(value string) string {
	value = trimCapabilityText(value, 100)
	if value == "" {
		return "unknown"
	}
	return value
}

type platformProfileCapabilitySubmitter struct {
	sessions *computerSessionManager
	client   *platform.Client
}

func (submitter *platformProfileCapabilitySubmitter) Submit(
	ctx context.Context,
	agentID string,
	operationID string,
	result platform.ComputerAgentProfileCapabilityResult,
) error {
	session, err := submitter.sessions.Current(ctx)
	if err != nil {
		return err
	}
	_, err = submitter.client.PutComputerAgentProfileCapabilityResult(
		ctx, session.AccessToken, agentID, operationID, result,
	)
	if !errors.Is(err, platform.ErrCredentialRejected) {
		return err
	}
	submitter.sessions.Invalidate(session.AccessToken)
	session, sessionErr := submitter.sessions.Current(ctx)
	if sessionErr != nil {
		return sessionErr
	}
	_, err = submitter.client.PutComputerAgentProfileCapabilityResult(
		ctx, session.AccessToken, agentID, operationID, result,
	)
	return err
}
