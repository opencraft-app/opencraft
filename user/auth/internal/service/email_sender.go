package service

import (
	"context"
	"log/slog"
)

type EmailSender interface {
	SendEmailBindMagicLink(ctx context.Context, to string, confirmURL string) error
}

type LogEmailSender struct {
	Logger *slog.Logger
}

func (s *LogEmailSender) SendEmailBindMagicLink(ctx context.Context, to string, confirmURL string) error {
	logger := s.Logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.InfoContext(ctx, "email bind magic link",
		"to", to,
		"confirm_url", confirmURL,
	)
	return nil
}
