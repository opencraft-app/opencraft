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
