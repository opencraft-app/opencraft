package platform

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
)

const (
	maxReminderOccurrenceResponseBytes = 2 << 20
	maxReminderOccurrencesPerSweep     = 10_000
	reminderOccurrencePageSize         = 100
)

var ErrInvalidReminderOccurrence = errors.New(
	"平台返回的 Reminder Occurrence 无效",
)

type ReminderOccurrenceState string

const (
	ReminderOccurrenceDue          ReminderOccurrenceState = "due"
	ReminderOccurrenceAcknowledged ReminderOccurrenceState = "acknowledged"
	ReminderOccurrenceCanceled     ReminderOccurrenceState = "canceled"
)

type ReminderOccurrence struct {
	ID              string
	ServerID        string
	ReminderID      string
	AgentID         string
	ScheduledFireAt time.Time
	State           ReminderOccurrenceState
	Text            string
	AcknowledgedAt  *time.Time
	ResultCode      string
}

func (c *Client) ListAllReminderOccurrences(
	ctx context.Context,
	token AccessToken,
) ([]ReminderOccurrence, error) {
	values := make([]ReminderOccurrence, 0)
	seen := make(map[string]struct{})
	cursor := ""
	for {
		page, err := c.ListReminderOccurrences(
			ctx,
			token,
			cursor,
			reminderOccurrencePageSize,
		)
		if err != nil {
			return nil, err
		}
		for _, occurrence := range page {
			if _, exists := seen[occurrence.ID]; exists {
				return nil, ErrInvalidReminderOccurrence
			}
			seen[occurrence.ID] = struct{}{}
			values = append(values, occurrence)
			if len(values) > maxReminderOccurrencesPerSweep {
				return nil, ErrInvalidReminderOccurrence
			}
		}
		if len(page) < reminderOccurrencePageSize {
			return values, nil
		}
		nextCursor := page[len(page)-1].ID
		if nextCursor == cursor {
			return nil, ErrInvalidReminderOccurrence
		}
		cursor = nextCursor
	}
}

func (c *Client) ListReminderOccurrences(
	ctx context.Context,
	token AccessToken,
	cursor string,
	limit int,
) ([]ReminderOccurrence, error) {
	if c == nil || c.httpClient == nil || ctx == nil ||
		strings.TrimSpace(token.Reveal()) == "" ||
		limit < 1 || limit > reminderOccurrencePageSize ||
		cursor != "" && !validUUIDv7(cursor) {
		return nil, ErrInvalidConfig
	}
	query := url.Values{}
	query.Set("limit", strconv.Itoa(limit))
	if cursor != "" {
		query.Set("cursor", cursor)
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		c.baseURL+"/runtime/reminder-occurrences?"+query.Encode(),
		nil,
	)
	if err != nil {
		return nil, ErrInvalidConfig
	}
	request.Header.Set("Authorization", "Bearer "+token.Reveal())
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	response, err := c.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, newRequestError(true, 0)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized ||
		response.StatusCode == http.StatusForbidden {
		return nil, ErrCredentialRejected
	}
	if response.StatusCode != http.StatusOK {
		return nil, requestErrorForResponse(response, c.now().UTC())
	}
	data, err := readBounded(response.Body, maxReminderOccurrenceResponseBytes)
	if err != nil {
		return nil, ErrInvalidReminderOccurrence
	}
	var payload []reminderOccurrencePayload
	if err := common.Unmarshal(data, &payload); err != nil || len(payload) > limit {
		return nil, ErrInvalidReminderOccurrence
	}
	values := make([]ReminderOccurrence, 0, len(payload))
	for index, item := range payload {
		occurrence, err := validateReminderOccurrence(item)
		if err != nil || occurrence.State != ReminderOccurrenceDue ||
			index > 0 && values[index-1].ID >= occurrence.ID {
			return nil, ErrInvalidReminderOccurrence
		}
		values = append(values, occurrence)
	}
	return values, nil
}

func (c *Client) AcknowledgeReminderOccurrence(
	ctx context.Context,
	token AccessToken,
	occurrenceID string,
) (ReminderOccurrence, error) {
	if c == nil || c.httpClient == nil || ctx == nil ||
		strings.TrimSpace(token.Reveal()) == "" ||
		!validUUIDv7(occurrenceID) {
		return ReminderOccurrence{}, ErrInvalidConfig
	}
	body, err := common.Marshal(map[string]string{
		"resultCode": "completed",
	})
	if err != nil {
		return ReminderOccurrence{}, ErrInvalidConfig
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/runtime/reminder-occurrences/"+
			url.PathEscape(occurrenceID)+"/ack",
		bytes.NewReader(body),
	)
	if err != nil {
		return ReminderOccurrence{}, ErrInvalidConfig
	}
	request.Header.Set("Authorization", "Bearer "+token.Reveal())
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", ReminderOccurrenceAckKey(occurrenceID))
	response, err := c.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ReminderOccurrence{}, ctx.Err()
		}
		return ReminderOccurrence{}, newRequestError(true, 0)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized ||
		response.StatusCode == http.StatusForbidden {
		return ReminderOccurrence{}, ErrCredentialRejected
	}
	if response.StatusCode != http.StatusOK {
		return ReminderOccurrence{}, requestErrorForResponse(
			response,
			c.now().UTC(),
		)
	}
	data, err := readBounded(response.Body, maxReminderOccurrenceResponseBytes)
	if err != nil {
		return ReminderOccurrence{}, ErrInvalidReminderOccurrence
	}
	var payload reminderOccurrencePayload
	if err := common.Unmarshal(data, &payload); err != nil {
		return ReminderOccurrence{}, ErrInvalidReminderOccurrence
	}
	occurrence, err := validateReminderOccurrence(payload)
	if err != nil || occurrence.ID != occurrenceID ||
		occurrence.State != ReminderOccurrenceAcknowledged ||
		occurrence.ResultCode != "completed" {
		return ReminderOccurrence{}, ErrInvalidReminderOccurrence
	}
	return occurrence, nil
}

func ReminderOccurrenceAckKey(occurrenceID string) string {
	if !validUUIDv7(occurrenceID) {
		return ""
	}
	return "reminder-ack-v1-" + occurrenceID
}

type reminderOccurrencePayload struct {
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

func validateReminderOccurrence(
	payload reminderOccurrencePayload,
) (ReminderOccurrence, error) {
	state := ReminderOccurrenceState(payload.State)
	if !validUUIDv7(payload.ID) ||
		!validUUIDv7(payload.ServerID) ||
		!validUUIDv7(payload.ReminderID) ||
		!validUUIDv7(payload.AgentID) ||
		payload.ScheduledFireAt.IsZero() ||
		len(payload.Text) > 5_000 ||
		(state != ReminderOccurrenceDue &&
			state != ReminderOccurrenceAcknowledged &&
			state != ReminderOccurrenceCanceled) {
		return ReminderOccurrence{}, ErrInvalidReminderOccurrence
	}
	if state == ReminderOccurrenceAcknowledged {
		if payload.AcknowledgedAt == nil || payload.AcknowledgedAt.IsZero() ||
			payload.ResultCode == nil || strings.TrimSpace(*payload.ResultCode) == "" {
			return ReminderOccurrence{}, ErrInvalidReminderOccurrence
		}
	} else if payload.AcknowledgedAt != nil || payload.ResultCode != nil {
		return ReminderOccurrence{}, ErrInvalidReminderOccurrence
	}
	resultCode := ""
	if payload.ResultCode != nil {
		resultCode = strings.TrimSpace(*payload.ResultCode)
	}
	return ReminderOccurrence{
		ID:              payload.ID,
		ServerID:        payload.ServerID,
		ReminderID:      payload.ReminderID,
		AgentID:         payload.AgentID,
		ScheduledFireAt: payload.ScheduledFireAt.UTC(),
		State:           state,
		Text:            payload.Text,
		AcknowledgedAt:  utcTimePointer(payload.AcknowledgedAt),
		ResultCode:      resultCode,
	}, nil
}

func utcTimePointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	result := value.UTC()
	return &result
}

func readBounded(reader io.Reader, maximum int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, maximum+1))
	if err != nil || len(data) == 0 || int64(len(data)) > maximum {
		return nil, ErrInvalidReminderOccurrence
	}
	return data, nil
}

func requestErrorForResponse(
	response *http.Response,
	now time.Time,
) error {
	return newRequestError(
		response.StatusCode == http.StatusTooManyRequests ||
			response.StatusCode >= http.StatusInternalServerError,
		parseRetryAfter(response.Header.Get("Retry-After"), now),
	)
}
