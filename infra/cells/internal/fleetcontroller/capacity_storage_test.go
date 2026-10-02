package fleetcontroller

import "testing"

func TestPlanCellCapacityEnforcesGasolineLogicalWatermarks(t *testing.T) {
	policy := CellCapacityPolicy{
		HealthyWriteUtilizationLimitPct: 50, DegradedWriteUtilizationLimitPct: 70, ScaleOutAtPct: 80,
		FDBLogicalSoftBytes: 40 << 30, FDBLogicalHardBytes: 60 << 30,
	}
	for _, test := range []struct {
		name      string
		logical   int64
		writePct  int64
		wantRisk  string
		wantEpoch int64
	}{
		{name: "below soft", logical: 3 << 30, writePct: 10, wantRisk: "Normal"},
		{name: "soft closes admission", logical: 40 << 30, writePct: 10, wantRisk: "AdmissionClosed", wantEpoch: 1},
		{name: "hard is emergency", logical: 60 << 30, writePct: 10, wantRisk: "Emergency", wantEpoch: 1},
		{name: "more severe write pressure wins", logical: 40 << 30, writePct: 75, wantRisk: "Protect", wantEpoch: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			plan := PlanCellCapacity(policy, "Normal", 0, &CellReport{
				FDBCapacityEvidenceReady: true, FDBStorageHeadroomSamples: 10,
				FDBWriteUtilizationPercent: test.writePct, FDBLogicalBytes: test.logical, FDBLogicalBytesKnown: true,
			}, true)
			if !plan.EvidenceReady || plan.Risk != test.wantRisk || plan.ScaleOutEpoch != test.wantEpoch {
				t.Fatalf("plan=%#v, want risk=%s epoch=%d", plan, test.wantRisk, test.wantEpoch)
			}
		})
	}
}

func TestPlanCellCapacityRejectsHalfConfiguredGasolineWatermarks(t *testing.T) {
	policy := CellCapacityPolicy{
		HealthyWriteUtilizationLimitPct: 50, DegradedWriteUtilizationLimitPct: 70, ScaleOutAtPct: 80,
		FDBLogicalSoftBytes: 40 << 30,
	}
	plan := PlanCellCapacity(policy, "Normal", 0, &CellReport{
		FDBCapacityEvidenceReady: true, FDBStorageHeadroomSamples: 10,
		FDBWriteUtilizationPercent: 10, FDBLogicalBytes: 3 << 30, FDBLogicalBytesKnown: true,
	}, true)
	if plan.EvidenceReady || plan.Risk != "Normal" {
		t.Fatalf("invalid logical policy was accepted: %#v", plan)
	}
}

func TestPlanCellCapacityRejectsLegacyReportWithoutLogicalBytes(t *testing.T) {
	policy := CellCapacityPolicy{
		HealthyWriteUtilizationLimitPct: 50, DegradedWriteUtilizationLimitPct: 70, ScaleOutAtPct: 80,
		FDBLogicalSoftBytes: 40 << 30, FDBLogicalHardBytes: 60 << 30,
	}
	plan := PlanCellCapacity(policy, "Normal", 0, &CellReport{
		FDBCapacityEvidenceReady: true, FDBStorageHeadroomSamples: 10, FDBWriteUtilizationPercent: 10,
	}, true)
	if plan.EvidenceReady {
		t.Fatalf("legacy report without logical-byte evidence was accepted: %#v", plan)
	}
}
