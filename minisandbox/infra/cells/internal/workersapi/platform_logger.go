package workersapi

import (
	"bytes"
	"context"
	"io"
	"log"
	"log/slog"
)

// NewPlatformLogger is the Workers API process logger, not a sanitizer for user
// logs. Callers must use constant messages and explicit platform metadata.
// Raw errors and unknown string classifications never cross the JSON boundary.
func NewPlatformLogger(output io.Writer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(output, &slog.HandlerOptions{
		ReplaceAttr: func(_ []string, attr slog.Attr) slog.Attr {
			if attr.Key != "error" {
				return attr
			}
			if err, ok := attr.Value.Any().(error); ok {
				return slog.String("error", diagnosticErrorClass(err))
			}
			if attr.Value.Kind() == slog.KindString {
				switch attr.Value.String() {
				case "none", "cancelled", "deadline", "no_admission_capacity", "upstream_error",
					"dns", "connection_refused", "connection_reset", "eof", "timeout", "transport_error",
					"http_server_error", "http_server_panic", "tls_handshake_failed":
					return attr
				}
			}
			return slog.String("error", "unclassified_error")
		},
	}))
}

// PlatformHTTPErrorLog replaces net/http's default raw stderr output. Panic
// values, stacks and TLS error messages can contain request or secret data.
// Keep only a finite event class and a code-owned listener identity.
func PlatformHTTPErrorLog(logger *slog.Logger, listener string) *log.Logger {
	if listener != "public" && listener != "internal" {
		listener = "unknown"
	}
	return log.New(platformHTTPLogWriter{logger: logger, listener: listener}, "", 0)
}

type platformHTTPLogWriter struct {
	logger   *slog.Logger
	listener string
}

func (writer platformHTTPLogWriter) Write(data []byte) (int, error) {
	class := "http_server_error"
	switch {
	case bytes.HasPrefix(data, []byte("http: panic serving ")):
		class = "http_server_panic"
	case bytes.HasPrefix(data, []byte("http: TLS handshake error from ")):
		class = "tls_handshake_failed"
	}
	writer.logger.LogAttrs(context.Background(), slog.LevelError, "Workers API HTTP server failed",
		slog.String("error", class), slog.String("listener", writer.listener))
	return len(data), nil
}
