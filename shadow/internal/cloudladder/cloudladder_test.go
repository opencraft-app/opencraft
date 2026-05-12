package cloudladder

import "testing"

func TestRouteIDForEndpoint(t *testing.T) {
	tests := map[string]string{
		"account.dev.tencentcloudapi.com":          "tcapi-account-cn-dev",
		"https://billing.dev.tencentcloudapi.com/": "tcapi-billing-cn-dev",
		"account.test.tencentcloudapi.com":         "tcapi-account-cn-test",
		"cam.test.tencentcloudapi.com":             "tcapi-cam-cn-test",
		"sts.test.tencentcloudapi.com":             "tcapi-sts-cn-test",
	}
	for endpoint, want := range tests {
		got, err := RouteIDForEndpoint(endpoint)
		if err != nil {
			t.Fatalf("route for %s: %v", endpoint, err)
		}
		if got != want {
			t.Fatalf("route for %s = %s, want %s", endpoint, got, want)
		}
	}
}

func TestRouteIDForEndpointRejectsUnknownHost(t *testing.T) {
	if _, err := RouteIDForEndpoint("account.tencentcloudapi.com"); err == nil {
		t.Fatal("expected unknown endpoint error")
	}
}

func TestValidateEnabledRequiresRuntimeSecrets(t *testing.T) {
	if err := (Options{Enabled: true}).Validate(); err == nil {
		t.Fatal("expected missing gateway url")
	}
	if err := (Options{Enabled: true, GatewayBaseURL: "http://81.71.196.13", Caller: "shadow"}).Validate(); err == nil {
		t.Fatal("expected missing hmac secret")
	}
	if err := (Options{Enabled: true, GatewayBaseURL: "http://81.71.196.13", Caller: "shadow", Secret: "secret"}).Validate(); err != nil {
		t.Fatalf("validate enabled: %v", err)
	}
	if err := (Options{}).Validate(); err != nil {
		t.Fatalf("disabled options should not validate required fields: %v", err)
	}
}

func TestValidateEndpointFailsFastWhenEnabled(t *testing.T) {
	opts := Options{
		Enabled:        true,
		GatewayBaseURL: "http://81.71.196.13",
		Caller:         "shadow",
		Secret:         "secret",
	}
	if _, err := opts.ValidateEndpoint("account.tencentcloudapi.com"); err == nil {
		t.Fatal("expected unsupported endpoint error")
	}
	if routeID, err := opts.ValidateEndpoint("account.test.tencentcloudapi.com"); err != nil {
		t.Fatalf("validate endpoint: %v", err)
	} else if routeID != "tcapi-account-cn-test" {
		t.Fatalf("route id = %s, want tcapi-account-cn-test", routeID)
	}
}
