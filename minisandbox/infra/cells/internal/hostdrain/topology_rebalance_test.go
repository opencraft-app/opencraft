package hostdrain

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"testing"
	"time"
)

func repairSnapshot() Snapshot {
	now := time.Date(2026, 10, 3, 21, 30, 19, 0, time.UTC)
	snapshot := healthySnapshot(now)
	snapshot.MinReplicas, snapshot.RequiredZones, snapshot.TopologyMaxSkew = 4, 3, 2
	snapshot.Hosts = nil
	appendHost := func(zone string) {
		ordinal := len(snapshot.Hosts)
		snapshot.Hosts = append(snapshot.Hosts, Host{
			Name: fmt.Sprintf("runtime-%d", ordinal), UID: fmt.Sprintf("uid-%d", ordinal), Ordinal: int32(ordinal),
			Zone: zone, Ready: true, Accepting: true, Quiescent: true, Capacity: 32,
			RequestCapacity: 32, ObservedAt: now, ResourceVersion: fmt.Sprint(1000 + ordinal),
		})
	}
	for index := 0; index < 34; index++ {
		for _, zone := range []string{"zone-a", "zone-b", "zone-c"} {
			appendHost(zone)
		}
	}
	for index := 0; index < 3; index++ {
		appendHost("zone-c")
	}
	for _, zone := range []string{"zone-b", "zone-c", "zone-c", "zone-c", "zone-c", "zone-a"} {
		appendHost(zone)
	}
	snapshot.Replicas, snapshot.ReadyReplicas = 111, 111
	snapshot.RebalanceZones = []string{"zone-b", "zone-a"}
	return snapshot
}

func selectedRepair(t *testing.T, snapshot Snapshot) State {
	t.Helper()
	decision := Decide(State{Phase: PhaseIdle}, snapshot)
	if decision.State.Phase != PhaseRebalanceSelected || decision.State.TargetName != "runtime-109" ||
		decision.State.TargetUID != "uid-109" || decision.State.RepairDestinationZone != "zone-a" ||
		decision.Action.Kind != ActionNone {
		t.Fatalf("repair selection = %#v", decision)
	}
	return decision.State
}

func authorizedEviction(t *testing.T) (State, Snapshot) {
	t.Helper()
	snapshot := repairSnapshot()
	state := selectedRepair(t, snapshot)
	decision := Decide(state, snapshot)
	if decision.State.Phase != PhaseRebalanceDraining || decision.Action.Kind != ActionSetDraining || !decision.Action.Draining {
		t.Fatalf("placement fence = %#v", decision)
	}
	snapshot.Hosts[109].Draining, snapshot.Hosts[109].Accepting = true, false
	decision = Decide(decision.State, snapshot)
	if decision.State.Phase != PhaseRebalanceReady || decision.Action.Kind != ActionNone {
		t.Fatalf("exact quiescence = %#v", decision)
	}
	decision = Decide(decision.State, snapshot)
	if decision.State.Phase != PhaseRebalanceEvicting || decision.Action.Kind != ActionEvictHost ||
		decision.Action.ResourceVersion != "1109" || decision.Action.TargetUID != "uid-109" {
		t.Fatalf("eviction authorization = %#v", decision)
	}
	return decision.State, snapshot
}

func TestTopologyRebalanceSerialHappyPath(t *testing.T) {
	state, snapshot := authorizedEviction(t)
	if state.FromReplicas != 111 || snapshot.Replicas != 111 {
		t.Fatal("repair changed the workload replica target")
	}
	snapshot.Hosts[109].Terminating = true
	decision := Decide(state, snapshot)
	if decision.State.Phase != PhaseRebalanceReplacing || decision.Action.Kind != ActionNone {
		t.Fatalf("termination wait = %#v", decision)
	}
	snapshot.Hosts[109].UID, snapshot.Hosts[109].ResourceVersion = "successor-uid", "2000"
	snapshot.Hosts[109].Terminating, snapshot.Hosts[109].Draining, snapshot.Hosts[109].Accepting = false, false, true
	snapshot.Hosts[109].Zone = "zone-a"
	decision = Decide(decision.State, snapshot)
	if decision.State.Phase != PhaseIdle || decision.Action.Kind != ActionNone || decision.State.TargetUID != "" {
		t.Fatalf("replacement convergence = %#v", decision)
	}
	decision = Decide(decision.State, snapshot)
	if decision.State.Phase != PhaseSelected || decision.State.TargetName != "runtime-110" {
		t.Fatalf("original serial scale-in was not restored: %#v", decision)
	}
}

func TestTopologyRebalanceRestartAndRejectedEvictionKeepExactAuthority(t *testing.T) {
	state, snapshot := authorizedEviction(t)
	payload, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	var restored State
	if err := json.Unmarshal(payload, &restored); err != nil {
		t.Fatal(err)
	}
	if restored != state {
		t.Fatal("persisted authority did not round-trip")
	}
	// PDB rejection and a lost response are indistinguishable to the pure
	// planner until Kubernetes reports a changed Pod. Retry only the same fence.
	for step := 0; step < 3; step++ {
		decision := Decide(restored, snapshot)
		if decision.State != state || decision.Action.Kind != ActionEvictHost ||
			decision.Action.TargetUID != state.TargetUID || decision.Action.ResourceVersion != state.EvictionResourceVersion {
			t.Fatalf("changed eviction authority at step %d: %#v", step, decision)
		}
	}
}

func TestTopologyRebalanceCancellationFencesLateEvictionBeforeUnfencing(t *testing.T) {
	for _, reason := range []string{"expansion", "deadline", "new Pod resourceVersion", "lost quiescence"} {
		t.Run(reason, func(t *testing.T) {
			state, snapshot := authorizedEviction(t)
			switch reason {
			case "expansion":
				snapshot.DemandRising = true
			case "deadline":
				snapshot.Now = snapshot.Now.Add(snapshot.DrainTimeout)
				for index := range snapshot.Hosts {
					snapshot.Hosts[index].ObservedAt = snapshot.Now
				}
			case "new Pod resourceVersion":
				snapshot.Hosts[109].ResourceVersion = "1110"
			case "lost quiescence":
				snapshot.Hosts[109].Quiescent = false
			}
			decision := Decide(state, snapshot)
			if decision.State.Phase != PhaseRebalanceCancelling || decision.Action.Kind != ActionCancelEviction ||
				decision.Action.TargetUID != "uid-109" {
				t.Fatalf("unfenced before cancellation: %#v", decision)
			}
			decision = Decide(decision.State, snapshot)
			if decision.Action.Kind != ActionCancelEviction {
				t.Fatalf("lost cancellation response advanced unsafely: %#v", decision)
			}
			// Only the trusted Kubernetes adapter may prove the exact epoch's
			// cancellation CAS. A changed RV by itself was not this proof.
			snapshot.Hosts[109].EvictionCancelled = true
			snapshot.Hosts[109].ResourceVersion = "cancelled-rv"
			decision = Decide(decision.State, snapshot)
			if decision.State.Phase != PhaseAborting || decision.Action.Kind != ActionSetDraining || decision.Action.Draining {
				t.Fatalf("cancellation did not restore old placement: %#v", decision)
			}
		})
	}
}

func TestTopologyRebalanceNeverActsOnSuccessorUID(t *testing.T) {
	state, snapshot := authorizedEviction(t)
	decision := Decide(state, snapshot)
	snapshot.Hosts[109].UID = "new-uid"
	snapshot.Hosts[109].Ready = false
	decision = Decide(decision.State, snapshot)
	if decision.Action.Kind != ActionNone {
		t.Fatalf("old action inherited by successor: %#v", decision)
	}
	snapshot.Hosts[109].Ready, snapshot.Hosts[109].Draining, snapshot.Hosts[109].Accepting = true, false, true
	decision = Decide(decision.State, snapshot)
	if decision.State.Phase != PhaseRebalanceBlocked || decision.Action.Kind != ActionNone {
		t.Fatalf("same-zone replacement caused a repair loop: %#v", decision)
	}
	if next := Decide(decision.State, snapshot); next.Action.Kind != ActionNone || next.State.Phase != PhaseRebalanceBlocked {
		t.Fatalf("non-improving replacement retried: %#v", next)
	}
}

func TestTopologyRebalanceEligibilityFailsClosed(t *testing.T) {
	mutations := map[string]func(*Snapshot){
		"no admitted spare zone":  func(s *Snapshot) { s.RebalanceZones = nil },
		"only surplus spare zone": func(s *Snapshot) { s.RebalanceZones = []string{"zone-c"} },
		"unknown zone":            func(s *Snapshot) { s.RebalanceZones = []string{"other"} },
		"expansion":               func(s *Snapshot) { s.ScaleUpPending = true },
		"stale counters":          func(s *Snapshot) { s.Hosts[0].ObservedAt = s.Now.Add(-time.Minute) },
		"missing Pod RV":          func(s *Snapshot) { s.Hosts[0].ResourceVersion = "" },
		"duplicate UID":           func(s *Snapshot) { s.Hosts[0].UID = s.Hosts[1].UID },
		"duplicate ordinal":       func(s *Snapshot) { s.Hosts[0].Ordinal = s.Hosts[1].Ordinal },
		"invalid ordinal":         func(s *Snapshot) { s.Hosts[0].Ordinal = s.Replicas },
		"another drain":           func(s *Snapshot) { s.Hosts[0].Draining = true },
		"all Actors active": func(s *Snapshot) {
			for index := range s.Hosts {
				s.Hosts[index].ActiveActors = 1
				s.Hosts[index].Quiescent = false
			}
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			snapshot := repairSnapshot()
			mutate(&snapshot)
			decision := Decide(State{Phase: PhaseIdle}, snapshot)
			if decision.State.Phase != PhaseIdle || decision.Action.Kind != ActionNone {
				t.Fatalf("incomplete authority admitted repair: %#v", decision)
			}
		})
	}
}

func TestTopologyRebalanceRequiresLowLoadStabilization(t *testing.T) {
	snapshot := repairSnapshot()
	snapshot.ScaleDownStabilization = 5 * time.Minute
	decision := Decide(State{Phase: PhaseIdle}, snapshot)
	if decision.State.Phase != PhaseObserving {
		t.Fatalf("repair skipped stabilization: %#v", decision)
	}
	snapshot.Now = snapshot.Now.Add(time.Minute)
	for index := range snapshot.Hosts {
		snapshot.Hosts[index].ObservedAt = snapshot.Now
	}
	decision = Decide(decision.State, snapshot)
	if decision.State.Phase != PhaseObserving || decision.Action.Kind != ActionNone {
		t.Fatalf("repair acted too early: %#v", decision)
	}
	snapshot.Now = snapshot.Now.Add(4 * time.Minute)
	for index := range snapshot.Hosts {
		snapshot.Hosts[index].ObservedAt = snapshot.Now
	}
	decision = Decide(decision.State, snapshot)
	if decision.State.Phase != PhaseRebalanceSelected {
		t.Fatalf("stabilized repair not selected: %#v", decision)
	}
}

func TestTopologyRebalancePreEvictionAbortAndWorkloadUIDFence(t *testing.T) {
	for _, reason := range []string{"expansion", "destination unavailable", "UID replacement", "workload replacement"} {
		t.Run(reason, func(t *testing.T) {
			snapshot := repairSnapshot()
			state := selectedRepair(t, snapshot)
			switch reason {
			case "expansion":
				snapshot.DemandRising = true
			case "destination unavailable":
				snapshot.RebalanceZones = nil
			case "UID replacement":
				snapshot.Hosts[109].UID = "different-uid"
			case "workload replacement":
				snapshot.WorkloadUID = "different-workload"
			}
			decision := Decide(state, snapshot)
			if decision.Action.Kind != ActionNone ||
				(decision.State.Phase != PhaseIdle && decision.State.Phase != PhaseRebalanceSelected) {
				t.Fatalf("stale selected authority performed an action: %#v", decision)
			}
		})
	}
}

func TestTopologyRebalanceEvictionWinsCancellationRace(t *testing.T) {
	state, snapshot := authorizedEviction(t)
	snapshot.DemandRising = true
	decision := Decide(state, snapshot)
	if decision.Action.Kind != ActionCancelEviction {
		t.Fatal(decision)
	}
	// The CAS adapter will reject its stale RV because deletion already won.
	// The next authoritative observation must wait, never unfence Terminating.
	snapshot.Hosts[109].Terminating = true
	decision = Decide(decision.State, snapshot)
	if decision.Action.Kind != ActionNone || decision.State.Phase != PhaseRebalanceReplacing {
		t.Fatalf("termination was treated as cancellable: %#v", decision)
	}
	snapshot.Hosts[109].UID = "replacement"
	snapshot.Hosts[109].Terminating, snapshot.Hosts[109].Draining = false, false
	snapshot.Hosts[109].Accepting = true
	decision = Decide(decision.State, snapshot)
	if decision.Action.Kind != ActionNone || decision.State.Phase != PhaseIdle {
		t.Fatalf("expansion did not supersede completed replacement: %#v", decision)
	}
}

func TestTopologyRebalanceCancellingRequiresRVAndFreshHostEvidence(t *testing.T) {
	state, snapshot := authorizedEviction(t)
	snapshot.DemandRising = true
	state = Decide(state, snapshot).State
	snapshot.Hosts[109].ResourceVersion = ""
	if decision := Decide(state, snapshot); decision.Action.Kind != ActionNone {
		t.Fatalf("empty RV authorized cancellation: %#v", decision)
	}
	snapshot.Hosts[109].ResourceVersion = "cancelled"
	snapshot.Hosts[109].EvictionCancelled = true
	snapshot.Hosts[109].Ready = false
	if decision := Decide(state, snapshot); decision.Action.Kind != ActionNone {
		t.Fatalf("unready Host unfenced: %#v", decision)
	}
	snapshot.Hosts[109].Ready = true
	snapshot.Hosts[109].ObservedAt = snapshot.Now.Add(-time.Minute)
	if decision := Decide(state, snapshot); decision.Action.Kind != ActionNone {
		t.Fatalf("stale Host unfenced: %#v", decision)
	}
}

func TestTopologyRebalanceAbortNeverCrossesWorkloadUID(t *testing.T) {
	state, snapshot := authorizedEviction(t)
	snapshot.DemandRising = true
	state = Decide(state, snapshot).State
	snapshot.Hosts[109].EvictionCancelled = true
	state = Decide(state, snapshot).State
	if state.Phase != PhaseAborting {
		t.Fatal(state)
	}
	snapshot.WorkloadUID = "recreated-workload"
	if decision := Decide(state, snapshot); decision.State != state || decision.Action.Kind != ActionNone {
		t.Fatalf("abort crossed workload identity: %#v", decision)
	}
}

func TestTopologyRebalanceMissingPersistedAuthorityFailsClosed(t *testing.T) {
	state, snapshot := authorizedEviction(t)
	for _, mutate := range []func(*State){
		func(s *State) { s.TargetUID = "" },
		func(s *State) { s.RepairWorkloadUID = "" },
		func(s *State) { s.RepairSourceZone = "" },
		func(s *State) { s.RepairDestinationZone = s.RepairSourceZone },
		func(s *State) { s.RepairPrefixScore = 0 },
		func(s *State) { s.EvictionResourceVersion = "" },
	} {
		invalid := state
		mutate(&invalid)
		if decision := Decide(invalid, snapshot); decision.Action.Kind != ActionNone || decision.State != invalid {
			t.Fatalf("incomplete persisted authority acted: %#v", decision)
		}
	}
}

func BenchmarkTopologyRebalanceCandidate(b *testing.B) {
	snapshot := repairSnapshot()
	b.ReportAllocs()
	for b.Loop() {
		rebalanceCandidate(snapshot)
	}
}

func TestTopologyRebalanceModelConvergesAcrossArbitraryOrdinalPrefixes(t *testing.T) {
	for seed := uint64(1); seed <= 4; seed++ {
		t.Run(fmt.Sprint(seed), func(t *testing.T) {
			snapshot := repairSnapshot()
			snapshot.Hosts = nil
			snapshot.RebalanceZones = []string{"zone-a", "zone-b", "zone-c"}
			random := rand.New(rand.NewPCG(seed, seed+1))
			for ordinal := 0; ordinal < 120; ordinal++ {
				zone := snapshot.RebalanceZones[random.IntN(3)]
				if ordinal < 4 {
					zone = "zone-a"
				}
				snapshot.Hosts = append(snapshot.Hosts, Host{
					Name: fmt.Sprintf("runtime-%d", ordinal), UID: fmt.Sprintf("uid-%d", ordinal),
					Ordinal: int32(ordinal), Zone: zone, Ready: true, Accepting: true, Quiescent: true,
					Capacity: 32, RequestCapacity: 32, ObservedAt: snapshot.Now, ResourceVersion: fmt.Sprint(ordinal + 1000),
				})
			}
			snapshot.Replicas, snapshot.ReadyReplicas = 120, 120
			state := State{Phase: PhaseIdle}
			for step := 0; step < 4000; step++ {
				if snapshot.Replicas == snapshot.MinReplicas {
					zones := map[string]bool{}
					for _, host := range snapshot.Hosts {
						zones[host.Zone] = true
					}
					if len(zones) != snapshot.RequiredZones {
						t.Fatal("model lost a required zone")
					}
					return
				}
				decision := Decide(state, snapshot)
				state = decision.State
				switch decision.Action.Kind {
				case ActionNone:
				case ActionSetDraining:
					for i := range snapshot.Hosts {
						if snapshot.Hosts[i].UID == decision.Action.TargetUID {
							snapshot.Hosts[i].Draining, snapshot.Hosts[i].Accepting = decision.Action.Draining, !decision.Action.Draining
						}
					}
				case ActionEvictHost:
					before := prefixScore(snapshot.Hosts)
					for i := range snapshot.Hosts {
						host := &snapshot.Hosts[i]
						if host.UID != decision.Action.TargetUID {
							continue
						}
						if !host.Draining || !host.Quiescent || host.ActiveActors != 0 || host.ResourceVersion != decision.Action.ResourceVersion {
							t.Fatalf("model evicted outside exact quiescent authority: %#v", decision)
						}
						// This model assumes the admitted destination is scheduled.
						// Real Kubernetes capacity and PDB behavior require adapter E2E.
						host.UID = fmt.Sprintf("successor-%d-%d", i, step)
						host.ResourceVersion = fmt.Sprintf("replacement-%d", step)
						host.Zone = state.RepairDestinationZone
						host.Draining, host.Accepting = false, true
					}
					if prefixScore(snapshot.Hosts) >= before {
						t.Fatal("repair did not decrease the termination measure")
					}
				case ActionSetReplicas:
					if decision.Action.Replicas != snapshot.Replicas-1 {
						t.Fatal("model skipped a serial scale boundary")
					}
					highest := snapshot.Hosts[len(snapshot.Hosts)-1]
					if !highest.Draining || !highest.Quiescent || highest.ActiveActors != 0 {
						t.Fatal("model removed a live Host")
					}
					snapshot.Hosts = snapshot.Hosts[:len(snapshot.Hosts)-1]
					snapshot.Replicas, snapshot.ReadyReplicas = decision.Action.Replicas, decision.Action.Replicas
				default:
					t.Fatalf("unexpected model action: %#v", decision)
				}
				draining := 0
				for i := range snapshot.Hosts {
					if snapshot.Hosts[i].Draining {
						draining++
					}
					snapshot.Hosts[i].ObservedAt = snapshot.Now.Add(time.Second)
				}
				if draining > 1 {
					t.Fatal("model drained multiple Hosts concurrently")
				}
				snapshot.Now = snapshot.Now.Add(time.Second)
			}
			t.Fatalf("model did not converge: replicas=%d state=%#v", snapshot.Replicas, state)
		})
	}
}
