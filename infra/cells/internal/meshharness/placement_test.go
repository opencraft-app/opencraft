package meshharness

import (
	"testing"
	"time"
)

func TestPlanPlacementUsesHardGatesAndDeterministicOrdering(t *testing.T) {
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	environment := func(name string, slots, units, cells int64) EnvironmentObservation {
		return EnvironmentObservation{
			Name: name, UID: name + "-uid", Generation: 3, ObservedGeneration: 3, ObservedAt: now, Region: "ap-beijing",
			Reachable: true, APIReady: true, CellControllerReady: true, FDBOperatorReady: true,
			MaxCells: 20, CurrentCells: cells, AvailableCellSlots: slots, AllocatableCellUnits: units, MaxConcurrentProvisioning: 2,
		}
	}
	a := environment("tke-a", 3, 50, 2)
	b := environment("tke-b", 8, 20, 8)
	c := environment("tke-c", 8, 90, 10)
	plan := PlanPlacement([]string{"tke-a", "tke-b", "tke-c"}, "ap-beijing", now, 2*time.Minute, []EnvironmentObservation{b, a, c})
	if plan.Blocked || plan.TargetCluster != "tke-c" || plan.TargetClusterUID != c.UID || plan.TargetClusterGeneration != 3 {
		t.Fatalf("placement = %#v", plan)
	}

	c.Reachable = false
	plan = PlanPlacement([]string{"tke-a", "tke-b", "tke-c"}, "ap-beijing", now, 2*time.Minute, []EnvironmentObservation{c, b, a})
	if plan.TargetCluster != "tke-b" {
		t.Fatalf("unreachable target was not excluded: %#v", plan)
	}
	b.ObservedAt = now.Add(-3 * time.Minute)
	a.ProvisioningCells = a.MaxConcurrentProvisioning
	plan = PlanPlacement([]string{"tke-a", "tke-b", "tke-c"}, "ap-beijing", now, 2*time.Minute, []EnvironmentObservation{a, b, c})
	if !plan.Blocked {
		t.Fatalf("stale/unreachable/credit-exhausted environments were accepted: %#v", plan)
	}
}
