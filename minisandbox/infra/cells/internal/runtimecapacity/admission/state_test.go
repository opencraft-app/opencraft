package admission

import (
	"strings"
	"testing"
	"time"
)

func TestAdmissionStateRoundTripAndStrictDecode(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	state := State{
		Phase: PhaseProbing,
		Identity: Identity{
			NodeUID: "node-uid", ProviderID: "qcloud://instance", MachineUID: "machine-uid",
			MachineSetUID: "machineset-uid", ProfileDigest: ProfileDigest(), RuntimeImage: testImage("a"),
		},
		AttemptUID: "attempt", ProbePodName: "probe", ProbePodUID: "pod-uid", Attempt: 1,
		StartedAt: now, TransitionAt: now,
	}
	raw, err := EncodeState(state)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeState(raw)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.AttemptUID != state.AttemptUID || !SameAttempt(decoded.Identity, state.Identity) {
		t.Fatalf("state changed across round trip: %#v", decoded)
	}
	if _, err := DecodeState(strings.TrimSuffix(raw, "}") + `,"unexpected":true}`); err == nil {
		t.Fatal("unknown state field was accepted")
	}
}

func TestAdmittedIdentitySurvivesRuntimeReleaseButNotNodeReplacement(t *testing.T) {
	base := Identity{
		NodeUID: "node-uid", ProviderID: "qcloud://instance", MachineUID: "machine-uid",
		MachineSetUID: "machineset-uid", ProfileDigest: ProfileDigest(), RuntimeImage: testImage("a"),
	}
	release := base
	release.RuntimeImage = testImage("b")
	if !SameNode(base, release) || SameAttempt(base, release) {
		t.Fatal("runtime release was confused with Node identity")
	}
	replacement := base
	replacement.NodeUID = "replacement-node-uid"
	if SameNode(base, replacement) {
		t.Fatal("replacement Node inherited admission identity")
	}
}

func testImage(character string) string {
	return "registry.invalid/runtime@sha256:" + strings.Repeat(character, 64)
}
