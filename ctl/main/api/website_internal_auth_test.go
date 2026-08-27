package main

import "testing"

func TestWebsiteInternalTokenFailsClosed(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "")
	if hasValidWebsiteInternalToken("anything") {
		t.Fatal("missing configured token must reject internal website requests")
	}
}

func TestWebsiteInternalTokenRequiresExactMatch(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	if hasValidWebsiteInternalToken("wrong-token") {
		t.Fatal("wrong token must be rejected")
	}
	if !hasValidWebsiteInternalToken("expected-token") {
		t.Fatal("matching token must be accepted")
	}
}
