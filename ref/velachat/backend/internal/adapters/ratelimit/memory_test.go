package ratelimitadapter

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	ratelimitport "chatserver/internal/ports/ratelimit"
)

const (
	memoryTestAccountID = "01989c24-7540-7f12-a27b-c83243215dd1"
	memoryTestServerID  = "01989c24-7540-7f12-a27b-c83243215dd2"
	memoryTestAgentID   = "01989c24-7540-7f12-a27b-c83243215dd3"
)

type mutableClock struct {
	mu    sync.RWMutex
	value time.Time
}

func (c *mutableClock) Now() time.Time {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.value
}

func (c *mutableClock) Advance(duration time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.value = c.value.Add(duration)
}

func TestMemoryLimiterKeepsSubjectKindsIndependent(t *testing.T) {
	limiter, _ := newTestMemoryLimiter(t, 1, time.Minute)
	subjects := testSubjects(t)

	for _, subject := range subjects {
		decision, err := limiter.Allow(context.Background(), ratelimitport.Request{
			Subjects:       []ratelimitport.Subject{subject},
			OperationClass: "auth.issue",
			Cost:           1,
		})
		if err != nil {
			t.Fatalf("Allow(%s) error = %v", subject.Kind(), err)
		}
		if !decision.Allowed {
			t.Fatalf("Allow(%s) denied independent first request", subject.Kind())
		}
	}
}

func TestMemoryLimiterRejectsAllSubjectsAtomically(t *testing.T) {
	limiter, _ := newTestMemoryLimiter(t, 1, time.Minute)
	subjects := testSubjects(t)
	ip := subjects[0]
	account := subjects[2]

	first, err := limiter.Allow(context.Background(), ratelimitport.Request{
		Subjects:       []ratelimitport.Subject{ip},
		OperationClass: "auth.issue",
		Cost:           1,
	})
	if err != nil || !first.Allowed {
		t.Fatalf("first Allow() = %#v, %v", first, err)
	}

	blocked, err := limiter.Allow(context.Background(), ratelimitport.Request{
		Subjects:       []ratelimitport.Subject{ip, account},
		OperationClass: "auth.issue",
		Cost:           1,
	})
	if err != nil {
		t.Fatalf("blocked Allow() error = %v", err)
	}
	if blocked.Allowed {
		t.Fatal("multi-subject request allowed when IP bucket was exhausted")
	}
	if blocked.RetryAfter != time.Minute {
		t.Fatalf("RetryAfter = %v, want 1m", blocked.RetryAfter)
	}

	accountOnly, err := limiter.Allow(context.Background(), ratelimitport.Request{
		Subjects:       []ratelimitport.Subject{account},
		OperationClass: "auth.issue",
		Cost:           1,
	})
	if err != nil || !accountOnly.Allowed {
		t.Fatalf(
			"account bucket was consumed by rejected request: %#v, %v",
			accountOnly,
			err,
		)
	}
}

func TestMemoryLimiterReturnsStableRetryAfterAndResetsWindow(t *testing.T) {
	limiter, clock := newTestMemoryLimiter(t, 1, time.Minute)
	subject := testSubjects(t)[0]
	request := ratelimitport.Request{
		Subjects:       []ratelimitport.Subject{subject},
		OperationClass: "auth.issue",
		Cost:           1,
	}

	if decision, err := limiter.Allow(context.Background(), request); err != nil || !decision.Allowed {
		t.Fatalf("first Allow() = %#v, %v", decision, err)
	}
	clock.Advance(17 * time.Second)
	blocked, err := limiter.Allow(context.Background(), request)
	if err != nil {
		t.Fatalf("second Allow() error = %v", err)
	}
	if blocked.RetryAfter != 43*time.Second {
		t.Fatalf("RetryAfter = %v, want 43s", blocked.RetryAfter)
	}

	clock.Advance(43 * time.Second)
	reset, err := limiter.Allow(context.Background(), request)
	if err != nil || !reset.Allowed {
		t.Fatalf("Allow() after reset = %#v, %v", reset, err)
	}
}

func TestMemoryLimiterDoesNotConsumeCancelledRequest(t *testing.T) {
	limiter, _ := newTestMemoryLimiter(t, 1, time.Minute)
	subject := testSubjects(t)[0]
	request := ratelimitport.Request{
		Subjects:       []ratelimitport.Subject{subject},
		OperationClass: "auth.issue",
		Cost:           1,
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := limiter.Allow(ctx, request); err == nil {
		t.Fatal("Allow(cancelled) error = nil")
	}
	decision, err := limiter.Allow(context.Background(), request)
	if err != nil || !decision.Allowed {
		t.Fatalf("cancelled request consumed capacity: %#v, %v", decision, err)
	}
}

func TestMemoryLimiterIsAtomicUnderConcurrency(t *testing.T) {
	const limit = 25
	limiter, _ := newTestMemoryLimiter(t, limit, time.Minute)
	subject := testSubjects(t)[0]
	request := ratelimitport.Request{
		Subjects:       []ratelimitport.Subject{subject},
		OperationClass: "auth.issue",
		Cost:           1,
	}
	var allowed atomic.Int64
	var wait sync.WaitGroup

	for range 100 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			decision, err := limiter.Allow(context.Background(), request)
			if err == nil && decision.Allowed {
				allowed.Add(1)
			}
		}()
	}
	wait.Wait()

	if got := allowed.Load(); got != limit {
		t.Fatalf("allowed = %d, want %d", got, limit)
	}
}

func TestMemoryLimiterRecountsPlannedBucketsAfterPruning(t *testing.T) {
	clock := &mutableClock{
		value: time.Date(2026, time.July, 30, 12, 0, 0, 0, time.UTC),
	}
	rules := []Rule{
		{
			SubjectKind:    ratelimitport.SubjectIP,
			OperationClass: "auth.issue",
			Limit:          1,
			Window:         time.Minute,
		},
		{
			SubjectKind:    ratelimitport.SubjectAccountID,
			OperationClass: "auth.issue",
			Limit:          1,
			Window:         time.Minute,
		},
	}
	limiter, err := NewMemory(clock, Config{Rules: rules, MaxBuckets: 1})
	if err != nil {
		t.Fatalf("NewMemory() error = %v", err)
	}
	subjects := testSubjects(t)
	ip := subjects[0]
	account := subjects[2]
	if decision, err := limiter.Allow(context.Background(), ratelimitport.Request{
		Subjects:       []ratelimitport.Subject{ip},
		OperationClass: "auth.issue",
		Cost:           1,
	}); err != nil || !decision.Allowed {
		t.Fatalf("first Allow() = %#v, %v", decision, err)
	}
	clock.Advance(time.Minute)

	_, err = limiter.Allow(context.Background(), ratelimitport.Request{
		Subjects:       []ratelimitport.Subject{ip, account},
		OperationClass: "auth.issue",
		Cost:           1,
	})

	if !errors.Is(err, ErrBucketCapacity) {
		t.Fatalf("Allow() error = %v, want ErrBucketCapacity", err)
	}
	if got := len(limiter.buckets); got > 1 {
		t.Fatalf("bucket count = %d, exceeds MaxBuckets", got)
	}
}

func newTestMemoryLimiter(
	t *testing.T,
	limit uint64,
	window time.Duration,
) (*Memory, *mutableClock) {
	t.Helper()
	clock := &mutableClock{
		value: time.Date(2026, time.July, 30, 12, 0, 0, 0, time.UTC),
	}
	rules := make([]Rule, 0, 4)
	for _, kind := range []ratelimitport.SubjectKind{
		ratelimitport.SubjectIP,
		ratelimitport.SubjectLoginHash,
		ratelimitport.SubjectAccountID,
		ratelimitport.SubjectAgentID,
	} {
		rules = append(rules, Rule{
			SubjectKind:    kind,
			OperationClass: "auth.issue",
			Limit:          limit,
			Window:         window,
		})
	}
	limiter, err := NewMemory(clock, Config{
		Rules:      rules,
		MaxBuckets: 1024,
	})
	if err != nil {
		t.Fatalf("NewMemory() error = %v", err)
	}
	return limiter, clock
}

func testSubjects(t *testing.T) []ratelimitport.Subject {
	t.Helper()
	ip, err := ratelimitport.NewIPSubject(netip.MustParseAddr("192.0.2.10"))
	if err != nil {
		t.Fatal(err)
	}
	login, err := ratelimitport.NewLoginHashSubject(strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	account, err := ratelimitport.NewAccountSubject(memoryTestAccountID)
	if err != nil {
		t.Fatal(err)
	}
	agent, err := ratelimitport.NewAgentSubject(memoryTestServerID, memoryTestAgentID)
	if err != nil {
		t.Fatal(err)
	}
	return []ratelimitport.Subject{ip, login, account, agent}
}
