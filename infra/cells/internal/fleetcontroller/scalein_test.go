package fleetcontroller

import (
	"context"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestPlanScaleInRequiresSevenDaysAcrossHysteresis(t *testing.T) {
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	cell := PoolCell{
		Name: "actor-low-a01", UID: "cell-low-uid", Phase: "Ready", ReadyForPlacement: true, CapacityRisk: "Normal",
		ReportObservedAt: now, ScaleInEvidenceReady: true,
		PlacementUtilizationPercent: 10, RuntimeUtilizationPercent: 20, FDBWriteUtilizationPercent: 15,
	}
	in := PoolInput{
		UID: "pool-uid", MinCells: 2, Now: now, Cells: []PoolCell{cell, readyScaleInCell("actor-a", "a", now, 60), readyScaleInCell("actor-b", "b", now, 60)},
		ScaleInPolicy: ScaleInPolicy{Mode: "Automatic", EnterPercent: 25, ExitPercent: 40, Observation: 7 * 24 * time.Hour, MaxConcurrent: 1, ReportFreshness: 2 * time.Minute},
	}
	candidate, request, _ := PlanScaleIn(in, false, 0)
	if candidate == nil || request != nil || candidate.CellUID != cell.UID || candidate.CompositeLoadPct != 20 {
		t.Fatalf("initial low-load plan = candidate %#v request %#v", candidate, request)
	}

	in.ExistingScaleInCandidate = candidate
	in.Now = now.Add(6 * 24 * time.Hour)
	in.Cells[0].ReportObservedAt = in.Now
	in.Cells[0].RuntimeUtilizationPercent = 35 // hysteresis band preserves the candidate.
	candidate, request, _ = PlanScaleIn(in, false, 0)
	if candidate == nil || request != nil {
		t.Fatalf("hysteresis band lost candidate: %#v %#v", candidate, request)
	}

	in.Now = now.Add(7 * 24 * time.Hour)
	in.Cells[0].ReportObservedAt = in.Now
	candidate, request, _ = PlanScaleIn(in, false, 0)
	if candidate == nil || request == nil || request.RequestID != candidate.RequestID {
		t.Fatalf("seven-day boundary did not produce one durable drain: %#v %#v", candidate, request)
	}
}

func TestPlanScaleInFailsClosedAndCancelsAboveExitThreshold(t *testing.T) {
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	cell := readyScaleInCell("actor-low", "low", now, 10)
	in := PoolInput{
		UID: "pool", MinCells: 1, Now: now, Cells: []PoolCell{cell, readyScaleInCell("actor-other", "other", now, 60)},
		ScaleInPolicy: ScaleInPolicy{Mode: "Automatic", EnterPercent: 25, ExitPercent: 40, Observation: 7 * 24 * time.Hour, MaxConcurrent: 1, ReportFreshness: 2 * time.Minute},
	}
	candidate, _, _ := PlanScaleIn(in, false, 0)
	if candidate == nil {
		t.Fatal("expected low-load candidate")
	}
	in.ExistingScaleInCandidate = candidate
	in.Now = now.Add(time.Minute)
	in.Cells[0].ReportObservedAt = in.Now
	in.Cells[0].RuntimeUtilizationPercent = 41
	if got, request, _ := PlanScaleIn(in, false, 0); got != nil || request != nil {
		t.Fatalf("exit threshold did not cancel observation: %#v %#v", got, request)
	}

	in.ExistingScaleInCandidate = candidate
	in.Cells[0].RuntimeUtilizationPercent = 10
	in.Cells[0].ReportObservedAt = now.Add(-time.Hour)
	if got, request, _ := PlanScaleIn(in, false, 0); got != nil || request != nil {
		t.Fatalf("stale evidence advanced scale-in: %#v %#v", got, request)
	}
}

func TestPlanScaleInFinalizesOnlyFullySettledDrain(t *testing.T) {
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	in := PoolInput{
		UID: "pool", MinCells: 1, Now: now,
		Cells: []PoolCell{
			{Name: "retiring", UID: "retiring-uid", Phase: "Draining", RetirementProofReady: true, RetirementRequestID: "scalein-fixed"},
			readyScaleInCell("other", "other-uid", now, 60),
		},
		ScaleInPolicy: ScaleInPolicy{Mode: "Automatic", MaxConcurrent: 1},
	}
	_, request, _ := PlanScaleIn(in, false, 0)
	if request == nil || request.DesiredState != "Retired" || request.RequestID != "scalein-fixed" {
		t.Fatalf("settled drain did not cross the explicit Retired boundary: %#v", request)
	}
}

func TestScaleInRequestIsIdempotentAcrossDrainAndRetiredBoundaries(t *testing.T) {
	ctx := context.Background()
	pool := object(poolGVK)
	pool.SetName("pool")
	pool.SetNamespace("scalein")
	cell := object(cellGVK)
	cell.SetName("actor-low-a01")
	cell.SetNamespace("scalein")
	cell.SetUID(types.UID("cell-uid"))
	cell.Object["spec"] = map[string]any{"desiredState": "Ready", "retirement": map[string]any{"generation": int64(4), "requestId": "initial"}}
	cell.Object["status"] = map[string]any{}
	scheme := operatorTestScheme()
	addUnstructuredTypes(scheme, poolGVK)
	base := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(object(cellGVK)).WithObjects(pool, cell).Build()
	reconciler := PoolReconciler{Client: base}
	drain := ScaleInRequest{CellName: cell.GetName(), CellUID: string(cell.GetUID()), RequestID: "scalein-stable", DesiredState: "Draining"}
	if err := reconciler.beginCellDrain(ctx, pool, drain); err != nil {
		t.Fatal(err)
	}
	if err := reconciler.beginCellDrain(ctx, pool, drain); err != nil {
		t.Fatal(err)
	}
	stored := getObject(t, ctx, base, cellGVK, cell.GetName(), cell.GetNamespace())
	if nestedString(stored.Object, "spec", "desiredState") != "Draining" || nestedInt64(stored.Object, "spec", "retirement", "generation") != 5 {
		t.Fatalf("drain retry changed retirement generation: %#v", stored.Object["spec"])
	}
	status := stored.DeepCopy()
	status.Object["status"] = map[string]any{"phase": "Draining", "retirementProofReady": true}
	if err := base.Status().Update(ctx, status); err != nil {
		t.Fatal(err)
	}
	finalize := ScaleInRequest{CellName: cell.GetName(), CellUID: string(cell.GetUID()), RequestID: "scalein-stable", DesiredState: "Retired"}
	if err := reconciler.beginCellDrain(ctx, pool, finalize); err != nil {
		t.Fatal(err)
	}
	if err := reconciler.beginCellDrain(ctx, pool, finalize); err != nil {
		t.Fatal(err)
	}
	stored = getObject(t, ctx, base, cellGVK, cell.GetName(), cell.GetNamespace())
	if nestedString(stored.Object, "spec", "desiredState") != "Retired" || nestedInt64(stored.Object, "spec", "retirement", "generation") != 5 {
		t.Fatalf("Retired boundary was not idempotent: %#v", stored.Object["spec"])
	}
}

func readyScaleInCell(name, uid string, now time.Time, load int64) PoolCell {
	return PoolCell{
		Name: name, UID: uid, Phase: "Ready", ReadyForPlacement: true, CapacityRisk: "Normal", ReportObservedAt: now,
		ScaleInEvidenceReady: true, PlacementUtilizationPercent: load, RuntimeUtilizationPercent: load, FDBWriteUtilizationPercent: load,
	}
}
