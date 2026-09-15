package computercontrol

import "testing"

func TestSessionIdentityCarriesAssignmentFence(t *testing.T) {
	identity := SessionIdentity{
		ServerID:           "01989c24-7540-7f12-a27b-c83243215dd3",
		ComputerID:         "01989c24-7540-7f12-a27b-c83243215dd5",
		CredentialVersion:  2,
		AssignmentEpoch:    "01989c24-7540-7f12-a27b-c83243215dd6",
		AssignmentRevision: 3,
	}
	if identity.AssignmentRevision != 3 || identity.CredentialVersion != 2 {
		t.Fatalf("SessionIdentity = %#v", identity)
	}
}
