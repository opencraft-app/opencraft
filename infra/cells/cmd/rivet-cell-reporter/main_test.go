package main

import (
	"strings"
	"testing"
	"time"

	"github.com/rivet-dev/rivet/infra/cells/internal/cellreporter"
)

func TestStaticReleaseMetricsTrackContinuousDriftAndRecovery(t *testing.T) {
	now := time.Unix(1000, 0)
	metrics := &reporterMetrics{cell: "actor-bj-q01"}
	metrics.lastSuccess.Store(now.UnixNano())
	metrics.observe(cellreporter.Observation{StaticRelease: cellreporter.StaticReleaseEvidence{
		Ready: false, DriftCount: 2, ReleaseID: "sha256:abc",
	}})
	metrics.mu.Lock()
	metrics.driftSince = now.Add(-30 * time.Second)
	metrics.mu.Unlock()
	output := metrics.render(now, time.Minute)
	for _, expected := range []string{
		`actor_static_release_collection_success{cell="actor-bj-q01"} 1`,
		`actor_static_release_converged{cell="actor-bj-q01"} 0`,
		`actor_static_release_drift_findings{cell="actor-bj-q01"} 2`,
		`actor_static_release_drift_age_seconds{cell="actor-bj-q01"} 30`,
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("metric output missing %q:\n%s", expected, output)
		}
	}

	metrics.observe(cellreporter.Observation{StaticRelease: cellreporter.StaticReleaseEvidence{
		Ready: true, ReleaseID: "sha256:def",
	}})
	output = metrics.render(now, time.Minute)
	if !strings.Contains(output, `actor_static_release_converged{cell="actor-bj-q01"} 1`) ||
		!strings.Contains(output, `actor_static_release_drift_age_seconds{cell="actor-bj-q01"} 0`) {
		t.Fatalf("recovery did not reset metrics:\n%s", output)
	}
}
