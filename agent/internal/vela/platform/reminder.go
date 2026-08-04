package platform

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"velachat/agent/internal/common"
)

const maxRuntimeReminderResponseBytes = 2 << 20

var ErrInvalidRuntimeReminder = errors.New("平台返回的 Runtime Reminder 无效")

type ReminderScheduleKind string

const (
	ReminderOnce ReminderScheduleKind = "once"
	ReminderCron ReminderScheduleKind = "cron"
)

type ReminderStatus string

const (
	ReminderActive    ReminderStatus = "active"
	ReminderPaused    ReminderStatus = "paused"
	ReminderCompleted ReminderStatus = "completed"
	ReminderCanceled  ReminderStatus = "canceled"
)

type ReminderAnchorKind string

const (
	ReminderAnchorMessage ReminderAnchorKind = "message"
	ReminderAnchorThread  ReminderAnchorKind = "thread"
)

type ReminderAnchor struct {
	Kind       ReminderAnchorKind
	ChannelID  string
	ThreadID   string
	MessageRef ThreadMessageRef
}

type Reminder struct {
	ID           string
	ServerID     string
	AgentID      string
	ScheduleKind ReminderScheduleKind
	Schedule     string
	Timezone     string
	Text         string
	Status       ReminderStatus
	NextFireAt   *time.Time
	Anchor       *ReminderAnchor
	Revision     int64
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

type ReminderDraft struct {
	ScheduleKind ReminderScheduleKind
	Schedule     string
	Timezone     string
	Text         string
	Anchor       *ReminderAnchor
}

type ReminderPatch struct {
	Schedule *string
	Timezone *string
	Text     *string
	Status   *ReminderStatus
	Anchor   *ReminderAnchor
}

type ReminderLogEntry struct {
	ID              string
	ServerID        string
	ReminderID      string
	AgentID         string
	ScheduledFireAt time.Time
	State           string
	Text            string
	AcknowledgedAt  *time.Time
	ResultCode      *string
}

type runtimeReminderAnchorPayload struct {
	Kind           string                   `json:"kind"`
	ChannelID      string                   `json:"channelId"`
	ThreadID       *string                  `json:"threadId,omitempty"`
	MessageRef     *runtimeThreadRefPayload `json:"messageRef,omitempty"`
	RootMessageRef *runtimeThreadRefPayload `json:"rootMessageRef,omitempty"`
}

type runtimeReminderPayload struct {
	ID           string                        `json:"id"`
	ServerID     string                        `json:"serverId"`
	AgentID      string                        `json:"agentId"`
	ScheduleKind string                        `json:"scheduleKind"`
	Schedule     string                        `json:"schedule"`
	Timezone     string                        `json:"timezone"`
	Text         string                        `json:"text"`
	Status       string                        `json:"status"`
	NextFireAt   *time.Time                    `json:"nextFireAt"`
	Anchor       *runtimeReminderAnchorPayload `json:"anchor"`
	Revision     int64                         `json:"revision"`
	CreatedAt    time.Time                     `json:"createdAt"`
	UpdatedAt    time.Time                     `json:"updatedAt"`
}

type runtimeReminderLogPayload struct {
	ID              string     `json:"id"`
	ServerID        string     `json:"serverId"`
	ReminderID      string     `json:"reminderId"`
	AgentID         string     `json:"agentId"`
	ScheduledFireAt time.Time  `json:"scheduledFireAt"`
	State           string     `json:"state"`
	Text            string     `json:"text"`
	AcknowledgedAt  *time.Time `json:"acknowledgedAt"`
	ResultCode      *string    `json:"resultCode"`
}

func (c *Client) ListRuntimeReminders(
	ctx context.Context,
	token AccessToken,
	serverID string,
	agentID string,
) ([]Reminder, error) {
	if !validUUIDv7(serverID) || !validUUIDv7(agentID) {
		return nil, ErrInvalidConfig
	}
	request, err := c.runtimeTaskRequest(ctx, token, http.MethodGet, "/runtime/reminders", nil)
	if err != nil {
		return nil, err
	}
	response, err := c.doRuntimeRequest(request, http.StatusOK)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := readBounded(response.Body, maxRuntimeReminderResponseBytes)
	if err != nil {
		return nil, ErrInvalidRuntimeReminder
	}
	var payload []runtimeReminderPayload
	if err := common.Unmarshal(data, &payload); err != nil || len(payload) > 10_000 {
		return nil, ErrInvalidRuntimeReminder
	}
	values := make([]Reminder, 0, len(payload))
	for _, item := range payload {
		value, err := validateRuntimeReminder(item, serverID, agentID)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, nil
}

func (c *Client) CreateRuntimeReminder(
	ctx context.Context,
	token AccessToken,
	serverID string,
	agentID string,
	draft ReminderDraft,
	idempotencyKey string,
) (Reminder, error) {
	if !validUUIDv7(serverID) || !validUUIDv7(agentID) ||
		!validReminderDraft(draft) || strings.TrimSpace(idempotencyKey) == "" {
		return Reminder{}, ErrInvalidConfig
	}
	anchor, err := runtimeReminderAnchorToPayload(draft.Anchor)
	if err != nil {
		return Reminder{}, ErrInvalidConfig
	}
	body, err := common.Marshal(struct {
		ScheduleKind ReminderScheduleKind          `json:"scheduleKind"`
		Schedule     string                        `json:"schedule"`
		Timezone     string                        `json:"timezone"`
		Text         string                        `json:"text"`
		Anchor       *runtimeReminderAnchorPayload `json:"anchor,omitempty"`
	}{draft.ScheduleKind, draft.Schedule, draft.Timezone, draft.Text, anchor})
	if err != nil {
		return Reminder{}, ErrInvalidConfig
	}
	request, err := c.runtimeTaskRequest(
		ctx, token, http.MethodPost, "/runtime/reminders", bytes.NewReader(body),
	)
	if err != nil {
		return Reminder{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", strings.TrimSpace(idempotencyKey))
	return c.doRuntimeReminderMutation(
		request, http.StatusCreated, "", serverID, agentID,
	)
}

func (c *Client) UpdateRuntimeReminder(
	ctx context.Context,
	token AccessToken,
	serverID string,
	agentID string,
	reminderID string,
	revision int64,
	patch ReminderPatch,
	idempotencyKey string,
) (Reminder, error) {
	if !validUUIDv7(serverID) || !validUUIDv7(agentID) || !validUUIDv7(reminderID) ||
		revision < 1 || strings.TrimSpace(idempotencyKey) == "" || !validReminderPatch(patch) {
		return Reminder{}, ErrInvalidConfig
	}
	anchor, err := runtimeReminderAnchorToPayload(patch.Anchor)
	if err != nil {
		return Reminder{}, ErrInvalidConfig
	}
	body, err := common.Marshal(struct {
		Schedule *string                       `json:"schedule,omitempty"`
		Timezone *string                       `json:"timezone,omitempty"`
		Text     *string                       `json:"text,omitempty"`
		Status   *ReminderStatus               `json:"status,omitempty"`
		Anchor   *runtimeReminderAnchorPayload `json:"anchor,omitempty"`
	}{patch.Schedule, patch.Timezone, patch.Text, patch.Status, anchor})
	if err != nil {
		return Reminder{}, ErrInvalidConfig
	}
	request, err := c.runtimeTaskRequest(
		ctx, token, http.MethodPatch,
		"/runtime/reminders/"+url.PathEscape(reminderID), bytes.NewReader(body),
	)
	if err != nil {
		return Reminder{}, err
	}
	setRuntimeMutationHeaders(request, revision, idempotencyKey)
	return c.doRuntimeReminderMutation(
		request, http.StatusOK, reminderID, serverID, agentID,
	)
}

func (c *Client) CancelRuntimeReminder(
	ctx context.Context,
	token AccessToken,
	reminderID string,
	revision int64,
	idempotencyKey string,
) error {
	if !validUUIDv7(reminderID) || revision < 1 || strings.TrimSpace(idempotencyKey) == "" {
		return ErrInvalidConfig
	}
	request, err := c.runtimeTaskRequest(
		ctx, token, http.MethodDelete,
		"/runtime/reminders/"+url.PathEscape(reminderID), nil,
	)
	if err != nil {
		return err
	}
	setRuntimeMutationHeaders(request, revision, idempotencyKey)
	response, err := c.doRuntimeRequest(request, http.StatusNoContent)
	if err != nil {
		return err
	}
	return response.Body.Close()
}

func (c *Client) SnoozeRuntimeReminder(
	ctx context.Context,
	token AccessToken,
	serverID string,
	agentID string,
	reminderID string,
	revision int64,
	delay time.Duration,
	idempotencyKey string,
) (Reminder, error) {
	if !validUUIDv7(serverID) || !validUUIDv7(agentID) || !validUUIDv7(reminderID) ||
		revision < 1 || delay < time.Second || delay > 365*24*time.Hour ||
		strings.TrimSpace(idempotencyKey) == "" || delay%time.Second != 0 {
		return Reminder{}, ErrInvalidConfig
	}
	body, err := common.Marshal(struct {
		DelaySeconds int64 `json:"delaySeconds"`
	}{DelaySeconds: int64(delay / time.Second)})
	if err != nil {
		return Reminder{}, ErrInvalidConfig
	}
	request, err := c.runtimeTaskRequest(
		ctx, token, http.MethodPost,
		"/runtime/reminders/"+url.PathEscape(reminderID)+"/snooze", bytes.NewReader(body),
	)
	if err != nil {
		return Reminder{}, err
	}
	setRuntimeMutationHeaders(request, revision, idempotencyKey)
	return c.doRuntimeReminderMutation(
		request, http.StatusOK, reminderID, serverID, agentID,
	)
}

func (c *Client) ListRuntimeReminderLog(
	ctx context.Context,
	token AccessToken,
	serverID string,
	agentID string,
	reminderID string,
	cursor string,
	limit int,
) ([]ReminderLogEntry, error) {
	if !validUUIDv7(serverID) || !validUUIDv7(agentID) || !validUUIDv7(reminderID) ||
		(cursor != "" && !validUUIDv7(cursor)) || limit < 1 || limit > 100 {
		return nil, ErrInvalidConfig
	}
	query := url.Values{}
	query.Set("limit", strconv.Itoa(limit))
	if cursor != "" {
		query.Set("cursor", cursor)
	}
	request, err := c.runtimeTaskRequest(
		ctx, token, http.MethodGet,
		"/runtime/reminders/"+url.PathEscape(reminderID)+"/log?"+query.Encode(), nil,
	)
	if err != nil {
		return nil, err
	}
	response, err := c.doRuntimeRequest(request, http.StatusOK)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := readBounded(response.Body, maxRuntimeReminderResponseBytes)
	if err != nil {
		return nil, ErrInvalidRuntimeReminder
	}
	var payload []runtimeReminderLogPayload
	if err := common.Unmarshal(data, &payload); err != nil || len(payload) > 100 {
		return nil, ErrInvalidRuntimeReminder
	}
	values := make([]ReminderLogEntry, 0, len(payload))
	for _, item := range payload {
		if !validUUIDv7(item.ID) || item.ServerID != serverID || item.AgentID != agentID ||
			item.ReminderID != reminderID || item.ScheduledFireAt.IsZero() ||
			!validReminderLogState(item.State) || strings.TrimSpace(item.Text) == "" {
			return nil, ErrInvalidRuntimeReminder
		}
		values = append(values, ReminderLogEntry{
			ID: item.ID, ServerID: item.ServerID, ReminderID: item.ReminderID,
			AgentID: item.AgentID, ScheduledFireAt: item.ScheduledFireAt.UTC(),
			State: item.State, Text: item.Text, AcknowledgedAt: item.AcknowledgedAt,
			ResultCode: item.ResultCode,
		})
	}
	return values, nil
}

func setRuntimeMutationHeaders(
	request *http.Request,
	revision int64,
	idempotencyKey string,
) {
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("If-Match", strconv.FormatInt(revision, 10))
	request.Header.Set("Idempotency-Key", strings.TrimSpace(idempotencyKey))
}

func (c *Client) doRuntimeReminderMutation(
	request *http.Request,
	status int,
	reminderID string,
	serverID string,
	agentID string,
) (Reminder, error) {
	response, err := c.doRuntimeRequest(request, status)
	if err != nil {
		return Reminder{}, err
	}
	defer response.Body.Close()
	data, err := readBounded(response.Body, maxRuntimeReminderResponseBytes)
	if err != nil {
		return Reminder{}, ErrInvalidRuntimeReminder
	}
	var payload runtimeReminderPayload
	if err := common.Unmarshal(data, &payload); err != nil {
		return Reminder{}, ErrInvalidRuntimeReminder
	}
	value, err := validateRuntimeReminder(payload, serverID, agentID)
	if err != nil || reminderID != "" && value.ID != reminderID {
		return Reminder{}, ErrInvalidRuntimeReminder
	}
	return value, nil
}

func validateRuntimeReminder(
	payload runtimeReminderPayload,
	serverID string,
	agentID string,
) (Reminder, error) {
	scheduleKind := ReminderScheduleKind(payload.ScheduleKind)
	status := ReminderStatus(payload.Status)
	if !validUUIDv7(payload.ID) || payload.ServerID != serverID || payload.AgentID != agentID ||
		!validReminderScheduleKind(scheduleKind) || strings.TrimSpace(payload.Schedule) == "" ||
		strings.TrimSpace(payload.Timezone) == "" || strings.TrimSpace(payload.Text) == "" ||
		!validReminderStatus(status) || payload.Revision < 1 || payload.CreatedAt.IsZero() ||
		payload.UpdatedAt.IsZero() || payload.NextFireAt != nil && payload.NextFireAt.IsZero() {
		return Reminder{}, ErrInvalidRuntimeReminder
	}
	anchor, err := runtimeReminderAnchorFromPayload(payload.Anchor)
	if err != nil {
		return Reminder{}, err
	}
	return Reminder{
		ID: payload.ID, ServerID: payload.ServerID, AgentID: payload.AgentID,
		ScheduleKind: scheduleKind, Schedule: payload.Schedule,
		Timezone: payload.Timezone, Text: payload.Text, Status: status,
		NextFireAt: payload.NextFireAt, Anchor: anchor, Revision: payload.Revision,
		CreatedAt: payload.CreatedAt.UTC(), UpdatedAt: payload.UpdatedAt.UTC(),
	}, nil
}

func validReminderDraft(value ReminderDraft) bool {
	return validReminderScheduleKind(value.ScheduleKind) &&
		strings.TrimSpace(value.Schedule) != "" && len(value.Schedule) <= 200 &&
		strings.TrimSpace(value.Timezone) != "" && len(value.Timezone) <= 100 &&
		strings.TrimSpace(value.Text) != "" && len(value.Text) <= 5000
}

func validReminderPatch(value ReminderPatch) bool {
	if value.Schedule == nil && value.Timezone == nil && value.Text == nil &&
		value.Status == nil && value.Anchor == nil {
		return false
	}
	if value.Schedule != nil && (strings.TrimSpace(*value.Schedule) == "" || len(*value.Schedule) > 200) ||
		value.Timezone != nil && (strings.TrimSpace(*value.Timezone) == "" || len(*value.Timezone) > 100) ||
		value.Text != nil && (strings.TrimSpace(*value.Text) == "" || len(*value.Text) > 5000) ||
		value.Status != nil && *value.Status != ReminderActive && *value.Status != ReminderPaused {
		return false
	}
	return true
}

func validReminderScheduleKind(value ReminderScheduleKind) bool {
	return value == ReminderOnce || value == ReminderCron
}

func validReminderStatus(value ReminderStatus) bool {
	return value == ReminderActive || value == ReminderPaused ||
		value == ReminderCompleted || value == ReminderCanceled
}

func validReminderLogState(value string) bool {
	return value == "due" || value == "acknowledged" || value == "canceled"
}

func runtimeReminderAnchorToPayload(
	value *ReminderAnchor,
) (*runtimeReminderAnchorPayload, error) {
	if value == nil {
		return nil, nil
	}
	if !validUUIDv7(value.ChannelID) || !validThreadMessageRef(value.MessageRef, false) {
		return nil, ErrInvalidConfig
	}
	reference := runtimeThreadRefToPayload(value.MessageRef)
	payload := &runtimeReminderAnchorPayload{
		Kind: string(value.Kind), ChannelID: value.ChannelID,
	}
	switch value.Kind {
	case ReminderAnchorMessage:
		if value.ThreadID != "" {
			return nil, ErrInvalidConfig
		}
		payload.MessageRef = &reference
	case ReminderAnchorThread:
		if !validUUIDv7(value.ThreadID) {
			return nil, ErrInvalidConfig
		}
		payload.ThreadID = &value.ThreadID
		payload.RootMessageRef = &reference
	default:
		return nil, ErrInvalidConfig
	}
	return payload, nil
}

func runtimeReminderAnchorFromPayload(
	value *runtimeReminderAnchorPayload,
) (*ReminderAnchor, error) {
	if value == nil {
		return nil, nil
	}
	if !validUUIDv7(value.ChannelID) {
		return nil, ErrInvalidRuntimeReminder
	}
	result := &ReminderAnchor{
		Kind: ReminderAnchorKind(value.Kind), ChannelID: value.ChannelID,
	}
	switch result.Kind {
	case ReminderAnchorMessage:
		if value.MessageRef == nil || value.ThreadID != nil || value.RootMessageRef != nil {
			return nil, ErrInvalidRuntimeReminder
		}
		reference, err := runtimeThreadRefFromPayload(*value.MessageRef, false)
		if err != nil {
			return nil, ErrInvalidRuntimeReminder
		}
		result.MessageRef = reference
	case ReminderAnchorThread:
		if value.ThreadID == nil || !validUUIDv7(*value.ThreadID) ||
			value.RootMessageRef == nil || value.MessageRef != nil {
			return nil, ErrInvalidRuntimeReminder
		}
		reference, err := runtimeThreadRefFromPayload(*value.RootMessageRef, false)
		if err != nil {
			return nil, ErrInvalidRuntimeReminder
		}
		result.ThreadID = *value.ThreadID
		result.MessageRef = reference
	default:
		return nil, ErrInvalidRuntimeReminder
	}
	return result, nil
}
