package meshharness

import "testing"

func TestPlanClaimSurvivesEveryUncertainResultBoundary(t *testing.T) {
	claim := ClaimObservation{
		Namespace: "actor-fleet", Name: "claim-1", UID: "claim-uid-1234567890",
		TargetCluster: "tke-b", TargetClusterUID: "tke-b-uid", TargetClusterGeneration: 3,
		TargetCell: "actor-bj-b01", LogicalCellUID: "logical-cell-uid-b01",
	}
	first := PlanClaim(claim, WorkObservation{})
	if !first.PersistProviderRef || first.EnsureWork || first.Blocked {
		t.Fatalf("first boundary plan = %#v", first)
	}
	claim.ProviderRef = first.ProviderRef
	second := PlanClaim(claim, WorkObservation{})
	if !second.EnsureWork || second.PersistProviderRef || second.Blocked {
		t.Fatalf("post-providerRef plan = %#v", second)
	}

	// Simulate ManifestWork creation succeeding while the OCM API response is
	// lost. The retry observes the deterministic object and must not create it
	// again or change provider identity.
	work := WorkObservation{Exists: true, UID: "work-uid", ProviderRef: first.ProviderRef, ClaimUID: claim.UID,
		TargetClusterUID: claim.TargetClusterUID, TargetClusterGeneration: claim.TargetClusterGeneration,
		CellName: claim.TargetCell, LogicalCellUID: claim.LogicalCellUID}
	for i := 0; i < 10; i++ {
		got := PlanClaim(claim, work)
		if got.EnsureWork || got.PersistProviderRef || got.BindClaim || got.Blocked || got.ProviderRef != first.ProviderRef {
			t.Fatalf("uncertain-result retry %d = %#v", i, got)
		}
	}
	work.Ready, work.CellUID, work.CellGeneration = true, "cell-uid-b01", 4
	ready := PlanClaim(claim, work)
	if !ready.BindClaim || ready.BoundCellUID != claim.LogicalCellUID || ready.Blocked {
		t.Fatalf("ready feedback plan = %#v", ready)
	}
	claim.Phase, claim.BoundCellUID, claim.SpokeCellUID = "Bound", claim.LogicalCellUID, work.CellUID
	claim.WorkUID, claim.SpokeCellGeneration = work.UID, work.CellGeneration
	for i := 0; i < 10; i++ {
		got := PlanClaim(claim, work)
		if got.PersistProviderRef || got.EnsureWork || got.BindClaim || got.Blocked {
			t.Fatalf("bound replay %d was not terminal: %#v", i, got)
		}
	}
	work.CellGeneration++
	if got := PlanClaim(claim, work); got.Blocked {
		t.Fatalf("a newer generation of the same spoke Cell UID was rejected: %#v", got)
	}
	work.CellGeneration = claim.SpokeCellGeneration - 1
	if got := PlanClaim(claim, work); !got.Blocked {
		t.Fatalf("older feedback crossed the persisted spoke generation fence: %#v", got)
	}
}

func TestPlanClaimRejectsStaleGenerationFeedback(t *testing.T) {
	claim := ClaimObservation{
		Namespace: "actor-fleet", Name: "claim-new", UID: "new-claim-uid",
		TargetCluster: "tke-b", TargetClusterUID: "tke-b-uid", TargetClusterGeneration: 3,
		TargetCell: "actor-bj-b01", LogicalCellUID: "logical-cell-uid",
	}
	claim.ProviderRef = PlanClaim(claim, WorkObservation{}).ProviderRef
	stale := WorkObservation{
		Exists: true, UID: "old-work-uid", ProviderRef: claim.ProviderRef, ClaimUID: "old-claim-uid",
		TargetClusterUID: claim.TargetClusterUID, TargetClusterGeneration: claim.TargetClusterGeneration,
		CellName: claim.TargetCell, CellUID: "old-cell-uid", CellGeneration: 1, LogicalCellUID: claim.LogicalCellUID, Ready: true,
	}
	got := PlanClaim(claim, stale)
	if !got.Blocked || got.BindClaim {
		t.Fatalf("stale feedback was accepted: %#v", got)
	}

	claim.Phase, claim.BoundCellUID, claim.SpokeCellUID = "Bound", claim.LogicalCellUID, "new-cell-uid"
	claim.WorkUID, claim.SpokeCellGeneration = "new-work-uid", 2
	got = PlanClaim(claim, stale)
	if !got.Blocked || got.BindClaim || got.BoundCellUID != "" {
		t.Fatalf("old feedback changed a bound generation: %#v", got)
	}
}

func TestPlanRetirementDeletesOnlyComputeEnvelope(t *testing.T) {
	blocked := PlanRetirement(false, true)
	if blocked.DeleteWork || !blocked.RetainFDB || !blocked.RetainCBS || !blocked.RetainCOS {
		t.Fatalf("incomplete retirement proof changed resources: %#v", blocked)
	}
	ready := PlanRetirement(true, true)
	if !ready.DeleteWork || !ready.RetainFDB || !ready.RetainCBS || !ready.RetainCOS {
		t.Fatalf("retirement crossed the wrong ownership boundary: %#v", ready)
	}
}
