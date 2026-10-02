package admission

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

const (
	PendingTaintKey = "fleet.actor.dev/runtime-admission"
	AdmittedLabel   = "fleet.actor.dev/runtime-admitted"
	PhaseLabel      = "fleet.actor.dev/runtime-admission-phase"
	StateAnnotation = "fleet.actor.dev/runtime-admission-state"
	DrainAnnotation = "fleet.actor.dev/runtime-capacity-drain"

	ProbeComponent = "runtime-node-admission-probe"
	ProfileVersion = "workerd-node-v1"
)

type Phase string

const (
	PhasePending Phase = "Pending"
	PhaseProbing Phase = "Probing"
	// PhasePrepared means the exact Node/Machine/image probe succeeded, but
	// scheduling remains fenced until an equally prepared topology frontier is
	// available in every required zone. This prevents a fast AZ from consuming
	// all new workload replicas while another AZ is still provisioning.
	PhasePrepared    Phase = "Prepared"
	PhaseBlocked     Phase = "Blocked"
	PhaseSuspect     Phase = "Suspect"
	PhaseQuarantined Phase = "Quarantined"
	PhaseAdmitted    Phase = "Admitted"
	PhaseCancelled   Phase = "Cancelled"
)

type Identity struct {
	NodeUID       string `json:"node_uid"`
	ProviderID    string `json:"provider_id"`
	MachineUID    string `json:"machine_uid"`
	MachineSetUID string `json:"machine_set_uid"`
	ProfileDigest string `json:"profile_digest"`
	RuntimeImage  string `json:"runtime_image"`
}

type State struct {
	Phase        Phase     `json:"phase"`
	Identity     Identity  `json:"identity"`
	AttemptUID   string    `json:"attempt_uid,omitempty"`
	ProbePodName string    `json:"probe_pod_name,omitempty"`
	ProbePodUID  string    `json:"probe_pod_uid,omitempty"`
	Attempt      int       `json:"attempt,omitempty"`
	StartedAt    time.Time `json:"started_at,omitempty"`
	TransitionAt time.Time `json:"transition_at"`
	RetryAt      time.Time `json:"retry_at,omitempty"`
	Reason       string    `json:"reason,omitempty"`
	Fault        string    `json:"fault,omitempty"`
	FaultSince   time.Time `json:"fault_since,omitempty"`
}

func ProfileDigest() string {
	return ProfileDigestFor(ProfileVersion)
}

// ProfileDigestFor binds durable admission evidence to the exact workload
// profile.  Stateless and durable Nodes run the same runtime image probe but
// must never accept one another's persisted Node evidence.
func ProfileDigestFor(profileVersion string) string {
	digest := sha256.Sum256([]byte(profileVersion + "\n" +
		"node-ready,disk-pressure,memory-pressure,pid-pressure,network-unavailable\n" +
		"runtime-image-pull,workerd-version,kubernetes-service-dns\n" +
		"no-service-account-token,no-host-path,non-root,read-only-rootfs"))
	return hex.EncodeToString(digest[:])
}

func EncodeState(state State) (string, error) {
	if err := ValidateState(state); err != nil {
		return "", err
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return "", fmt.Errorf("encode runtime admission state: %w", err)
	}
	return string(encoded), nil
}

func DecodeState(raw string) (State, error) {
	if raw == "" {
		return State{}, nil
	}
	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	decoder.DisallowUnknownFields()
	var state State
	if err := decoder.Decode(&state); err != nil {
		return State{}, fmt.Errorf("decode runtime admission state: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return State{}, fmt.Errorf("decode runtime admission state: trailing JSON")
	}
	if err := ValidateState(state); err != nil {
		return State{}, err
	}
	return state, nil
}

func ValidateState(state State) error {
	switch state.Phase {
	case PhasePending, PhaseProbing, PhasePrepared, PhaseBlocked, PhaseSuspect, PhaseQuarantined, PhaseAdmitted, PhaseCancelled:
	default:
		return fmt.Errorf("invalid runtime admission phase %q", state.Phase)
	}
	if state.Identity.NodeUID == "" || state.Identity.ProviderID == "" || state.Identity.MachineUID == "" || state.Identity.MachineSetUID == "" ||
		state.Identity.ProfileDigest == "" || state.Identity.RuntimeImage == "" {
		return fmt.Errorf("runtime admission identity is incomplete")
	}
	if state.TransitionAt.IsZero() {
		return fmt.Errorf("runtime admission transition time is missing")
	}
	if state.Phase == PhasePending || state.Phase == PhaseProbing || state.Phase == PhasePrepared || state.Phase == PhaseBlocked || state.Phase == PhaseSuspect || state.Phase == PhaseQuarantined {
		if state.AttemptUID == "" || state.Attempt < 1 || state.StartedAt.IsZero() {
			return fmt.Errorf("active runtime admission attempt is incomplete")
		}
	}
	if (state.Fault == "") != state.FaultSince.IsZero() {
		return fmt.Errorf("runtime admission fault evidence is incomplete")
	}
	if state.Phase == PhaseSuspect && state.Fault == "" {
		return fmt.Errorf("suspect runtime admission state has no fault evidence")
	}
	if state.ProbePodUID != "" && state.ProbePodName == "" {
		return fmt.Errorf("runtime admission probe UID has no Pod name")
	}
	return nil
}

func SameNode(left, right Identity) bool {
	return left.NodeUID == right.NodeUID &&
		left.ProviderID == right.ProviderID &&
		left.MachineUID == right.MachineUID &&
		left.MachineSetUID == right.MachineSetUID &&
		left.ProfileDigest == right.ProfileDigest
}

func SameAttempt(left, right Identity) bool {
	return SameNode(left, right) && left.RuntimeImage == right.RuntimeImage
}
