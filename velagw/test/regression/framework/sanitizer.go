package framework

import (
	"errors"
	"sort"
	"strings"
	"sync"
)

const RedactedValue = "[REDACTED]"

type Secret struct {
	value string
}

func (s Secret) String() string   { return RedactedValue }
func (s Secret) GoString() string { return RedactedValue }
func (s Secret) Reveal() string   { return s.value }
func (s Secret) Empty() bool      { return s.value == "" }

type Sanitizer struct {
	mu      sync.RWMutex
	secrets map[string]struct{}
}

func NewSanitizer() *Sanitizer {
	return &Sanitizer{secrets: map[string]struct{}{}}
}

func (s *Sanitizer) Secret(value string) Secret {
	value = strings.TrimSpace(value)
	if value != "" {
		s.mu.Lock()
		s.secrets[value] = struct{}{}
		s.mu.Unlock()
	}
	return Secret{value: value}
}

func (s *Sanitizer) String(value string) string {
	if s == nil || value == "" {
		return value
	}
	s.mu.RLock()
	secrets := make([]string, 0, len(s.secrets))
	for secret := range s.secrets {
		secrets = append(secrets, secret)
	}
	s.mu.RUnlock()
	sort.Slice(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	for _, secret := range secrets {
		value = strings.ReplaceAll(value, secret, RedactedValue)
	}
	return value
}

func (s *Sanitizer) Error(err error) error {
	if err == nil {
		return nil
	}
	return errors.New(s.String(err.Error()))
}

func (s *Sanitizer) Bytes(value []byte) []byte {
	return []byte(s.String(string(value)))
}
