package hostdrain

import (
	"fmt"
	"testing"
	"time"
)

func TestSerialDrainHappyPathRemovesExactlyOneHighestOrdinal(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	state := State{Phase: PhaseIdle}

	decision := Decide(state, snapshot)
	if decision.State.Phase != PhaseSelected || decision.State.TargetName != "runtime-2" || decision.Action.Kind != ActionNone {
		t.Fatalf("selection = %#v", decision)
	}
	state = decision.State

	decision = Decide(state, snapshot)
	if decision.State.Phase != PhaseDraining || decision.Action.Kind != ActionSetDraining || !decision.Action.Draining {
		t.Fatalf("start drain = %#v", decision)
	}
	state = decision.State
	snapshot.Hosts[2].Draining = true
	snapshot.Hosts[2].Accepting = false
	snapshot.Hosts[2].ActiveActors = 0
	snapshot.Hosts[2].Quiescent = true

	decision = Decide(state, snapshot)
	if decision.State.Phase != PhaseReadyToScaleDown || decision.Action.Kind != ActionNone {
		t.Fatalf("quiescent = %#v", decision)
	}
	state = decision.State

	decision = Decide(state, snapshot)
	if decision.State.Phase != PhaseScalingDown || decision.Action.Kind != ActionSetReplicas || decision.Action.Replicas != 2 {
		t.Fatalf("scale down = %#v", decision)
	}
	state = decision.State
	snapshot.Replicas = 2
	snapshot.ReadyReplicas = 2
	snapshot.Hosts = snapshot.Hosts[:2]

	decision = Decide(state, snapshot)
	if decision.State.Phase != PhaseConverging {
		t.Fatalf("pod removal = %#v", decision)
	}
	decision = Decide(decision.State, snapshot)
	if decision.State.Phase != PhaseIdle || decision.State.Epoch != 1 {
		t.Fatalf("convergence = %#v", decision)
	}
}

func TestStableContractionSelectsNextHostWithoutAnotherObservationWindow(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	snapshot.Replicas = 4
	snapshot.ReadyReplicas = 4
	snapshot.MinReplicas = 2
	snapshot.ScaleDownStabilization = 5 * time.Minute
	snapshot.Hosts = append(snapshot.Hosts, Host{
		Name: "runtime-3", UID: "uid-3", Ordinal: 3, Ready: true, Accepting: true,
		Capacity: 4, RequestCapacity: 4, ObservedAt: now,
	})
	state := State{
		Phase: PhaseConverging, Epoch: 8, TargetName: "runtime-4", TargetUID: "uid-4",
		FromReplicas: 5, StartedAt: now.Add(-time.Minute), TransitionAt: now.Add(-time.Second),
	}

	decision := Decide(state, snapshot)
	if decision.State.Phase != PhaseSelected || decision.State.TargetName != "runtime-3" || decision.State.Epoch != 9 {
		t.Fatalf("continuous contraction restarted stabilization: %#v", decision)
	}
	if decision.Action.Kind != ActionNone {
		t.Fatalf("next serial selection performed an action too early: %#v", decision.Action)
	}
}

func TestStableContractionStopsImmediatelyWhenDemandRises(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	snapshot.Replicas = 2
	snapshot.ReadyReplicas = 2
	snapshot.Hosts = snapshot.Hosts[:2]
	snapshot.DemandRising = true
	state := State{
		Phase: PhaseConverging, Epoch: 8, TargetName: "runtime-2", TargetUID: "uid-2",
		FromReplicas: 3, StartedAt: now.Add(-time.Minute), TransitionAt: now.Add(-time.Second),
	}

	decision := Decide(state, snapshot)
	if decision.State.Phase != PhaseIdle || decision.State.Epoch != state.Epoch || decision.Action.Kind != ActionNone {
		t.Fatalf("rising demand did not terminate contraction episode: %#v", decision)
	}
}

func TestDemandRiseAbortsAndRestoresTheSameHost(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	state := Decide(State{Phase: PhaseIdle}, snapshot).State
	state = Decide(state, snapshot).State
	snapshot.Hosts[2].Draining = true
	snapshot.Hosts[2].Accepting = false
	snapshot.DemandRising = true

	decision := Decide(state, snapshot)
	if decision.State.Phase != PhaseAborting || decision.Action.Kind != ActionSetDraining || decision.Action.Draining {
		t.Fatalf("abort = %#v", decision)
	}
	if decision.Action.TargetUID != "uid-2" {
		t.Fatalf("abort changed target identity: %#v", decision.Action)
	}

	snapshot.Hosts[2].Draining = false
	snapshot.Hosts[2].Accepting = true
	decision = Decide(decision.State, snapshot)
	if decision.State.Phase != PhaseIdle || decision.Action.Kind != ActionNone {
		t.Fatalf("restored = %#v", decision)
	}
}

func TestScaleUpSignalsAbortEveryPreScalePhaseWithoutChangingReplicas(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	for _, phase := range []Phase{PhaseSelected, PhaseDraining, PhaseReadyToScaleDown} {
		t.Run(string(phase), func(t *testing.T) {
			snapshot := healthySnapshot(now)
			state := State{
				Phase: phase, Epoch: 7, TargetName: "runtime-2", TargetUID: "uid-2",
				FromReplicas: 3, StartedAt: now, TransitionAt: now,
			}
			snapshot.Hosts[2].Draining = phase != PhaseSelected
			snapshot.Hosts[2].Accepting = phase == PhaseSelected
			snapshot.ScaleUpPending = true

			decision := Decide(state, snapshot)
			if decision.Action.Kind == ActionSetReplicas {
				t.Fatalf("scale-up race changed replicas: %#v", decision)
			}
			if phase == PhaseSelected {
				if decision.State.Phase != PhaseIdle {
					t.Fatalf("selection was not cancelled: %#v", decision)
				}
			} else if decision.State.Phase != PhaseAborting || decision.Action.Kind != ActionSetDraining || decision.Action.Draining {
				t.Fatalf("active drain was not restored: %#v", decision)
			}
		})
	}
}

func TestPersistedActionPhasesRetryIdempotentlyAfterControllerCrash(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	selected := State{
		Phase: PhaseSelected, Epoch: 9, TargetName: "runtime-2", TargetUID: "uid-2",
		FromReplicas: 3, StartedAt: now, TransitionAt: now,
	}
	decision := Decide(selected, snapshot)
	if decision.State.Phase != PhaseDraining || decision.Action.Kind != ActionSetDraining || !decision.Action.Draining {
		t.Fatalf("selected crash recovery = %#v", decision)
	}

	snapshot.Hosts[2].Draining = true
	snapshot.Hosts[2].Accepting = false
	snapshot.Hosts[2].ActiveActors = 0
	snapshot.Hosts[2].Quiescent = true
	scaling := State{
		Phase: PhaseScalingDown, Epoch: 9, TargetName: "runtime-2", TargetUID: "uid-2",
		FromReplicas: 3, StartedAt: now, TransitionAt: now,
	}
	decision = Decide(scaling, snapshot)
	if decision.State != scaling || decision.Action.Kind != ActionSetReplicas || decision.Action.Replicas != 2 {
		t.Fatalf("scale action crash recovery = %#v", decision)
	}
}

func TestExistingDrainBlocksASecondTarget(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	snapshot.Hosts[0].Draining = true
	snapshot.Hosts[0].Accepting = false

	decision := Decide(State{Phase: PhaseIdle}, snapshot)
	if decision.State.Phase != PhaseIdle || decision.Action.Kind != ActionNone {
		t.Fatalf("second drain was admitted: %#v", decision)
	}
}

func TestLowLoadMustRemainStableBeforeSelectingAHost(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	snapshot.ScaleDownStabilization = 5 * time.Minute

	decision := Decide(State{Phase: PhaseIdle}, snapshot)
	if decision.State.Phase != PhaseObserving || decision.State.TargetUID != "" {
		t.Fatalf("observation start = %#v", decision)
	}
	snapshot.Now = now.Add(4 * time.Minute)
	for index := range snapshot.Hosts {
		snapshot.Hosts[index].ObservedAt = snapshot.Now
	}
	decision = Decide(decision.State, snapshot)
	if decision.State.Phase != PhaseObserving {
		t.Fatalf("early selection = %#v", decision)
	}

	snapshot.Now = now.Add(5 * time.Minute)
	for index := range snapshot.Hosts {
		snapshot.Hosts[index].ObservedAt = snapshot.Now
	}
	decision = Decide(decision.State, snapshot)
	if decision.State.Phase != PhaseSelected || decision.State.TargetName != "runtime-2" {
		t.Fatalf("stable selection = %#v", decision)
	}
}

func TestStaleEvidenceAndRemainingHeadroomFailClosed(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	snapshot.Hosts[1].ObservedAt = now.Add(-time.Minute)
	if decision := Decide(State{Phase: PhaseIdle}, snapshot); decision.State.Phase != PhaseIdle {
		t.Fatalf("stale evidence admitted scale-in: %#v", decision)
	}

	snapshot = healthySnapshot(now)
	for index := range snapshot.Hosts {
		snapshot.Hosts[index].ActiveActors = 3
		snapshot.Hosts[index].Capacity = 4
	}
	if decision := Decide(State{Phase: PhaseIdle}, snapshot); decision.State.Phase != PhaseIdle {
		t.Fatalf("unsafe remaining utilization admitted scale-in: %#v", decision)
	}
}

func TestScaleDownRequiresBalancedRemainingRuntimeTopology(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	snapshot.MinReplicas = 2
	snapshot.RequiredZones = 3
	snapshot.TopologyMaxSkew = 1
	snapshot.Hosts[0].Zone = "zone-a"
	snapshot.Hosts[1].Zone = "zone-b"
	snapshot.Hosts[2].Zone = "zone-c"
	decision := Decide(State{Phase: PhaseIdle}, snapshot)
	if decision.State.Phase != PhaseIdle || decision.Reason != "scale-down would remove a required runtime zone" {
		t.Fatalf("required-zone removal was admitted: %#v", decision)
	}

	snapshot = healthySnapshot(now)
	snapshot.Replicas = 7
	snapshot.ReadyReplicas = 7
	snapshot.MinReplicas = 3
	snapshot.RequiredZones = 3
	snapshot.TopologyMaxSkew = 1
	snapshot.Hosts = append(snapshot.Hosts,
		Host{Name: "runtime-3", UID: "uid-3", Ordinal: 3, Zone: "zone-a", Ready: true, Accepting: true, Capacity: 4, RequestCapacity: 4, ObservedAt: now},
		Host{Name: "runtime-4", UID: "uid-4", Ordinal: 4, Zone: "zone-b", Ready: true, Accepting: true, Capacity: 4, RequestCapacity: 4, ObservedAt: now},
		Host{Name: "runtime-5", UID: "uid-5", Ordinal: 5, Zone: "zone-c", Ready: true, Accepting: true, Capacity: 4, RequestCapacity: 4, ObservedAt: now},
		Host{Name: "runtime-6", UID: "uid-6", Ordinal: 6, Zone: "zone-a", Ready: true, Accepting: true, Capacity: 4, RequestCapacity: 4, ObservedAt: now},
	)
	snapshot.Hosts[0].Zone = "zone-a"
	snapshot.Hosts[1].Zone = "zone-b"
	snapshot.Hosts[2].Zone = "zone-c"
	decision = Decide(State{Phase: PhaseIdle}, snapshot)
	if decision.State.Phase != PhaseSelected || decision.State.TargetName != "runtime-6" {
		t.Fatalf("balanced highest-ordinal removal was rejected: %#v", decision)
	}

	// A small transient skew is unavoidable because StatefulSet can remove only
	// the highest ordinal. It remains bounded while every required zone stays
	// represented.
	snapshot.Hosts[4].Zone = "zone-a"
	snapshot.Hosts[6].Zone = "zone-b"
	decision = Decide(State{Phase: PhaseIdle}, snapshot)
	if decision.State.Phase != PhaseSelected {
		t.Fatalf("bounded contraction skew was rejected: %#v", decision)
	}
}

func TestScaleDownRejectsSkewBeyondBoundedContractionEnvelope(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	snapshot.Replicas = 20
	snapshot.ReadyReplicas = 20
	snapshot.MinReplicas = 3
	snapshot.RequiredZones = 3
	snapshot.TopologyMaxSkew = 1
	snapshot.Hosts = nil
	zones := []string{
		"zone-a", "zone-a", "zone-a", "zone-a", "zone-a", "zone-a", "zone-a", "zone-a",
		"zone-a", "zone-a", "zone-a", "zone-a", "zone-a", "zone-a", "zone-a", "zone-a",
		"zone-b", "zone-b", "zone-c", "zone-c",
	}
	for ordinal, zone := range zones {
		snapshot.Hosts = append(snapshot.Hosts, Host{
			Name: fmt.Sprintf("runtime-%d", ordinal), UID: fmt.Sprintf("uid-%d", ordinal),
			Ordinal: int32(ordinal), Zone: zone, Ready: true, Accepting: true,
			Capacity: 4, RequestCapacity: 4, ObservedAt: now,
		})
	}
	decision := Decide(State{Phase: PhaseIdle}, snapshot)
	if decision.State.Phase != PhaseIdle || decision.Reason != "scale-down would violate runtime topology maxSkew" {
		t.Fatalf("unsafe contraction skew was admitted: %#v", decision)
	}
}

func TestScaleDownAllowsObservedThreeZoneStatefulSetPrefix(t *testing.T) {
	now := time.Date(2026, 9, 20, 10, 20, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	snapshot.Replicas = 81
	snapshot.ReadyReplicas = 81
	snapshot.MinReplicas = 4
	snapshot.RequiredZones = 3
	snapshot.TopologyMaxSkew = 1
	snapshot.Hosts = nil
	// The highest ordinal is in zone-a. Removing it leaves 23/29/28. This is a
	// bounded intermediate prefix, and every required zone remains represented.
	counts := map[string]int{"zone-a": 24, "zone-b": 29, "zone-c": 28}
	ordinal := 0
	for _, zone := range []string{"zone-b", "zone-c", "zone-a"} {
		for index := 0; index < counts[zone]; index++ {
			snapshot.Hosts = append(snapshot.Hosts, Host{
				Name: fmt.Sprintf("runtime-%d", ordinal), UID: fmt.Sprintf("uid-%d", ordinal),
				Ordinal: int32(ordinal), Zone: zone, Ready: true, Accepting: true,
				Capacity: 4, RequestCapacity: 4, ObservedAt: now,
			})
			ordinal++
		}
	}
	// StatefulSet removes the largest ordinal, so make that exact identity the
	// final zone-a member while preserving the observed totals.
	snapshot.Hosts[len(snapshot.Hosts)-1].Zone = "zone-a"
	decision := Decide(State{Phase: PhaseIdle}, snapshot)
	if decision.State.Phase != PhaseSelected || decision.State.TargetName != "runtime-80" {
		t.Fatalf("observed bounded contraction prefix was rejected: %#v", decision)
	}
}

func TestMalformedCapacityEvidenceFailsClosed(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	tests := map[string]func(*Snapshot){
		"negative actors":          func(snapshot *Snapshot) { snapshot.Hosts[0].ActiveActors = -1 },
		"actors above capacity":    func(snapshot *Snapshot) { snapshot.Hosts[0].ActiveActors = 5 },
		"negative in flight":       func(snapshot *Snapshot) { snapshot.Hosts[0].InFlight = -1 },
		"in flight above capacity": func(snapshot *Snapshot) { snapshot.Hosts[0].InFlight = 5 },
		"negative queue":           func(snapshot *Snapshot) { snapshot.Hosts[0].Queued = -1 },
		"invalid utilization":      func(snapshot *Snapshot) { snapshot.MaxRemainingUsagePct = 101 },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			snapshot := healthySnapshot(now)
			mutate(&snapshot)
			decision := Decide(State{Phase: PhaseIdle}, snapshot)
			if decision.State.Phase != PhaseIdle || decision.Action.Kind != ActionNone {
				t.Fatalf("malformed evidence admitted scale-in: %#v", decision)
			}
		})
	}
}

func TestTimeoutAbortsWithoutChangingReplicas(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	state := Decide(State{Phase: PhaseIdle}, snapshot).State
	state = Decide(state, snapshot).State
	snapshot.Hosts[2].Draining = true
	snapshot.Hosts[2].Accepting = false
	snapshot.Now = now.Add(10 * time.Minute)
	for index := range snapshot.Hosts {
		snapshot.Hosts[index].ObservedAt = snapshot.Now
	}

	decision := Decide(state, snapshot)
	if decision.State.Phase != PhaseAborting || decision.Action.Kind != ActionSetDraining || decision.Action.Draining {
		t.Fatalf("timeout = %#v", decision)
	}
	if decision.Action.Kind == ActionSetReplicas {
		t.Fatal("timeout must never force a scale-down")
	}
}

func TestTargetUIDReplacementFailsClosed(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	state := Decide(State{Phase: PhaseIdle}, snapshot).State
	snapshot.Hosts[2].UID = "replacement"

	decision := Decide(state, snapshot)
	if decision.State.Phase != PhaseIdle || decision.Action.Kind != ActionNone {
		t.Fatalf("replacement Pod inherited a drain: %#v", decision)
	}
}

func TestReplacementUIDCannotInheritAnyActiveDrainPhase(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	for _, phase := range []Phase{PhaseSelected, PhaseDraining, PhaseReadyToScaleDown, PhaseScalingDown} {
		t.Run(string(phase), func(t *testing.T) {
			snapshot := healthySnapshot(now)
			snapshot.Hosts[2].UID = "replacement"
			state := State{
				Phase: phase, Epoch: 11, TargetName: "runtime-2", TargetUID: "uid-2",
				FromReplicas: 3, StartedAt: now, TransitionAt: now,
			}
			decision := Decide(state, snapshot)
			if decision.Action.Kind != ActionNone || decision.State.Phase != PhaseIdle {
				t.Fatalf("replacement inherited %s: %#v", phase, decision)
			}
			if decision.State.Epoch != state.Epoch {
				t.Fatalf("replacement reset changed epoch: %#v", decision.State)
			}
		})
	}
}

func TestScalingDownAcceptsTheExpectedTerminatingTarget(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	state := Decide(State{Phase: PhaseIdle}, snapshot).State
	state = Decide(state, snapshot).State
	snapshot.Hosts[2].Draining = true
	snapshot.Hosts[2].Accepting = false
	snapshot.Hosts[2].ActiveActors = 0
	snapshot.Hosts[2].Quiescent = true
	state = Decide(state, snapshot).State
	state = Decide(state, snapshot).State
	snapshot.Replicas = 2
	snapshot.ReadyReplicas = 2
	snapshot.Hosts[2] = Host{
		Name: "runtime-2", UID: "uid-2", Ordinal: 2, Terminating: true, ObservedAt: now,
	}

	decision := Decide(state, snapshot)
	if decision.State.Phase != PhaseConverging || decision.Action.Kind != ActionNone {
		t.Fatalf("terminating target = %#v", decision)
	}
}

func TestScaleUpDuringConvergenceClearsStaleTargetWithoutTouchingReplacement(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	state := State{
		Phase: PhaseConverging, Epoch: 9, TargetName: "runtime-2", TargetUID: "old-uid-2",
		FromReplicas: 3, StartedAt: now.Add(-time.Minute), TransitionAt: now.Add(-time.Second),
	}
	snapshot.Hosts[2].UID = "replacement-uid-2"

	decision := Decide(state, snapshot)
	if decision.State.Phase != PhaseIdle || decision.State.Epoch != state.Epoch {
		t.Fatalf("scale-up convergence recovery = %#v", decision)
	}
	if decision.Action.Kind != ActionNone {
		t.Fatalf("replacement Pod inherited a drain action: %#v", decision.Action)
	}
}

func TestScaleUpDuringScalingDownRestoresTheSurvivingTarget(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	state := State{
		Phase: PhaseScalingDown, Epoch: 9, TargetName: "runtime-2", TargetUID: "uid-2",
		FromReplicas: 3, StartedAt: now.Add(-time.Minute), TransitionAt: now.Add(-time.Second),
	}
	snapshot.Replicas = 4
	snapshot.Hosts[2].Draining = true
	snapshot.Hosts[2].Accepting = false

	decision := Decide(state, snapshot)
	if decision.State.Phase != PhaseAborting || decision.Action.Kind != ActionSetDraining || decision.Action.Draining {
		t.Fatalf("scale-up scaling-down recovery = %#v", decision)
	}
	if decision.Action.TargetUID != state.TargetUID {
		t.Fatalf("scale-up changed target identity: %#v", decision.Action)
	}
	if decision.Action.Kind == ActionSetReplicas {
		t.Fatalf("scale-up recovery attempted another replica mutation: %#v", decision.Action)
	}
}

func TestScaleUpDuringConvergenceRestoresTheSurvivingTarget(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	snapshot := healthySnapshot(now)
	state := State{
		Phase: PhaseConverging, Epoch: 9, TargetName: "runtime-2", TargetUID: "uid-2",
		FromReplicas: 3, StartedAt: now.Add(-time.Minute), TransitionAt: now.Add(-time.Second),
	}
	snapshot.Hosts[2].Draining = true
	snapshot.Hosts[2].Accepting = false

	decision := Decide(state, snapshot)
	if decision.State.Phase != PhaseAborting || decision.Action.Kind != ActionSetDraining || decision.Action.Draining {
		t.Fatalf("scale-up convergence recovery = %#v", decision)
	}
	if decision.Action.TargetUID != state.TargetUID {
		t.Fatalf("scale-up changed target identity: %#v", decision.Action)
	}
}

func healthySnapshot(now time.Time) Snapshot {
	hosts := make([]Host, 3)
	for index := range hosts {
		hosts[index] = Host{
			Name: "runtime-" + string(rune('0'+index)), UID: "uid-" + string(rune('0'+index)), Ordinal: int32(index),
			Ready: true, Accepting: true, ActiveActors: 1, Capacity: 4, ObservedAt: now,
			RequestCapacity: 4,
		}
	}
	return Snapshot{
		Now: now, WorkloadUID: "statefulset-uid", Replicas: 3, ReadyReplicas: 3, MinReplicas: 2,
		MaxRemainingUsagePct: 70, MetricsFreshness: 45 * time.Second, DrainTimeout: 10 * time.Minute,
		ScaleDownStabilization: -1,
		Hosts:                  hosts,
	}
}
