// Package reminderoccurrence 实现 Reminder 调度和 Runtime occurrence 用例。
package reminderoccurrence

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"chatserver/internal/apperror"
	"chatserver/internal/pagination"
	clockport "chatserver/internal/ports/clock"
	occurrenceport "chatserver/internal/ports/reminderoccurrence"

	"github.com/google/uuid"
)

const (
	defaultLimit = 50
	maxLimit     = 100
)

type Service struct {
	repository occurrenceport.Repository
	clock      clockport.Clock
}

func NewService(
	repository occurrenceport.Repository,
	clock clockport.Clock,
) (*Service, error) {
	if repository == nil || clock == nil {
		return nil, errors.New("Reminder occurrence 服务配置无效")
	}
	return &Service{repository: repository, clock: clock}, nil
}

// ProcessOne 物化一个当前已到期 Reminder，供后台 Worker 排空。
func (service *Service) ProcessOne(ctx context.Context) (bool, error) {
	return service.repository.ProcessOne(ctx, service.clock.Now().UTC())
}

func (service *Service) List(
	ctx context.Context,
	serverID string,
	agentID string,
	limit int,
	cursor string,
) (occurrenceport.Page, error) {
	if !validID(serverID) || !validID(agentID) {
		return occurrenceport.Page{}, invalid("Runtime Reminder 身份无效")
	}
	if limit == 0 {
		limit = defaultLimit
	}
	if limit < 1 || limit > maxLimit {
		return occurrenceport.Page{}, invalid("Runtime Reminder limit 无效")
	}
	cursor = strings.TrimSpace(cursor)
	filter := fmt.Sprintf("server=%s&agent=%s&state=due", serverID, agentID)
	options := occurrenceport.ListOptions{Limit: limit, Cursor: cursor}
	if cursor != "" {
		sort, err := pagination.Decode(cursor, "listRuntimeReminderOccurrences", filter, 2)
		if err != nil || !validID(sort[1]) {
			return occurrenceport.Page{}, apperror.New("invalid_cursor", "Runtime Reminder cursor 无效", err)
		}
		scheduledAt, parseErr := time.Parse(time.RFC3339Nano, sort[0])
		if parseErr != nil {
			return occurrenceport.Page{}, apperror.New("invalid_cursor", "Runtime Reminder cursor 无效", parseErr)
		}
		options.AfterScheduledFireAt, options.AfterID = &scheduledAt, sort[1]
	}
	page, err := service.repository.ListDue(
		ctx,
		serverID,
		agentID,
		options,
	)
	if err != nil {
		return occurrenceport.Page{}, internal(err)
	}
	if page.NextScheduledFireAt != nil && page.NextID != "" {
		page.NextCursor, err = pagination.Encode(
			"listRuntimeReminderOccurrences", filter,
			page.NextScheduledFireAt.UTC().Format(time.RFC3339Nano), page.NextID,
		)
		if err != nil {
			return occurrenceport.Page{}, internal(err)
		}
	}
	return page, nil
}

func (service *Service) Acknowledge(
	ctx context.Context,
	serverID string,
	agentID string,
	occurrenceID string,
	idempotencyKey string,
	resultCode *string,
) (occurrenceport.Occurrence, error) {
	if !validID(serverID) || !validID(agentID) || !validID(occurrenceID) ||
		strings.TrimSpace(idempotencyKey) == "" {
		return occurrenceport.Occurrence{}, invalid("Runtime Reminder ack 参数无效")
	}
	if resultCode != nil {
		normalized := strings.TrimSpace(*resultCode)
		if len(normalized) > 64 || !utf8.ValidString(normalized) {
			return occurrenceport.Occurrence{}, invalid("Runtime Reminder resultCode 无效")
		}
		resultCode = &normalized
	}
	value, err := service.repository.Acknowledge(
		ctx,
		serverID,
		agentID,
		occurrenceID,
		resultCode,
		service.clock.Now().UTC(),
	)
	if errors.Is(err, occurrenceport.ErrNotFound) {
		return occurrenceport.Occurrence{}, apperror.New(
			"reminder_occurrence_not_found",
			"提醒触发记录不存在",
			err,
		)
	}
	if err != nil {
		return occurrenceport.Occurrence{}, internal(err)
	}
	return value, nil
}

func validID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func invalid(message string) error {
	return apperror.New("invalid_request", message, nil)
}

func internal(err error) error {
	return apperror.New("internal_error", "暂时无法处理 Runtime Reminder 请求", err)
}
