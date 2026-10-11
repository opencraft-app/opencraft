package computermanagement

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/apperror"
	computerport "chatserver/internal/ports/computer"
	tencenttatport "chatserver/internal/ports/tencenttat"
)

const (
	testAccountID  = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	testServerID   = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	testComputerID = "0198f4c2-7a35-7af3-a01e-0fcb31e9d84c"
	testOperation  = "0198f4c2-7a36-7af3-a01e-0fcb31e9d84d"
)

type fixedIDs struct {
	values []string
	index  int
}

func (ids *fixedIDs) New() (string, error) {
	value := ids.values[ids.index]
	ids.index++
	return value, nil
}

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

type fakeRepository struct {
	createCommand   computerport.CreateCommand
	releaseCommand  computerport.ReleaseCommand
	releaseErr      error
	refreshCommand  computerport.RefreshCommand
	registerCommand computerport.RegistrationCommand
	computers       []computerport.Computer
	adminErr        error
}

func (repository *fakeRepository) Release(
	_ context.Context,
	command computerport.ReleaseCommand,
) error {
	repository.releaseCommand = command
	return repository.releaseErr
}

func (repository *fakeRepository) BeginRegistration(
	_ context.Context,
	command computerport.RegistrationCommand,
) (computerport.Operation, error) {
	repository.registerCommand = command
	return computerport.Operation{
		ID:        command.OperationID,
		ServerID:  command.ServerID,
		Service:   "tat",
		Kind:      "tat.computer.registration.reconcile",
		State:     "pending",
		CreatedAt: command.CreatedAt,
	}, nil
}

func (repository *fakeRepository) Create(
	_ context.Context,
	command computerport.CreateCommand,
) (computerport.Computer, error) {
	repository.createCommand = command
	return computerport.Computer{
		ID:              command.Computer.ID,
		ServerID:        command.ServerID,
		Name:            command.Computer.Name,
		TATRegion:       command.Computer.TATRegion,
		TATInstanceID:   command.Computer.TATInstanceID,
		TATInstanceKind: command.Computer.TATInstanceKind,
		OSType:          command.Computer.OSType,
		LifecycleState:  command.Computer.LifecycleState,
		TATAgentState:   "unknown",
		Revision:        1,
	}, nil
}

func (repository *fakeRepository) List(
	context.Context,
	string,
	string,
) ([]computerport.Computer, error) {
	return repository.computers, nil
}

func (repository *fakeRepository) Get(
	context.Context,
	string,
	string,
	string,
) (computerport.Computer, error) {
	return repository.computers[0], nil
}

func (repository *fakeRepository) GetForAdmin(
	context.Context,
	string,
	string,
	string,
) (computerport.Computer, error) {
	if repository.adminErr != nil {
		return computerport.Computer{}, repository.adminErr
	}
	return repository.computers[0], nil
}

func (repository *fakeRepository) EnqueueRefresh(
	_ context.Context,
	command computerport.RefreshCommand,
) (computerport.Operation, error) {
	repository.refreshCommand = command
	return computerport.Operation{
		ID:        command.OperationID,
		ServerID:  command.ServerID,
		Service:   "tat",
		Kind:      "tat.computer.refresh",
		State:     "pending",
		CreatedAt: command.CreatedAt,
	}, nil
}

type fakeRegistrar struct {
	request tencenttatport.RegistrationRequest
	result  tencenttatport.Registration
}

type fakeTerminalIssuer struct {
	target tencenttatport.TerminalTarget
	result tencenttatport.TerminalSession
	err    error
}

type fakeTATError struct{ code string }

func (failure fakeTATError) Error() string   { return "provider detail" }
func (failure fakeTATError) TATCode() string { return failure.code }
func (fakeTATError) Retryable() bool         { return true }
func (fakeTATError) Uncertain() bool         { return false }

func (issuer *fakeTerminalIssuer) Issue(
	_ context.Context,
	target tencenttatport.TerminalTarget,
) (tencenttatport.TerminalSession, error) {
	issuer.target = target
	return issuer.result, issuer.err
}

func (registrar *fakeRegistrar) CreateRegistration(
	_ context.Context,
	request tencenttatport.RegistrationRequest,
) (tencenttatport.Registration, error) {
	registrar.request = request
	return registrar.result, nil
}

func TestServiceCreatesNativeAndManagedComputers(t *testing.T) {
	now := time.Date(2026, 7, 30, 22, 0, 0, 0, time.UTC)
	repository := &fakeRepository{}
	service, err := NewService(
		repository,
		&fakeRegistrar{},
		&fakeTerminalIssuer{},
		&fixedIDs{values: []string{testComputerID}},
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}

	native, err := service.Create(context.Background(), CreateCommand{
		AccountID:       testAccountID,
		ServerID:        testServerID,
		IdempotencyKey:  "computer-create-0001",
		Name:            "北京执行机",
		TATRegion:       "ap-beijing",
		TATInstanceID:   stringPointer("ins-test0001"),
		TATInstanceKind: "cvm",
		OSType:          "linux",
	})
	if err != nil {
		t.Fatal(err)
	}
	if native.ID != testComputerID ||
		repository.createCommand.Computer.LifecycleState != "active" {
		t.Fatalf("Create(native) = %#v, command=%#v", native, repository.createCommand)
	}

	repository = &fakeRepository{}
	service, err = NewService(
		repository,
		&fakeRegistrar{},
		&fakeTerminalIssuer{},
		&fixedIDs{values: []string{testComputerID}},
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}
	managed, err := service.Create(context.Background(), CreateCommand{
		AccountID:       testAccountID,
		ServerID:        testServerID,
		IdempotencyKey:  "computer-create-0002",
		Name:            "外部执行机",
		TATRegion:       "ap-beijing",
		TATInstanceKind: "managed",
		OSType:          "windows",
	})
	if err != nil {
		t.Fatal(err)
	}
	if managed.ID != testComputerID ||
		repository.createCommand.Computer.LifecycleState != "provisioning" ||
		repository.createCommand.Computer.TATInstanceID != nil {
		t.Fatalf("Create(managed) = %#v, command=%#v", managed, repository.createCommand)
	}
}

func TestServiceReleasesComputerWithValidatedIdentityAndClock(t *testing.T) {
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	repository := &fakeRepository{}
	service, err := NewService(
		repository,
		&fakeRegistrar{},
		&fakeTerminalIssuer{},
		&fixedIDs{},
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}
	err = service.Release(context.Background(), ReleaseCommand{
		AccountID: testAccountID, ServerID: testServerID,
		ComputerID: testComputerID, IdempotencyKey: "computer-release-0001",
	})
	if err != nil {
		t.Fatal(err)
	}
	command := repository.releaseCommand
	if command.AccountID != testAccountID || command.ServerID != testServerID ||
		command.ComputerID != testComputerID ||
		command.IdempotencyKey != "computer-release-0001" ||
		!command.ReleasedAt.Equal(now) {
		t.Fatalf("Release command = %#v", command)
	}
}

func TestServiceMapsBoundAgentReleaseConflict(t *testing.T) {
	repository := &fakeRepository{releaseErr: computerport.ErrComputerHasBoundAgents}
	service, err := NewService(
		repository,
		&fakeRegistrar{},
		&fakeTerminalIssuer{},
		&fixedIDs{},
		fixedClock{now: time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)},
	)
	if err != nil {
		t.Fatal(err)
	}
	err = service.Release(context.Background(), ReleaseCommand{
		AccountID: testAccountID, ServerID: testServerID,
		ComputerID: testComputerID, IdempotencyKey: "computer-release-bound",
	})
	if apperror.CodeOf(err) != "computer_has_bound_agents" {
		t.Fatalf("Release(bound) error = %v code=%q", err, apperror.CodeOf(err))
	}
}

func TestServiceSelectsManagedRegionFromServerConfig(t *testing.T) {
	now := time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC)
	repository := &fakeRepository{}
	service, err := NewService(
		repository,
		&fakeRegistrar{},
		&fakeTerminalIssuer{},
		&fixedIDs{values: []string{testComputerID}},
		fixedClock{now: now},
		Config{ManagedTATRegion: "ap-beijing"},
	)
	if err != nil {
		t.Fatal(err)
	}

	managed, err := service.Create(context.Background(), CreateCommand{
		AccountID:       testAccountID,
		ServerID:        testServerID,
		IdempotencyKey:  "computer-create-managed-region",
		Name:            "后台选区托管机",
		TATInstanceKind: "managed",
		OSType:          "linux",
	})
	if err != nil {
		t.Fatal(err)
	}
	if managed.TATRegion != "ap-beijing" ||
		repository.createCommand.Computer.TATRegion != "ap-beijing" {
		t.Fatalf("managed region = %#v", managed)
	}
}

func TestServiceRejectsInvalidComputerShape(t *testing.T) {
	service, err := NewService(
		&fakeRepository{},
		&fakeRegistrar{},
		&fakeTerminalIssuer{},
		&fixedIDs{values: []string{testComputerID}},
		fixedClock{now: time.Now()},
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range []CreateCommand{
		{
			AccountID: testAccountID, ServerID: testServerID,
			IdempotencyKey: "x", Name: "缺实例",
			TATRegion: "ap-beijing", TATInstanceKind: "cvm", OSType: "linux",
		},
		{
			AccountID: testAccountID, ServerID: testServerID,
			IdempotencyKey: "x", Name: "托管误带实例",
			TATRegion: "ap-beijing", TATInstanceKind: "managed",
			TATInstanceID: stringPointer("rins-test"), OSType: "linux",
		},
	} {
		if _, err := service.Create(context.Background(), command); err == nil {
			t.Fatalf("Create(%#v) expected error", command)
		}
	}
}

func TestServiceCreatesManagedMacOSCanaryAndRejectsNativeMacOS(t *testing.T) {
	now := time.Date(2026, 7, 30, 22, 0, 0, 0, time.UTC)
	repository := &fakeRepository{}
	service, err := NewService(
		repository,
		&fakeRegistrar{},
		&fakeTerminalIssuer{},
		&fixedIDs{values: []string{testComputerID}},
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}
	value, err := service.Create(context.Background(), CreateCommand{
		AccountID:       testAccountID,
		ServerID:        testServerID,
		IdempotencyKey:  "computer-create-macos-canary",
		Name:            "本机 Mac Canary",
		TATRegion:       "ap-beijing",
		TATInstanceKind: "managed",
		OSType:          "macos",
	})
	if err != nil {
		t.Fatal(err)
	}
	if value.OSType != "macos" ||
		value.LifecycleState != "provisioning" {
		t.Fatalf("Create(macos managed) = %#v", value)
	}

	service, err = NewService(
		&fakeRepository{},
		&fakeRegistrar{},
		&fakeTerminalIssuer{},
		&fixedIDs{values: []string{testComputerID}},
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Create(context.Background(), CreateCommand{
		AccountID:       testAccountID,
		ServerID:        testServerID,
		IdempotencyKey:  "computer-create-native-macos",
		Name:            "非法原生 Mac",
		TATRegion:       "ap-beijing",
		TATInstanceID:   stringPointer("ins-test0001"),
		TATInstanceKind: "cvm",
		OSType:          "macos",
	}); err == nil {
		t.Fatal("Create(native macos) unexpectedly succeeded")
	}
}

func TestServiceListsGetsAndEnqueuesComputerRefresh(t *testing.T) {
	now := time.Date(2026, 7, 30, 22, 0, 0, 0, time.UTC)
	repository := &fakeRepository{
		computers: []computerport.Computer{{
			ID: testComputerID, ServerID: testServerID,
			Name: "执行机", Revision: 3, LifecycleState: "active",
			TATInstanceID: stringPointer("ins-test0001"),
		}},
	}
	service, err := NewService(
		repository,
		&fakeRegistrar{},
		&fakeTerminalIssuer{},
		&fixedIDs{values: []string{testOperation}},
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}
	values, err := service.List(context.Background(), testAccountID, testServerID)
	if err != nil || len(values) != 1 {
		t.Fatalf("List() = (%#v, %v)", values, err)
	}
	value, err := service.Get(
		context.Background(), testAccountID, testServerID, testComputerID,
	)
	if err != nil || value.ID != testComputerID {
		t.Fatalf("Get() = (%#v, %v)", value, err)
	}
	operation, err := service.Refresh(
		context.Background(),
		RefreshCommand{
			AccountID:      testAccountID,
			ServerID:       testServerID,
			ComputerID:     testComputerID,
			IdempotencyKey: "computer-refresh-0001",
		},
	)
	if err != nil || operation.ID != testOperation ||
		repository.refreshCommand.ComputerRevision != 3 {
		t.Fatalf("Refresh() = (%#v, %v), command=%#v", operation, err, repository.refreshCommand)
	}
}

func TestServiceDoesNotTreatTATRegistrationSnapshotAsLiveConnection(t *testing.T) {
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	observedAt := now.Add(-time.Minute)
	repository := &fakeRepository{computers: []computerport.Computer{{
		ID: testComputerID, ServerID: testServerID, Name: "执行机",
		LifecycleState: "active", TATAgentState: "online",
		LastObservedAt: &observedAt, Revision: 3,
	}}}
	service, err := NewService(
		repository,
		&fakeRegistrar{},
		&fakeTerminalIssuer{},
		&fixedIDs{},
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}

	value, err := service.Get(
		context.Background(), testAccountID, testServerID, testComputerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if value.TATAgentState != "unknown" || value.LastObservedAt != nil {
		t.Fatalf("Get() connection projection = %#v", value)
	}
}

func TestServiceProjectsFreshHostHeartbeatAsOnline(t *testing.T) {
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	heartbeatAt := now.Add(-30 * time.Second)
	repository := &fakeRepository{computers: []computerport.Computer{{
		ID: testComputerID, ServerID: testServerID, Name: "执行机",
		LifecycleState: "active", TATAgentState: "offline",
		HostLastSeenAt: &heartbeatAt, Revision: 3,
	}}}
	service, err := NewService(
		repository,
		&fakeRegistrar{},
		&fakeTerminalIssuer{},
		&fixedIDs{},
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}

	value, err := service.Get(
		context.Background(), testAccountID, testServerID, testComputerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if value.TATAgentState != "online" || value.LastObservedAt == nil ||
		!value.LastObservedAt.Equal(heartbeatAt) {
		t.Fatalf("Get() connection projection = %#v", value)
	}
}

func TestServiceProjectsExpiredHostHeartbeatAsOffline(t *testing.T) {
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	heartbeatAt := now.Add(-DefaultHostLeaseTTL - time.Nanosecond)
	repository := &fakeRepository{computers: []computerport.Computer{{
		ID: testComputerID, ServerID: testServerID, Name: "执行机",
		LifecycleState: "active", TATAgentState: "online",
		HostLastSeenAt: &heartbeatAt, Revision: 3,
	}}}
	service, err := NewService(
		repository,
		&fakeRegistrar{},
		&fakeTerminalIssuer{},
		&fixedIDs{},
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}

	value, err := service.Get(
		context.Background(), testAccountID, testServerID, testComputerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if value.TATAgentState != "offline" || value.LastObservedAt == nil ||
		!value.LastObservedAt.Equal(heartbeatAt) {
		t.Fatalf("Get() connection projection = %#v", value)
	}
}

func TestServiceCreatesOneHourStructuredRegistrationMaterial(t *testing.T) {
	now := time.Date(2026, 7, 30, 22, 0, 0, 0, time.UTC)
	repository := &fakeRepository{
		computers: []computerport.Computer{{
			ID: testComputerID, ServerID: testServerID,
			Name: "外部机", TATRegion: "ap-beijing",
			TATInstanceKind: "managed", OSType: "linux",
			LifecycleState: "provisioning", Revision: 1,
		}},
	}
	registrar := &fakeRegistrar{result: tencenttatport.Registration{
		CodeID:    "register-code-id",
		CodeValue: "register-code-value",
		ExpiresAt: now.Add(time.Hour),
	}}
	service, err := NewService(
		repository,
		registrar,
		&fakeTerminalIssuer{},
		&fixedIDs{values: []string{testOperation}},
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.CreateRegistration(
		context.Background(), testAccountID, testServerID, testComputerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.ComputerID != testComputerID ||
		result.ExpiresAt != now.Add(time.Hour) ||
		registrar.request.Region != "ap-beijing" ||
		registrar.request.RegisterLimit != 1 ||
		registrar.request.EffectiveTime != time.Hour ||
		repository.registerCommand.OperationID != testOperation ||
		repository.registerCommand.ComputerRevision != 1 ||
		repository.registerCommand.ExpiresAt != now.Add(time.Hour) ||
		result.Protocol != "tencent-tat-register-v1" ||
		result.Region != "ap-beijing" ||
		result.RegisterCodeID != "register-code-id" ||
		result.RegisterCodeValue != "register-code-value" ||
		len(result.Tags) != 1 ||
		result.Tags[0].Key != "agent-network-computer-id" ||
		result.Tags[0].Value != testComputerID {
		t.Fatalf("registration = %#v, request=%#v", result, registrar.request)
	}
}

func TestServiceIssuesAdminTerminalSessionForReadyComputer(t *testing.T) {
	now := time.Date(2026, 7, 30, 22, 0, 0, 0, time.UTC)
	instanceID := "rins-test0001"
	repository := &fakeRepository{
		computers: []computerport.Computer{{
			ID: testComputerID, ServerID: testServerID,
			Name: "外部机", TATRegion: "ap-beijing",
			TATInstanceID: &instanceID, TATInstanceKind: "managed",
			OSType: "linux", LifecycleState: "active",
			TATAgentState: "online", HostLastSeenAt: &now, Revision: 3,
		}},
	}
	issuer := &fakeTerminalIssuer{
		result: tencenttatport.TerminalSession{
			SessionID:      "session-test",
			WebSocketURL:   "wss://terminal.example.test/connect",
			ExpiresAt:      now.Add(5 * time.Minute),
			OwnerUIN:       "100000000001",
			AppID:          1250000000,
			InstanceID:     instanceID,
			Cols:           120,
			Rows:           32,
			MaxIdleSeconds: 3600,
		},
	}
	service, err := NewService(
		repository,
		&fakeRegistrar{},
		issuer,
		&fixedIDs{},
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}

	session, err := service.CreateTerminalSession(
		context.Background(),
		testAccountID,
		testServerID,
		testComputerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if session.SessionID != "session-test" ||
		session.InstanceID != instanceID ||
		issuer.target.ComputerID != testComputerID ||
		issuer.target.Region != "ap-beijing" ||
		issuer.target.InstanceID != instanceID ||
		issuer.target.InstanceKind != "managed" ||
		issuer.target.OS != tencenttatport.OSLinux {
		t.Fatalf("session=%#v target=%#v", session, issuer.target)
	}
}

func TestServiceRejectsTerminalWhenHostLeaseIsMissing(t *testing.T) {
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	instanceID := "rins-test0001"
	issuer := &fakeTerminalIssuer{result: tencenttatport.TerminalSession{
		SessionID: "must-not-be-issued",
	}}
	service, err := NewService(
		&fakeRepository{computers: []computerport.Computer{{
			ID: testComputerID, ServerID: testServerID,
			TATRegion: "ap-beijing", TATInstanceID: &instanceID,
			TATInstanceKind: "managed", OSType: "macos",
			LifecycleState: "active", TATAgentState: "online",
		}}},
		&fakeRegistrar{},
		issuer,
		&fixedIDs{},
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}

	_, err = service.CreateTerminalSession(
		context.Background(), testAccountID, testServerID, testComputerID,
	)
	if apperror.CodeOf(err) != "computer_offline" {
		t.Fatalf("CreateTerminalSession() error = %v code=%q", err, apperror.CodeOf(err))
	}
	if issuer.target.InstanceID != "" {
		t.Fatalf("terminal issuer was called with %#v", issuer.target)
	}
}

func TestServiceMapsLiveTATOfflineFailureToComputerOffline(t *testing.T) {
	now := time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC)
	instanceID := "rins-test0001"
	issuer := &fakeTerminalIssuer{err: fakeTATError{code: "terminal_target_offline"}}
	service, err := NewService(
		&fakeRepository{computers: []computerport.Computer{{
			ID: testComputerID, ServerID: testServerID,
			TATRegion: "ap-beijing", TATInstanceID: &instanceID,
			TATInstanceKind: "managed", OSType: "macos",
			LifecycleState: "active", TATAgentState: "online",
			HostLastSeenAt: &now,
		}}},
		&fakeRegistrar{}, issuer, &fixedIDs{}, fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}

	_, err = service.CreateTerminalSession(
		context.Background(), testAccountID, testServerID, testComputerID,
	)
	if apperror.CodeOf(err) != "computer_offline" {
		t.Fatalf("CreateTerminalSession() error = %v code=%q", err, apperror.CodeOf(err))
	}
}

func TestServiceRejectsTerminalSessionWhenComputerIsNotReadyOrCallerIsNotAdmin(
	t *testing.T,
) {
	now := time.Date(2026, 7, 30, 22, 0, 0, 0, time.UTC)
	instanceID := "rins-test0001"
	for _, test := range []struct {
		name     string
		computer computerport.Computer
		adminErr error
	}{
		{
			name: "member",
			computer: computerport.Computer{
				ID: testComputerID, ServerID: testServerID,
				TATRegion: "ap-beijing", TATInstanceID: &instanceID,
				TATInstanceKind: "managed", OSType: "linux",
				LifecycleState: "active", TATAgentState: "online",
			},
			adminErr: computerport.ErrAdminRequired,
		},
		{
			name: "offline",
			computer: computerport.Computer{
				ID: testComputerID, ServerID: testServerID,
				TATRegion: "ap-beijing", TATInstanceID: &instanceID,
				TATInstanceKind: "managed", OSType: "linux",
				LifecycleState: "active", TATAgentState: "offline",
			},
		},
		{
			name: "provisioning",
			computer: computerport.Computer{
				ID: testComputerID, ServerID: testServerID,
				TATRegion: "ap-beijing", TATInstanceKind: "managed",
				OSType: "linux", LifecycleState: "provisioning",
				TATAgentState: "unknown",
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			issuer := &fakeTerminalIssuer{}
			service, err := NewService(
				&fakeRepository{
					computers: []computerport.Computer{test.computer},
					adminErr:  test.adminErr,
				},
				&fakeRegistrar{},
				issuer,
				&fixedIDs{},
				fixedClock{now: now},
			)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := service.CreateTerminalSession(
				context.Background(),
				testAccountID,
				testServerID,
				testComputerID,
			); err == nil {
				t.Fatal("CreateTerminalSession() unexpectedly succeeded")
			}
			if issuer.target.InstanceID != "" {
				t.Fatalf("issuer was called with %#v", issuer.target)
			}
		})
	}
}

func stringPointer(value string) *string { return &value }
