package cli

import (
	"testing"
	"time"
)

func TestProductionTATWorkerLeaseCoversMultiRequestInspection(t *testing.T) {
	t.Parallel()

	config := productionTATWorkerConfig(
		"019fb322-8f9a-7af8-a39f-b01234ec5678",
	)
	minimum := 4 * productionTATRequestTimeout
	if config.LeaseTTL < minimum {
		t.Fatalf(
			"TAT Worker LeaseTTL = %s, want at least %s for multi-request inspection",
			config.LeaseTTL,
			minimum,
		)
	}
	if config.PollDelay <= 0 || config.PollDelay > 5*time.Second {
		t.Fatalf("TAT Worker PollDelay = %s", config.PollDelay)
	}
}
