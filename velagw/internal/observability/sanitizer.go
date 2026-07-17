package observability

import (
	"io"
	"regexp"
	"strings"
)

const defaultMaxTelemetryTextBytes = 1024

var telemetrySecretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(https?://)[^/@\s]+@`),
	regexp.MustCompile(`(?i)(https?://[^\s?]+)\?[^\s]+`),
	regexp.MustCompile(`(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+`),
	regexp.MustCompile(`(?i)(cookie\s*[:=]\s*)[^\r\n]+`),
	regexp.MustCompile(`(?i)\b(sk-[A-Za-z0-9_-]{8,})\b`),
	regexp.MustCompile(`(?i)((?:password|passwd|api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;]+`),
}

type SanitizerConfig struct {
	Secrets      []string
	MaxTextBytes int
}

type Sanitizer struct {
	secrets      []string
	maxTextBytes int
}

func NewSanitizer(config SanitizerConfig) *Sanitizer {
	maxBytes := config.MaxTextBytes
	if maxBytes <= 0 {
		maxBytes = defaultMaxTelemetryTextBytes
	}
	secrets := make([]string, 0, len(config.Secrets))
	for _, secret := range config.Secrets {
		if secret = strings.TrimSpace(secret); secret != "" {
			secrets = append(secrets, secret)
		}
	}
	return &Sanitizer{secrets: secrets, maxTextBytes: maxBytes}
}

func (s *Sanitizer) Text(value string) string {
	if s == nil {
		s = NewSanitizer(SanitizerConfig{})
	}
	for _, secret := range s.secrets {
		value = strings.ReplaceAll(value, secret, "[REDACTED]")
	}
	for index, pattern := range telemetrySecretPatterns {
		replacement := "${1}[REDACTED]"
		if index == 0 {
			replacement = "${1}[REDACTED]@"
		} else if index == 1 {
			replacement = "${1}?[REDACTED]"
		}
		value = pattern.ReplaceAllString(value, replacement)
	}
	if len(value) > s.maxTextBytes {
		value = value[:s.maxTextBytes]
	}
	return value
}

type sanitizingWriter struct {
	output    io.Writer
	sanitizer *Sanitizer
}

func NewSanitizingWriter(output io.Writer, sanitizer *Sanitizer) io.Writer {
	return &sanitizingWriter{output: output, sanitizer: sanitizer}
}

func (w *sanitizingWriter) Write(raw []byte) (int, error) {
	if w == nil || w.output == nil {
		return len(raw), nil
	}
	clean := []byte(w.sanitizer.Text(string(raw)))
	_, err := w.output.Write(clean)
	if err != nil {
		return 0, err
	}
	return len(raw), nil
}
