package ratelimit

import (
	"context"
	"net/netip"
	"strings"
	"testing"
	"time"
)

const (
	rateTestAccountID = "01989c24-7540-7f12-a27b-c83243215dd1"
	rateTestServerID  = "01989c24-7540-7f12-a27b-c83243215dd2"
	rateTestAgentID   = "01989c24-7540-7f12-a27b-c83243215dd3"
)

type fixedLimiter struct {
	decision Decision
}

func (l fixedLimiter) Allow(_ context.Context, _ Request) (Decision, error) {
	return l.decision, nil
}

func TestInvalidSubjectsCannotBeConstructed(t *testing.T) {
	if _, err := NewIPSubject(netip.Addr{}); err == nil {
		t.Fatal("NewIPSubject() error = nil for invalid address")
	}
	if _, err := NewLoginHashSubject("not-a-sha256"); err == nil {
		t.Fatal("NewLoginHashSubject() error = nil for malformed hash")
	}
	if _, err := NewLoginHashSubject(strings.Repeat("A", 64)); err == nil {
		t.Fatal("NewLoginHashSubject() error = nil for non-canonical hash")
	}
	if _, err := NewAccountSubject("not-a-uuid"); err == nil {
		t.Fatal("NewAccountSubject() error = nil for malformed account ID")
	}
	if _, err := NewAgentSubject(rateTestServerID, "not-a-uuid"); err == nil {
		t.Fatal("NewAgentSubject() error = nil for malformed agent ID")
	}
}

func TestSubjectsHaveStableTypedKeys(t *testing.T) {
	ip, err := NewIPSubject(netip.MustParseAddr("::ffff:192.0.2.10"))
	if err != nil {
		t.Fatalf("NewIPSubject() error = %v", err)
	}
	login, err := NewLoginHashSubject(strings.Repeat("a", 64))
	if err != nil {
		t.Fatalf("NewLoginHashSubject() error = %v", err)
	}
	account, err := NewAccountSubject(rateTestAccountID)
	if err != nil {
		t.Fatalf("NewAccountSubject() error = %v", err)
	}
	agent, err := NewAgentSubject(rateTestServerID, rateTestAgentID)
	if err != nil {
		t.Fatalf("NewAgentSubject() error = %v", err)
	}

	tests := []struct {
		subject Subject
		kind    SubjectKind
		key     string
	}{
		{subject: ip, kind: SubjectIP, key: "192.0.2.10"},
		{subject: login, kind: SubjectLoginHash, key: strings.Repeat("a", 64)},
		{subject: account, kind: SubjectAccountID, key: rateTestAccountID},
		{
			subject: agent,
			kind:    SubjectAgentID,
			key:     rateTestServerID + "/" + rateTestAgentID,
		},
	}

	for _, test := range tests {
		if test.subject.Kind() != test.kind {
			t.Errorf("Kind() = %q, want %q", test.subject.Kind(), test.kind)
		}
		if test.subject.Key() != test.key {
			t.Errorf("Key() = %q, want %q", test.subject.Key(), test.key)
		}
	}
}

func TestLimiterReturnsRetryDecision(t *testing.T) {
	subject, err := NewAccountSubject(rateTestAccountID)
	if err != nil {
		t.Fatalf("NewAccountSubject() error = %v", err)
	}
	want := Decision{Allowed: false, RetryAfter: 5 * time.Second}
	var limiter Limiter = fixedLimiter{decision: want}

	got, err := limiter.Allow(context.Background(), Request{
		Subjects:       []Subject{subject},
		OperationClass: "task.write",
		Cost:           1,
	})
	if err != nil {
		t.Fatalf("Allow() error = %v", err)
	}
	if got != want {
		t.Fatalf("Allow() = %#v, want %#v", got, want)
	}
}
