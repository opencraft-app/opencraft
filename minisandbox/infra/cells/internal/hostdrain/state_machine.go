package hostdrain

import (
	"fmt"
	"math"
	"math/bits"
	"sort"
	"time"
)

// Phase is the durable phase of one Cell-local Host drain. A non-idle state
// always names exactly one target Host; this is the concurrency boundary that
// prevents two simultaneous scale-in operations in one Cell.
type Phase string

const (
	PhaseIdle                Phase = "Idle"
	PhaseObserving           Phase = "Observing"
	PhaseSelected            Phase = "Selected"
	PhaseDraining            Phase = "Draining"
	PhaseReadyToScaleDown    Phase = "ReadyToScaleDown"
	PhaseScalingDown         Phase = "ScalingDown"
	PhaseConverging          Phase = "Converging"
	PhaseAborting            Phase = "Aborting"
	PhaseRebalanceSelected   Phase = "RebalanceSelected"
	PhaseRebalanceDraining   Phase = "RebalanceDraining"
	PhaseRebalanceReady      Phase = "RebalanceReady"
	PhaseRebalanceEvicting   Phase = "RebalanceEvicting"
	PhaseRebalanceCancelling Phase = "RebalanceCancelling"
	PhaseRebalanceReplacing  Phase = "RebalanceReplacing"
	PhaseRebalanceBlocked    Phase = "RebalanceBlocked"
)

type State struct {
	Phase                   Phase     `json:"phase"`
	Epoch                   int64     `json:"epoch"`
	TargetName              string    `json:"targetName,omitempty"`
	TargetUID               string    `json:"targetUID,omitempty"`
	FromReplicas            int32     `json:"fromReplicas,omitempty"`
	StartedAt               time.Time `json:"startedAt,omitempty"`
	TransitionAt            time.Time `json:"transitionAt,omitempty"`
	RepairWorkloadUID       string    `json:"repairWorkloadUID,omitempty"`
	RepairSourceZone        string    `json:"repairSourceZone,omitempty"`
	RepairDestinationZone   string    `json:"repairDestinationZone,omitempty"`
	RepairPrefixScore       int64     `json:"repairPrefixScore,omitempty"`
	EvictionResourceVersion string    `json:"evictionResourceVersion,omitempty"`
}

type Host struct {
	Name            string
	UID             string
	Ordinal         int32
	Zone            string
	Ready           bool
	Terminating     bool
	Draining        bool
	Accepting       bool
	Quiescent       bool
	ActiveActors    int64
	Capacity        int64
	RequestCapacity int64
	InFlight        int64
	Queued          int64
	ObservedAt      time.Time
	ResourceVersion string
	// This proof is derived from the exact Kubernetes cancellation CAS token.
	// Guest stats and an arbitrary resourceVersion change cannot supply it.
	EvictionCancelled bool
}

type Snapshot struct {
	Now                    time.Time
	WorkloadUID            string
	Replicas               int32
	ReadyReplicas          int32
	MinReplicas            int32
	MaxRemainingUsagePct   int64
	MetricsFreshness       time.Duration
	ScaleDownStabilization time.Duration
	DrainTimeout           time.Duration
	DemandRising           bool
	ScaleUpPending         bool
	RequiredZones          int
	TopologyMaxSkew        int
	Hosts                  []Host
	// Only the Kubernetes adapter may supply fresh, admitted spare-zone evidence.
	RebalanceZones []string
}

type ActionKind string

const (
	ActionNone           ActionKind = "None"
	ActionSetDraining    ActionKind = "SetHostDraining"
	ActionSetReplicas    ActionKind = "SetReplicas"
	ActionEvictHost      ActionKind = "EvictHost"
	ActionCancelEviction ActionKind = "CancelEviction"
)

type Action struct {
	Kind            ActionKind
	TargetName      string
	TargetUID       string
	Draining        bool
	Replicas        int32
	ResourceVersion string
}

type Decision struct {
	State  State
	Action Action
	Reason string
}

func Decide(current State, snapshot Snapshot) Decision {
	if current.Phase == "" {
		current.Phase = PhaseIdle
	}
	if snapshot.MaxRemainingUsagePct <= 0 {
		snapshot.MaxRemainingUsagePct = 70
	}
	if snapshot.MetricsFreshness <= 0 {
		snapshot.MetricsFreshness = 45 * time.Second
	}
	if snapshot.ScaleDownStabilization == 0 {
		snapshot.ScaleDownStabilization = 5 * time.Minute
	}
	if snapshot.DrainTimeout <= 0 {
		snapshot.DrainTimeout = 10 * time.Minute
	}

	if err := validateState(current); err != nil {
		return Decision{State: current, Action: Action{Kind: ActionNone}, Reason: err.Error()}
	}
	if current.RepairWorkloadUID != "" && current.RepairWorkloadUID != snapshot.WorkloadUID {
		return stay(current, "rebalance workload UID changed; no target action is authorized")
	}
	if isRebalancePhase(current.Phase) {
		return decideRebalance(current, snapshot)
	}

	switch current.Phase {
	case PhaseIdle:
		return decideIdle(current, snapshot)
	case PhaseObserving:
		return decideObserving(current, snapshot)
	case PhaseSelected:
		return decideSelected(current, snapshot)
	case PhaseDraining:
		return decideDraining(current, snapshot)
	case PhaseReadyToScaleDown:
		return decideReadyToScaleDown(current, snapshot)
	case PhaseScalingDown:
		return decideScalingDown(current, snapshot)
	case PhaseConverging:
		return decideConverging(current, snapshot)
	case PhaseAborting:
		return decideAborting(current, snapshot)
	default:
		return Decision{State: current, Action: Action{Kind: ActionNone}, Reason: fmt.Sprintf("unknown drain phase %q", current.Phase)}
	}
}

func decideIdle(current State, snapshot Snapshot) Decision {
	if reason := contractionBlockReason(snapshot); reason != "" {
		return stay(current, reason)
	}
	if snapshot.ScaleDownStabilization > 0 {
		next := State{
			Phase:        PhaseObserving,
			Epoch:        current.Epoch,
			StartedAt:    snapshot.Now,
			TransitionAt: snapshot.Now,
		}
		return Decision{State: next, Action: Action{Kind: ActionNone}, Reason: "started the low-load scale-down stabilization window"}
	}
	return selectTarget(current, snapshot)
}

func decideObserving(current State, snapshot Snapshot) Decision {
	if reason := contractionBlockReason(snapshot); reason != "" {
		return reset(current, snapshot.Now, "low-load observation reset: "+reason)
	}
	if snapshot.Now.Sub(current.StartedAt) < snapshot.ScaleDownStabilization {
		return stay(current, "low-load evidence remains inside the scale-down stabilization window")
	}
	return selectTarget(current, snapshot)
}

func selectTarget(current State, snapshot Snapshot) Decision {
	if reason := scaleInBlockReason(snapshot, nil); reason != "" {
		if target, destination, score := rebalanceCandidate(snapshot); target != nil {
			return Decision{State: State{
				Phase: PhaseRebalanceSelected, Epoch: current.Epoch + 1,
				TargetName: target.Name, TargetUID: target.UID, FromReplicas: snapshot.Replicas,
				StartedAt: snapshot.Now, TransitionAt: snapshot.Now,
				RepairWorkloadUID: snapshot.WorkloadUID, RepairSourceZone: target.Zone,
				RepairDestinationZone: destination, RepairPrefixScore: score,
			}, Action: Action{Kind: ActionNone}, Reason: "selected one idle Host for topology repair before serial scale-in"}
		}
		return stay(current, reason)
	}
	target := highestOrdinal(snapshot.Hosts)
	if target == nil {
		return stay(current, "no eligible Host exists")
	}
	next := State{
		Phase:        PhaseSelected,
		Epoch:        current.Epoch + 1,
		TargetName:   target.Name,
		TargetUID:    target.UID,
		FromReplicas: snapshot.Replicas,
		StartedAt:    snapshot.Now,
		TransitionAt: snapshot.Now,
	}
	return Decision{State: next, Action: Action{Kind: ActionNone}, Reason: "selected the highest StatefulSet ordinal for a serial drain"}
}

func decideSelected(current State, snapshot Snapshot) Decision {
	target, found := exactTarget(current, snapshot.Hosts)
	if !found {
		return reset(current, snapshot.Now, "selected Host identity disappeared before drain began")
	}
	if reason := scaleInBlockReason(snapshot, target); reason != "" {
		return reset(current, snapshot.Now, "selection cancelled: "+reason)
	}
	if target.Draining || !target.Accepting {
		return Decision{State: withPhase(current, PhaseDraining, snapshot.Now), Action: Action{Kind: ActionNone}, Reason: "Host already reflects the requested drain fence"}
	}
	return Decision{
		State:  withPhase(current, PhaseDraining, snapshot.Now),
		Action: Action{Kind: ActionSetDraining, TargetName: target.Name, TargetUID: target.UID, Draining: true},
		Reason: "fence the selected Host from new actor placement",
	}
}

func decideDraining(current State, snapshot Snapshot) Decision {
	target, found := exactTarget(current, snapshot.Hosts)
	if !found {
		return reset(current, snapshot.Now, "draining Host identity disappeared; clear the stale operation")
	}
	if abortReason := drainAbortReason(current, snapshot, target); abortReason != "" {
		return Decision{
			State:  withPhase(current, PhaseAborting, snapshot.Now),
			Action: Action{Kind: ActionSetDraining, TargetName: target.Name, TargetUID: target.UID, Draining: false},
			Reason: abortReason,
		}
	}
	if !target.Draining || target.Accepting {
		return Decision{
			State:  current,
			Action: Action{Kind: ActionSetDraining, TargetName: target.Name, TargetUID: target.UID, Draining: true},
			Reason: "retry the idempotent Host placement fence",
		}
	}
	if !target.Quiescent || target.ActiveActors != 0 || target.InFlight != 0 || target.Queued != 0 {
		return stay(current, "waiting for the target Host to become exactly quiescent")
	}
	return Decision{
		State:  withPhase(current, PhaseReadyToScaleDown, snapshot.Now),
		Action: Action{Kind: ActionNone},
		Reason: "the fenced Host is quiescent and ready for StatefulSet scale-down",
	}
}

func decideReadyToScaleDown(current State, snapshot Snapshot) Decision {
	target, found := exactTarget(current, snapshot.Hosts)
	if !found {
		return reset(current, snapshot.Now, "quiescent Host identity disappeared before scale-down")
	}
	if abortReason := drainAbortReason(current, snapshot, target); abortReason != "" {
		return Decision{
			State:  withPhase(current, PhaseAborting, snapshot.Now),
			Action: Action{Kind: ActionSetDraining, TargetName: target.Name, TargetUID: target.UID, Draining: false},
			Reason: abortReason,
		}
	}
	if snapshot.Replicas != current.FromReplicas || target.Ordinal != current.FromReplicas-1 {
		return Decision{
			State:  withPhase(current, PhaseAborting, snapshot.Now),
			Action: Action{Kind: ActionSetDraining, TargetName: target.Name, TargetUID: target.UID, Draining: false},
			Reason: "StatefulSet shape changed before the scale-down boundary",
		}
	}
	if !target.Draining || target.Accepting || !target.Quiescent || target.ActiveActors != 0 || target.InFlight != 0 || target.Queued != 0 {
		return Decision{
			State:  withPhase(current, PhaseDraining, snapshot.Now),
			Action: Action{Kind: ActionNone},
			Reason: "target lost exact quiescence before scale-down; return to draining",
		}
	}
	nextReplicas := current.FromReplicas - 1
	if nextReplicas < snapshot.MinReplicas {
		return Decision{
			State:  withPhase(current, PhaseAborting, snapshot.Now),
			Action: Action{Kind: ActionSetDraining, TargetName: target.Name, TargetUID: target.UID, Draining: false},
			Reason: "scale-down would cross minReplicas",
		}
	}
	return Decision{
		State:  withPhase(current, PhaseScalingDown, snapshot.Now),
		Action: Action{Kind: ActionSetReplicas, Replicas: nextReplicas},
		Reason: "remove exactly one already-quiescent highest ordinal",
	}
}

func decideScalingDown(current State, snapshot Snapshot) Decision {
	target, found := exactTarget(current, snapshot.Hosts)
	want := current.FromReplicas - 1
	if snapshot.Replicas > current.FromReplicas {
		return abortSupersededScaleDown(current, snapshot, target, found)
	}
	if snapshot.Replicas == current.FromReplicas && found {
		if abortReason := drainAbortReason(current, snapshot, target); abortReason != "" {
			return Decision{
				State:  withPhase(current, PhaseAborting, snapshot.Now),
				Action: Action{Kind: ActionSetDraining, TargetName: target.Name, TargetUID: target.UID, Draining: false},
				Reason: abortReason,
			}
		}
		if target.Draining && !target.Accepting && target.Quiescent && target.ActiveActors == 0 && target.InFlight == 0 && target.Queued == 0 {
			return Decision{
				State:  current,
				Action: Action{Kind: ActionSetReplicas, Replicas: want},
				Reason: "retry the idempotent one-Host StatefulSet scale-down",
			}
		}
		return Decision{State: withPhase(current, PhaseDraining, snapshot.Now), Action: Action{Kind: ActionNone}, Reason: "scale-down was not applied and target is no longer quiescent"}
	}
	if snapshot.Replicas == current.FromReplicas && !found {
		return reset(current, snapshot.Now, "scale-down was not applied and the target identity disappeared")
	}
	if snapshot.Replicas == want && (!found || target.Terminating) {
		return Decision{State: withPhase(current, PhaseConverging, snapshot.Now), Action: Action{Kind: ActionNone}, Reason: "the drained ordinal has disappeared"}
	}
	return stay(current, "waiting for Kubernetes to remove the drained Host")
}

func decideConverging(current State, snapshot Snapshot) Decision {
	want := current.FromReplicas - 1
	target, targetFound := exactTarget(current, snapshot.Hosts)
	if snapshot.Replicas == want && snapshot.ReadyReplicas == want && !targetFound {
		// The stabilization window qualifies one continuous low-load contraction
		// episode, not every individual Host in that episode.  Re-evaluate every
		// fail-closed capacity, demand and topology invariant after the previous
		// ordinal has disappeared, then select at most one next Host.  Any rising
		// demand or incomplete evidence resets to Idle, so a later contraction
		// must earn a fresh stabilization window.
		if reason := contractionBlockReason(snapshot); reason != "" {
			return reset(current, snapshot.Now, "the one-Host scale-down converged; contraction stopped: "+reason)
		}
		return selectTarget(current, snapshot)
	}
	if snapshot.Replicas >= current.FromReplicas {
		return abortSupersededScaleDown(current, snapshot, target, targetFound)
	}
	return stay(current, "waiting for all remaining Hosts to become Ready")
}

func abortSupersededScaleDown(current State, snapshot Snapshot, target *Host, found bool) Decision {
	// A scale-up can preserve the old ordinal or recreate it with a different
	// Pod UID. Only the exact old identity may receive an unfence action. A
	// replacement must never inherit that action, while a surviving old Host
	// must not remain permanently fenced after the operation is forgotten.
	if !found || target.Terminating {
		return reset(current, snapshot.Now, "scale-up superseded scale-down; clear the stale target identity")
	}
	if target.Draining || !target.Accepting {
		return Decision{
			State:  withPhase(current, PhaseAborting, snapshot.Now),
			Action: Action{Kind: ActionSetDraining, TargetName: target.Name, TargetUID: target.UID, Draining: false},
			Reason: "scale-up superseded scale-down; restore the surviving target Host",
		}
	}
	return reset(current, snapshot.Now, "scale-up superseded scale-down and the target already accepts placement")
}

func decideAborting(current State, snapshot Snapshot) Decision {
	target, found := exactTarget(current, snapshot.Hosts)
	if !found {
		return reset(current, snapshot.Now, "target disappeared while aborting; clear the stale operation")
	}
	if target.Terminating {
		return reset(current, snapshot.Now, "target is already terminating while aborting; clear the stale operation")
	}
	if target.Draining || !target.Accepting {
		return Decision{
			State:  current,
			Action: Action{Kind: ActionSetDraining, TargetName: target.Name, TargetUID: target.UID, Draining: false},
			Reason: "waiting for the target Host to restore placement capacity",
		}
	}
	return reset(current, snapshot.Now, "the target Host restored placement capacity")
}

func scaleInBlockReason(snapshot Snapshot, selected *Host) string {
	if snapshot.WorkloadUID == "" {
		return "workload identity is missing"
	}
	if snapshot.Replicas <= snapshot.MinReplicas {
		return "minReplicas already reached"
	}
	if snapshot.ReadyReplicas != snapshot.Replicas || int32(len(snapshot.Hosts)) != snapshot.Replicas {
		return "not every desired Host is observed Ready"
	}
	if snapshot.DemandRising || snapshot.ScaleUpPending {
		return "demand is rising or a scale-up is pending"
	}
	if snapshot.MaxRemainingUsagePct < 1 || snapshot.MaxRemainingUsagePct > 100 {
		return "remaining utilization ceiling is outside 1..100 percent"
	}
	for index := range snapshot.Hosts {
		host := &snapshot.Hosts[index]
		if host.UID == "" || !host.Ready || host.Terminating || host.Capacity <= 0 {
			return "Host identity, readiness, termination, or capacity evidence is incomplete"
		}
		if host.ActiveActors < 0 || host.ActiveActors > host.Capacity || host.RequestCapacity <= 0 ||
			host.InFlight < 0 || host.InFlight > host.RequestCapacity || host.Queued < 0 {
			return "Host capacity counters are invalid"
		}
		if host.ObservedAt.IsZero() || host.ObservedAt.After(snapshot.Now) || snapshot.Now.Sub(host.ObservedAt) > snapshot.MetricsFreshness {
			return "Host metrics are stale"
		}
		if selected == nil && (host.Draining || !host.Accepting) {
			return "another Host is already draining"
		}
	}

	target := selected
	if target == nil {
		target = highestOrdinal(snapshot.Hosts)
	}
	if target == nil {
		return "no highest ordinal is available"
	}
	if reason := topologyScaleInBlockReason(snapshot, target); reason != "" {
		return reason
	}
	var active, remainingCapacity, inFlight, remainingRequestCapacity int64
	for _, host := range snapshot.Hosts {
		var ok bool
		if active, ok = checkedAdd(active, host.ActiveActors); !ok {
			return "aggregate actor usage overflowed"
		}
		if inFlight, ok = checkedAdd(inFlight, host.InFlight); !ok {
			return "aggregate request usage overflowed"
		}
		if host.Queued != 0 {
			return "a Host request queue is not empty"
		}
		if host.UID != target.UID {
			if remainingCapacity, ok = checkedAdd(remainingCapacity, host.Capacity); !ok {
				return "aggregate actor capacity overflowed"
			}
			if remainingRequestCapacity, ok = checkedAdd(remainingRequestCapacity, host.RequestCapacity); !ok {
				return "aggregate request capacity overflowed"
			}
		}
	}
	if remainingCapacity <= 0 || productGreater(active, 100, remainingCapacity, snapshot.MaxRemainingUsagePct) {
		return "remaining actor capacity would exceed the configured utilization ceiling"
	}
	if remainingRequestCapacity <= 0 || productGreater(inFlight, 100, remainingRequestCapacity, snapshot.MaxRemainingUsagePct) {
		return "remaining request capacity would exceed the configured utilization ceiling"
	}
	return ""
}

// A StatefulSet always removes its highest ordinal. The scheduler's topology
// spread constraint only applies while placing Pods; it cannot make that
// ordinal land in an over-represented zone. Prove the remaining set still
// spans every required zone within maxSkew before fencing or deleting it.
func topologyScaleInBlockReason(snapshot Snapshot, target *Host) string {
	if snapshot.RequiredZones == 0 && snapshot.TopologyMaxSkew == 0 {
		return ""
	}
	if snapshot.RequiredZones < 1 || snapshot.TopologyMaxSkew < 1 {
		return "runtime topology policy is invalid"
	}
	counts := make(map[string]int, snapshot.RequiredZones)
	for index := range snapshot.Hosts {
		host := &snapshot.Hosts[index]
		if host.UID == target.UID {
			continue
		}
		if host.Zone == "" {
			return "Host topology evidence is incomplete"
		}
		counts[host.Zone]++
	}
	if len(counts) != snapshot.RequiredZones {
		return "scale-down would remove a required runtime zone"
	}
	minimum, maximum := math.MaxInt, 0
	for _, count := range counts {
		if count < minimum {
			minimum = count
		}
		if count > maximum {
			maximum = count
		}
	}
	// StatefulSet scale-in can remove only the highest ordinal. Even when the
	// scheduler produced a balanced fleet, arbitrary ordinal-to-zone ordering
	// can therefore make strict maxSkew=1 impossible at an intermediate prefix.
	// Keep the configured bound as the steady-state goal, but permit a small,
	// bounded contraction skew: at most two Hosts per required zone or five
	// percent of the remaining fleet, whichever is larger. A three-Host floor
	// was insufficient for a real three-zone StatefulSet prefix (24/29/28):
	// deleting its highest ordinal temporarily produces 23/29/28 even though
	// the already-placed low prefix converges to 2/1/1. RequiredZones above
	// remains a hard invariant, so this relaxation can never drain a zone
	// completely.
	remaining := len(snapshot.Hosts) - 1
	contractionSkew := (remaining + 19) / 20
	zoneFloor := snapshot.RequiredZones * 2
	if contractionSkew < zoneFloor {
		contractionSkew = zoneFloor
	}
	allowedSkew := snapshot.TopologyMaxSkew
	if contractionSkew > allowedSkew {
		allowedSkew = contractionSkew
	}
	if maximum-minimum > allowedSkew {
		return "scale-down would violate runtime topology maxSkew"
	}
	return ""
}

func checkedAdd(left, right int64) (int64, bool) {
	if left < 0 || right < 0 || left > math.MaxInt64-right {
		return 0, false
	}
	return left + right, true
}

func productGreater(leftA, leftB, rightA, rightB int64) bool {
	leftHigh, leftLow := bits.Mul64(uint64(leftA), uint64(leftB))
	rightHigh, rightLow := bits.Mul64(uint64(rightA), uint64(rightB))
	return leftHigh > rightHigh || leftHigh == rightHigh && leftLow > rightLow
}

func drainAbortReason(current State, snapshot Snapshot, target *Host) string {
	if snapshot.DemandRising || snapshot.ScaleUpPending {
		return "abort drain because demand rose or scale-up became pending"
	}
	if snapshot.Replicas != current.FromReplicas || snapshot.ReadyReplicas != current.FromReplicas {
		return "abort drain because the StatefulSet changed concurrently"
	}
	if snapshot.Now.Sub(current.StartedAt) >= snapshot.DrainTimeout {
		return "abort drain because the bounded drain deadline expired"
	}
	if reason := scaleInBlockReason(snapshot, target); reason != "" {
		return "abort drain: " + reason
	}
	return ""
}

func highestOrdinal(hosts []Host) *Host {
	if len(hosts) == 0 {
		return nil
	}
	ordered := append([]Host(nil), hosts...)
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].Ordinal != ordered[j].Ordinal {
			return ordered[i].Ordinal > ordered[j].Ordinal
		}
		return ordered[i].Name < ordered[j].Name
	})
	return &ordered[0]
}

func exactTarget(state State, hosts []Host) (*Host, bool) {
	for index := range hosts {
		if hosts[index].Name == state.TargetName && hosts[index].UID == state.TargetUID {
			return &hosts[index], true
		}
	}
	return nil, false
}

func validateState(state State) error {
	if isRebalancePhase(state.Phase) {
		if state.TargetName == "" || state.TargetUID == "" || state.FromReplicas < 2 ||
			state.StartedAt.IsZero() || state.RepairWorkloadUID == "" || state.RepairSourceZone == "" ||
			state.RepairDestinationZone == "" || state.RepairDestinationZone == state.RepairSourceZone ||
			state.RepairPrefixScore <= 0 {
			return fmt.Errorf("rebalance state must retain exact target, workload, zones and prefix score")
		}
		if (state.Phase == PhaseRebalanceEvicting || state.Phase == PhaseRebalanceCancelling ||
			state.Phase == PhaseRebalanceReplacing || state.Phase == PhaseRebalanceBlocked) && state.EvictionResourceVersion == "" {
			return fmt.Errorf("rebalance eviction state must retain the authorized Pod resourceVersion")
		}
		return nil
	}
	if state.Phase == PhaseIdle || state.Phase == PhaseObserving {
		if state.TargetName != "" || state.TargetUID != "" || state.FromReplicas != 0 {
			return fmt.Errorf("idle or observing state must not retain a drain target")
		}
		if state.Phase == PhaseObserving && state.StartedAt.IsZero() {
			return fmt.Errorf("observing state must retain its low-load start time")
		}
		return nil
	}
	if state.TargetName == "" || state.TargetUID == "" || state.FromReplicas < 2 || state.StartedAt.IsZero() {
		return fmt.Errorf("active drain state must identify exactly one target and source replica count")
	}
	return nil
}

func withPhase(state State, phase Phase, now time.Time) State {
	state.Phase = phase
	state.TransitionAt = now
	return state
}

func reset(state State, now time.Time, reason string) Decision {
	return Decision{
		State:  State{Phase: PhaseIdle, Epoch: state.Epoch, TransitionAt: now},
		Action: Action{Kind: ActionNone},
		Reason: reason,
	}
}

func stay(state State, reason string) Decision {
	return Decision{State: state, Action: Action{Kind: ActionNone}, Reason: reason}
}
