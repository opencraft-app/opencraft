package main

import (
	"os"
	"strings"
	"testing"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/oidc"
)

func TestProductionOpenCraftOIDCRegistries(t *testing.T) {
	for _, environment := range []string{"shprod", "sgprod"} {
		t.Run(environment, func(t *testing.T) {
			assertProductionOpenCraftOIDCRegistry(t, environment)
		})
	}
}

func assertProductionOpenCraftOIDCRegistry(t *testing.T, environment string) {
	t.Helper()
	raw, err := os.ReadFile("../../../../argocd/services/lightclaw-auth/" + environment + "/auth-platform.env")
	if err != nil {
		t.Fatal(err)
	}
	var registry string
	for _, line := range strings.Split(string(raw), "\n") {
		if value, ok := strings.CutPrefix(line, "AUTH_OIDC_CLIENTS_JSON="); ok {
			if registry != "" {
				t.Fatal("duplicate registry configuration")
			}
			registry = value
		}
	}
	clients, err := decodeOIDCClients(registry)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateSiteGatewayOIDCClients(clients); err != nil {
		t.Fatal(err)
	}
	parsedRegistry, err := oidc.NewRegistry(clients)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parsedRegistry.ValidateRedirectURI(oidc.WebClientID, "https://join.devcloud.woa.com/auth/lightvela/callback"); err != nil {
		t.Fatal("missing production DevCloud registration", err)
	}
	if len(clients) != 3 {
		t.Fatal("expected exactly Sites, native and web clients")
	}
	foundNative := false
	foundWeb := false
	for _, client := range clients {
		if client.ID == oidc.NativeClientID {
			foundNative = client.DisplayName == "Vela" && len(client.RedirectURIs) == 1 &&
				client.RedirectURIs[0] == oidc.NativeRedirectURI
		}
		if client.ID == oidc.WebClientID {
			foundWeb = client.DisplayName == "OpenCraft Web" && len(client.RedirectURIs) == 3
		}
	}
	if !foundNative {
		t.Fatal("missing exact native client registration")
	}
	if !foundWeb {
		t.Fatal("missing exact web client registration")
	}
}
