package main

import (
	"errors"
	"testing"
	"time"
)

func TestValidateGenerationTransitionRequiresExactMonotonicStep(t *testing.T) {
	before := managedSet{ID: "set-a", ActiveRuntimeGeneration: 7, RouteRevision: 11}
	after := managedSet{ID: "set-a", ActiveRuntimeGeneration: 8, RouteRevision: 12}
	if err := validateGenerationTransition(before, after, 8); err != nil {
		t.Fatal(err)
	}
	after.RouteRevision = 13
	if err := validateGenerationTransition(before, after, 8); err == nil {
		t.Fatal("route revision jump unexpectedly accepted")
	}
}

func TestRetryTransientRetriesDeadlockButNotPermanentFailure(t *testing.T) {
	calls := 0
	err := retryTransient(t.Context(), 5, func() error {
		calls++
		if calls < 3 {
			return errors.New("Error 1213 (40001): Deadlock found")
		}
		return nil
	})
	if err != nil || calls != 3 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
	calls = 0
	err = retryTransient(t.Context(), 5, func() error {
		calls++
		return errors.New("invalid user")
	})
	if err == nil || calls != 1 {
		t.Fatalf("permanent err=%v calls=%d", err, calls)
	}
}

func TestWindowStatsEnforcesNormalAndSSEThresholds(t *testing.T) {
	stats := newLoadStats()
	for i := 0; i < 1000; i++ {
		stats.recordNormal(1, nil)
	}
	for i := 0; i < 100; i++ {
		stats.recordSSE(1, 20*time.Second, nil)
	}
	window := stats.window(1)
	if err := window.validate(0.999, 0.99, 19*time.Second); err != nil {
		t.Fatal(err)
	}
	stats.recordNormal(2, assertError("status=502"))
	window = stats.window(2)
	if err := window.validate(0.999, 0.99, 19*time.Second); err == nil {
		t.Fatal("failed window unexpectedly accepted")
	}
}

type assertError string

func (e assertError) Error() string { return string(e) }

func TestUpsertManagerProbeModelReplacesExistingValue(t *testing.T) {
	spec := map[string]any{
		"template": map[string]any{
			"spec": map[string]any{
				"containers": []any{map[string]any{
					"name": "set-manager",
					"env":  []any{map[string]any{"name": "LLMGATEWAY_SET_UPGRADE_PROBE_MODEL", "value": "auto"}},
				}},
			},
		},
	}
	if err := upsertManagerProbeModel(spec, "llmgw-upgrade-soak"); err != nil {
		t.Fatal(err)
	}
	containers := spec["template"].(map[string]any)["spec"].(map[string]any)["containers"].([]any)
	env := containers[0].(map[string]any)["env"].([]any)
	if got := env[0].(map[string]any)["value"]; got != "llmgw-upgrade-soak" {
		t.Fatalf("probe model=%v", got)
	}
}
