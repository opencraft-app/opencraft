package main

import (
	"testing"

	"git.woa.com/wisp/mono/trade/internal/config"
)

func TestBillingCloudLadderConfigUsesBillingSpecificSecret(t *testing.T) {
	cfg := config.Config{
		BillingCloudAPICloudLadderGatewayURL: "http://billing-gateway.test",
		BillingCloudAPICloudLadderRouteID:    "billing-route",
		CloudLadderHMACSecret:                "general-secret",
		BillingCloudAPICloudLadderHMACSecret: "billing-secret",
	}

	got := billingCloudLadderConfig(cfg)
	if got.GatewayBaseURL != cfg.BillingCloudAPICloudLadderGatewayURL {
		t.Fatalf("GatewayBaseURL = %q", got.GatewayBaseURL)
	}
	if got.RouteID != cfg.BillingCloudAPICloudLadderRouteID {
		t.Fatalf("RouteID = %q", got.RouteID)
	}
	if got.Secret != cfg.BillingCloudAPICloudLadderHMACSecret {
		t.Fatalf("Secret = %q, want Billing-specific secret", got.Secret)
	}
}
