package logging

import (
	"io"
	"log/slog"
	"os"
	"strings"
)

type Config struct {
	Service string
	Level   string
	Writer  io.Writer
}

func New(config Config) *slog.Logger {
	writer := config.Writer
	if writer == nil {
		writer = os.Stdout
	}

	handler := slog.NewTextHandler(writer, &slog.HandlerOptions{
		Level: parseLevel(config.Level),
	})

	logger := slog.New(handler)
	service := strings.TrimSpace(config.Service)
	if service != "" {
		logger = logger.With("service", service)
	}
	return logger
}

func parseLevel(value string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
