package meshharness

import "testing"

type claimModelState struct {
	claim ClaimObservation
	work  WorkObservation
}

func TestClaimModelExhaustiveBoundedSequencesPreserveIdentity(t *testing.T) {
	initial := claimModelState{claim: ClaimObservation{
		Namespace: "fleet", Name: "claim", UID: "claim-uid", TargetCluster: "tke-c", TargetClusterUID: "tke-c-uid",
		TargetClusterGeneration: 1, TargetCell: "actor-model-a01", LogicalCellUID: "logical-uid",
	}}
	events := []func(claimModelState) claimModelState{
		func(state claimModelState) claimModelState { return state }, // restart/duplicate reconcile
		func(state claimModelState) claimModelState {
			plan := PlanClaim(state.claim, state.work)
			if plan.PersistProviderRef {
				state.claim.ProviderRef = plan.ProviderRef
			}
			return state
		},
		func(state claimModelState) claimModelState {
			plan := PlanClaim(state.claim, state.work)
			if plan.EnsureWork {
				state.work = WorkObservation{Exists: true, UID: "work-uid", ProviderRef: plan.ProviderRef, ClaimUID: state.claim.UID,
					TargetClusterUID: state.claim.TargetClusterUID, TargetClusterGeneration: state.claim.TargetClusterGeneration,
					CellName: state.claim.TargetCell, LogicalCellUID: state.claim.LogicalCellUID}
			}
			return state
		},
		func(state claimModelState) claimModelState {
			if state.work.Exists {
				state.work.Ready, state.work.CellUID, state.work.CellGeneration = true, "spoke-uid", 1
			}
			return state
		},
		func(state claimModelState) claimModelState {
			plan := PlanClaim(state.claim, state.work)
			if plan.BindClaim {
				state.claim.Phase, state.claim.BoundCellUID = "Bound", plan.BoundCellUID
				state.claim.SpokeCellUID = state.work.CellUID
				state.claim.SpokeCellGeneration = state.work.CellGeneration
				state.claim.WorkUID = state.work.UID
			}
			return state
		},
		func(state claimModelState) claimModelState {
			if state.work.Exists {
				state.work.ClaimUID = "stale-claim-uid"
			}
			return state
		},
	}

	var visit func(claimModelState, int)
	visit = func(state claimModelState, depth int) {
		plan := PlanClaim(state.claim, state.work)
		if state.claim.ProviderRef != "" && state.claim.ProviderRef != plan.ProviderRef {
			t.Fatalf("provider identity drifted at depth %d: %#v %#v", depth, state, plan)
		}
		if state.claim.Phase == "Bound" && (state.claim.BoundCellUID != state.claim.LogicalCellUID || state.claim.SpokeCellUID == "") {
			t.Fatalf("invalid bound identity at depth %d: %#v", depth, state)
		}
		if depth == 7 {
			return
		}
		for _, event := range events {
			visit(event(state), depth+1)
		}
	}
	visit(initial, 0)
}
