package hostdrain

import "sort"

func isRebalancePhase(phase Phase) bool {
	switch phase {
	case PhaseRebalanceSelected, PhaseRebalanceDraining, PhaseRebalanceReady,
		PhaseRebalanceEvicting, PhaseRebalanceCancelling, PhaseRebalanceReplacing, PhaseRebalanceBlocked:
		return true
	default:
		return false
	}
}

func topologyBlocked(reason string) bool {
	return reason == "scale-down would violate runtime topology maxSkew" ||
		reason == "scale-down would remove a required runtime zone"
}

func contractionBlockReason(snapshot Snapshot) string {
	reason := scaleInBlockReason(snapshot, nil)
	if topologyBlocked(reason) {
		if target, _, _ := rebalanceCandidate(snapshot); target != nil {
			return ""
		}
	}
	return reason
}

// prefixScore measures imbalance in the next highest-ordinal removal. Keeping
// zero-count domains in the score also exposes a would-be lost required zone.
func prefixScore(hosts []Host) int64 {
	highest := highestOrdinal(hosts)
	if highest == nil {
		return 0
	}
	counts := map[string]int64{}
	for _, host := range hosts {
		if _, found := counts[host.Zone]; !found {
			counts[host.Zone] = 0
		}
		if host.UID != highest.UID {
			counts[host.Zone]++
		}
	}
	var score int64
	for _, count := range counts {
		score += count * count
	}
	return score
}

func rebalanceCandidate(snapshot Snapshot) (*Host, string, int64) {
	if !topologyBlocked(scaleInBlockReason(snapshot, nil)) || len(snapshot.RebalanceZones) == 0 {
		return nil, "", 0
	}
	withoutTopology := snapshot
	withoutTopology.RequiredZones, withoutTopology.TopologyMaxSkew = 0, 0
	if scaleInBlockReason(withoutTopology, nil) != "" {
		return nil, "", 0
	}
	counts := map[string]int{}
	uids, ordinals := map[string]bool{}, map[int32]bool{}
	for _, host := range snapshot.Hosts {
		if host.Zone == "" || host.ResourceVersion == "" || uids[host.UID] || ordinals[host.Ordinal] ||
			host.Ordinal < 0 || host.Ordinal >= snapshot.Replicas {
			return nil, "", 0
		}
		uids[host.UID], ordinals[host.Ordinal] = true, true
		counts[host.Zone]++
	}
	if len(counts) != snapshot.RequiredZones {
		return nil, "", 0
	}
	highest := highestOrdinal(snapshot.Hosts)
	before := prefixScore(snapshot.Hosts)
	best := before
	var active, inFlight, capacity, requestCapacity int64
	for _, host := range snapshot.Hosts {
		var ok bool
		if active, ok = checkedAdd(active, host.ActiveActors); !ok {
			return nil, "", 0
		}
		if inFlight, ok = checkedAdd(inFlight, host.InFlight); !ok {
			return nil, "", 0
		}
		if capacity, ok = checkedAdd(capacity, host.Capacity); !ok {
			return nil, "", 0
		}
		if requestCapacity, ok = checkedAdd(requestCapacity, host.RequestCapacity); !ok {
			return nil, "", 0
		}
	}
	prefixCounts := map[string]int64{}
	for zone, count := range counts {
		prefixCounts[zone] = int64(count)
	}
	prefixCounts[highest.Zone]--
	var target *Host
	destination := ""
	zones := append([]string(nil), snapshot.RebalanceZones...)
	sort.Strings(zones)
	ordered := append([]Host(nil), snapshot.Hosts...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Ordinal > ordered[j].Ordinal })
	for index := range ordered {
		host := &ordered[index]
		if host.UID == highest.UID || counts[host.Zone] <= 1 || !host.Quiescent ||
			host.ActiveActors != 0 || host.InFlight != 0 || host.Queued != 0 {
			continue
		}
		if remaining := capacity - host.Capacity; remaining <= 0 ||
			productGreater(active, 100, remaining, snapshot.MaxRemainingUsagePct) {
			continue
		}
		if remaining := requestCapacity - host.RequestCapacity; remaining <= 0 ||
			productGreater(inFlight, 100, remaining, snapshot.MaxRemainingUsagePct) {
			continue
		}
		for _, zone := range zones {
			if zone == host.Zone || counts[zone] == 0 {
				continue
			}
			// Moving one Host changes only two squared terms. Do not clone and
			// sort the entire fleet for every candidate at each reconciliation.
			score := before + 2*(prefixCounts[zone]-prefixCounts[host.Zone]+1)
			if score < best {
				copy := *host
				target, destination, best = &copy, zone, score
			}
		}
	}
	return target, destination, before
}

func repairPreflight(state State, snapshot Snapshot, target *Host) string {
	if snapshot.WorkloadUID != state.RepairWorkloadUID {
		return "rebalance workload UID changed"
	}
	if snapshot.Replicas != state.FromReplicas {
		return "rebalance replica shape changed"
	}
	if snapshot.Now.Before(state.StartedAt) {
		return "rebalance start time is in the future"
	}
	withoutTopology := snapshot
	withoutTopology.RequiredZones, withoutTopology.TopologyMaxSkew = 0, 0
	if reason := scaleInBlockReason(withoutTopology, target); reason != "" {
		return reason
	}
	if target.Zone != state.RepairSourceZone || target.ResourceVersion == "" {
		return "rebalance target placement or resourceVersion changed"
	}
	if !topologyBlocked(topologyScaleInBlockReason(snapshot, highestOrdinal(snapshot.Hosts))) {
		return "serial contraction no longer requires topology repair"
	}
	for _, host := range snapshot.Hosts {
		if host.UID != target.UID && (host.Draining || !host.Accepting) {
			return "another Host is already draining"
		}
	}
	found := false
	for _, zone := range snapshot.RebalanceZones {
		found = found || zone == state.RepairDestinationZone
	}
	if !found {
		return "rebalance destination no longer has admitted spare capacity"
	}
	if snapshot.Now.Sub(state.StartedAt) >= snapshot.DrainTimeout {
		return "rebalance deadline expired"
	}
	return ""
}

func decideRebalance(state State, snapshot Snapshot) Decision {
	if snapshot.WorkloadUID != state.RepairWorkloadUID {
		return stay(state, "rebalance workload UID changed; no target action is authorized")
	}
	target, found := exactTarget(state, snapshot.Hosts)
	issued := state.EvictionResourceVersion != ""
	if !found || (target != nil && target.Terminating) {
		if !issued {
			return reset(state, snapshot.Now, "rebalance target changed before eviction; cancel stale identity")
		}
		return finishRebalanceReplacement(state, snapshot)
	}
	if state.Phase == PhaseRebalanceReplacing || state.Phase == PhaseRebalanceBlocked {
		return stay(state, "waiting for the old rebalance identity to disappear")
	}
	if issued && target.ResourceVersion == "" {
		return stay(state, "eviction recovery requires an observed Pod resourceVersion")
	}
	if state.Phase == PhaseRebalanceCancelling {
		if !target.EvictionCancelled {
			if target.ResourceVersion == "" {
				return stay(state, "cancellation requires an observed Pod resourceVersion")
			}
			return Decision{State: state, Action: Action{Kind: ActionCancelEviction,
				TargetName: target.Name, TargetUID: target.UID, ResourceVersion: target.ResourceVersion},
				Reason: "invalidate every late eviction before restoring old Host placement"}
		}
		if !target.Ready || target.ObservedAt.IsZero() || target.ObservedAt.After(snapshot.Now) ||
			snapshot.Now.Sub(target.ObservedAt) > snapshot.MetricsFreshness {
			return stay(state, "cancellation is fenced; placement restoration requires fresh Host evidence")
		}
		return abortRebalance(state, snapshot, target, "the exact eviction cancellation fence is observed")
	}
	if reason := repairPreflight(state, snapshot, target); reason != "" {
		if issued {
			return Decision{State: withPhase(state, PhaseRebalanceCancelling, snapshot.Now),
				Action: Action{Kind: ActionCancelEviction, TargetName: target.Name,
					TargetUID: target.UID, ResourceVersion: target.ResourceVersion}, Reason: reason}
		}
		return abortRebalance(state, snapshot, target, reason)
	}
	if !target.Draining || target.Accepting {
		if issued {
			return Decision{State: withPhase(state, PhaseRebalanceCancelling, snapshot.Now),
				Action: Action{Kind: ActionCancelEviction, TargetName: target.Name,
					TargetUID: target.UID, ResourceVersion: target.ResourceVersion},
				Reason: "rebalance placement fence was lost after eviction authorization"}
		}
		return Decision{State: withPhase(state, PhaseRebalanceDraining, snapshot.Now),
			Action: Action{Kind: ActionSetDraining, TargetName: target.Name, TargetUID: target.UID, Draining: true},
			Reason: "fence one idle Host before topology repair"}
	}
	if !target.Quiescent || target.ActiveActors != 0 || target.InFlight != 0 || target.Queued != 0 {
		if issued {
			return Decision{State: withPhase(state, PhaseRebalanceCancelling, snapshot.Now),
				Action: Action{Kind: ActionCancelEviction, TargetName: target.Name, TargetUID: target.UID,
					ResourceVersion: target.ResourceVersion}, Reason: "quiescence was lost after eviction authorization"}
		}
		return stay(state, "waiting for exact rebalance target quiescence")
	}
	if state.Phase == PhaseRebalanceSelected || state.Phase == PhaseRebalanceDraining {
		return Decision{State: withPhase(state, PhaseRebalanceReady, snapshot.Now),
			Action: Action{Kind: ActionNone}, Reason: "fenced rebalance target is exactly quiescent"}
	}
	if state.Phase == PhaseRebalanceReady {
		state = withPhase(state, PhaseRebalanceEvicting, snapshot.Now)
		state.EvictionResourceVersion = target.ResourceVersion
	}
	if target.ResourceVersion != state.EvictionResourceVersion {
		return Decision{State: withPhase(state, PhaseRebalanceCancelling, snapshot.Now),
			Action: Action{Kind: ActionCancelEviction, TargetName: target.Name, TargetUID: target.UID,
				ResourceVersion: target.ResourceVersion}, Reason: "Pod changed while eviction outcome was indeterminate"}
	}
	return Decision{State: state, Action: Action{Kind: ActionEvictHost, TargetName: target.Name,
		TargetUID: target.UID, ResourceVersion: state.EvictionResourceVersion},
		Reason: "request one UID and resourceVersion fenced PDB-respecting eviction"}
}

func abortRebalance(state State, snapshot Snapshot, target *Host, reason string) Decision {
	if target.Draining || !target.Accepting {
		return Decision{State: withPhase(state, PhaseAborting, snapshot.Now),
			Action: Action{Kind: ActionSetDraining, TargetName: target.Name, TargetUID: target.UID, Draining: false},
			Reason: "cancel rebalance: " + reason}
	}
	return reset(state, snapshot.Now, "rebalance cancelled: "+reason)
}

func finishRebalanceReplacement(state State, snapshot Snapshot) Decision {
	for _, host := range snapshot.Hosts {
		if host.Name == state.TargetName && host.UID != state.TargetUID && host.Ready && !host.Terminating {
			if snapshot.Replicas != state.FromReplicas || snapshot.DemandRising || snapshot.ScaleUpPending {
				return reset(state, snapshot.Now, "replacement is Ready; expansion superseded topology repair")
			}
			plain := snapshot
			plain.RequiredZones, plain.TopologyMaxSkew = 0, 0
			if reason := scaleInBlockReason(plain, nil); reason != "" {
				return stay(state, "replacement requires fresh complete capacity evidence: "+reason)
			}
			if host.Zone != state.RepairSourceZone && prefixScore(snapshot.Hosts) < state.RepairPrefixScore {
				return reset(state, snapshot.Now, "one replacement improved the next contraction prefix; requalify low load")
			}
			return Decision{State: withPhase(state, PhaseRebalanceBlocked, snapshot.Now),
				Action: Action{Kind: ActionNone}, Reason: "replacement did not improve topology; stop rather than repeat evictions"}
		}
	}
	return Decision{State: withPhase(state, PhaseRebalanceReplacing, snapshot.Now),
		Action: Action{Kind: ActionNone}, Reason: "waiting for a new Ready Pod UID without forcing termination"}
}
