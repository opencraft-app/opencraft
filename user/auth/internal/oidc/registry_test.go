package oidc

import "testing"

func TestNativeRedirectIsAnExplicitClientCapability(t *testing.T) {
	registry, err := NewRegistry([]Client{{ID: NativeClientID, DisplayName: "Vela", RedirectURIs: []string{NativeRedirectURI}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.ValidateRedirectURI(NativeClientID, NativeRedirectURI); err != nil {
		t.Fatal(err)
	}
	dual, err := NewRegistry([]Client{{ID: NativeClientID, DisplayName: "Vela", RedirectURIs: []string{NativeRedirectURI, NativeInternationalRedirectURI}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dual.ValidateRedirectURI(NativeClientID, NativeInternationalRedirectURI); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.ValidateRedirectURI(NativeClientID, NativeInternationalRedirectURI); err == nil {
		t.Fatal("international callback accepted before registration")
	}
	for _, raw := range []string{"opencraft://evil/lightvela", NativeRedirectURI + "?x=1", NativeRedirectURI + "/", "opencraft://auth/%6cightvela", "opencraft://user@auth/lightvela"} {
		if _, err := dual.ValidateRedirectURI(NativeClientID, raw); err == nil {
			t.Fatal("nonexact callback accepted")
		}
	}
	for _, redirects := range [][]string{
		{NativeInternationalRedirectURI},
		{NativeRedirectURI, NativeInternationalRedirectURI + "?x=1"},
		{NativeRedirectURI, NativeRedirectURI},
	} {
		if _, err := NewRegistry([]Client{{ID: NativeClientID, DisplayName: "Vela", RedirectURIs: redirects}}); err == nil {
			t.Fatalf("accepted native redirects: %v", redirects)
		}
	}
	if _, err := NewRegistry([]Client{{ID: "web", DisplayName: "Web", RedirectURIs: []string{NativeRedirectURI}}}); err == nil {
		t.Fatal("custom scheme allowed for web client")
	}
}

func TestWebClientRequiresOnlyTheTwoCanonicalCallbacks(t *testing.T) {
	registry, err := NewRegistry([]Client{{
		ID: WebClientID, DisplayName: "OpenCraft Web",
		RedirectURIs: []string{WebInternationalRedirectURI, WebCNRedirectURI},
	}})
	if err != nil {
		t.Fatal(err)
	}
	for _, redirectURI := range []string{WebCNRedirectURI, WebInternationalRedirectURI} {
		if _, err := registry.ValidateRedirectURI(WebClientID, redirectURI); err != nil {
			t.Fatal(err)
		}
	}
	for _, redirects := range [][]string{
		{WebCNRedirectURI},
		{WebCNRedirectURI, "https://evil.example/auth/lightvela/callback"},
	} {
		if _, err := NewRegistry([]Client{{ID: WebClientID, DisplayName: "OpenCraft Web", RedirectURIs: redirects}}); err == nil {
			t.Fatalf("accepted web redirects: %v", redirects)
		}
	}
}

func TestRegistryAcceptsExactRedirectURIsOnly(t *testing.T) {
	t.Parallel()

	registry, err := NewRegistry([]Client{{
		ID:           "site-gateway",
		DisplayName:  "Lightvela Sites",
		RedirectURIs: []string{"https://sites-auth.lightvela.tech/auth/lightvela/callback", "https://sites-auth.lightvela.site/auth/lightvela/callback"},
	}})
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}

	for _, redirectURI := range []string{
		"https://sites-auth.lightvela.tech/auth/lightvela/callback",
		"https://sites-auth.lightvela.site/auth/lightvela/callback",
	} {
		if got, err := registry.ValidateRedirectURI("site-gateway", redirectURI); err != nil || got != redirectURI {
			t.Fatalf("ValidateRedirectURI(%q) = %q, %v", redirectURI, got, err)
		}
	}

	for _, redirectURI := range []string{
		"https://foo.sites-auth.lightvela.tech/auth/lightvela/callback",
		"https://sites-auth.lightvela.tech/auth/lightvela/callback?x=1",
		"https://sites-auth.lightvela.tech/AUTH/lightvela/callback",
		"https://sites-auth.lightvela.tech/auth/lightvela/callback/",
		"HTTPS://sites-auth.lightvela.tech/auth/lightvela/callback",
		"https://SITES-AUTH.lightvela.tech/auth/lightvela/callback",
		"https://sites-auth.lightvela.tech./auth/lightvela/callback",
		"https://sites-auth.lightvela.tech/auth/lightvela/%63allback",
		"https://sites-auth.lightvela.tech/auth/lightvela/call%62ack",
	} {
		if _, err := registry.ValidateRedirectURI("site-gateway", redirectURI); err == nil {
			t.Fatalf("ValidateRedirectURI(%q) unexpectedly succeeded", redirectURI)
		}
	}
}

func TestRegistryRejectsNonCanonicalRegisteredRedirectURIs(t *testing.T) {
	t.Parallel()

	for _, redirectURI := range []string{
		"HTTPS://sites-auth.lightvela.tech/auth/lightvela/callback",
		"https://SITES-AUTH.lightvela.tech/auth/lightvela/callback",
		"https://sites-auth.lightvela.tech./auth/lightvela/callback",
		"https://sites-auth.lightvela.tech/auth/lightvela/%63allback",
		"https://sites-auth.lightvela.tech/auth/lightvela/callback?x=1",
		"https://sites-auth.lightvela.tech:443/auth/lightvela/callback",
	} {
		if _, err := NewRegistry([]Client{{
			ID:           "site-gateway",
			DisplayName:  "Lightvela Sites",
			RedirectURIs: []string{redirectURI},
		}}); err == nil {
			t.Fatalf("NewRegistry() unexpectedly accepted registered redirect URI %q", redirectURI)
		}
	}
}
