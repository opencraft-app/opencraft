package instance

import (
	"fmt"
	"strings"
	"time"

	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/transport"

	"go.uber.org/zap"
)

type openClawCronListPage struct {
	Jobs       []*openClawCronJob `json:"jobs"`
	Total      int64              `json:"total"`
	Offset     int64              `json:"offset"`
	Limit      int64              `json:"limit"`
	HasMore    bool               `json:"hasMore"`
	NextOffset *int64             `json:"nextOffset"`
}

type openClawCronJobState struct {
	NextRunAtMs        *int64 `json:"nextRunAtMs,omitempty"`
	RunningAtMs        *int64 `json:"runningAtMs,omitempty"`
	LastRunAtMs        *int64 `json:"lastRunAtMs,omitempty"`
	LastRunStatus      string `json:"lastRunStatus,omitempty"`
	LastStatus         string `json:"lastStatus,omitempty"`
	LastError          string `json:"lastError,omitempty"`
	LastDeliveryStatus string `json:"lastDeliveryStatus,omitempty"`
}

type openClawCronJob struct {
	ID             string                 `json:"id"`
	AgentID        string                 `json:"agentId,omitempty"`
	SessionKey     string                 `json:"sessionKey,omitempty"`
	Name           string                 `json:"name"`
	Description    string                 `json:"description,omitempty"`
	Enabled        bool                   `json:"enabled"`
	DeleteAfterRun bool                   `json:"deleteAfterRun,omitempty"`
	CreatedAtMs    int64                  `json:"createdAtMs"`
	UpdatedAtMs    int64                  `json:"updatedAtMs"`
	Schedule       map[string]interface{} `json:"schedule"`
	SessionTarget  string                 `json:"sessionTarget"`
	WakeMode       string                 `json:"wakeMode"`
	Payload        map[string]interface{} `json:"payload"`
	Delivery       map[string]interface{} `json:"delivery,omitempty"`
	State          *openClawCronJobState  `json:"state,omitempty"`
}

type openClawCronRunResult struct {
	OK     bool   `json:"ok"`
	Ran    bool   `json:"ran"`
	Reason string `json:"reason,omitempty"`
}

func buildInstanceGatewayURL(entity *modelinstance.Entity) (string, error) {
	sandboxID := strings.TrimSpace(entity.SandboxId)
	if sandboxID == "" || isPendingSandboxID(sandboxID) {
		return "", errcode.Wrap(errcode.ErrInstanceAutomationUnavailable, "instance gateway is not ready")
	}
	port := 0
	if config.ServerConf != nil && config.ServerConf.AdapterConfig != nil && config.ServerConf.AdapterConfig.LLMGateway != nil {
		port = config.ServerConf.AdapterConfig.LLMGateway.DefaultGatewayPort
	}
	if port <= 0 {
		port = 18789
	}
	return fmt.Sprintf("wss://%d-%s.sandbox.lightclaw.tech", port, sandboxID), nil
}

func (l *logic) resolveAutomationGateway(ctx pctx.Context, instanceID string) (*modelinstance.Entity, string, string, error) {
	entity, err := l.loadOwnedRunningInstance(ctx, instanceID)
	if err != nil {
		if err == errcode.ErrDebugNotSupported {
			return nil, "", "", errcode.Wrap(errcode.ErrInstanceAutomationUnavailable, "%v", err)
		}
		return nil, "", "", err
	}
	token := strings.TrimSpace(entity.GatewayAuthToken)
	if token == "" {
		if err := l.ensureAutomationGatewayAuthMaterial(ctx, entity); err != nil {
			return nil, "", "", err
		}
		token = strings.TrimSpace(entity.GatewayAuthToken)
		if token == "" {
			return nil, "", "", errcode.Wrap(errcode.ErrInstanceAutomationUnavailable, "instance gateway auth material is unavailable")
		}
	}
	url, err := buildInstanceGatewayURL(entity)
	if err != nil {
		return nil, "", "", err
	}
	return entity, url, token, nil
}

func (l *logic) ensureAutomationGatewayAuthMaterial(ctx pctx.Context, entity *modelinstance.Entity) error {
	if entity == nil {
		return errcode.Wrap(errcode.ErrInstanceAutomationUnavailable, "instance gateway auth material is unavailable")
	}
	if strings.TrimSpace(entity.GatewayAuthToken) != "" {
		return nil
	}
	if !l.aiGatewayProvisioningEnabled() {
		return errcode.Wrap(errcode.ErrInstanceAutomationUnavailable, "instance gateway auth material is unavailable")
	}
	previousKeyID := strings.TrimSpace(entity.AiGatewayKeyID)

	apiKeyResp, err := l.createAiGatewayApiKey(ctx, ctx.GetUserID(), entity.InstanceId)
	if err != nil {
		return errcode.Wrap(errcode.ErrInstanceAutomationUnavailable, "create ai-gateway key for automation: %v", err)
	}
	gatewayAuthToken, err := generateGatewayAuthToken()
	if err != nil {
		_ = l.revokeAiGatewayApiKey(ctx, apiKeyResp.KeyID)
		return errcode.Wrap(errcode.ErrInstanceAutomationUnavailable, "generate automation gateway token: %v", err)
	}
	if err := l.configureOnboard(ctx, entity.SandboxId, apiKeyResp.APIKey, gatewayAuthToken); err != nil {
		_ = l.revokeAiGatewayApiKey(ctx, apiKeyResp.KeyID)
		return errcode.Wrap(errcode.ErrInstanceAutomationUnavailable, "configure automation gateway auth material: %v", err)
	}
	if err := l.persistAiGatewayKeyIDWithStatuses(ctx, entity, apiKeyResp.KeyID, []string{modelinstance.InstanceStatusRunning}); err != nil {
		_ = l.revokeAiGatewayApiKey(ctx, apiKeyResp.KeyID)
		return errcode.Wrap(errcode.ErrInstanceAutomationUnavailable, "persist automation ai-gateway key id: %v", err)
	}
	if err := l.persistGatewayAuthTokenWithStatuses(ctx, entity, gatewayAuthToken, []string{modelinstance.InstanceStatusRunning}); err != nil {
		_ = l.revokeAiGatewayApiKey(ctx, apiKeyResp.KeyID)
		return errcode.Wrap(errcode.ErrInstanceAutomationUnavailable, "persist automation gateway auth token: %v", err)
	}

	if previousKeyID != "" && previousKeyID != apiKeyResp.KeyID {
		if err := l.revokeAiGatewayApiKey(ctx, previousKeyID); err != nil && !isAiGatewayKeyNotFound(err) {
			l.logger.Warn("revoke previous ai-gateway key after automation backfill failed",
				zap.Error(err),
				zap.String("instance_id", entity.InstanceId),
				zap.String("previous_key_id", previousKeyID),
			)
		}
	}
	return nil
}

func summarizeCronPayload(payload map[string]interface{}) string {
	if len(payload) == 0 {
		return ""
	}
	if kind, _ := payload["kind"].(string); kind == "systemEvent" {
		if text, _ := payload["text"].(string); text != "" {
			return text
		}
	}
	if kind, _ := payload["kind"].(string); kind == "agentTurn" {
		if message, _ := payload["message"].(string); message != "" {
			return message
		}
	}
	return ""
}

func scheduleExprAndTimezone(schedule map[string]interface{}) (string, string) {
	kind, _ := schedule["kind"].(string)
	if kind == "cron" {
		expr, _ := schedule["expr"].(string)
		tz, _ := schedule["tz"].(string)
		return expr, tz
	}
	return "", ""
}

func formatMillis(ms *int64) string {
	if ms == nil || *ms <= 0 {
		return ""
	}
	return time.UnixMilli(*ms).UTC().Format(time.RFC3339)
}

func mapAutomationSchedule(job *openClawCronJob) *transport.AutomationSchedule {
	if job == nil {
		return nil
	}
	expr, tz := scheduleExprAndTimezone(job.Schedule)
	promptSummary := summarizeCronPayload(job.Payload)
	state := &transport.AutomationScheduleState{}
	if job.State != nil {
		state.NextRunAtMs = job.State.NextRunAtMs
		state.RunningAtMs = job.State.RunningAtMs
		state.LastRunAtMs = job.State.LastRunAtMs
		state.LastRunStatus = strings.TrimSpace(job.State.LastRunStatus)
		if state.LastRunStatus == "" {
			state.LastRunStatus = strings.TrimSpace(job.State.LastStatus)
		}
		state.LastError = job.State.LastError
		state.LastDeliveryStatus = job.State.LastDeliveryStatus
	}
	if state.NextRunAtMs == nil && state.RunningAtMs == nil && state.LastRunAtMs == nil && state.LastRunStatus == "" && state.LastError == "" && state.LastDeliveryStatus == "" {
		state = nil
	}
	status := "idle"
	if state != nil && state.LastRunStatus != "" {
		status = state.LastRunStatus
	} else if state != nil && state.RunningAtMs != nil {
		status = "running"
	}
	return &transport.AutomationSchedule{
		ID:             job.ID,
		Title:          job.Name,
		Prompt:         promptSummary,
		Cron:           expr,
		Timezone:       tz,
		AgentID:        job.AgentID,
		SessionKey:     job.SessionKey,
		Name:           job.Name,
		Description:    job.Description,
		Enabled:        job.Enabled,
		DeleteAfterRun: job.DeleteAfterRun,
		SessionTarget:  job.SessionTarget,
		WakeMode:       job.WakeMode,
		PromptSummary:  promptSummary,
		Status:         status,
		LastRunAt: func() string {
			if state == nil {
				return ""
			}
			return formatMillis(state.LastRunAtMs)
		}(),
		LastRunStatus: func() string {
			if state == nil {
				return ""
			}
			return state.LastRunStatus
		}(),
		LastError: func() string {
			if state == nil {
				return ""
			}
			return state.LastError
		}(),
		NextRunAt: func() string {
			if state == nil {
				return ""
			}
			return formatMillis(state.NextRunAtMs)
		}(),
		Schedule:    job.Schedule,
		Payload:     job.Payload,
		Delivery:    job.Delivery,
		State:       state,
		CreatedAtMs: job.CreatedAtMs,
		UpdatedAtMs: job.UpdatedAtMs,
	}
}

func (l *logic) ListAutomationSchedules(ctx pctx.Context, instanceID string, offset, limit int64) (*transport.AutomationSchedulesResponse, error) {
	_, gatewayURL, gatewayToken, err := l.resolveAutomationGateway(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 50
	}
	var page openClawCronListPage
	if err := l.openclawGatewayAdapter.Call(ctx, gatewayURL, gatewayToken, "cron.list", map[string]interface{}{
		"includeDisabled": true,
		"offset":          offset,
		"limit":           limit,
	}, &page); err != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceCreationFailed, "list automation schedules: %v", err)
	}
	items := make([]*transport.AutomationSchedule, 0, len(page.Jobs))
	for _, job := range page.Jobs {
		if mapped := mapAutomationSchedule(job); mapped != nil {
			items = append(items, mapped)
		}
	}
	return &transport.AutomationSchedulesResponse{
		Items:  items,
		Total:  page.Total,
		Limit:  page.Limit,
		Offset: page.Offset,
	}, nil
}

func (l *logic) GetAutomationSchedule(ctx pctx.Context, instanceID, scheduleID string) (*transport.AutomationSchedule, error) {
	resp, err := l.ListAutomationSchedules(ctx, instanceID, 0, 200)
	if err != nil {
		return nil, err
	}
	for _, item := range resp.Items {
		if item.ID == scheduleID {
			return item, nil
		}
	}
	return nil, errcode.ErrInstanceNotFound
}

func (l *logic) CreateAutomationSchedule(ctx pctx.Context, instanceID string, req *transport.CreateAutomationScheduleRequest) (*transport.AutomationSchedule, error) {
	if req == nil || strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.SessionTarget) == "" || strings.TrimSpace(req.WakeMode) == "" || len(req.Schedule) == 0 || len(req.Payload) == 0 {
		if strings.TrimSpace(req.Title) == "" || strings.TrimSpace(req.Prompt) == "" || strings.TrimSpace(req.Cron) == "" {
			return nil, errcode.ErrInstanceInvalidParam
		}
	}
	_, gatewayURL, gatewayToken, err := l.resolveAutomationGateway(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = strings.TrimSpace(req.Title)
	}
	sessionTarget := strings.TrimSpace(req.SessionTarget)
	if sessionTarget == "" {
		sessionTarget = "main"
	}
	wakeMode := strings.TrimSpace(req.WakeMode)
	if wakeMode == "" {
		wakeMode = "now"
	}
	schedule := req.Schedule
	if len(schedule) == 0 {
		schedule = map[string]interface{}{
			"kind": "cron",
			"expr": strings.TrimSpace(req.Cron),
		}
		if strings.TrimSpace(req.Timezone) != "" {
			schedule["tz"] = strings.TrimSpace(req.Timezone)
		}
	}
	payload := req.Payload
	if len(payload) == 0 {
		payload = map[string]interface{}{
			"kind": "systemEvent",
			"text": strings.TrimSpace(req.Prompt),
		}
	}
	params := map[string]interface{}{
		"name":          name,
		"sessionTarget": sessionTarget,
		"wakeMode":      wakeMode,
		"schedule":      schedule,
		"payload":       payload,
	}
	if req.Description != "" {
		params["description"] = req.Description
	}
	if req.Enabled != nil {
		params["enabled"] = *req.Enabled
	}
	if req.DeleteAfterRun != nil {
		params["deleteAfterRun"] = *req.DeleteAfterRun
	}
	if req.AgentID != "" {
		params["agentId"] = strings.TrimSpace(req.AgentID)
	}
	if req.SessionKey != "" {
		params["sessionKey"] = strings.TrimSpace(req.SessionKey)
	}
	if len(req.Delivery) > 0 {
		params["delivery"] = req.Delivery
	}
	var job openClawCronJob
	if err := l.openclawGatewayAdapter.Call(ctx, gatewayURL, gatewayToken, "cron.add", params, &job); err != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceCreationFailed, "create automation schedule: %v", err)
	}
	return mapAutomationSchedule(&job), nil
}

func (l *logic) UpdateAutomationSchedule(ctx pctx.Context, instanceID, scheduleID string, req *transport.UpdateAutomationScheduleRequest) (*transport.AutomationSchedule, error) {
	if req == nil {
		return nil, errcode.ErrInstanceInvalidParam
	}
	_, gatewayURL, gatewayToken, err := l.resolveAutomationGateway(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	patch := map[string]interface{}{}
	if req.Title != nil && strings.TrimSpace(*req.Title) != "" {
		patch["name"] = strings.TrimSpace(*req.Title)
	}
	if req.Prompt != nil {
		patch["payload"] = map[string]interface{}{
			"kind": "systemEvent",
			"text": strings.TrimSpace(*req.Prompt),
		}
	}
	if req.Cron != nil {
		nextSchedule := map[string]interface{}{
			"kind": "cron",
			"expr": strings.TrimSpace(*req.Cron),
		}
		if req.Timezone != nil && strings.TrimSpace(*req.Timezone) != "" {
			nextSchedule["tz"] = strings.TrimSpace(*req.Timezone)
		}
		patch["schedule"] = nextSchedule
	}
	if req.Name != nil {
		patch["name"] = strings.TrimSpace(*req.Name)
	}
	if req.Description != nil {
		patch["description"] = *req.Description
	}
	if req.Enabled != nil {
		patch["enabled"] = *req.Enabled
	}
	if req.DeleteAfterRun != nil {
		patch["deleteAfterRun"] = *req.DeleteAfterRun
	}
	if req.AgentID != nil {
		if strings.TrimSpace(*req.AgentID) == "" {
			patch["agentId"] = nil
		} else {
			patch["agentId"] = strings.TrimSpace(*req.AgentID)
		}
	}
	if req.SessionKey != nil {
		if strings.TrimSpace(*req.SessionKey) == "" {
			patch["sessionKey"] = nil
		} else {
			patch["sessionKey"] = strings.TrimSpace(*req.SessionKey)
		}
	}
	if req.SessionTarget != nil {
		patch["sessionTarget"] = strings.TrimSpace(*req.SessionTarget)
	}
	if req.WakeMode != nil {
		patch["wakeMode"] = strings.TrimSpace(*req.WakeMode)
	}
	if len(req.Schedule) > 0 {
		patch["schedule"] = req.Schedule
	}
	if len(req.Payload) > 0 {
		patch["payload"] = req.Payload
	}
	if req.Delivery != nil {
		patch["delivery"] = req.Delivery
	}
	var job openClawCronJob
	if err := l.openclawGatewayAdapter.Call(ctx, gatewayURL, gatewayToken, "cron.update", map[string]interface{}{
		"id":    scheduleID,
		"patch": patch,
	}, &job); err != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceCreationFailed, "update automation schedule: %v", err)
	}
	return mapAutomationSchedule(&job), nil
}

func (l *logic) DeleteAutomationSchedule(ctx pctx.Context, instanceID, scheduleID string) error {
	_, gatewayURL, gatewayToken, err := l.resolveAutomationGateway(ctx, instanceID)
	if err != nil {
		return err
	}
	var resp map[string]interface{}
	if err := l.openclawGatewayAdapter.Call(ctx, gatewayURL, gatewayToken, "cron.remove", map[string]interface{}{"id": scheduleID}, &resp); err != nil {
		return errcode.Wrap(errcode.ErrInstanceCreationFailed, "delete automation schedule: %v", err)
	}
	return nil
}

func (l *logic) RunAutomationSchedule(ctx pctx.Context, instanceID, scheduleID string) (*transport.AutomationRunResponse, error) {
	_, gatewayURL, gatewayToken, err := l.resolveAutomationGateway(ctx, instanceID)
	if err != nil {
		return nil, err
	}
	var resp openClawCronRunResult
	if err := l.openclawGatewayAdapter.Call(ctx, gatewayURL, gatewayToken, "cron.run", map[string]interface{}{
		"id":   scheduleID,
		"mode": "force",
	}, &resp); err != nil {
		return nil, errcode.Wrap(errcode.ErrInstanceCreationFailed, "run automation schedule: %v", err)
	}
	result := &transport.AutomationRunResponse{ID: scheduleID}
	if resp.OK && resp.Ran {
		result.Status = "ok"
	} else if resp.OK && !resp.Ran {
		result.Status = resp.Reason
	} else {
		result.Status = "error"
	}
	schedule, err := l.GetAutomationSchedule(ctx, instanceID, scheduleID)
	if err == nil && schedule.State != nil {
		result.LastRunAtMs = schedule.State.LastRunAtMs
		result.LastDeliveryStatus = schedule.State.LastDeliveryStatus
	}
	return result, nil
}
