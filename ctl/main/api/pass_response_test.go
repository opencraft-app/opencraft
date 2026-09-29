package main

import (
	"testing"

	passlogic "ctl/pkg/logic/pass"
)

func TestDetailToUserPassResponseIncludesBundleType(t *testing.T) {
	response := detailToUserPassResponse(&passlogic.PassDetail{
		BundleID:   "bundle_future_ai_01",
		BundleName: "Future AI",
		BundleType: "ai",
	})

	if response.BundleType != "ai" {
		t.Fatalf("BundleType = %q, want ai", response.BundleType)
	}
}
