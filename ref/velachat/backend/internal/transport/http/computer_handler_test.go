package httptransport

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	appcomputer "chatserver/internal/app/computermanagement"
	computerport "chatserver/internal/ports/computer"
	tencenttatport "chatserver/internal/ports/tencenttat"

	"github.com/google/uuid"
)

const handlerComputerID = "0198f4c2-7a35-7af3-a01e-0fcb31e9d84c"

type fakeComputerService struct {
	createCommand  appcomputer.CreateCommand
	releaseCommand appcomputer.ReleaseCommand
	refreshCommand appcomputer.RefreshCommand
	computers      []computerport.Computer
	operation      computerport.Operation
	registration   appcomputer.RegistrationMaterial
	terminal       tencenttatport.TerminalSession
}

func (service *fakeComputerService) Release(
	_ context.Context,
	command appcomputer.ReleaseCommand,
) error {
	service.releaseCommand = command
	return nil
}

type fakeComputerCredentialService struct {
	accountID      string
	serverID       string
	computerID     string
	mode           string
	idempotencyKey string
	credential     appcomputer.RuntimeCredential
}

type fakeComputerEnrollmentService struct {
	accountID        string
	serverID         string
	computerID       string
	expectedRevision int64
	claim            appcomputer.ClaimCommand
	preflight        appcomputer.PreflightCommand
	preflightResult  appcomputer.PreflightResult
	redeemedCode     string
	redeemedTarget   string
	script           appcomputer.SetupCodeScript
	setup            appcomputer.SetupCommand
	claimResult      appcomputer.ClaimResult
}

func (service *fakeComputerEnrollmentService) InstallationOptions() appcomputer.InstallationOptions {
	return appcomputer.InstallationOptions{
		ReleaseVersion: "0.1.0",
		Platforms: []appcomputer.InstallationPlatform{
			{OSType: "macos", Architectures: []string{"arm64"}},
			{OSType: "linux", Architectures: []string{"amd64"}},
		},
	}
}

func (service *fakeComputerEnrollmentService) CreateSetupCommand(
	_ context.Context,
	accountID string,
	serverID string,
	computerID string,
	expectedRevision int64,
) (appcomputer.SetupCommand, error) {
	service.accountID = accountID
	service.serverID = serverID
	service.computerID = computerID
	service.expectedRevision = expectedRevision
	return service.setup, nil
}

func (service *fakeComputerEnrollmentService) Claim(
	_ context.Context,
	command appcomputer.ClaimCommand,
) (appcomputer.ClaimResult, error) {
	service.claim = command
	return service.claimResult, nil
}

func (service *fakeComputerEnrollmentService) Preflight(
	_ context.Context,
	command appcomputer.PreflightCommand,
) (appcomputer.PreflightResult, error) {
	service.preflight = command
	return service.preflightResult, nil
}

func (service *fakeComputerEnrollmentService) RedeemSetupCode(
	_ context.Context,
	code string,
	target string,
) (appcomputer.SetupCodeScript, error) {
	service.redeemedCode = code
	service.redeemedTarget = target
	return service.script, nil
}

type fakeComputerArtifactService struct {
	token   string
	version string
	target  string
	file    string
	result  appcomputer.ArtifactRedirect
}

func (service *fakeComputerArtifactService) Resolve(
	_ context.Context,
	token string,
	version string,
	target string,
	file string,
) (appcomputer.ArtifactRedirect, error) {
	service.token = token
	service.version = version
	service.target = target
	service.file = file
	return service.result, nil
}

func (service *fakeComputerCredentialService) Issue(
	_ context.Context,
	accountID string,
	serverID string,
	computerID string,
	mode string,
	idempotencyKey string,
) (appcomputer.RuntimeCredential, error) {
	service.accountID = accountID
	service.serverID = serverID
	service.computerID = computerID
	service.mode = mode
	service.idempotencyKey = idempotencyKey
	return service.credential, nil
}

func (service *fakeComputerService) CreateTerminalSession(
	context.Context,
	string,
	string,
	string,
) (tencenttatport.TerminalSession, error) {
	return service.terminal, nil
}

func (service *fakeComputerService) Create(
	_ context.Context,
	command appcomputer.CreateCommand,
) (computerport.Computer, error) {
	service.createCommand = command
	return service.computers[0], nil
}

func (service *fakeComputerService) List(
	context.Context,
	string,
	string,
) ([]computerport.Computer, error) {
	return service.computers, nil
}

func (service *fakeComputerService) Get(
	context.Context,
	string,
	string,
	string,
) (computerport.Computer, error) {
	return service.computers[0], nil
}

func (service *fakeComputerService) Refresh(
	_ context.Context,
	command appcomputer.RefreshCommand,
) (computerport.Operation, error) {
	service.refreshCommand = command
	return service.operation, nil
}

func (service *fakeComputerService) CreateRegistration(
	context.Context,
	string,
	string,
	string,
) (appcomputer.RegistrationMaterial, error) {
	return service.registration, nil
}

func TestComputerHandlerMapsCreateListGetRefreshAndRegistration(t *testing.T) {
	now := time.Date(2026, 7, 30, 23, 0, 0, 0, time.UTC)
	instanceID := "ins-test0001"
	value := computerport.Computer{
		ID: handlerComputerID, ServerID: handlerServerID,
		Name: "北京执行机", TATRegion: "ap-beijing",
		TATInstanceID: &instanceID, TATInstanceKind: "cvm",
		OSType: "linux", LifecycleState: "active",
		TATAgentState: "online", LastObservedAt: &now, Revision: 2,
	}
	service := &fakeComputerService{
		computers: []computerport.Computer{value},
		operation: computerport.Operation{
			ID: handlerOperationID, ServerID: handlerServerID,
			Service: "tat", Kind: "tat.computer.refresh",
			State: "pending", CreatedAt: now,
		},
		registration: appcomputer.RegistrationMaterial{
			ComputerID:        handlerComputerID,
			Protocol:          "tencent-tat-register-v1",
			Region:            "ap-beijing",
			RegisterCodeID:    "register-code-id",
			RegisterCodeValue: "register-code-value",
			Tags: []appcomputer.RegistrationTag{{
				Key:   "agent-network-computer-id",
				Value: handlerComputerID,
			}},
			ExpiresAt: now.Add(time.Hour),
		},
		terminal: tencenttatport.TerminalSession{
			SessionID:    "terminal-test",
			WebSocketURL: "wss://terminal.example.test/connect",
			ExpiresAt:    now.Add(5 * time.Minute),
			OwnerUIN:     "100000000001", AppID: 1250000000,
			InstanceID: "ins-test0001", Cols: 120, Rows: 32,
			MaxIdleSeconds: 3600,
		},
	}
	credentialID := "0198f4c2-7a35-7af3-a01e-0fcb31e9d850"
	credentialService := &fakeComputerCredentialService{
		credential: appcomputer.RuntimeCredential{
			ID: credentialID, Version: 2,
			Secret:    "crc_server.computer.2.secret",
			ExpiresAt: now.Add(365 * 24 * time.Hour),
		},
	}
	handler, err := NewComputerHandler(service, credentialService)
	if err != nil {
		t.Fatal(err)
	}
	linux := openapi.CreateComputerRequestOsType("linux")
	body := openapi.CreateComputerJSONRequestBody{Name: "北京执行机", OsType: &linux}
	createdResponse, err := handler.CreateComputer(
		currentHumanContext(t),
		openapi.CreateComputerRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			Params: openapi.CreateComputerParams{
				IdempotencyKey: "computer-create-0001",
			},
			Body: &body,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	created, ok := createdResponse.(openapi.CreateComputer201JSONResponse)
	if !ok || created.Id.String() != handlerComputerID ||
		service.createCommand.AccountID != handlerAccountID ||
		service.createCommand.TATInstanceID != nil ||
		service.createCommand.TATInstanceKind != "managed" ||
		service.createCommand.OSType != "linux" {
		t.Fatalf("CreateComputer() = %#v command=%#v", createdResponse, service.createCommand)
	}
	listResponse, err := handler.ListComputers(
		currentHumanContext(t),
		openapi.ListComputersRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	list, ok := listResponse.(openapi.ListComputers200JSONResponse)
	if !ok || len(list) != 1 || list[0].Id.String() != handlerComputerID {
		t.Fatalf("ListComputers() = %#v", listResponse)
	}
	getResponse, err := handler.GetComputer(
		currentHumanContext(t),
		openapi.GetComputerRequestObject{
			ServerId:   uuid.MustParse(handlerServerID),
			ComputerId: uuid.MustParse(handlerComputerID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := getResponse.(openapi.GetComputer200JSONResponse); !ok ||
		got.ConnectionState != openapi.ComputerConnectionStateOnline {
		t.Fatalf("GetComputer() = %#v", getResponse)
	}
	removeResponse, err := handler.RemoveComputer(
		currentHumanContext(t),
		openapi.RemoveComputerRequestObject{
			ServerId:   uuid.MustParse(handlerServerID),
			ComputerId: uuid.MustParse(handlerComputerID),
			Params: openapi.RemoveComputerParams{
				IdempotencyKey: "computer-remove-0001",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := removeResponse.(openapi.RemoveComputer204Response); !ok ||
		service.releaseCommand.AccountID != handlerAccountID ||
		service.releaseCommand.ServerID != handlerServerID ||
		service.releaseCommand.ComputerID != handlerComputerID ||
		service.releaseCommand.IdempotencyKey != "computer-remove-0001" {
		t.Fatalf("RemoveComputer() = %#v command=%#v", removeResponse, service.releaseCommand)
	}
	refreshResponse, err := handler.RefreshComputer(
		currentHumanContext(t),
		openapi.RefreshComputerRequestObject{
			ServerId:   uuid.MustParse(handlerServerID),
			ComputerId: uuid.MustParse(handlerComputerID),
			Params: openapi.RefreshComputerParams{
				IdempotencyKey: "computer-refresh-0001",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed, ok := refreshResponse.(openapi.RefreshComputer202JSONResponse); !ok ||
		refreshed.Id.String() != handlerOperationID ||
		service.refreshCommand.ComputerID != handlerComputerID {
		t.Fatalf("RefreshComputer() = %#v", refreshResponse)
	}
	terminalResponse, err := handler.CreateTerminalSession(
		currentHumanContext(t),
		openapi.CreateTerminalSessionRequestObject{
			ServerId:   uuid.MustParse(handlerServerID),
			ComputerId: uuid.MustParse(handlerComputerID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	terminal, ok := terminalResponse.(openapi.CreateTerminalSession201JSONResponse)
	if !ok ||
		terminal.Headers.CacheControl != "no-store" ||
		terminal.Headers.Pragma != "no-cache" ||
		terminal.Body.Protocol != "tencent-tat-pty-v1" ||
		terminal.Body.WebSocketUrl == nil ||
		*terminal.Body.WebSocketUrl != "wss://terminal.example.test/connect" ||
		terminal.Body.Authentication.Uin != "100000000001" ||
		terminal.Body.Authentication.InstanceId != "ins-test0001" ||
		terminal.Body.Terminal.Cols != 120 {
		t.Fatalf("terminal response = %#v", terminalResponse)
	}

	credentialResponse, err := handler.CreateComputerRuntimeCredential(
		currentHumanContext(t),
		openapi.CreateComputerRuntimeCredentialRequestObject{
			ServerId:   uuid.MustParse(handlerServerID),
			ComputerId: uuid.MustParse(handlerComputerID),
			Params: openapi.CreateComputerRuntimeCredentialParams{
				IdempotencyKey: "computer-credential-0001",
			},
			Body: &openapi.ComputerRuntimeCredentialRequest{
				Mode: openapi.Bootstrap,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	credential, ok := credentialResponse.(openapi.CreateComputerRuntimeCredential201JSONResponse)
	if !ok || credential.Headers.CacheControl != "no-store" ||
		credential.Headers.Pragma != "no-cache" ||
		credential.Body.CredentialId.String() != credentialID ||
		credential.Body.Version != 2 || credential.Body.Secret == nil ||
		*credential.Body.Secret != "crc_server.computer.2.secret" ||
		credentialService.accountID != handlerAccountID ||
		credentialService.serverID != handlerServerID ||
		credentialService.computerID != handlerComputerID ||
		credentialService.mode != "bootstrap" ||
		credentialService.idempotencyKey != "computer-credential-0001" {
		t.Fatalf(
			"credential response = %#v service=%#v",
			credentialResponse,
			credentialService,
		)
	}
}

func TestComputerEnrollmentHandlerMapsSetupClaimAndArtifactWithoutCaching(t *testing.T) {
	now := time.Date(2026, 8, 2, 4, 0, 0, 0, time.UTC)
	enrollment := &fakeComputerEnrollmentService{
		setup: appcomputer.SetupCommand{
			ComputerID: handlerComputerID, Generation: 2,
			Command: "safe setup command", ExpiresAt: now.Add(15 * time.Minute), Revision: 4,
		},
		claimResult: appcomputer.ClaimResult{
			ServerID: handlerServerID, ComputerID: handlerComputerID,
			CredentialID:      "0198f4c2-7a37-7af3-a01e-0fcb31e9d84e",
			CredentialVersion: 1, ExpiresAt: now.Add(365 * 24 * time.Hour),
		},
		script: appcomputer.SetupCodeScript{
			Script: "verified second stage", ExpiresAt: now.Add(15 * time.Minute),
		},
	}
	artifact := &fakeComputerArtifactService{result: appcomputer.ArtifactRedirect{
		URL:       "https://private.example.cn/object?signature=secret",
		ExpiresAt: now.Add(5 * time.Minute),
	}}
	handler, err := NewComputerEnrollmentHandler(enrollment, artifact)
	if err != nil {
		t.Fatal(err)
	}
	optionsResponse, err := handler.GetComputerInstallationOptions(
		currentHumanContext(t), openapi.GetComputerInstallationOptionsRequestObject{},
	)
	options, ok := optionsResponse.(openapi.GetComputerInstallationOptions200JSONResponse)
	if err != nil || !ok || options.ReleaseVersion != "0.1.0" || len(options.Platforms) != 1 {
		t.Fatalf("GetComputerInstallationOptions() = (%#v, %v)", optionsResponse, err)
	}
	targetsResponse, err := handler.GetComputerInstallationTargets(
		currentHumanContext(t), openapi.GetComputerInstallationTargetsRequestObject{},
	)
	targets, ok := targetsResponse.(openapi.GetComputerInstallationTargets200JSONResponse)
	if err != nil || !ok || targets.ReleaseVersion != "0.1.0" || len(targets.Targets) != 2 ||
		targets.Targets[1].Target != "linux-amd64" {
		t.Fatalf("GetComputerInstallationTargets() = (%#v, %v)", targetsResponse, err)
	}
	setupResponse, err := handler.CreateComputerSetupCommand(
		currentHumanContext(t),
		openapi.CreateComputerSetupCommandRequestObject{
			ServerId:   uuid.MustParse(handlerServerID),
			ComputerId: uuid.MustParse(handlerComputerID),
			Params:     openapi.CreateComputerSetupCommandParams{XResourceRevision: 3},
		},
	)
	setup, ok := setupResponse.(openapi.CreateComputerSetupCommand201JSONResponse)
	if err != nil || !ok || setup.Body.Command == nil || *setup.Body.Command != "safe setup command" ||
		setup.Headers.CacheControl != "no-store" || setup.Headers.Pragma != "no-cache" ||
		enrollment.accountID != handlerAccountID || enrollment.expectedRevision != 3 {
		t.Fatalf("CreateComputerSetupCommand() = (%#v, %v) service=%#v", setupResponse, err, enrollment)
	}
	shortCode := openapi.RedeemComputerSetupCodeTextRequestBody("60RK-4CSM-6MV3-EE1S")
	linuxTarget := openapi.RedeemComputerSetupCodeParamsXVelaComputerTarget("linux-amd64")
	redeemResponse, err := handler.RedeemComputerSetupCode(
		context.Background(),
		openapi.RedeemComputerSetupCodeRequestObject{
			Params: openapi.RedeemComputerSetupCodeParams{XVelaComputerTarget: &linuxTarget},
			Body:   &shortCode,
		},
	)
	redeemed, ok := redeemResponse.(openapi.RedeemComputerSetupCode200TextResponse)
	if err != nil || !ok || redeemed.Body != "verified second stage" ||
		redeemed.Headers.CacheControl != "no-store" ||
		redeemed.Headers.Pragma != "no-cache" ||
		enrollment.redeemedCode != string(shortCode) || enrollment.redeemedTarget != "linux-amd64" {
		t.Fatalf("RedeemComputerSetupCode() = (%#v, %v)", redeemResponse, err)
	}
	const token = "cen1." + handlerServerID + "." + handlerComputerID +
		".2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	digest := sha256.Sum256([]byte("client secret"))
	digestHex := hex.EncodeToString(digest[:])
	claimResponse, err := handler.ClaimComputerEnrollment(
		currentEnrollmentContext(t, token),
		openapi.ClaimComputerEnrollmentRequestObject{Body: &openapi.ComputerEnrollmentClaimRequest{
			OsType: "macos", Architecture: "arm64", InstallerVersion: "0.1.0",
			CredentialDigest: &digestHex,
		}},
	)
	claim, ok := claimResponse.(openapi.ClaimComputerEnrollment201JSONResponse)
	if err != nil || !ok || claim.Body.CredentialVersion != 1 ||
		claim.Headers.CacheControl != "no-store" || claim.Headers.Pragma != "no-cache" ||
		enrollment.claim.Token != token || enrollment.claim.CredentialDigest != digest {
		t.Fatalf("ClaimComputerEnrollment() = (%#v, %v) command=%#v", claimResponse, err, enrollment.claim)
	}
	artifactResponse, err := handler.GetComputerArtifact(
		currentEnrollmentContext(t, token),
		openapi.GetComputerArtifactRequestObject{
			Version: "0.1.0", Target: "darwin-arm64", File: "install.sh",
		},
	)
	redirect, ok := artifactResponse.(openapi.GetComputerArtifact307Response)
	if err != nil || !ok || redirect.Headers.Location != artifact.result.URL ||
		redirect.Headers.CacheControl != "no-store" || redirect.Headers.Pragma != "no-cache" ||
		artifact.token != token {
		t.Fatalf("GetComputerArtifact() = (%#v, %v) service=%#v", artifactResponse, err, artifact)
	}
}

func TestComputerEnrollmentHandlerReturnsRemovedPreflightWithoutCurrentPrincipal(t *testing.T) {
	enrollment := &fakeComputerEnrollmentService{preflightResult: appcomputer.PreflightResult{
		Status: "removed", ReplacementGrant: "rpg1.signed.replacement",
	}}
	handler, err := NewComputerEnrollmentHandler(
		enrollment,
		&fakeComputerArtifactService{},
	)
	if err != nil {
		t.Fatal(err)
	}
	const credential = "crc_" + handlerServerID + "." + handlerComputerID +
		".3.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	state := &AuthState{}
	if err := state.setComputerPreflightCredential(credential); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), authStateContextKey{}, state)
	ctx = context.WithValue(ctx, requestIDContextKey{}, handlerComputerID)
	var body openapi.ComputerPreflightRequest
	if err := json.Unmarshal([]byte(`{"replacement":{"enrollmentToken":"cen1.new","tatRegion":"ap-beijing","tatInstanceId":"rins-old"}}`), &body); err != nil {
		t.Fatal(err)
	}
	response, err := handler.PreflightComputer(
		ctx,
		openapi.PreflightComputerRequestObject{Body: &body},
	)
	removed, ok := response.(openapi.PreflightComputer410JSONResponse)
	if err != nil || !ok || removed.Body.Error.Code != openapi.ComputerRemoved ||
		removed.Body.Error.RequestId.String() != handlerComputerID ||
		removed.Body.Error.ReplacementGrant == nil ||
		*removed.Body.Error.ReplacementGrant != "rpg1.signed.replacement" ||
		removed.Headers.CacheControl != "no-store" || removed.Headers.Pragma != "no-cache" ||
		enrollment.preflight.Credential != credential || enrollment.preflight.Replacement == nil ||
		enrollment.preflight.Replacement.EnrollmentToken != "cen1.new" ||
		enrollment.preflight.Replacement.TATInstanceID != "rins-old" {
		t.Fatalf("PreflightComputer() = (%#v, %v), command=%#v", response, err, enrollment.preflight)
	}
}

func currentEnrollmentContext(t *testing.T, token string) context.Context {
	t.Helper()
	state := &AuthState{}
	if err := state.setEnrollmentToken(token); err != nil {
		t.Fatal(err)
	}
	return context.WithValue(context.Background(), authStateContextKey{}, state)
}
