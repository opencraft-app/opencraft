package runtime

import (
	"fmt"
	"testing"
	"time"
)

func TestInvocationRateBurstRefillAndIsolation(t *testing.T) {
	s, _ := newTestService(t)
	now := time.Now()
	for i := 0; i < invocationBurst; i++ {
		if !s.allowInvocation("ws-hot", now) {
			t.Fatal("burst denied early")
		}
	}
	if s.allowInvocation("ws-hot", now) {
		t.Fatal("burst not limited")
	}
	if !s.allowInvocation("ws-other", now) {
		t.Fatal("other tenant rate affected")
	}
	if s.allowInvocation("ws-hot", now.Add(-time.Second)) {
		t.Fatal("clock reversal refilled bucket")
	}
	if !s.allowInvocation("ws-hot", now.Add(time.Second)) {
		t.Fatal("bucket did not refill")
	}
}
func TestInvocationRateStateIsBoundedAndExpires(t *testing.T) {
	s, _ := newTestService(t)
	now := time.Now()
	for i := 0; i < maxRateSites; i++ {
		if !s.allowInvocation(fmt.Sprintf("ws-%d", i), now) {
			t.Fatal("rate state filled prematurely")
		}
	}
	if s.allowInvocation("ws-extra", now) {
		t.Fatal("unbounded rate state")
	}
	if !s.allowInvocation("ws-extra", now.Add(rateIdleTTL+time.Second)) {
		t.Fatal("idle rate state not reaped")
	}
	if len(s.rates) != 1 {
		t.Fatalf("idle state retained: %d", len(s.rates))
	}
}

func TestRateAppliesToInvocationNotControlPlane(t *testing.T) {
	s, _ := newTestService(t)
	now := time.Now()
	for i := 0; i < invocationBurst; i++ {
		s.allowInvocation("ws-one", now)
	}
	rejected := call(t, s, "POST", "/v1/sites/ws-one/releases/wr-one/invoke", s.invokeToken, Invocation{SHA256: fixture().SHA256, Method: "GET", Path: "/api/test"})
	if rejected.Code != 429 || rejected.Header().Get("Retry-After") == "" {
		t.Fatalf("rate response %d", rejected.Code)
	}
	deleted := call(t, s, "DELETE", "/v1/sites/ws-one", s.deployToken, nil)
	if deleted.Code != 204 {
		t.Fatalf("cleanup rate limited: %d", deleted.Code)
	}
}
