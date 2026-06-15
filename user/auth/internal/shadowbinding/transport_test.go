package shadowbinding

import (
	"errors"
	"net/http"
	"testing"
)

func TestNewCloudLadderTransportDisabledReturnsBaseOrDefault(t *testing.T) {
	base := testRoundTripper{}
	got, err := NewCloudLadderTransport(CloudLadderConfig{}, base)
	if err != nil {
		t.Fatalf("disabled transport should not fail: %v", err)
	}
	if got != base {
		t.Fatalf("expected disabled transport to return provided base")
	}

	if got, err := NewCloudLadderTransport(CloudLadderConfig{}, nil); err != nil || got == nil {
		t.Fatalf("expected disabled transport with nil base to return default transport, got=%v err=%v", got, err)
	}
}

func TestNewCloudLadderTransportRequiresSignedProxyConfigWhenEnabled(t *testing.T) {
	if _, err := NewCloudLadderTransport(CloudLadderConfig{Enabled: true, GatewayBaseURL: "https://gateway.example.com", Caller: "shadow", Secret: "secret"}, nil); err == nil {
		t.Fatal("expected enabled transport without route id to fail")
	}
	if _, err := NewCloudLadderTransport(CloudLadderConfig{Enabled: true, GatewayBaseURL: "https://gateway.example.com", RouteID: "tcapi-account-cn-dev", Caller: "shadow", Secret: "secret"}, nil); err != nil {
		t.Fatalf("expected complete enabled transport config to pass: %v", err)
	}
}

type testRoundTripper struct{}

func (testRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("not implemented")
}
