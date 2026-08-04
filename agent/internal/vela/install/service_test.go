package install

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	rootstate "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/state"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/tat"
)

func TestServiceReusesStagedSecretAndCompletesFirstInstall(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	program := filepath.Join(root, ProgramName)
	if err := os.WriteFile(program, []byte("canonical-program"), 0o700); err != nil {
		t.Fatal(err)
	}
	tokenFile := filepath.Join(root, "token")
	if err := os.WriteFile(tokenFile, []byte("cen1."+testServerID+"."+testComputerID+".1.signature"), 0o600); err != nil {
		t.Fatal(err)
	}
	client := &recordingInstallClient{failFirstClaim: true}
	launcher := &recordingLauncher{}
	native := &recordingTAT{}
	service, err := NewService(ServiceConfig{
		Stdout:        &bytes.Buffer{},
		Random:        bytes.NewReader(bytes.Repeat([]byte{0x5a}, 128)),
		ClientFactory: func(ClientConfig) (InstallClient, error) { return client, nil },
		Verify: func(VerifyConfig) (VerifiedRelease, error) {
			digest := sha256.Sum256([]byte("canonical-program"))
			return VerifiedRelease{
				Version: "0.2.0", Target: "darwin-arm64", ProgramSize: 17,
				ProgramSHA256: digest,
			}, nil
		},
		TAT:      native,
		Launcher: launcher,
	})
	if err != nil {
		t.Fatal(err)
	}
	options := Options{
		PlatformURL: "http://192.0.2.10", AllowInsecurePlatformHTTP: true,
		TokenFile: tokenFile, ManifestFile: filepath.Join(root, "manifest"),
		SignatureFile: filepath.Join(root, "signature"), SigningPublicKey: "key",
		ReleaseVersion: "0.2.0", Target: "darwin-arm64", ProgramFile: program,
		InstallationRoot: filepath.Join(root, ".vela"),
		StateDirectory:   filepath.Join(root, ".vela", "state"),
	}
	if err := service.Install(context.Background(), options); err == nil {
		t.Fatal("first install unexpectedly succeeded")
	}
	if err := service.Install(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	if len(client.claimSecrets) != 2 || client.claimSecrets[0] != client.claimSecrets[1] {
		t.Fatalf("claim secrets = %#v", client.claimSecrets)
	}
	if native.registrations != 1 || launcher.starts != 1 {
		t.Fatalf("TAT registrations=%d launcher starts=%d", native.registrations, launcher.starts)
	}
	installed := filepath.Join(options.InstallationRoot, "bin", ProgramName)
	if info, err := os.Lstat(installed); err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o700 {
		t.Fatalf("installed program info=%v err=%v", info, err)
	}
	var config struct {
		ComputerID string `json:"computerId"`
	}
	if err := rootstate.New(options.StateDirectory).Read("config.json", &config); err != nil ||
		config.ComputerID != testComputerID {
		t.Fatalf("config=%#v err=%v", config, err)
	}
	for _, transient := range []string{installTokenName, installSecretName} {
		if _, err := os.Lstat(filepath.Join(options.StateDirectory, transient)); !os.IsNotExist(err) {
			t.Fatalf("transient install secret still exists: %s err=%v", transient, err)
		}
	}
}

func TestServiceRejectsDifferentReleaseBeforeReplacingInstalledProgram(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	program := filepath.Join(root, ProgramName)
	oldContent := []byte("canonical-program")
	if err := os.WriteFile(program, oldContent, 0o700); err != nil {
		t.Fatal(err)
	}
	tokenFile := filepath.Join(root, "token")
	if err := os.WriteFile(tokenFile, []byte("cen1."+testServerID+"."+testComputerID+".1.signature"), 0o600); err != nil {
		t.Fatal(err)
	}
	client := &recordingInstallClient{}
	launcher := &recordingLauncher{}
	native := &recordingTAT{}
	verifiedContent := append([]byte(nil), oldContent...)
	verifiedVersion := "0.2.0"
	service, err := NewService(ServiceConfig{
		Stdout: &bytes.Buffer{}, Random: bytes.NewReader(bytes.Repeat([]byte{0x2a}, 128)),
		ClientFactory: func(ClientConfig) (InstallClient, error) { return client, nil },
		Verify: func(VerifyConfig) (VerifiedRelease, error) {
			digest := sha256.Sum256(verifiedContent)
			return VerifiedRelease{Version: verifiedVersion, Target: "darwin-arm64", ProgramSize: int64(len(verifiedContent)), ProgramSHA256: digest}, nil
		},
		TAT: native, Launcher: launcher,
	})
	if err != nil {
		t.Fatal(err)
	}
	options := Options{
		PlatformURL: "http://192.0.2.10", AllowInsecurePlatformHTTP: true,
		TokenFile: tokenFile, ManifestFile: filepath.Join(root, "manifest"),
		SignatureFile: filepath.Join(root, "signature"), SigningPublicKey: "key",
		ReleaseVersion: verifiedVersion, Target: "darwin-arm64", ProgramFile: program,
		InstallationRoot: filepath.Join(root, ".vela"), StateDirectory: filepath.Join(root, ".vela", "state"),
	}
	if err := service.Install(context.Background(), options); err != nil {
		t.Fatal(err)
	}

	newContent := []byte("different-release-program")
	if err := os.WriteFile(program, newContent, 0o700); err != nil {
		t.Fatal(err)
	}
	verifiedContent = append([]byte(nil), newContent...)
	verifiedVersion = "0.3.0"
	options.ReleaseVersion = verifiedVersion
	if err := service.Install(context.Background(), options); !errors.Is(err, ErrInstallConflict) {
		t.Fatalf("error = %v, want %v", err, ErrInstallConflict)
	}
	installed, err := os.ReadFile(filepath.Join(options.InstallationRoot, "bin", ProgramName))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(installed, oldContent) {
		t.Fatalf("installed program was replaced before conflict check: %q", installed)
	}
}

func TestServiceReturnsClientFactoryErrorWithoutPanicking(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	program := filepath.Join(root, ProgramName)
	content := []byte("canonical-program")
	if err := os.WriteFile(program, content, 0o700); err != nil {
		t.Fatal(err)
	}
	tokenFile := filepath.Join(root, "token")
	if err := os.WriteFile(tokenFile, []byte("cen1."+testServerID+"."+testComputerID+".1.signature"), 0o600); err != nil {
		t.Fatal(err)
	}
	want := errors.New("client unavailable")
	digest := sha256.Sum256(content)
	service, err := NewService(ServiceConfig{
		Stdout: &bytes.Buffer{}, Random: bytes.NewReader(bytes.Repeat([]byte{1}, 64)),
		ClientFactory: func(ClientConfig) (InstallClient, error) { return nil, want },
		Verify: func(VerifyConfig) (VerifiedRelease, error) {
			return VerifiedRelease{Version: "0.2.0", Target: "darwin-arm64", ProgramSize: int64(len(content)), ProgramSHA256: digest}, nil
		},
		TAT: &recordingTAT{}, Launcher: &recordingLauncher{},
	})
	if err != nil {
		t.Fatal(err)
	}
	err = service.Install(context.Background(), Options{
		PlatformURL: "http://192.0.2.10", AllowInsecurePlatformHTTP: true,
		TokenFile: tokenFile, ManifestFile: filepath.Join(root, "manifest"),
		SignatureFile: filepath.Join(root, "signature"), SigningPublicKey: "key",
		ReleaseVersion: "0.2.0", Target: "darwin-arm64", ProgramFile: program,
		InstallationRoot: filepath.Join(root, ".vela"),
		StateDirectory:   filepath.Join(root, ".vela", "state"),
	})
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}

type recordingInstallClient struct {
	failFirstClaim bool
	claimSecrets   []string
}

func (client *recordingInstallClient) Claim(_ context.Context, request ClaimRequest) (ClaimResult, error) {
	client.claimSecrets = append(client.claimSecrets, request.SecretPart)
	if client.failFirstClaim {
		client.failFirstClaim = false
		return ClaimResult{}, errors.New("temporary claim failure")
	}
	return ClaimResult{
		ServerID: testServerID, ComputerID: testComputerID,
		CredentialID: testCredentialID, Version: 1,
		ExpiresAt:  time.Now().UTC().Add(time.Hour),
		Credential: "crc_" + testServerID + "." + testComputerID + ".1." + request.SecretPart,
	}, nil
}

func (*recordingInstallClient) Provider(context.Context, string) (ProviderResult, error) {
	return ProviderResult{
		Ready: true, OperationID: testCredentialID,
		Registration: ProviderRegistration{
			Region: "ap-beijing", CodeID: "code-id", CodeValue: "code-value",
			Tags:      []ProviderTag{{Key: "agent-network-computer-id", Value: testComputerID}},
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
	}, nil
}

type recordingTAT struct{ registrations int }

func (runtime *recordingTAT) Register(context.Context, tat.Registration) error {
	runtime.registrations++
	return nil
}

func (*recordingTAT) Start(context.Context, string) (tat.Handle, error) {
	return nil, errors.New("not used")
}

type recordingLauncher struct{ starts int }

func (launcher *recordingLauncher) Start(context.Context, LaunchSpec) error {
	launcher.starts++
	return nil
}
