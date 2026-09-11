package main

import (
	"testing"

	passlogic "ctl/pkg/logic/pass"
)

func TestDetailToUserPassResponseIncludesBotQuotaPerAgent(t *testing.T) {
	response := detailToUserPassResponse(&passlogic.PassDetail{
		PassID:           "pass-cruise",
		BundleID:         "bundle_cruise_01",
		BotQuotaPerAgent: 10,
	})
	if response.BotQuotaPerAgent != 10 {
		t.Fatalf("BotQuotaPerAgent = %d, want 10", response.BotQuotaPerAgent)
	}
}
