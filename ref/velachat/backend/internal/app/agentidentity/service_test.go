package agentidentity

import (
	"context"
	"errors"
	"testing"
	"time"

	agentidentityport "chatserver/internal/ports/agentidentity"
	tencentimport "chatserver/internal/ports/tencentim"
)

type fakeRepository struct {
	work         agentidentityport.Work
	completion   agentidentityport.Completion
	legacy       agentidentityport.LegacyMembership
	legacyFound  bool
	schedule     agentidentityport.LegacyMembershipSchedule
	repairDone   bool
	repairMarker string
	steps        *[]string
}

func (repository *fakeRepository) Claim(
	context.Context,
	agentidentityport.Claim,
) (agentidentityport.Work, bool, error) {
	return repository.work, true, nil
}

func (repository *fakeRepository) Complete(
	_ context.Context,
	completion agentidentityport.Completion,
) error {
	repository.completion = completion
	if repository.steps != nil {
		*repository.steps = append(*repository.steps, "complete")
	}
	return nil
}

func (repository *fakeRepository) RevokeRoute(
	context.Context,
	agentidentityport.RouteRevocation,
) error {
	if repository.steps != nil {
		*repository.steps = append(*repository.steps, "route")
	}
	return nil
}

func (repository *fakeRepository) FindLegacyMembership(
	context.Context,
) (agentidentityport.LegacyMembership, bool, error) {
	return repository.legacy, repository.legacyFound, nil
}

func (repository *fakeRepository) ScheduleLegacyMembership(
	_ context.Context,
	command agentidentityport.LegacyMembershipSchedule,
) (bool, error) {
	repository.schedule = command
	repository.legacyFound = false
	return true, nil
}

func (repository *fakeRepository) LegacyMembershipRepairCompleted(
	context.Context,
) (bool, error) {
	return repository.repairDone, nil
}

func (repository *fakeRepository) CompleteLegacyMembershipRepair(
	_ context.Context,
	operationID string,
	_ time.Time,
) error {
	repository.repairMarker = operationID
	repository.repairDone = true
	return nil
}

type fakeProvisioner struct {
	identity tencentimport.Identity
	err      error
	steps    *[]string
}

func (provisioner *fakeProvisioner) EnsureIdentity(
	_ context.Context,
	identity tencentimport.Identity,
) error {
	provisioner.identity = identity
	return provisioner.err
}

func (provisioner *fakeProvisioner) KickIdentity(
	context.Context,
	string,
) error {
	if provisioner.steps != nil {
		*provisioner.steps = append(*provisioner.steps, "kick")
	}
	return provisioner.err
}

func (provisioner *fakeProvisioner) DeleteIdentity(
	context.Context,
	string,
) error {
	if provisioner.steps != nil {
		*provisioner.steps = append(*provisioner.steps, "delete")
	}
	return provisioner.err
}

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

type fixedIDGenerator struct {
	value  string
	values []string
	err    error
	calls  int
}

func (generator *fixedIDGenerator) New() (string, error) {
	generator.calls++
	if generator.calls <= len(generator.values) {
		return generator.values[generator.calls-1], generator.err
	}
	return generator.value, generator.err
}

func TestServiceEnsuresAgentIdentity(t *testing.T) {
	now := time.Date(2026, 7, 31, 0, 15, 0, 0, time.UTC)
	membershipOperationID := "0198f4c2-7a38-7ae1-8b1b-1abf6588898b"
	repository := &fakeRepository{work: agentidentityport.Work{
		Kind:        "im.identity.ensure",
		OperationID: "0198f4c2-7a37-7e45-913c-6baf30401a83",
		LeaseOwner:  "worker-1",
		AgentID:     "0198f4c2-7a36-7e45-913c-6baf30401a82",
		DisplayName: "小舟", IMUserID: "a_TESTAGENTUSERID2345678901234",
		IMState: "provisioning", AgentRevision: 1,
		DesiredRevision: 1, Attempts: 1,
	}}
	provisioner := &fakeProvisioner{}
	ids := &fixedIDGenerator{value: membershipOperationID}
	service, err := NewService(
		repository,
		provisioner,
		ids,
		fixedClock{now: now},
		Config{
			WorkerID: "worker-1", LeaseTTL: 30 * time.Second,
			MaxAttempts: 8, BaseBackoff: time.Second,
			MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if provisioner.identity.UserID !=
		"a_TESTAGENTUSERID2345678901234" ||
		provisioner.identity.Nick != "小舟" ||
		repository.completion.Status !=
			agentidentityport.CompletionSucceeded ||
		repository.completion.MembershipOperationID !=
			membershipOperationID {
		t.Fatalf(
			"identity=%#v completion=%#v",
			provisioner.identity,
			repository.completion,
		)
	}
	if ids.calls != 1 {
		t.Fatalf("ID generator calls = %d", ids.calls)
	}
}

func TestServiceRevokesRouteKicksAndDeletesAgentIdentityInOrder(t *testing.T) {
	now := time.Date(2026, 7, 31, 0, 15, 0, 0, time.UTC)
	steps := []string{}
	repository := &fakeRepository{
		steps: &steps,
		work: agentidentityport.Work{
			Kind:        "im.identity.delete",
			OperationID: "0198f4c2-7a37-7e45-913c-6baf30401a83",
			LeaseOwner:  "worker-1",
			AgentID:     "0198f4c2-7a36-7e45-913c-6baf30401a82",
			IMUserID:    "a_TESTAGENTUSERID2345678901234",
			IMState:     "deleting", AgentRevision: 2,
			DesiredRevision: 2, Deleted: true, Attempts: 1,
		},
	}
	provisioner := &fakeProvisioner{steps: &steps}
	ids := &fixedIDGenerator{value: "0198f4c2-7a38-7ae1-8b1b-1abf6588898b"}
	service, err := NewService(
		repository,
		provisioner,
		ids,
		fixedClock{now: now},
		Config{
			WorkerID: "worker-1", LeaseTTL: 30 * time.Second,
			MaxAttempts: 8, BaseBackoff: time.Second,
			MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	want := []string{"route", "kick", "delete", "complete"}
	if len(steps) != len(want) {
		t.Fatalf("steps = %#v", steps)
	}
	for index := range want {
		if steps[index] != want[index] {
			t.Fatalf("steps = %#v", steps)
		}
	}
	if repository.completion.Status != agentidentityport.CompletionSucceeded ||
		repository.completion.MembershipOperationID != "" || ids.calls != 0 {
		t.Fatalf("completion=%#v ID calls=%d", repository.completion, ids.calls)
	}
}

func TestServiceDoesNotMintMembershipOperationWhenIdentityFails(
	t *testing.T,
) {
	now := time.Date(2026, 7, 31, 0, 16, 0, 0, time.UTC)
	repository := &fakeRepository{work: agentidentityport.Work{
		Kind:        "im.identity.ensure",
		OperationID: "0198f4c2-7a37-7e45-913c-6baf30401a83",
		LeaseOwner:  "worker-1",
		AgentID:     "0198f4c2-7a36-7e45-913c-6baf30401a82",
		DisplayName: "小舟", IMUserID: "a_TESTAGENTUSERID2345678901234",
		IMState: "provisioning", AgentRevision: 1,
		DesiredRevision: 1, Attempts: 8,
	}}
	provisioner := &fakeProvisioner{err: errors.New("identity rejected")}
	ids := &fixedIDGenerator{
		value: "0198f4c2-7a38-7ae1-8b1b-1abf6588898b",
	}
	service, err := NewService(
		repository,
		provisioner,
		ids,
		fixedClock{now: now},
		Config{
			WorkerID: "worker-1", LeaseTTL: 30 * time.Second,
			MaxAttempts: 8, BaseBackoff: time.Second,
			MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if repository.completion.Status !=
		agentidentityport.CompletionFailed ||
		repository.completion.MembershipOperationID != "" ||
		ids.calls != 0 {
		t.Fatalf(
			"completion=%#v ID calls=%d",
			repository.completion,
			ids.calls,
		)
	}
}

func TestServiceLeavesClaimForRetryWhenMembershipIDGenerationFails(
	t *testing.T,
) {
	now := time.Date(2026, 7, 31, 0, 17, 0, 0, time.UTC)
	repository := &fakeRepository{work: agentidentityport.Work{
		Kind:        "im.identity.ensure",
		OperationID: "0198f4c2-7a37-7e45-913c-6baf30401a83",
		LeaseOwner:  "worker-1",
		AgentID:     "0198f4c2-7a36-7e45-913c-6baf30401a82",
		DisplayName: "小舟", IMUserID: "a_TESTAGENTUSERID2345678901234",
		IMState: "provisioning", AgentRevision: 1,
		DesiredRevision: 1, Attempts: 1,
	}}
	generateErr := errors.New("uuid unavailable")
	ids := &fixedIDGenerator{err: generateErr}
	service, err := NewService(
		repository,
		&fakeProvisioner{},
		ids,
		fixedClock{now: now},
		Config{
			WorkerID: "worker-1", LeaseTTL: 30 * time.Second,
			MaxAttempts: 8, BaseBackoff: time.Second,
			MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	processed, err := service.ProcessOne(context.Background())
	if !processed || !errors.Is(err, generateErr) {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if repository.completion.OperationID != "" || ids.calls != 1 {
		t.Fatalf(
			"completion=%#v ID calls=%d",
			repository.completion,
			ids.calls,
		)
	}
}

func TestServiceRepairsLegacyMembershipsOnce(t *testing.T) {
	now := time.Date(2026, 7, 31, 0, 18, 0, 0, time.UTC)
	membershipOperationID := "0198f4c2-7a39-7e45-913c-6baf30401a84"
	markerID := "0198f4c2-7a3a-7e45-913c-6baf30401a85"
	repository := &fakeRepository{
		legacyFound: true,
		legacy: agentidentityport.LegacyMembership{
			ServerID: "0198f4c2-7a31-7c91-a6d2-7d76f9188c38",
			MemberID: "0198f4c2-7a36-7e45-913c-6baf30401a82",
			Revision: 2,
		},
	}
	ids := &fixedIDGenerator{
		values: []string{membershipOperationID, markerID},
	}
	service, err := NewService(
		repository,
		&fakeProvisioner{},
		ids,
		fixedClock{now: now},
		Config{
			WorkerID: "worker-1", LeaseTTL: 30 * time.Second,
			MaxAttempts: 8, BaseBackoff: time.Second,
			MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	repaired, err := service.RepairLegacyMemberships(
		context.Background(),
	)
	if err != nil || repaired != 1 {
		t.Fatalf("RepairLegacyMemberships() = (%d, %v)", repaired, err)
	}
	if repository.schedule.OperationID != membershipOperationID ||
		repository.schedule.ServerID != repository.legacy.ServerID ||
		repository.schedule.MemberID != repository.legacy.MemberID ||
		repository.schedule.Revision != repository.legacy.Revision ||
		!repository.schedule.ScheduledAt.Equal(now) ||
		repository.repairMarker != markerID ||
		ids.calls != 2 {
		t.Fatalf(
			"schedule=%#v ID calls=%d",
			repository.schedule,
			ids.calls,
		)
	}
	repaired, err = service.RepairLegacyMemberships(context.Background())
	if err != nil || repaired != 0 || ids.calls != 2 {
		t.Fatalf(
			"second RepairLegacyMemberships() = (%d, %v), ID calls=%d",
			repaired,
			err,
			ids.calls,
		)
	}
}
