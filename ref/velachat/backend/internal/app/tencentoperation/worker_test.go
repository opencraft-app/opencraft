package tencentoperation

import (
	"context"
	"strings"
	"testing"
	"time"

	clockport "chatserver/internal/ports/clock"
	tencentoperationport "chatserver/internal/ports/tencentoperation"
	tencenttatport "chatserver/internal/ports/tencenttat"
)

const (
	workerOperationID = "019b1f62-544b-752b-86cc-82d97bf0c0bc"
	workerComputerID  = "019b1f62-544b-752b-86cc-82d97bf0c0bf"
)

var operationNow = time.Date(2026, 7, 30, 18, 0, 0, 0, time.UTC)

type fakeRepository struct {
	work       tencentoperationport.Work
	hasWork    bool
	claim      tencentoperationport.Claim
	completion tencentoperationport.Completion
}

func (repository *fakeRepository) Claim(
	_ context.Context,
	claim tencentoperationport.Claim,
) (tencentoperationport.Work, bool, error) {
	repository.claim = claim
	return repository.work, repository.hasWork, nil
}

func (repository *fakeRepository) Complete(
	_ context.Context,
	completion tencentoperationport.Completion,
) error {
	repository.completion = completion
	return nil
}

type fakeTAT struct {
	calls        []string
	managed      tencenttatport.ManagedInstance
	managedFound bool
	managedErr   error
	probe        tencenttatport.AgentStatus
	probeErr     error
}

func (client *fakeTAT) Run(context.Context, tencenttatport.Command) (tencenttatport.Invocation, error) {
	client.calls = append(client.calls, "run")
	return tencenttatport.Invocation{}, nil
}

func (client *fakeTAT) FindByOperation(context.Context, tencenttatport.Target, string) (tencenttatport.Invocation, bool, error) {
	client.calls = append(client.calls, "find")
	return tencenttatport.Invocation{}, false, nil
}

func (client *fakeTAT) Inspect(context.Context, tencenttatport.Target, string) (tencenttatport.Invocation, error) {
	client.calls = append(client.calls, "inspect")
	return tencenttatport.Invocation{}, nil
}

func (client *fakeTAT) Probe(context.Context, tencenttatport.Target) (tencenttatport.AgentStatus, error) {
	client.calls = append(client.calls, "probe")
	return client.probe, client.probeErr
}

func (client *fakeTAT) FindManagedByComputerTag(context.Context, string, string) (tencenttatport.ManagedInstance, bool, error) {
	client.calls = append(client.calls, "find-managed")
	return client.managed, client.managedFound, client.managedErr
}

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

func TestComputerWorkerRejectsAgentWorkWithoutCloudCall(t *testing.T) {
	work := baseComputerWork("tat.computer.obsolete")
	work.ResourceType = "agent"
	repository := &fakeRepository{hasWork: true, work: work}
	client := &fakeTAT{}
	service := newComputerService(t, repository, client)

	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if len(client.calls) != 0 ||
		repository.completion.Status != tencentoperationport.CompletionFailed ||
		repository.completion.ErrorCode != "tat_resource_type_invalid" {
		t.Fatalf("calls/completion = (%#v, %#v)", client.calls, repository.completion)
	}
}

func TestComputerWorkerSupersedesStaleRevisionBeforeCloudCall(t *testing.T) {
	work := baseComputerWork("tat.computer.refresh")
	work.ResourceRevision++
	repository := &fakeRepository{hasWork: true, work: work}
	client := &fakeTAT{}
	service := newComputerService(t, repository, client)
	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed || len(client.calls) != 0 ||
		repository.completion.Status != tencentoperationport.CompletionSuperseded ||
		repository.completion.ErrorCode != "stale_revision" {
		t.Fatalf("processed=%v err=%v calls=%#v completion=%#v", processed, err, client.calls, repository.completion)
	}
}

func TestRegistrationReconcileBindsUniqueManagedComputer(t *testing.T) {
	work := baseComputerWork("tat.computer.registration.reconcile")
	expiresAt := operationNow.Add(time.Hour)
	work.RegistrationExpiresAt = &expiresAt
	repository := &fakeRepository{hasWork: true, work: work}
	client := &fakeTAT{managedFound: true, managed: tencenttatport.ManagedInstance{
		InstanceID: "rins-computer", OS: tencenttatport.OSLinux, Online: true,
	}}
	service := newComputerService(t, repository, client)

	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed || strings.Join(client.calls, ",") != "find-managed" {
		t.Fatalf("processed=%v err=%v calls=%#v", processed, err, client.calls)
	}
	online := repository.completion.ComputerTATOnline
	if repository.completion.Status != tencentoperationport.CompletionSucceeded ||
		repository.completion.ComputerInstanceID != "rins-computer" ||
		online == nil || !*online {
		t.Fatalf("completion = %#v", repository.completion)
	}
}

func TestMacOSRegistrationAcceptsManagedRuntimeOSProjection(t *testing.T) {
	work := baseComputerWork("tat.computer.registration.reconcile")
	work.Target.OS = tencenttatport.OSMacOS
	expiresAt := operationNow.Add(time.Hour)
	work.RegistrationExpiresAt = &expiresAt
	repository := &fakeRepository{hasWork: true, work: work}
	client := &fakeTAT{managedFound: true, managed: tencenttatport.ManagedInstance{
		InstanceID: "rins-macos", OS: tencenttatport.OSLinux, Online: true,
	}}
	service := newComputerService(t, repository, client)
	if processed, err := service.ProcessOne(context.Background()); err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if repository.completion.Status != tencentoperationport.CompletionSucceeded ||
		repository.completion.ComputerOS != tencenttatport.OSMacOS {
		t.Fatalf("completion = %#v", repository.completion)
	}
}

func TestRegistrationReconcileWaitsUntilExpiry(t *testing.T) {
	work := baseComputerWork("tat.computer.registration.reconcile")
	expiresAt := operationNow.Add(time.Hour)
	work.RegistrationExpiresAt = &expiresAt
	repository := &fakeRepository{hasWork: true, work: work}
	client := &fakeTAT{}
	service := newComputerService(t, repository, client)
	if processed, err := service.ProcessOne(context.Background()); err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if repository.completion.Status != tencentoperationport.CompletionRetry ||
		repository.completion.ErrorCode != "tat_registration_pending" ||
		!repository.completion.NextAttemptAt.Equal(operationNow.Add(2*time.Second)) {
		t.Fatalf("completion = %#v", repository.completion)
	}
}

func TestRegistrationReconcileExpiresWithoutCloudCall(t *testing.T) {
	work := baseComputerWork("tat.computer.registration.reconcile")
	expiresAt := operationNow
	work.RegistrationExpiresAt = &expiresAt
	repository := &fakeRepository{hasWork: true, work: work}
	client := &fakeTAT{}
	service := newComputerService(t, repository, client)
	if processed, err := service.ProcessOne(context.Background()); err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if len(client.calls) != 0 || repository.completion.ErrorCode != "registration_expired" {
		t.Fatalf("calls/completion = (%#v, %#v)", client.calls, repository.completion)
	}
}

func TestComputerRefreshPersistsOfflineObservation(t *testing.T) {
	work := baseComputerWork("tat.computer.refresh")
	work.Target.InstanceID = "rins-computer"
	work.ComputerActive = true
	repository := &fakeRepository{hasWork: true, work: work}
	client := &fakeTAT{probe: tencenttatport.AgentStatus{Online: false, OS: tencenttatport.OSLinux}}
	service := newComputerService(t, repository, client)
	if processed, err := service.ProcessOne(context.Background()); err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	online := repository.completion.ComputerTATOnline
	if strings.Join(client.calls, ",") != "probe" ||
		repository.completion.Status != tencentoperationport.CompletionSucceeded ||
		online == nil || *online {
		t.Fatalf("calls/completion = (%#v, %#v)", client.calls, repository.completion)
	}
}

func baseComputerWork(kind string) tencentoperationport.Work {
	return tencentoperationport.Work{
		OperationID: workerOperationID, LeaseOwner: "worker-a",
		ServerID:   "019b1f62-544b-752b-86cc-82d97bf0c0be",
		ResourceID: workerComputerID, ResourceType: "computer", Kind: kind,
		DesiredRevision: 2, ResourceRevision: 2,
		Target:   tencenttatport.Target{Region: "ap-beijing", OS: tencenttatport.OSLinux},
		Attempts: 1,
	}
}

func newComputerService(t *testing.T, repository tencentoperationport.Repository, client tencenttatport.Client) *Service {
	t.Helper()
	service, err := NewComputerService(repository, client, fixedClock{now: operationNow}, Config{
		WorkerID: "worker-a", LeaseTTL: time.Minute, MaxAttempts: 5,
		BaseBackoff: time.Second, MaxBackoff: time.Minute, PollDelay: 2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

var _ clockport.Clock = fixedClock{}
