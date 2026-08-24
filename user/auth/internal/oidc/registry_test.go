package oidc

import "testing"

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
