package main

import (
	"os"
	"strings"
	"testing"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/oidc"
)

func TestSGProdNativeOIDCRegistry(t *testing.T) {
	raw, err := os.ReadFile("../../../../argocd/services/lightclaw-auth/sgprod/auth-platform.env")
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
	if _, err := oidc.NewRegistry(clients); err != nil {
		t.Fatal(err)
	}
	if len(clients) != 2 {
		t.Fatal("expected exactly Sites and native clients")
	}
	found := false
	for _, client := range clients {
		if client.ID == oidc.NativeClientID {
			found = client.DisplayName == "Vela" && len(client.RedirectURIs) == 1 &&
				client.RedirectURIs[0] == oidc.NativeRedirectURI
		}
	}
	if !found {
		t.Fatal("missing exact native client registration")
	}
}
