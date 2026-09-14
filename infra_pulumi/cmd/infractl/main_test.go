package main

import "testing"

func TestScopedUpdateDoesNotSyncFullPlatformOutputs(t *testing.T) {
	if shouldSyncAfterUp("notify") {
		t.Fatal("notify-only update must not sync full platform outputs")
	}
}

func TestFullUpdateStillSyncsPlatformOutputs(t *testing.T) {
	if !shouldSyncAfterUp("") {
		t.Fatal("full update must continue syncing platform outputs")
	}
}

func TestParseReferralBootstrapArgs(t *testing.T) {
	stack, apply, allow, err := parseReferralBootstrapArgs([]string{"--stack", "shprod", "--apply", "--allow-token-change"})
	if err != nil {
		t.Fatal(err)
	}
	if stack != "shprod" || !apply || !allow {
		t.Fatalf("stack=%q apply=%v allow=%v", stack, apply, allow)
	}
}

func TestParseReferralBootstrapArgsDefaultsToBeijing(t *testing.T) {
	stack, apply, allow, err := parseReferralBootstrapArgs(nil)
	if err != nil {
		t.Fatal(err)
	}
	if stack != defaultStack || apply || allow {
		t.Fatalf("stack=%q apply=%v allow=%v", stack, apply, allow)
	}
}
