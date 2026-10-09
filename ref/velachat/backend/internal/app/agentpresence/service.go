// Package agentpresence 投影腾讯 IM 确认的在线事实。
package agentpresence

import (
	"context"
	"errors"
	"strings"
	"time"

	agentpresenceport "chatserver/internal/ports/agentpresence"
)

type IMObservation struct {
	IMUserID   string
	Presence   string
	ObservedAt time.Time
	Reason     string
}

type Service struct {
	repository agentpresenceport.Repository
}

func NewService(repository agentpresenceport.Repository) (*Service, error) {
	if repository == nil {
		return nil, errors.New("Agent 在线投影服务配置无效")
	}
	return &Service{repository: repository}, nil
}

func (service *Service) ObserveIMPresence(
	ctx context.Context,
	value IMObservation,
) error {
	value.IMUserID = strings.TrimSpace(value.IMUserID)
	value.Presence = strings.TrimSpace(value.Presence)
	value.Reason = strings.TrimSpace(value.Reason)
	if value.IMUserID == "" ||
		(value.Presence != "online" && value.Presence != "offline") ||
		value.ObservedAt.IsZero() {
		return errors.New("腾讯 IM 在线事实无效")
	}
	_, err := service.repository.ApplyIMPresence(
		ctx,
		agentpresenceport.IMObservation{
			IMUserID:   value.IMUserID,
			Presence:   value.Presence,
			ObservedAt: value.ObservedAt.UTC(),
			Reason:     value.Reason,
		},
	)
	return err
}
