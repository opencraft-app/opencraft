package hermes

import (
	"bufio"
	"errors"
	"io"
	"regexp"
)

const (
	maximumStderrLine = 4 * 1024
	maximumStderrTail = 64 * 1024
)

var stderrBearerPattern = regexp.MustCompile(`(?i)\bBearer[ \t]+[^\s]+`)
var stderrKeyPattern = regexp.MustCompile(
	`(?i)\b(token|secret|password|api[_-]?key|authorization|key)\b[ \t]*[:=][ \t]*[^\s]+`,
)
var stderrAPIKeyPattern = regexp.MustCompile(`\b(?:sk|sap)_[A-Za-z0-9_-]{6,}\b|\bsk-[A-Za-z0-9_-]{6,}\b`)
var stderrJWTPattern = regexp.MustCompile(
	`\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b`,
)
var stderrURLCredentialPattern = regexp.MustCompile(
	`://[^/@\s:]+:[^/@\s]+@`,
)

func captureHermesStderr(reader io.Reader, enabled bool) string {
	if !enabled {
		_, _ = io.Copy(io.Discard, reader)
		return ""
	}
	buffered := bufio.NewReaderSize(reader, maximumStderrLine)
	rawTail := newByteTail(maximumStderrTail)
	redactedTail := newByteTail(maximumStderrTail)
	discardLineRemainder := false
	for {
		fragment, err := buffered.ReadSlice('\n')
		if !discardLineRemainder && len(fragment) > 0 {
			if len(fragment) > maximumStderrLine {
				fragment = fragment[:maximumStderrLine]
			}
			rawTail.Append(fragment)
			redactedTail.Append(redactHermesDiagnostic(fragment))
		}
		switch {
		case errors.Is(err, bufio.ErrBufferFull):
			discardLineRemainder = true
			continue
		case err == nil:
			discardLineRemainder = false
			continue
		case errors.Is(err, io.EOF):
			return string(redactedTail.Bytes())
		default:
			return string(redactedTail.Bytes())
		}
	}
}

func redactHermesDiagnostic(fragment []byte) []byte {
	redacted := append([]byte(nil), fragment...)
	redacted = stderrBearerPattern.ReplaceAll(redacted, []byte("Bearer [REDACTED]"))
	redacted = stderrURLCredentialPattern.ReplaceAll(redacted, []byte("://[REDACTED]@"))
	redacted = stderrAPIKeyPattern.ReplaceAll(redacted, []byte("[REDACTED]"))
	redacted = stderrJWTPattern.ReplaceAll(redacted, []byte("[REDACTED]"))
	redacted = stderrKeyPattern.ReplaceAll(redacted, []byte("${1}=[REDACTED]"))
	return redacted
}

type byteTail struct {
	maximum int
	data    []byte
}

func newByteTail(maximum int) *byteTail {
	return &byteTail{
		maximum: maximum,
		data:    make([]byte, 0, maximum),
	}
}

func (tail *byteTail) Append(value []byte) {
	if tail.maximum <= 0 || len(value) == 0 {
		return
	}
	if len(value) >= tail.maximum {
		tail.data = append(tail.data[:0], value[len(value)-tail.maximum:]...)
		return
	}
	overflow := len(tail.data) + len(value) - tail.maximum
	if overflow > 0 {
		copy(tail.data, tail.data[overflow:])
		tail.data = tail.data[:len(tail.data)-overflow]
	}
	tail.data = append(tail.data, value...)
}

func (tail *byteTail) Bytes() []byte {
	return append([]byte(nil), tail.data...)
}
