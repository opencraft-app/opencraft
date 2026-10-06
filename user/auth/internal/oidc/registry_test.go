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
	for _, raw := range []string{"opencraft://evil/lightvela", NativeRedirectURI + "?x=1", NativeRedirectURI + "/", "opencraft://auth/%6cightvela", "opencraft://user@auth/lightvela"} {
		if _, err := registry.ValidateRedirectURI(NativeClientID, raw); err == nil {
			t.Fatal("nonexact callback accepted")
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

func TestDevCloudCallbacksRequireOptInAndCanonicalWebOrigin(t *testing.T) {
	legacy, err := NewRegistry([]Client{{ID: WebClientID, DisplayName: "Web", RedirectURIs: []string{WebCNRedirectURI, WebInternationalRedirectURI}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.ValidateRedirectURI(WebClientID, "https://join.devcloud.woa.com/auth/lightvela/callback"); err == nil {
		t.Fatal("DevCloud enabled without registration")
	}
	registry, err := NewRegistry([]Client{{ID: WebClientID, DisplayName: "Web", RedirectURIs: []string{WebCNRedirectURI, WebInternationalRedirectURI, WebDevCloudRedirectURI}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{WebCNRedirectURI, WebInternationalRedirectURI, "https://join.devcloud.woa.com/auth/lightvela/callback", "https://preview-42.team.devcloud.woa.com/auth/lightvela/callback"} {
		if got, err := registry.ValidateRedirectURI(WebClientID, raw); err != nil || got != raw {
			t.Fatalf("valid callback %q rejected or rewritten: %q, %v", raw, got, err)
		}
	}
	for _, raw := range []string{
		WebDevCloudRedirectURI,
		"https://devcloud.woa.com/auth/lightvela/callback",
		"https://join.devcloud.woa.com.evil.example/auth/lightvela/callback",
		"https://evildevcloud.woa.com/auth/lightvela/callback",
		"http://join.devcloud.woa.com/auth/lightvela/callback",
		"https://join.devcloud.woa.com:443/auth/lightvela/callback",
		"https://join.devcloud.woa.com:8443/auth/lightvela/callback",
		"https://JOIN.devcloud.woa.com/auth/lightvela/callback",
		"https://join.devcloud.woa.com./auth/lightvela/callback",
		"https://join..devcloud.woa.com/auth/lightvela/callback",
		"https://-join.devcloud.woa.com/auth/lightvela/callback",
		"https://join_.devcloud.woa.com/auth/lightvela/callback",
		"https://user@join.devcloud.woa.com/auth/lightvela/callback",
		"https://join.devcloud.woa.com/auth/lightvela/callback/",
		"https://join.devcloud.woa.com/auth/lightvela/%63allback",
		"https://join.devcloud.woa.com/auth/lightvela/callback?",
		"https://join.devcloud.woa.com/auth/lightvela/callback?next=evil",
		"https://join.devcloud.woa.com/auth/lightvela/callback#",
		"https://join.devcloud.woa.com/other",
	} {
		if _, err := registry.ValidateRedirectURI(WebClientID, raw); err == nil {
			t.Errorf("unsafe callback accepted: %q", raw)
		}
	}
	for _, client := range []Client{
		{ID: "site-gateway", DisplayName: "Sites", RedirectURIs: []string{WebDevCloudRedirectURI}},
		{ID: WebClientID, DisplayName: "Web", RedirectURIs: []string{WebCNRedirectURI, WebInternationalRedirectURI, "https://*.woa.com/auth/lightvela/callback"}},
		{ID: WebClientID, DisplayName: "Web", RedirectURIs: []string{WebCNRedirectURI, WebInternationalRedirectURI, WebDevCloudRedirectURI, WebDevCloudRedirectURI}},
	} {
		if _, err := NewRegistry([]Client{client}); err == nil {
			t.Errorf("unsafe registration accepted: %+v", client)
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
