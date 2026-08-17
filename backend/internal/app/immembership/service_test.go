package immembership

import (
	"context"
	"testing"
	"time"

	clockport "chatserver/internal/ports/clock"
	immembershipport "chatserver/internal/ports/immembership"
	tencentimport "chatserver/internal/ports/tencentim"
)

type membershipRepository struct {
	work       immembershipport.Work
	found      bool
	completion immembershipport.Completion
}

func (repository *membershipRepository) Claim(
	context.Context,
	immembershipport.Claim,
) (immembershipport.Work, bool, error) {
	return repository.work, repository.found, nil
}

func (repository *membershipRepository) Complete(
	_ context.Context,
	completion immembershipport.Completion,
) error {
	repository.completion = completion
	return nil
}

type membershipProvisioner struct {
	ensured     tencentimport.Membership
	removed     tencentimport.Membership
	ensureCalls int
	removeCalls int
}

func (provisioner *membershipProvisioner) EnsureMember(
	_ context.Context,
	value tencentimport.Membership,
) error {
	provisioner.ensureCalls++
	provisioner.ensured = value
	return nil
}

func (provisioner *membershipProvisioner) RemoveMember(
	_ context.Context,
	value tencentimport.Membership,
) error {
	provisioner.removeCalls++
	provisioner.removed = value
	return nil
}

type membershipClock struct{ now time.Time }

func (clock membershipClock) Now() time.Time { return clock.now }

var _ clockport.Clock = membershipClock{}

func TestServiceEnsuresCommunityMemberAndCompletes(t *testing.T) {
	now := time.Date(2026, 7, 31, 1, 0, 0, 0, time.UTC)
	repository := &membershipRepository{
		found: true,
		work: immembershipport.Work{
			OperationID: "operation-1",
			LeaseOwner:  "worker-1", Kind: "im.membership.ensure",
			GroupID: "@TGS#2TEST", IMUserID: "u_JOINER",
			IMState: "provisioning", MemberRevision: 1,
			DesiredRevision: 1, Attempts: 1,
		},
	}
	provisioner := &membershipProvisioner{}
	service, err := NewService(
		repository,
		provisioner,
		membershipClock{now: now},
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
	if provisioner.ensured.GroupID != "@TGS#2TEST" ||
		provisioner.ensured.UserID != "u_JOINER" ||
		provisioner.ensured.TopicID != "" ||
		repository.completion.Status !=
			immembershipport.CompletionSucceeded {
		t.Fatalf(
			"ensure/completion = (%#v, %#v)",
			provisioner.ensured,
			repository.completion,
		)
	}
}

func TestServiceRejectsChannelMembershipWithoutTopic(
	t *testing.T,
) {
	for _, kind := range []string{
		"im.membership.ensure",
		"im.membership.remove",
	} {
		t.Run(kind, func(t *testing.T) {
			now := time.Date(2026, 8, 4, 3, 33, 13, 0, time.UTC)
			repository := &membershipRepository{
				found: true,
				work: immembershipport.Work{
					OperationID:     "operation-public-channel",
					LeaseOwner:      "worker-public-channel",
					Kind:            kind,
					ResourceType:    "channel_member",
					GroupID:         "@TGS#_C_PUBLIC",
					IMUserID:        "u_JOINER",
					IMState:         "provisioning",
					MemberRevision:  1,
					DesiredRevision: 1,
					Attempts:        1,
				},
			}
			provisioner := &membershipProvisioner{}
			service, err := NewService(
				repository,
				provisioner,
				membershipClock{now: now},
				Config{
					WorkerID: "worker-public-channel",
					LeaseTTL: 30 * time.Second, MaxAttempts: 8,
					BaseBackoff: time.Second, MaxBackoff: time.Minute,
				},
			)
			if err != nil {
				t.Fatal(err)
			}

			processed, err := service.ProcessOne(context.Background())

			if err != nil || !processed {
				t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
			}
			if provisioner.ensureCalls != 0 || provisioner.removeCalls != 0 ||
				repository.completion.Status !=
					immembershipport.CompletionFailed ||
				repository.completion.ErrorCode != "invalid_channel_topic" {
				t.Fatalf(
					"calls/completion = (%d, %d, %#v)",
					provisioner.ensureCalls,
					provisioner.removeCalls,
					repository.completion,
				)
			}
		})
	}
}
