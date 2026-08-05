package install

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	rootstate "velachat/agent/internal/state"
	"velachat/agent/internal/vela/tat"
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
	if err := service.Install(context.Background(), options); err == nil ||
		err.Error() != "Vela Computer is already installed and active for this macOS user." {
		t.Fatalf("repeat install error = %v", err)
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
		ComputerID        string `json:"computerId"`
		AllowInsecureHTTP bool   `json:"allowInsecureHttp"`
	}
	if err := rootstate.New(options.StateDirectory).Read("config.json", &config); err != nil ||
		config.ComputerID != testComputerID || !config.AllowInsecureHTTP {
		t.Fatalf("config=%#v err=%v", config, err)
	}
	for _, transient := range []string{installTokenName, installSecretName} {
		if _, err := os.Lstat(filepath.Join(options.StateDirectory, transient)); !os.IsNotExist(err) {
			t.Fatalf("transient install secret still exists: %s err=%v", transient, err)
		}
	}
}

func TestServiceUpgradesVerifiedReleaseWhileReplacingRemovedComputer(t *testing.T) {
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
	newComputerID := "019fd111-1111-7111-8111-111111111111"
	newToken := "cen1." + testServerID + "." + newComputerID + ".2.signature"
	if err := os.WriteFile(tokenFile, []byte(newToken), 0o600); err != nil {
		t.Fatal(err)
	}
	client.preflight = PreflightResult{
		Status: PreflightRemoved, ReplacementGrant: "rpg1.payload.signature-with-enough-bytes",
	}
	client.claimComputerID = newComputerID
	if err := service.Install(context.Background(), options); err != nil {
		t.Fatalf("cross-release replacement failed: %v", err)
	}
	installed, err := os.ReadFile(filepath.Join(options.InstallationRoot, "bin", ProgramName))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(installed, newContent) {
		t.Fatalf("installed program = %q, want verified replacement", installed)
	}
	if launcher.starts != 2 || native.inspections != 1 {
		t.Fatalf("launcher starts=%d TAT inspections=%d", launcher.starts, native.inspections)
	}
	wantProgramSHA := fmt.Sprintf("%x", sha256.Sum256(newContent))
	if len(launcher.specs) != 2 || launcher.specs[1].ProgramSHA256 != wantProgramSHA {
		t.Fatalf("replacement launch specs = %#v", launcher.specs)
	}
	var journal installJournal
	if err := rootstate.New(options.StateDirectory).Read(installJournalName, &journal); err != nil {
		t.Fatal(err)
	}
	if journal.Version != verifiedVersion ||
		journal.ProgramSHA256 != fmt.Sprintf("%x", sha256.Sum256(newContent)) {
		t.Fatalf("journal release = %#v", journal)
	}
}

func TestServiceResumesProviderRegistrationWithNewVerifiedRelease(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	program := filepath.Join(root, ProgramName)
	content := []byte("first-release")
	if err := os.WriteFile(program, content, 0o700); err != nil {
		t.Fatal(err)
	}
	tokenFile := filepath.Join(root, "token")
	if err := os.WriteFile(
		tokenFile,
		[]byte("cen1."+testServerID+"."+testComputerID+".1.signature"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	version := "0.2.0"
	verifiedContent := append([]byte(nil), content...)
	launcher := &recordingLauncher{failures: 1}
	service, err := NewService(ServiceConfig{
		Stdout: &bytes.Buffer{}, Random: bytes.NewReader(bytes.Repeat([]byte{0x44}, 128)),
		ClientFactory: func(ClientConfig) (InstallClient, error) {
			return &recordingInstallClient{}, nil
		},
		Verify: func(VerifyConfig) (VerifiedRelease, error) {
			digest := sha256.Sum256(verifiedContent)
			return VerifiedRelease{
				Version: version, Target: "darwin-arm64",
				ProgramSize: int64(len(verifiedContent)), ProgramSHA256: digest,
			}, nil
		},
		TAT: &recordingTAT{}, Launcher: launcher,
	})
	if err != nil {
		t.Fatal(err)
	}
	options := Options{
		PlatformURL: "http://192.0.2.10", AllowInsecurePlatformHTTP: true,
		TokenFile: tokenFile, ManifestFile: filepath.Join(root, "manifest"),
		SignatureFile: filepath.Join(root, "signature"), SigningPublicKey: "key",
		ReleaseVersion: version, Target: "darwin-arm64", ProgramFile: program,
		InstallationRoot: filepath.Join(root, ".vela"),
		StateDirectory:   filepath.Join(root, ".vela", "state"),
	}
	if err := service.Install(context.Background(), options); err == nil {
		t.Fatal("first launcher failure was not returned")
	}
	verifiedContent = []byte("second-release")
	version = "0.3.0"
	options.ReleaseVersion = version
	if err := os.WriteFile(program, verifiedContent, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := service.Install(context.Background(), options); err != nil {
		t.Fatalf("provider registration did not resume across release: %v", err)
	}
	var journal installJournal
	if err := rootstate.New(options.StateDirectory).Read(installJournalName, &journal); err != nil {
		t.Fatal(err)
	}
	if journal.Stage != "complete" || journal.Version != version || launcher.starts != 2 {
		t.Fatalf("journal=%#v launcher starts=%d", journal, launcher.starts)
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

func TestServiceAutomaticallyReclaimsRetiredTATIdentityForRemovedComputer(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	program := filepath.Join(root, ProgramName)
	content := []byte("canonical-program")
	if err := os.WriteFile(program, content, 0o700); err != nil {
		t.Fatal(err)
	}
	tokenFile := filepath.Join(root, "token")
	oldToken := "cen1." + testServerID + "." + testComputerID + ".1.signature"
	if err := os.WriteFile(tokenFile, []byte(oldToken), 0o600); err != nil {
		t.Fatal(err)
	}
	newComputerID := "019fd111-1111-7111-8111-111111111111"
	client := &recordingInstallClient{}
	launcher := &recordingLauncher{}
	native := &recordingTAT{}
	digest := sha256.Sum256(content)
	service, err := NewService(ServiceConfig{
		Stdout: &bytes.Buffer{}, Random: bytes.NewReader(bytes.Repeat([]byte{0x33}, 256)),
		ClientFactory: func(ClientConfig) (InstallClient, error) { return client, nil },
		Verify: func(VerifyConfig) (VerifiedRelease, error) {
			return VerifiedRelease{Version: "0.2.0", Target: "darwin-arm64", ProgramSize: int64(len(content)), ProgramSHA256: digest}, nil
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
		ReleaseVersion: "0.2.0", Target: "darwin-arm64", ProgramFile: program,
		InstallationRoot: filepath.Join(root, ".vela"), StateDirectory: filepath.Join(root, ".vela", "state"),
	}
	if err := service.Install(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	newToken := "cen1." + testServerID + "." + newComputerID + ".2.signature"
	if err := os.WriteFile(tokenFile, []byte(newToken), 0o600); err != nil {
		t.Fatal(err)
	}
	client.preflight = PreflightResult{Status: PreflightRemoved, ReplacementGrant: "rpg1.payload.signature-with-enough-bytes"}
	client.claimComputerID = newComputerID
	client.failReplacementClaim = true
	if err := service.Install(context.Background(), options); err == nil {
		t.Fatal("replacement claim failure was not returned")
	}
	conflictingToken := "cen1." + testServerID + ".019fd222-2222-7222-8222-222222222222.3.signature"
	if err := os.WriteFile(tokenFile, []byte(conflictingToken), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := service.Install(context.Background(), options); !errors.Is(err, ErrInstallConflict) {
		t.Fatalf("conflicting enrollment error = %v, want %v", err, ErrInstallConflict)
	}
	if err := os.WriteFile(tokenFile, []byte(newToken), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := service.Install(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	if native.registrations != 1 || native.inspections != 1 || launcher.starts != 2 {
		t.Fatalf("registrations=%d inspections=%d starts=%d", native.registrations, native.inspections, launcher.starts)
	}
	if len(client.claimGrants) != 3 || client.claimGrants[1] != "rpg1.payload.signature-with-enough-bytes" ||
		client.claimGrants[2] != client.claimGrants[1] || client.claimSecrets[2] != client.claimSecrets[1] {
		t.Fatalf("claim grants=%#v secrets=%#v", client.claimGrants, client.claimSecrets)
	}
	var config struct {
		ComputerID string `json:"computerId"`
	}
	if err := rootstate.New(options.StateDirectory).Read(configName, &config); err != nil || config.ComputerID != newComputerID {
		t.Fatalf("config=%#v err=%v", config, err)
	}
}

func TestServiceFinishesCommittedReplacementWithoutClaimingAgain(t *testing.T) {
	t.Parallel()

	service, options, client, launcher := prepareCommittedReplacementResidue(t)
	claimsBeforeRetry := len(client.claimSecrets)
	client.failReplacementClaim = true

	if err := service.Install(context.Background(), options); err != nil {
		t.Fatalf("committed replacement retry failed: %v", err)
	}
	if len(client.claimSecrets) != claimsBeforeRetry {
		t.Fatalf("claim calls = %d, want %d", len(client.claimSecrets), claimsBeforeRetry)
	}
	if launcher.starts != 3 {
		t.Fatalf("launcher starts = %d, want 3", launcher.starts)
	}
	for _, name := range []string{
		replacementTokenName, replacementSecretName, replacementGrantName, replacementJournalName,
	} {
		if _, err := os.Lstat(filepath.Join(options.StateDirectory, name)); !os.IsNotExist(err) {
			t.Fatalf("replacement state still exists: %s err=%v", name, err)
		}
	}
}

func TestServiceReconcilesCommittedReplacementBeforeNewEnrollment(t *testing.T) {
	t.Parallel()

	service, options, client, launcher := prepareCommittedReplacementResidue(t)
	thirdComputerID := "019fd222-2222-7222-8222-222222222222"
	thirdToken := "cen1." + testServerID + "." + thirdComputerID + ".3.signature"
	if err := os.WriteFile(options.TokenFile, []byte(thirdToken), 0o600); err != nil {
		t.Fatal(err)
	}
	newContent := []byte("new-installer-release")
	if err := os.WriteFile(options.ProgramFile, newContent, 0o700); err != nil {
		t.Fatal(err)
	}
	options.ReleaseVersion = "0.3.0"
	client.claimComputerID = thirdComputerID

	if err := service.Install(context.Background(), options); err != nil {
		t.Fatalf("new enrollment after committed replacement failed: %v", err)
	}
	if len(client.claimSecrets) != 3 {
		t.Fatalf("claim calls = %d, want 3", len(client.claimSecrets))
	}
	if launcher.starts != 4 {
		t.Fatalf("launcher starts = %d, want 4", launcher.starts)
	}
	var journal installJournal
	if err := rootstate.New(options.StateDirectory).Read(installJournalName, &journal); err != nil {
		t.Fatal(err)
	}
	if journal.ComputerID != thirdComputerID {
		t.Fatalf("installed computer = %q, want %q", journal.ComputerID, thirdComputerID)
	}
}

func prepareCommittedReplacementResidue(
	t *testing.T,
) (*Service, Options, *recordingInstallClient, *recordingLauncher) {
	t.Helper()

	root := t.TempDir()
	content := []byte("canonical-program")
	program := filepath.Join(root, ProgramName)
	if err := os.WriteFile(program, content, 0o700); err != nil {
		t.Fatal(err)
	}
	tokenFile := filepath.Join(root, "token")
	firstToken := "cen1." + testServerID + "." + testComputerID + ".1.signature"
	if err := os.WriteFile(tokenFile, []byte(firstToken), 0o600); err != nil {
		t.Fatal(err)
	}
	client := &recordingInstallClient{}
	launcher := &recordingLauncher{}
	service, err := NewService(ServiceConfig{
		Stdout: &bytes.Buffer{}, Random: bytes.NewReader(bytes.Repeat([]byte{0x55}, 256)),
		ClientFactory: func(ClientConfig) (InstallClient, error) { return client, nil },
		Verify: func(config VerifyConfig) (VerifiedRelease, error) {
			verifiedContent, readErr := os.ReadFile(config.ProgramPath)
			if readErr != nil {
				return VerifiedRelease{}, readErr
			}
			digest := sha256.Sum256(verifiedContent)
			return VerifiedRelease{
				Version: config.Version, Target: config.Target,
				ProgramSize: int64(len(verifiedContent)), ProgramSHA256: digest,
			}, nil
		},
		TAT: &recordingTAT{}, Launcher: launcher,
	})
	if err != nil {
		t.Fatal(err)
	}
	options := Options{
		PlatformURL: "http://192.0.2.10", AllowInsecurePlatformHTTP: true,
		TokenFile: tokenFile, ManifestFile: filepath.Join(root, "manifest"),
		SignatureFile: filepath.Join(root, "signature"), SigningPublicKey: "key",
		ReleaseVersion: "0.2.0", Target: "darwin-arm64", ProgramFile: program,
		InstallationRoot: filepath.Join(root, ".vela"), StateDirectory: filepath.Join(root, ".vela", "state"),
	}
	if err := service.Install(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	secondComputerID := "019fd111-1111-7111-8111-111111111111"
	secondToken := "cen1." + testServerID + "." + secondComputerID + ".2.signature"
	if err := os.WriteFile(tokenFile, []byte(secondToken), 0o600); err != nil {
		t.Fatal(err)
	}
	client.preflight = PreflightResult{
		Status: PreflightRemoved, ReplacementGrant: "rpg1.payload.signature-with-enough-bytes",
	}
	client.claimComputerID = secondComputerID
	launcher.failures = 1
	if err := service.Install(context.Background(), options); err == nil {
		t.Fatal("replacement launch failure was not returned")
	}
	return service, options, client, launcher
}

type recordingInstallClient struct {
	failFirstClaim       bool
	failReplacementClaim bool
	claimSecrets         []string
	claimGrants          []string
	claimComputerID      string
	preflight            PreflightResult
}

func (client *recordingInstallClient) Claim(_ context.Context, request ClaimRequest) (ClaimResult, error) {
	client.claimSecrets = append(client.claimSecrets, request.SecretPart)
	client.claimGrants = append(client.claimGrants, request.ReplacementGrant)
	if client.failFirstClaim {
		client.failFirstClaim = false
		return ClaimResult{}, errors.New("temporary claim failure")
	}
	if request.ReplacementGrant != "" && client.failReplacementClaim {
		client.failReplacementClaim = false
		return ClaimResult{}, errors.New("temporary replacement claim failure")
	}
	return ClaimResult{
		ServerID: testServerID, ComputerID: fallbackString(client.claimComputerID, testComputerID),
		CredentialID: testCredentialID, Version: 1,
		ExpiresAt:  time.Now().UTC().Add(time.Hour),
		Credential: "crc_" + testServerID + "." + fallbackString(client.claimComputerID, testComputerID) + ".1." + request.SecretPart,
	}, nil
}

func (client *recordingInstallClient) Preflight(context.Context, PreflightRequest) (PreflightResult, error) {
	if client.preflight.Status == "" {
		return PreflightResult{Status: PreflightActive}, nil
	}
	return client.preflight, nil
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

type recordingTAT struct {
	registrations int
	inspections   int
}

func (runtime *recordingTAT) Register(context.Context, tat.Registration) error {
	runtime.registrations++
	return nil
}

func (*recordingTAT) Start(context.Context, string) (tat.Handle, error) {
	return nil, errors.New("not used")
}

func (runtime *recordingTAT) Inspect(context.Context, string) (tat.Identity, error) {
	runtime.inspections++
	return tat.Identity{Region: "ap-beijing", InstanceID: "rins-test"}, nil
}

func fallbackString(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

type recordingLauncher struct {
	starts   int
	failures int
	specs    []LaunchSpec
}

func (launcher *recordingLauncher) Start(_ context.Context, spec LaunchSpec) error {
	launcher.starts++
	launcher.specs = append(launcher.specs, spec)
	if launcher.failures > 0 {
		launcher.failures--
		return errors.New("temporary launch failure")
	}
	return nil
}
