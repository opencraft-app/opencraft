package cli

import (
	"path/filepath"
	"testing"
)

func TestParseServeConfigAcceptsLightVelaGatewayTokenFile(t *testing.T) {
	root := t.TempDir()
	want := filepath.Join(root, "lightvela-gateway.token")
	cfg, err := parseServeConfig([]string{
		"--jwt-key-file", filepath.Join(root, "jwt.key"),
		"--lightvela-gateway-token-file", want,
		"--im-sdk-app-id", "1600000000",
		"--im-admin-user-id", "administrator",
		"--im-secret-key-file", filepath.Join(root, "im.key"),
		"--im-identity-key-file", filepath.Join(root, "identity.key"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.lightVelaGatewayTokenFile != want {
		t.Fatalf("gateway token file = %q", cfg.lightVelaGatewayTokenFile)
	}
}
