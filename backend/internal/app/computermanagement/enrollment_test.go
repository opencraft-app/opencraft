package computermanagement

import (
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"
	"time"

	computerport "chatserver/internal/ports/computer"
)

const enrollmentCredentialID = "0198f4c2-7a37-7af3-a01e-0fcb31e9d84e"
const setupCodeID = "0198f4c2-7a37-7af3-a01e-0fcb31e9d84f"

type enrollmentRepository struct {
	computer        computerport.Computer
	begin           computerport.BeginEnrollmentCommand
	claim           computerport.ClaimEnrollmentCommand
	result          computerport.EnrollmentClaim
	artifactCommand computerport.ResolveArtifactCommand
	artifact        computerport.ArtifactAccess
	setupCode       computerport.StoreSetupCodeCommand
	resolveCode     computerport.ResolveSetupCodeCommand
	validateCode    computerport.ValidateSetupCodeCommand
	setupCodeRoute  computerport.SetupCodeRoute
	redemption      computerport.SetupCodeRedemption
	err             error
}

func (repository *enrollmentRepository) GetForAdmin(
	context.Context,
	string,
	string,
	string,
) (computerport.Computer, error) {
	return repository.computer, repository.err
}

func (repository *enrollmentRepository) BeginEnrollment(
	_ context.Context,
	command computerport.BeginEnrollmentCommand,
) (computerport.Computer, error) {
	repository.begin = command
	if repository.err != nil {
		return computerport.Computer{}, repository.err
	}
	result := repository.computer
	result.EnrollmentGeneration = command.Generation
	result.Revision = command.ExpectedRevision + 1
	return result, nil
}

func (repository *enrollmentRepository) ClaimEnrollment(
	_ context.Context,
	command computerport.ClaimEnrollmentCommand,
) (computerport.EnrollmentClaim, error) {
	repository.claim = command
	return repository.result, repository.err
}

func (repository *enrollmentRepository) StoreSetupCode(
	_ context.Context,
	command computerport.StoreSetupCodeCommand,
) error {
	repository.setupCode = command
	return repository.err
}

func (repository *enrollmentRepository) ResolveSetupCode(
	_ context.Context,
	command computerport.ResolveSetupCodeCommand,
) (computerport.SetupCodeRoute, error) {
	repository.resolveCode = command
	return repository.setupCodeRoute, repository.err
}

func (repository *enrollmentRepository) ValidateSetupCode(
	_ context.Context,
	command computerport.ValidateSetupCodeCommand,
) (computerport.SetupCodeRedemption, error) {
	repository.validateCode = command
	return repository.redemption, repository.err
}

func (repository *enrollmentRepository) ResolveEnrollmentArtifact(
	_ context.Context,
	command computerport.ResolveArtifactCommand,
) (computerport.ArtifactAccess, error) {
	repository.artifactCommand = command
	return repository.artifact, repository.err
}

type artifactSigner struct {
	objectKey string
	ttl       time.Duration
	url       string
}

func (signer *artifactSigner) PresignGet(
	_ context.Context,
	objectKey string,
	ttl time.Duration,
) (string, error) {
	signer.objectKey = objectKey
	signer.ttl = ttl
	return signer.url, nil
}

func enrollmentRelease() computerport.ReleaseBinding {
	return computerport.ReleaseBinding{
		Version: "0.1.0", Target: "darwin-arm64",
		OSType: "macos", Architecture: "arm64", SigningKeyID: "release-2026-01",
		Manifest: computerport.ArtifactBinding{
			ObjectKey: "computer/releases/0.1.0/manifest.json",
			SHA256:    sha256.Sum256([]byte("manifest")), Size: 512,
		},
		Signature: computerport.ArtifactBinding{
			ObjectKey: "computer/releases/0.1.0/manifest.sig",
			SHA256:    sha256.Sum256([]byte("signature")), Size: 64,
		},
		Installer: computerport.ArtifactBinding{
			ObjectKey: "computer/releases/0.1.0/darwin-arm64/install.sh",
			SHA256:    sha256.Sum256([]byte("installer")), Size: 1024,
		},
		Program: computerport.ArtifactBinding{
			ObjectKey: "computer/releases/0.1.0/darwin-arm64/vela-computer",
			SHA256:    sha256.Sum256([]byte("program")), Size: 8 << 20,
		},
	}
}

func TestEnrollmentTokenRoundTripsCanonicalRoute(t *testing.T) {
	secret := make([]byte, 32)
	for index := range secret {
		secret[index] = byte(index + 1)
	}
	token, err := newEnrollmentToken(testServerID, testComputerID, 7, secret)
	if err != nil {
		t.Fatal(err)
	}
	route, err := parseEnrollmentToken(token)
	if err != nil {
		t.Fatal(err)
	}
	if route.ServerID != testServerID || route.ComputerID != testComputerID ||
		route.Generation != 7 || len(route.Secret) != 32 {
		t.Fatalf("route = %#v", route)
	}
	for _, invalid := range []string{
		strings.Replace(token, ".7.", ".07.", 1),
		strings.Replace(token, "cen1.", "cen2.", 1),
		token + "=",
		"cen1." + testServerID + "." + testComputerID + ".0.AA",
	} {
		if _, err := parseEnrollmentToken(invalid); err == nil {
			t.Fatalf("parseEnrollmentToken(%q) unexpectedly succeeded", invalid)
		}
	}
}

func TestSetupCodeUsesSixteenCanonicalCrockfordCharacters(t *testing.T) {
	display, canonical, err := generateSetupCode(
		strings.NewReader("0123456789"),
	)
	if err != nil {
		t.Fatal(err)
	}
	if display != "60RK-4CSM-6MV3-EE1S" || canonical != "60RK4CSM6MV3EE1S" {
		t.Fatalf("setup code = (%q, %q)", display, canonical)
	}
	for _, input := range []string{
		"60rk-4csm-6mv3-ee1s",
		"60RK4CSM6MV3EE1S",
	} {
		got, err := normalizeSetupCode(input)
		if err != nil || got != canonical {
			t.Fatalf("normalizeSetupCode(%q) = (%q, %v)", input, got, err)
		}
	}
	for _, input := range []string{
		"60RK-4CSM-6MV3-EE1", "60RK-4CSM-6MV3-EE1I",
		"60RK_4CSM_6MV3_EE1S", " 60RK-4CSM-6MV3-EE1S",
	} {
		if _, err := normalizeSetupCode(input); err == nil {
			t.Fatalf("normalizeSetupCode(%q) unexpectedly succeeded", input)
		}
	}
}

func TestSetupCodeDerivesStableRouteBoundEnrollmentSecret(t *testing.T) {
	const canonical = "60RK4CSM6MV3EE1S"
	first := deriveEnrollmentSecret(canonical, testServerID, testComputerID, 3)
	second := deriveEnrollmentSecret(canonical, testServerID, testComputerID, 3)
	otherGeneration := deriveEnrollmentSecret(
		canonical, testServerID, testComputerID, 4,
	)
	if first != second || first == ([32]byte{}) || first == otherGeneration {
		t.Fatalf("derived secrets are not stable and route-bound")
	}
}

func TestEnrollmentServiceCreatesBoundNoStoreSetupCommand(t *testing.T) {
	now := time.Date(2026, 8, 2, 2, 0, 0, 0, time.UTC)
	repository := &enrollmentRepository{computer: computerport.Computer{
		ID: testComputerID, ServerID: testServerID, Name: "研发 Mac",
		OSType: "macos", LifecycleState: "provisioning", Revision: 4,
		EnrollmentGeneration: 2,
	}}
	service, err := NewEnrollmentService(
		repository,
		&fixedIDs{values: []string{setupCodeID}},
		fixedClock{now: now},
		EnrollmentConfig{
			Release: enrollmentRelease(), TokenTTL: 15 * time.Minute,
			CredentialTTL:   365 * 24 * time.Hour,
			PlatformBaseURL: "https://platform.example.cn",
			Random:          strings.NewReader(strings.Repeat("x", 32)),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	setup, err := service.CreateSetupCommand(
		context.Background(), testAccountID, testServerID, testComputerID, 4,
	)
	if err != nil {
		t.Fatal(err)
	}
	if setup.Generation != 3 || setup.Revision != 5 ||
		!setup.ExpiresAt.Equal(now.Add(15*time.Minute)) {
		t.Fatalf("setup = %#v", setup)
	}
	const commandPrefix = "curl -fsSL https://platform.example.cn/install | sh -s -- "
	if !strings.HasPrefix(setup.Command, commandPrefix) {
		t.Fatalf("setup command = %q", setup.Command)
	}
	displayCode := strings.TrimPrefix(setup.Command, commandPrefix)
	canonicalCode, err := normalizeSetupCode(displayCode)
	if err != nil {
		t.Fatalf("setup code = %q: %v", displayCode, err)
	}
	derivedSecret := deriveEnrollmentSecret(
		canonicalCode, testServerID, testComputerID, 3,
	)
	token, err := newEnrollmentToken(
		testServerID, testComputerID, 3, derivedSecret[:],
	)
	if err != nil {
		t.Fatal(err)
	}
	if repository.begin.Generation != 3 || repository.begin.ExpectedRevision != 4 ||
		repository.begin.Release != enrollmentRelease() ||
		repository.begin.TokenHash != sha256.Sum256([]byte(token)) {
		t.Fatalf("begin command = %#v", repository.begin)
	}
	if repository.setupCode.ID != setupCodeID ||
		repository.setupCode.CodeHash != setupCodeHash(canonicalCode) ||
		repository.setupCode.ServerID != testServerID ||
		repository.setupCode.ComputerID != testComputerID ||
		repository.setupCode.Generation != 3 ||
		!repository.setupCode.ExpiresAt.Equal(now.Add(15*time.Minute)) {
		t.Fatalf("setup code command = %#v", repository.setupCode)
	}
	for _, forbidden := range []string{
		"cen1", testServerID, testComputerID, "mktemp", "--token-file", "sudo",
	} {
		if strings.Contains(setup.Command, forbidden) {
			t.Fatalf("setup command leaks %q: %s", forbidden, setup.Command)
		}
	}
}

func TestEnrollmentServiceGeneratesExplicitHTTPInstallFlow(t *testing.T) {
	now := time.Date(2026, 8, 2, 4, 0, 0, 0, time.UTC)
	repository := &enrollmentRepository{computer: computerport.Computer{
		ID: testComputerID, ServerID: testServerID, Name: "内网 Mac",
		OSType: "macos", LifecycleState: "provisioning", Revision: 1,
	}}
	service, err := NewEnrollmentService(
		repository,
		&fixedIDs{values: []string{setupCodeID}},
		fixedClock{now: now},
		EnrollmentConfig{
			Release: enrollmentRelease(), TokenTTL: 15 * time.Minute,
			CredentialTTL:     365 * 24 * time.Hour,
			PlatformBaseURL:   "http://9.135.236.64/",
			AllowInsecureHTTP: true,
			Random:            strings.NewReader(strings.Repeat("x", 32)),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	setup, err := service.CreateSetupCommand(
		context.Background(), testAccountID, testServerID, testComputerID, 1,
	)
	if err != nil {
		t.Fatal(err)
	}
	const prefix = "curl -fsS http://9.135.236.64/install | sh -s -- "
	if !strings.HasPrefix(setup.Command, prefix) || strings.Contains(setup.Command, "-fsSL") {
		t.Fatalf("HTTP setup command = %q", setup.Command)
	}
	canonicalCode, err := normalizeSetupCode(strings.TrimPrefix(setup.Command, prefix))
	if err != nil {
		t.Fatal(err)
	}
	repository.setupCodeRoute = computerport.SetupCodeRoute{
		ServerID: testServerID, ComputerID: testComputerID,
		Generation: 1, ExpiresAt: now.Add(10 * time.Minute),
	}
	repository.redemption = computerport.SetupCodeRedemption{
		ServerID: testServerID, ComputerID: testComputerID,
		Generation: 1, ExpiresAt: now.Add(10 * time.Minute),
		Release: computerport.SetupCodeRelease{
			Version: "0.1.0", Target: "darwin-arm64",
			InstallerSHA256: enrollmentRelease().Installer.SHA256,
		},
	}
	redeemed, err := service.RedeemSetupCode(context.Background(), canonicalCode)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		`url = "http://9.135.236.64/v1/computer-artifacts/0.1.0/darwin-arm64/install.sh"`,
		`proto = "=http,https"`,
		`proto-redir = "=https"`,
		`--allow-insecure-platform-http`,
	} {
		if !strings.Contains(redeemed.Script, required) {
			t.Fatalf("HTTP setup script missing %q: %s", required, redeemed.Script)
		}
	}
}

func TestEnrollmentServiceRejectsUnapprovedOrNonOriginHTTPURL(t *testing.T) {
	base := EnrollmentConfig{
		Release: enrollmentRelease(), TokenTTL: time.Minute,
		CredentialTTL: time.Hour, Random: strings.NewReader(strings.Repeat("z", 32)),
	}
	for _, mutate := range []func(*EnrollmentConfig){
		func(config *EnrollmentConfig) { config.PlatformBaseURL = "http://9.135.236.64" },
		func(config *EnrollmentConfig) {
			config.PlatformBaseURL = "https://platform.example.cn/v1"
		},
		func(config *EnrollmentConfig) {
			config.PlatformBaseURL = "https://platform.example.cn"
			config.AllowInsecureHTTP = true
		},
	} {
		config := base
		mutate(&config)
		if service, err := NewEnrollmentService(
			&enrollmentRepository{}, &fixedIDs{}, fixedClock{now: time.Now()}, config,
		); err == nil || service != nil {
			t.Fatalf("NewEnrollmentService() accepted config %#v", config)
		}
	}
}

func TestEnrollmentServiceRedeemsSetupCodeWithoutPassingPlaintextToRepository(t *testing.T) {
	now := time.Date(2026, 8, 2, 2, 15, 0, 0, time.UTC)
	const displayCode = "60RK-4CSM-6MV3-EE1S"
	const canonicalCode = "60RK4CSM6MV3EE1S"
	repository := &enrollmentRepository{
		setupCodeRoute: computerport.SetupCodeRoute{
			ServerID: testServerID, ComputerID: testComputerID,
			Generation: 3, ExpiresAt: now.Add(10 * time.Minute),
		},
		redemption: computerport.SetupCodeRedemption{
			ServerID: testServerID, ComputerID: testComputerID,
			Generation: 3, ExpiresAt: now.Add(10 * time.Minute),
			Release: computerport.SetupCodeRelease{
				Version: "0.1.0", Target: "darwin-arm64",
				InstallerSHA256: enrollmentRelease().Installer.SHA256,
			},
		},
	}
	service, err := NewEnrollmentService(
		repository,
		&fixedIDs{},
		fixedClock{now: now},
		EnrollmentConfig{
			Release: enrollmentRelease(), TokenTTL: 15 * time.Minute,
			CredentialTTL:   365 * 24 * time.Hour,
			PlatformBaseURL: "https://platform.example.cn",
			Random:          strings.NewReader(strings.Repeat("x", 32)),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.RedeemSetupCode(context.Background(), displayCode)
	if err != nil {
		t.Fatal(err)
	}
	if repository.resolveCode.CodeHash != setupCodeHash(canonicalCode) ||
		!repository.resolveCode.RequestedAt.Equal(now) {
		t.Fatalf("resolve command = %#v", repository.resolveCode)
	}
	secret := deriveEnrollmentSecret(canonicalCode, testServerID, testComputerID, 3)
	token, err := newEnrollmentToken(testServerID, testComputerID, 3, secret[:])
	if err != nil {
		t.Fatal(err)
	}
	if repository.validateCode.ServerID != testServerID ||
		repository.validateCode.ComputerID != testComputerID ||
		repository.validateCode.Generation != 3 ||
		repository.validateCode.TokenHash != sha256.Sum256([]byte(token)) ||
		!repository.validateCode.RequestedAt.Equal(now) {
		t.Fatalf("validate command = %#v", repository.validateCode)
	}
	if !result.ExpiresAt.Equal(now.Add(10*time.Minute)) ||
		!strings.Contains(result.Script, token) ||
		!strings.Contains(result.Script, "/v1/computer-artifacts/0.1.0/darwin-arm64/install.sh") ||
		!strings.Contains(result.Script, "--token-file") ||
		strings.Contains(result.Script, displayCode) ||
		strings.Contains(result.Script, canonicalCode) {
		t.Fatalf("redeemed script = %q", result.Script)
	}
}

func TestEnrollmentServiceClaimsIdempotentlyWithoutOwningSecret(t *testing.T) {
	now := time.Date(2026, 8, 2, 2, 30, 0, 0, time.UTC)
	secret := make([]byte, 32)
	for index := range secret {
		secret[index] = byte(255 - index)
	}
	token, err := newEnrollmentToken(testServerID, testComputerID, 9, secret)
	if err != nil {
		t.Fatal(err)
	}
	credentialDigest := sha256.Sum256([]byte("base64url-client-secret"))
	repository := &enrollmentRepository{result: computerport.EnrollmentClaim{
		ServerID: testServerID, ComputerID: testComputerID,
		CredentialID: enrollmentCredentialID, CredentialVersion: 2,
		ExpiresAt: now.Add(365 * 24 * time.Hour), Created: true,
	}}
	service, err := NewEnrollmentService(
		repository,
		&fixedIDs{values: []string{enrollmentCredentialID}},
		fixedClock{now: now},
		EnrollmentConfig{
			Release: enrollmentRelease(), TokenTTL: 15 * time.Minute,
			CredentialTTL:   365 * 24 * time.Hour,
			PlatformBaseURL: "https://platform.example.cn",
			Random:          strings.NewReader(strings.Repeat("z", 32)),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	claim, err := service.Claim(context.Background(), ClaimCommand{
		Token: token, OSType: "macos", Architecture: "arm64",
		InstallerVersion: "0.1.0", CredentialDigest: credentialDigest,
	})
	if err != nil {
		t.Fatal(err)
	}
	if claim.CredentialVersion != 2 || claim.ServerID != testServerID ||
		repository.claim.Generation != 9 ||
		repository.claim.TokenHash != sha256.Sum256([]byte(token)) ||
		repository.claim.CredentialDigest != credentialDigest {
		t.Fatalf("claim=%#v command=%#v", claim, repository.claim)
	}
	if repository.claim.CredentialExpiresAt != now.Add(365*24*time.Hour) {
		t.Fatalf("credential expires = %v", repository.claim.CredentialExpiresAt)
	}
}

func TestEnrollmentServiceMapsClaimConflict(t *testing.T) {
	secret := strings.Repeat("y", 32)
	token, err := newEnrollmentToken(testServerID, testComputerID, 1, []byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	repository := &enrollmentRepository{err: computerport.ErrEnrollmentClaimConflict}
	service, err := NewEnrollmentService(
		repository,
		&fixedIDs{values: []string{enrollmentCredentialID}},
		fixedClock{now: time.Now()},
		EnrollmentConfig{
			Release: enrollmentRelease(), TokenTTL: time.Minute,
			CredentialTTL: time.Hour, PlatformBaseURL: "https://platform.example.cn",
			Random: strings.NewReader(strings.Repeat("z", 32)),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Claim(context.Background(), ClaimCommand{
		Token: token, OSType: "macos", Architecture: "arm64",
		InstallerVersion: "0.1.0",
		CredentialDigest: sha256.Sum256([]byte("other")),
	})
	if err == nil || !errors.Is(err, computerport.ErrEnrollmentClaimConflict) {
		t.Fatalf("Claim() error = %v", err)
	}
}

func TestEnrollmentServiceReturnsFixedInstallationOptions(t *testing.T) {
	service, err := NewEnrollmentService(
		&enrollmentRepository{},
		&fixedIDs{values: []string{enrollmentCredentialID}},
		fixedClock{now: time.Now()},
		EnrollmentConfig{
			Release: enrollmentRelease(), TokenTTL: time.Minute,
			CredentialTTL: time.Hour, PlatformBaseURL: "https://platform.example.cn",
			Random: strings.NewReader(strings.Repeat("z", 32)),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	options := service.InstallationOptions()
	if options.ReleaseVersion != "0.1.0" || len(options.Platforms) != 1 ||
		options.Platforms[0].OSType != "macos" ||
		len(options.Platforms[0].Architectures) != 1 ||
		options.Platforms[0].Architectures[0] != "arm64" {
		t.Fatalf("InstallationOptions() = %#v", options)
	}
}

func TestArtifactServiceUsesBoundObjectAndCapsSignedURLTTL(t *testing.T) {
	now := time.Date(2026, 8, 2, 3, 0, 0, 0, time.UTC)
	secret := []byte(strings.Repeat("a", 32))
	token, err := newEnrollmentToken(testServerID, testComputerID, 5, secret)
	if err != nil {
		t.Fatal(err)
	}
	repository := &enrollmentRepository{artifact: computerport.ArtifactAccess{
		ObjectKey: "computer/releases/0.1.0/darwin-arm64/install.sh",
		ExpiresAt: now.Add(10 * time.Minute),
	}}
	signer := &artifactSigner{url: "https://private.example.cn/object?signature=secret"}
	service, err := NewArtifactService(repository, signer, fixedClock{now: now}, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Resolve(
		context.Background(), token, "0.1.0", "darwin-arm64", "install.sh",
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.URL != signer.url || signer.ttl != 5*time.Minute ||
		signer.objectKey != repository.artifact.ObjectKey {
		t.Fatalf("Resolve() = %#v signer=%#v", result, signer)
	}
	if repository.artifactCommand.ServerID != testServerID ||
		repository.artifactCommand.ComputerID != testComputerID ||
		repository.artifactCommand.Generation != 5 ||
		repository.artifactCommand.TokenHash != sha256.Sum256([]byte(token)) {
		t.Fatalf("artifact command = %#v", repository.artifactCommand)
	}
}
