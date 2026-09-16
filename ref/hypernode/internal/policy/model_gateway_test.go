package policy

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"hypernode/internal/modelgateway"
)

func TestCodexAuthProfilesAreSnapshottedAndActivatedAtomically(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential ownership test requires chown")
	}
	usersRoot := t.TempDir()
	host := &hostRuntime{usersRoot: usersRoot}
	codexHome := filepath.Join(usersRoot, userHomeSegment("alice"), ".codex")
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	const userID = 20002
	if err := os.Chown(codexHome, userID, userID); err != nil {
		t.Fatal(err)
	}
	first := []byte(`{"auth_mode":"chatgpt","tokens":{"account_id":"account-one"}}`)
	active := filepath.Join(codexHome, "auth.json")
	activeInstallation := filepath.Join(codexHome, "installation_id")
	if err := os.WriteFile(active, first, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(activeInstallation, []byte("installation-one"), 0o600); err != nil {
		t.Fatal(err)
	}
	profilePath, err := host.saveCodexAuthProfile("alice", "subscription-one")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(profilePath, filepath.Join("subscription-one", "auth.json")) {
		t.Fatalf("unexpected profile path %q", profilePath)
	}
	profileInfo, err := os.Stat(profilePath)
	if err != nil {
		t.Fatal(err)
	}
	if stat, ok := profileInfo.Sys().(*syscall.Stat_t); !ok || stat.Uid != userID || stat.Gid != userID {
		t.Fatalf("profile owner=%v, want uid/gid %d", profileInfo.Sys(), userID)
	}
	if err := os.WriteFile(active, []byte(`{"auth_mode":"chatgpt","tokens":{"account_id":"account-two"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(activeInstallation, []byte("installation-two"), 0o600); err != nil {
		t.Fatal(err)
	}
	markerDir := filepath.Join(codexHome, "hypernode")
	if err := os.MkdirAll(markerDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(markerDir, "active-shared"), []byte("shared-old"), 0o600); err != nil {
		t.Fatal(err)
	}
	activatedInstallation, err := host.activateCodexAuthProfile("alice", "subscription-one")
	if err != nil {
		t.Fatal(err)
	}
	if activatedInstallation != "installation-one" {
		t.Fatalf("activated installation=%q, want installation-one", activatedInstallation)
	}
	activeInfo, err := os.Stat(active)
	if err != nil {
		t.Fatal(err)
	}
	if stat, ok := activeInfo.Sys().(*syscall.Stat_t); !ok || stat.Uid != userID || stat.Gid != userID {
		t.Fatalf("active owner=%v, want uid/gid %d", activeInfo.Sys(), userID)
	}
	got, err := os.ReadFile(active)
	if err != nil || string(got) != string(first) {
		t.Fatalf("activated auth=%q err=%v", got, err)
	}
	gotInstallation, err := os.ReadFile(activeInstallation)
	if err != nil || string(gotInstallation) != "installation-one" {
		t.Fatalf("activated installation=%q err=%v", gotInstallation, err)
	}
	if _, err := os.Stat(filepath.Join(markerDir, "active-shared")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("owned profile activation retained shared marker: %v", err)
	}
	if _, err := host.saveCodexAuthProfile("alice", "../escape"); err == nil {
		t.Fatal("credential profile accepted a traversal id")
	}
}

func TestSharedCodexProfileCopiesCredentialPairAndMarksTheConsumer(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential ownership test requires chown")
	}
	usersRoot := t.TempDir()
	host := &hostRuntime{usersRoot: usersRoot}
	for index, username := range []string{"owner", "consumer"} {
		codexHome := filepath.Join(usersRoot, userHomeSegment(username), ".codex")
		if err := os.MkdirAll(codexHome, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(codexHome, 20100+index, 20100+index); err != nil {
			t.Fatal(err)
		}
	}
	ownerHome := filepath.Join(usersRoot, userHomeSegment("owner"), ".codex")
	ownerAuth := []byte(`{"auth_mode":"chatgpt","tokens":{"account_id":"shared-account"}}`)
	if err := os.WriteFile(filepath.Join(ownerHome, "auth.json"), ownerAuth, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ownerHome, "installation_id"), []byte("shared-installation"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := host.saveCodexAuthProfile("owner", "subscription-shared"); err != nil {
		t.Fatal(err)
	}
	installation, err := host.activateSharedCodexAuthProfile(
		"owner", "subscription-shared", "consumer", "shared-slot-one",
	)
	if err != nil {
		t.Fatal(err)
	}
	if installation != "shared-installation" {
		t.Fatalf("installation=%q", installation)
	}
	consumerHome := filepath.Join(usersRoot, userHomeSegment("consumer"), ".codex")
	if got, err := os.ReadFile(filepath.Join(consumerHome, "auth.json")); err != nil || string(got) != string(ownerAuth) {
		t.Fatalf("consumer auth=%q err=%v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(consumerHome, "installation_id")); err != nil || string(got) != "shared-installation" {
		t.Fatalf("consumer installation=%q err=%v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(consumerHome, "hypernode", "active-shared")); err != nil || string(got) != "shared-slot-one" {
		t.Fatalf("consumer marker=%q err=%v", got, err)
	}
	refreshedAuth := []byte(`{"auth_mode":"chatgpt","tokens":{"account_id":"shared-account","access_token":"new"}}`)
	if err := os.WriteFile(filepath.Join(consumerHome, "auth.json"), refreshedAuth, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := host.syncSharedCodexAuthProfile("consumer", "owner", "subscription-shared"); err != nil {
		t.Fatal(err)
	}
	canonicalPath, err := host.codexAuthProfilePath("owner", "subscription-shared")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(canonicalPath); err != nil || string(got) != string(refreshedAuth) {
		t.Fatalf("synced canonical auth=%q err=%v", got, err)
	}
}

func TestCodexLoginStagingUsesANewInstallationWithoutDestroyingTheOldCredential(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential ownership test requires chown")
	}
	usersRoot := t.TempDir()
	host := &hostRuntime{usersRoot: usersRoot}
	codexHome := filepath.Join(usersRoot, userHomeSegment("alice"), ".codex")
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	const userID = 20004
	if err := os.Chown(codexHome, userID, userID); err != nil {
		t.Fatal(err)
	}
	oldAuth := []byte(`{"auth_mode":"chatgpt","tokens":{"account_id":"old-account"}}`)
	activeAuth := filepath.Join(codexHome, "auth.json")
	activeInstallation := filepath.Join(codexHome, "installation_id")
	if err := os.WriteFile(activeAuth, oldAuth, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(activeInstallation, []byte("installation-old"), 0o600); err != nil {
		t.Fatal(err)
	}
	sharedMarker := filepath.Join(codexHome, "hypernode", "active-shared")
	if err := os.MkdirAll(filepath.Dir(sharedMarker), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sharedMarker, []byte("shared-before-login"), 0o600); err != nil {
		t.Fatal(err)
	}

	previous, err := host.beginCodexAuthLogin("alice", "login-one", "installation-new")
	if err != nil {
		t.Fatal(err)
	}
	if previous != "installation-old" {
		t.Fatalf("previous installation=%q", previous)
	}
	if _, err := os.Stat(activeAuth); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("active auth still exists during isolated login: %v", err)
	}
	if got, err := os.ReadFile(activeInstallation); err != nil || string(got) != "installation-new" {
		t.Fatalf("staged installation=%q err=%v", got, err)
	}
	if _, err := os.Stat(sharedMarker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("shared marker remains during owned login: %v", err)
	}
	restored, err := host.rollbackCodexAuthLogin("alice", "login-one")
	if err != nil {
		t.Fatal(err)
	}
	if restored != "installation-old" {
		t.Fatalf("restored installation=%q", restored)
	}
	if got, err := os.ReadFile(activeAuth); err != nil || string(got) != string(oldAuth) {
		t.Fatalf("restored auth=%q err=%v", got, err)
	}
	if got, err := os.ReadFile(activeInstallation); err != nil || string(got) != "installation-old" {
		t.Fatalf("restored installation file=%q err=%v", got, err)
	}
	if got, err := os.ReadFile(sharedMarker); err != nil || string(got) != "shared-before-login" {
		t.Fatalf("restored shared marker=%q err=%v", got, err)
	}

	if _, err := host.beginCodexAuthLogin("alice", "login-two", "installation-new"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(activeAuth, []byte(`{"auth_mode":"chatgpt","tokens":{"account_id":"new-account"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := host.commitCodexAuthLogin("alice", "login-two"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(codexHome, "hypernode", "login-staging", "login-two")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("committed staging directory remains: %v", err)
	}
}

func TestEnsureUserRepairsHostOwnedActiveCodexCredential(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential ownership test requires chown")
	}
	usersRoot := t.TempDir()
	host := &hostRuntime{usersRoot: usersRoot}
	const userID = 20003
	paths, err := host.ensureUser("alice", userID, userID, "installation-one")
	if err != nil {
		t.Fatal(err)
	}
	authPath := filepath.Join(paths["codexHome"].(string), "auth.json")
	if err := os.WriteFile(authPath, []byte(`{"auth_mode":"chatgpt"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(authPath, 0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := host.ensureUser("alice", userID, userID, "installation-one"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(authPath)
	if err != nil {
		t.Fatal(err)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Uid != userID || stat.Gid != userID {
		t.Fatalf("active owner=%v, want uid/gid %d", info.Sys(), userID)
	}
}

func TestCodexAppServerNeverInheritsCustomProviderConfiguration(t *testing.T) {
	registry := modelgateway.NewRegistry()
	if _, err := registry.Register("hypernode-test", "https://models.example/v1"); err != nil {
		t.Fatal(err)
	}
	if err := registry.SetUserCredential("alice", "hypernode-test", "secret", "model-a", "Provider A"); err != nil {
		t.Fatal(err)
	}
	host := &hostRuntime{modelGateway: registry, modelGatewayBaseURL: "http://hypernode.internal:9988"}
	arguments := host.codexAppServerArguments("alice", "codex")
	if len(arguments) != 4 || arguments[0] != "codex" || arguments[1] != "app-server" {
		t.Fatalf("arguments=%#v", arguments)
	}
	joined := strings.Join(arguments, "\n")
	for _, forbidden := range []string{
		"model_provider", "model_providers", "HYPERNODE_MODEL_API_KEY", "model-a",
	} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("Codex arguments expose custom provider field %q: %#v", forbidden, arguments)
		}
	}
}

func TestCodexAppServerIgnoresExplicitCustomProviderRoute(t *testing.T) {
	registry := modelgateway.NewRegistry()
	for _, provider := range []struct {
		id, endpoint, key, model string
	}{
		{"provider-a", "https://models-a.example/v1", "secret-a", "model-a"},
		{"provider-b", "https://models-b.example/v1", "secret-b", "model-b"},
	} {
		if _, err := registry.Register(provider.id, provider.endpoint); err != nil {
			t.Fatal(err)
		}
		if err := registry.SetUserCredential(
			"alice", provider.id, provider.key, provider.model, provider.id,
		); err != nil {
			t.Fatal(err)
		}
	}
	host := &hostRuntime{modelGateway: registry, modelGatewayBaseURL: "http://hypernode.internal:9988"}
	providerA := strings.Join(host.codexAppServerArgumentsForProvider("alice", "provider-a", "codex"), "\n")
	if strings.Contains(providerA, "provider-a") || strings.Contains(providerA, "provider-b") ||
		strings.Contains(providerA, "HYPERNODE_MODEL_API_KEY") {
		t.Fatalf("Codex process inherited a DSH provider route: %s", providerA)
	}
	subscription := strings.Join(host.codexAppServerArgumentsForProvider("alice", "", "codex"), "\n")
	if providerA != subscription {
		t.Fatalf("provider route changed native Codex launch: provider=%q native=%q", providerA, subscription)
	}
}
