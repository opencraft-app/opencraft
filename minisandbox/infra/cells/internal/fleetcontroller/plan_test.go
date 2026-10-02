package fleetcontroller

import (
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const testDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestPlanCellRequiresFreshBoundEvidence(t *testing.T) {
	now := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name       string
		mutate     func(*CellInput)
		wantReady  bool
		wantPhase  string
		wantReason string
	}{
		{name: "ready", wantReady: true, wantPhase: "Ready", wantReason: "Ready"},
		{
			name:      "single-zone qualification never opens placement",
			mutate:    func(in *CellInput) { in.ProductionEligible = false },
			wantPhase: "Qualifying", wantReason: "QualificationOnly",
		},
		{
			name:      "expired report",
			mutate:    func(in *CellInput) { in.Report.ObservedAt = now.Add(-3 * time.Minute) },
			wantPhase: "Qualifying", wantReason: "EvidenceMissing",
		},
		{
			name:      "UID mismatch",
			mutate:    func(in *CellInput) { in.Report.CellUID = "other" },
			wantPhase: "Qualifying", wantReason: "EvidenceMissing",
		},
		{
			name:      "capacity closes placement",
			mutate:    func(in *CellInput) { in.Report.FDBWriteUtilizationPercent = 50 },
			wantPhase: "Qualifying", wantReason: "CapacityRisk",
		},
		{
			name:      "correctness violation",
			mutate:    func(in *CellInput) { in.Report.CorrectnessViolation = true },
			wantPhase: "Failed", wantReason: "CorrectnessViolation",
		},
		{
			name:      "declared topology mismatch",
			mutate:    func(in *CellInput) { in.TopologyConforming = false },
			wantPhase: "NonConforming", wantReason: "SafetyGateFailed",
		},
		{
			name: "operator cluster still reconciling",
			mutate: func(in *CellInput) {
				in.FDBOperatorRequired = true
				in.FDBOperatorFound = true
				in.FDBOperatorReady = false
				in.FDBOperatorReason = "GenerationPending"
			},
			wantPhase: "Qualifying", wantReason: "SafetyGateFailed",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			in := validCellInput(now)
			if test.mutate != nil {
				test.mutate(&in)
			}
			plan := PlanCell(in)
			if plan.Status.ReadyForPlacement != test.wantReady {
				t.Fatalf("ready = %v, want %v", plan.Status.ReadyForPlacement, test.wantReady)
			}
			if plan.Status.Phase != test.wantPhase {
				t.Fatalf("phase = %q, want %q", plan.Status.Phase, test.wantPhase)
			}
			if got := findCondition(t, plan.Status.Conditions, "PlacementReady").Reason; got != test.wantReason {
				t.Fatalf("PlacementReady reason = %q, want %q", got, test.wantReason)
			}
		})
	}
}

func TestPlanCellRequiresOperatorAndIndependentReport(t *testing.T) {
	now := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
	in := validCellInput(now)
	in.FDBOperatorRequired = true
	in.FDBOperatorFound = true
	in.FDBOperatorReady = true

	plan := PlanCell(in)
	if !plan.Status.ReadyForPlacement || !plan.Status.FDBOperatorReady {
		t.Fatalf("reconciled operator-backed Cell did not become ready: %#v", plan.Status)
	}
	if got := findCondition(t, plan.Status.Conditions, "FDBOperatorReady"); got.Status != metav1.ConditionTrue || got.Reason != "Reconciled" {
		t.Fatalf("FDBOperatorReady = %#v", got)
	}

	in.Report.FDBHealthy = false
	plan = PlanCell(in)
	if plan.Status.ReadyForPlacement {
		t.Fatal("operator status replaced the independent FDB report")
	}
}

func TestPlanCellRetirementProofIsAllOrNothing(t *testing.T) {
	now := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
	in := validCellInput(now)
	in.DesiredState = "Retired"
	in.Report.QualificationReady = false
	in.Report.PlacementCount = 0
	in.Report.PendingReservations = 0
	in.Report.Retirement = &RetirementReport{
		Generation:               7,
		ExactColdReachable:       true,
		ExactBackupReachable:     true,
		OldGenerationRejected:    true,
		RollbackRetentionExpired: true,
		ArtifactsEnumerated:      true,
		FullySettled:             true,
		CrossCellRestoreVerified: true,
		ColdManifestRef:          "cos://cold/manifests/cell-retired.json",
		ColdManifestDigest:       testDigest,
		ReceiptRef:               "cos://receipts/cell-retired.json",
		ReceiptDigest:            testDigest,
	}

	plan := PlanCell(in)
	if !plan.RemoveFinalizer || !plan.Status.RetirementProofVerified || plan.Status.Phase != "Retired" {
		t.Fatalf("valid proof was not accepted: %#v", plan)
	}

	in.Report.ReconciliationBacklog = 1
	plan = PlanCell(in)
	if plan.RemoveFinalizer || plan.Status.RetirementProofVerified || plan.Status.Phase != "Draining" {
		t.Fatalf("incomplete proof was accepted: %#v", plan)
	}
}

func TestPlanCellRejectsQualificationFromAnotherRelease(t *testing.T) {
	now := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
	in := validCellInput(now)
	in.Report.QualificationReleaseDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

	plan := PlanCell(in)
	if plan.Status.ReadyForPlacement {
		t.Fatal("qualification from another release opened placement")
	}
	condition := findCondition(t, plan.Status.Conditions, "PlacementReady")
	if condition.Reason != "QualificationMissing" {
		t.Fatalf("placement reason = %q, want QualificationMissing", condition.Reason)
	}
}

func TestPlanCellPreservesConditionTransitionTime(t *testing.T) {
	now := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
	old := metav1.NewTime(now.Add(-time.Hour))
	in := validCellInput(now)
	in.ExistingConditions = []metav1.Condition{{
		Type: "PlacementReady", Status: metav1.ConditionTrue, Reason: "OlderReason", LastTransitionTime: old,
	}}
	got := findCondition(t, PlanCell(in).Status.Conditions, "PlacementReady")
	if !got.LastTransitionTime.Equal(&old) {
		t.Fatalf("transition time changed without a status transition: got %s want %s", got.LastTransitionTime, old)
	}
}

func TestPlanCellCapacityDerivesRiskAndMonotonicEpoch(t *testing.T) {
	policy := CellCapacityPolicy{
		HealthyWriteUtilizationLimitPct: 50, DegradedWriteUtilizationLimitPct: 70, ScaleOutAtPct: 80,
	}
	report := &CellReport{FDBCapacityEvidenceReady: true, FDBStorageHeadroomSamples: 1200}
	tests := []struct {
		name        string
		utilization int64
		previous    string
		epoch       int64
		wantRisk    string
		wantEpoch   int64
	}{
		{name: "below healthy budget", utilization: 49, previous: "Normal", epoch: 3, wantRisk: "Normal", wantEpoch: 3},
		{name: "close admission", utilization: 50, previous: "Normal", epoch: 3, wantRisk: "AdmissionClosed", wantEpoch: 4},
		{name: "sustained pressure", utilization: 69, previous: "AdmissionClosed", epoch: 4, wantRisk: "AdmissionClosed", wantEpoch: 4},
		{name: "escalation is same pressure event", utilization: 70, previous: "AdmissionClosed", epoch: 4, wantRisk: "Protect", wantEpoch: 4},
		{name: "emergency is same pressure event", utilization: 80, previous: "Protect", epoch: 4, wantRisk: "Emergency", wantEpoch: 4},
		{name: "recovery retains epoch", utilization: 10, previous: "Emergency", epoch: 4, wantRisk: "Normal", wantEpoch: 4},
		{name: "new pressure after recovery", utilization: 50, previous: "Normal", epoch: 4, wantRisk: "AdmissionClosed", wantEpoch: 5},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			report.FDBWriteUtilizationPercent = test.utilization
			got := PlanCellCapacity(policy, test.previous, test.epoch, report, true)
			if !got.EvidenceReady || got.Risk != test.wantRisk || got.ScaleOutEpoch != test.wantEpoch {
				t.Fatalf("capacity plan = %#v, want risk=%s epoch=%d", got, test.wantRisk, test.wantEpoch)
			}
		})
	}
}

func TestPlanCellCapacityFailsClosedWithoutMintingEpoch(t *testing.T) {
	policy := CellCapacityPolicy{
		HealthyWriteUtilizationLimitPct: 50, DegradedWriteUtilizationLimitPct: 70, ScaleOutAtPct: 80,
	}
	report := &CellReport{
		CapacityRisk: "Emergency", ScaleOutEpoch: 999,
		FDBCapacityEvidenceReady: true, FDBStorageHeadroomSamples: 1200, FDBWriteUtilizationPercent: 10,
	}
	got := PlanCellCapacity(policy, "AdmissionClosed", 7, report, false)
	if got.EvidenceReady || got.Risk != "AdmissionClosed" || got.ScaleOutEpoch != 7 {
		t.Fatalf("missing evidence changed persisted capacity state: %#v", got)
	}
	got = PlanCellCapacity(policy, "Normal", 7, report, true)
	if !got.EvidenceReady || got.Risk != "Normal" || got.ScaleOutEpoch != 7 {
		t.Fatalf("report-owned risk or epoch influenced controller decision: %#v", got)
	}
	report.FDBStorageHeadroomSamples = 0
	got = PlanCellCapacity(policy, "Normal", 7, report, true)
	if got.EvidenceReady || got.Risk != "Normal" || got.ScaleOutEpoch != 7 {
		t.Fatalf("insufficient sample window was accepted: %#v", got)
	}
}

func TestPlanPoolCreatesOnlyCellSizedClaims(t *testing.T) {
	now := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
	base := PoolInput{
		Generation: 2, MinCells: 2, MaxCells: 5, MaxConcurrentCellProvisioning: 2, ClassName: "class", Region: "ap-beijing",
		ManagementClusters: []string{"cluster-a"}, Now: now,
	}

	plan := PlanPool(base)
	if len(plan.ClaimRequests) != 2 || plan.Status.DesiredCells != 2 {
		t.Fatalf("empty pool plan = %#v", plan)
	}
	if plan.ClaimRequests[0].RequestID != "minimum/1" || plan.ClaimRequests[1].RequestID != "minimum/2" {
		t.Fatalf("minimum Claim request IDs are not deterministic: %#v", plan.ClaimRequests)
	}

	base.Cells = []PoolCell{
		{Name: "cell-a", UID: "uid-a", ClassName: "class", Region: "ap-beijing", ManagementCluster: "cluster-a", Phase: "Ready", ReadyForPlacement: true, CapacityRisk: "Normal", PlacementCount: 20, ReportObservedAt: now},
		{Name: "cell-b", UID: "uid-b", ClassName: "class", Region: "ap-beijing", ManagementCluster: "cluster-a", Phase: "Ready", ReadyForPlacement: true, CapacityRisk: "AdmissionClosed", ScaleOutEpoch: 1, PlacementCount: 10, ReportObservedAt: now},
	}
	plan = PlanPool(base)
	if len(plan.ClaimRequests) != 1 || plan.Status.DesiredCells != 3 {
		t.Fatalf("capacity pressure did not request one Cell: %#v", plan)
	}
	if !plan.Status.AdmissionOpen {
		t.Fatal("normal ready cell should keep pool admission open")
	}
	if len(plan.Status.AdmissionCandidates) != 1 || plan.Status.AdmissionCandidates[0] != "cell-a" {
		t.Fatalf("admission candidates = %#v", plan.Status.AdmissionCandidates)
	}

	base.Claims = []PoolClaim{{Name: "claim-c", UID: "claim-uid-c", Phase: "Provisioning", TriggerKey: "uid-b/1"}}
	plan = PlanPool(base)
	if len(plan.ClaimRequests) != 0 || plan.Status.PendingClaims != 1 {
		t.Fatalf("pending claim should absorb desired capacity: %#v", plan)
	}

	base.Cells = append(base.Cells, PoolCell{
		Name: "cell-c", UID: "uid-c", ClaimName: "claim-c", ClaimUID: "claim-uid-c", ClassName: "class", Region: "ap-beijing",
		ManagementCluster: "cluster-a", Phase: "Ready", ReadyForPlacement: true, CapacityRisk: "Normal", ReportObservedAt: now,
	})
	base.Claims[0].Phase = "Bound"
	plan = PlanPool(base)
	if len(plan.ClaimRequests) != 0 || plan.Status.DesiredCells != 3 {
		t.Fatalf("a fulfilled pressure epoch triggered repeated expansion: %#v", plan)
	}

	base.Cells[1].ScaleOutEpoch = 2
	plan = PlanPool(base)
	if len(plan.ClaimRequests) != 1 || plan.ClaimRequests[0].ScaleOutEpoch != 2 || plan.Status.DesiredCells != 4 {
		t.Fatalf("a new pressure epoch did not request exactly one Cell: %#v", plan)
	}
}

func TestPlanPoolBoundsConcurrentCellProvisioning(t *testing.T) {
	now := time.Now()
	in := PoolInput{
		Generation: 1, MinCells: 2, MaxCells: 10, MaxConcurrentCellProvisioning: 1,
		ClassName: "class", Region: "ap-beijing", ManagementClusters: []string{"tke-a", "tke-b"}, Now: now,
		Cells: []PoolCell{
			{Name: "cell-a1", UID: "uid-a1", ClassName: "class", Region: "ap-beijing", ManagementCluster: "tke-a", Phase: "Ready", CapacityRisk: "AdmissionClosed", ScaleOutEpoch: 4, ReportObservedAt: now},
			{Name: "cell-a2", UID: "uid-a2", ClassName: "class", Region: "ap-beijing", ManagementCluster: "tke-a", Phase: "Ready", CapacityRisk: "AdmissionClosed", ScaleOutEpoch: 9, ReportObservedAt: now},
			{Name: "cell-b1", UID: "uid-b1", ClassName: "class", Region: "ap-beijing", ManagementCluster: "tke-b", Phase: "Ready", ReadyForPlacement: true, CapacityRisk: "Normal", ReportObservedAt: now},
		},
	}
	plan := PlanPool(in)
	if len(plan.ClaimRequests) != 1 || plan.ClaimRequests[0].CellName != "cell-a1" {
		t.Fatalf("bounded provisioning plan = %#v, want deterministic first pressure Cell", plan)
	}
	if !plan.Status.AdmissionOpen || len(plan.Status.AdmissionCandidates) != 1 || plan.Status.AdmissionCandidates[0] != "cell-b1" {
		t.Fatalf("healthy TKE-B Cell did not keep admission open: %#v", plan.Status)
	}
	in.Claims = []PoolClaim{{Name: "pending-a1", UID: "claim-a1", Phase: "Provisioning", TriggerKey: "uid-a1/4"}}
	plan = PlanPool(in)
	if len(plan.ClaimRequests) != 0 || plan.Status.PendingClaims != 1 {
		t.Fatalf("pending provider work did not consume the global provisioning credit: %#v", plan)
	}
	in.Claims[0].Phase = "Bound"
	in.Cells[0].ClaimName, in.Cells[0].ClaimUID = "pending-a1", "claim-a1"
	plan = PlanPool(in)
	if len(plan.ClaimRequests) != 1 || plan.ClaimRequests[0].CellName != "cell-a2" {
		t.Fatalf("credit release did not advance to the next pressure epoch: %#v", plan)
	}
}

func TestPlanPoolCountsClaimBeforeFirstStatusWriteAsProvisioning(t *testing.T) {
	in := PoolInput{
		Generation: 1, MinCells: 2, MaxCells: 2, MaxConcurrentCellProvisioning: 1,
		ClassName: "class", Region: "local", ManagementClusters: []string{"runtime-a", "runtime-b"}, Now: time.Now(),
		Claims: []PoolClaim{{Name: "new-claim", UID: "new-claim-uid"}},
	}
	plan := PlanPool(in)
	if plan.Status.PendingClaims != 1 || len(plan.ClaimRequests) != 0 {
		t.Fatalf("new Claim without status did not consume provisioning credit: %#v", plan)
	}
}

func TestPlanPoolLogicalCellDoesNotReleaseProvisioningCredit(t *testing.T) {
	in := PoolInput{
		Generation: 1, MinCells: 2, MaxCells: 2, MaxConcurrentCellProvisioning: 1,
		ClassName: "class", Region: "local", ManagementClusters: []string{"runtime-a", "runtime-b"}, Now: time.Now(),
		Cells: []PoolCell{{
			Name: "logical-a", ClaimName: "claim-a", ClaimUID: "claim-a-uid", ClassName: "class", Region: "local",
			ManagementCluster: "runtime-a", Phase: "", ReadyForPlacement: false,
		}},
		Claims: []PoolClaim{{Name: "claim-a", UID: "claim-a-uid", Phase: "Provisioning"}},
	}
	plan := PlanPool(in)
	if plan.Status.PendingClaims != 1 || plan.Status.TotalCells != 1 || len(plan.ClaimRequests) != 0 {
		t.Fatalf("unbound logical Cell released or double-counted provisioning credit: %#v", plan)
	}
}

func TestPlanPoolFailedClaimWithLogicalCellIsNotDoubleCounted(t *testing.T) {
	in := PoolInput{
		Generation: 1, MinCells: 2, MaxCells: 3, MaxConcurrentCellProvisioning: 1,
		ClassName: "class", Region: "local", ManagementClusters: []string{"runtime-a"}, Now: time.Now(),
		Cells: []PoolCell{{
			Name: "logical-a", ClaimName: "claim-a", ClaimUID: "claim-a-uid", ClassName: "class", Region: "local",
			ManagementCluster: "runtime-a",
		}},
		Claims: []PoolClaim{{Name: "claim-a", UID: "claim-a-uid", Phase: "Failed"}},
	}
	plan := PlanPool(in)
	if plan.Status.TotalCells != 1 || plan.Status.FailedClaims != 1 || plan.Status.DesiredCells != 2 {
		t.Fatalf("failed Claim and its logical Cell were double-counted: %#v", plan)
	}
}

func TestPlanPoolDoesNotDoubleCountBoundClaim(t *testing.T) {
	in := PoolInput{
		Generation: 1, MinCells: 2, MaxCells: 5, ClassName: "class", Region: "ap-beijing",
		ManagementClusters: []string{"cluster-a"}, Now: time.Now(),
		Cells:  []PoolCell{{Name: "cell-a", ClaimName: "claim-a", ClaimUID: "claim-uid-a", ClassName: "class", Region: "ap-beijing", ManagementCluster: "cluster-a"}},
		Claims: []PoolClaim{{Name: "claim-a", UID: "claim-uid-a", Phase: "Bound"}},
	}
	plan := PlanPool(in)
	if plan.Status.PendingClaims != 0 || len(plan.ClaimRequests) != 1 {
		t.Fatalf("bound claim was double counted: %#v", plan)
	}
	in.Claims[0].UID = "recreated-claim-uid"
	plan = PlanPool(in)
	if got := findCondition(t, plan.Status.Conditions, "MembersValid").Status; got != metav1.ConditionFalse {
		t.Fatalf("stale claim UID was accepted: %#v", plan.Status.Conditions)
	}
}

func TestPlanPoolInvalidMemberFailsClosed(t *testing.T) {
	in := PoolInput{
		Generation: 1, MinCells: 1, MaxCells: 5, ClassName: "class", Region: "ap-beijing",
		ManagementClusters: []string{"cluster-a"}, Now: time.Now(),
		Cells: []PoolCell{{Name: "wrong", ClassName: "other", Region: "ap-beijing", ManagementCluster: "cluster-a", Phase: "Ready", ReadyForPlacement: true, CapacityRisk: "Normal"}},
	}
	plan := PlanPool(in)
	if plan.Status.AdmissionOpen {
		t.Fatal("invalid member opened Pool admission")
	}
	if got := findCondition(t, plan.Status.Conditions, "MembersValid").Status; got != metav1.ConditionFalse {
		t.Fatalf("MembersValid = %s", got)
	}
}

func TestPlanPoolStaleCellEvidenceClosesAdmission(t *testing.T) {
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	in := PoolInput{
		Generation: 1, MinCells: 1, MaxCells: 2, MaxConcurrentCellProvisioning: 1,
		ClassName: "class", Region: "local", ManagementClusters: []string{"runtime-a"}, Now: now, ReportFreshness: time.Minute,
		Cells: []PoolCell{{
			Name: "cell-a", ClassName: "class", Region: "local", ManagementCluster: "runtime-a",
			Phase: "Ready", ReadyForPlacement: true, CapacityRisk: "Normal", ReportObservedAt: now.Add(-time.Minute - time.Second),
		}},
	}
	plan := PlanPool(in)
	if plan.Status.AdmissionOpen || plan.Status.ReadyCells != 0 || len(plan.Status.AdmissionCandidates) != 0 {
		t.Fatalf("stale spoke evidence opened Pool admission: %#v", plan.Status)
	}
	if plan.Status.TotalCells != 1 || plan.Status.PendingCells != 1 {
		t.Fatalf("stale Cell disappeared instead of becoming unavailable: %#v", plan.Status)
	}
}

func TestPlanPoolPressureWithoutEpochDoesNotRunAway(t *testing.T) {
	now := time.Now()
	in := PoolInput{
		Generation: 1, MinCells: 2, MaxCells: 5, ClassName: "class", Region: "ap-beijing",
		ManagementClusters: []string{"cluster-a"}, Now: now,
		Cells: []PoolCell{
			{Name: "cell-a", UID: "uid-a", ClassName: "class", Region: "ap-beijing", ManagementCluster: "cluster-a", CapacityRisk: "AdmissionClosed", ReportObservedAt: now},
			{Name: "cell-b", UID: "uid-b", ClassName: "class", Region: "ap-beijing", ManagementCluster: "cluster-a", CapacityRisk: "Normal", ReportObservedAt: now},
		},
	}
	plan := PlanPool(in)
	if len(plan.ClaimRequests) != 0 {
		t.Fatalf("pressure without a monotonic epoch created claims: %#v", plan)
	}
	if got := findCondition(t, plan.Status.Conditions, "ScaleOutRequired").Reason; got != "EpochMissing" {
		t.Fatalf("ScaleOutRequired reason = %q, want EpochMissing", got)
	}
}

func TestPlanPoolFailedClaimsRequireOperatorAction(t *testing.T) {
	in := PoolInput{
		Generation: 1, MinCells: 2, MaxCells: 5, ClassName: "class", Region: "ap-beijing",
		ManagementClusters: []string{"cluster-a"}, Now: time.Now(),
		Claims: []PoolClaim{
			{Name: "failed-a", Phase: "Failed"},
			{Name: "failed-b", Phase: "Failed"},
		},
	}
	plan := PlanPool(in)
	if len(plan.ClaimRequests) != 0 || plan.Status.FailedClaims != 2 || plan.Status.DesiredCells != 2 {
		t.Fatalf("failed provider claims caused automatic retry: %#v", plan)
	}
	if got := findCondition(t, plan.Status.Conditions, "ClaimsHealthy").Reason; got != "ProviderFailure" {
		t.Fatalf("ClaimsHealthy reason = %q, want ProviderFailure", got)
	}
}

func validCellInput(now time.Time) CellInput {
	return CellInput{
		Name: "cell-a", UID: "uid-a", Generation: 3, DesiredState: "Ready", RetirementGeneration: 7,
		ClusterIdentityHash: testDigest, ProfileDigest: testDigest, ProfileSpecDigest: testDigest,
		ProfileConforming: true, ProductionEligible: true, MinRuntimeReadyHosts: 3,
		TopologyConforming: true, Now: now, ReportFreshness: 2 * time.Minute,
		CapacityPolicy: CellCapacityPolicy{
			HealthyWriteUtilizationLimitPct: 50, DegradedWriteUtilizationLimitPct: 70, ScaleOutAtPct: 80,
		},
		Report: &CellReport{
			CellName: "cell-a", CellUID: "uid-a", ObservedCellGeneration: 3, ObservedAt: now.Add(-time.Minute),
			ProfileDigest: testDigest, ClusterIdentityHash: testDigest,
			FDBAvailable: true, FDBHealthy: true, FDBTopologyConforming: true,
			RuntimeReadyHosts: 3, BackupReady: true, CredentialsReady: true,
			CapacityRisk: "Emergency", ScaleOutEpoch: 99,
			FDBCapacityEvidenceReady: true, FDBStorageHeadroomSamples: 1200, FDBWriteUtilizationPercent: 10,
			QualificationReady:      true,
			QualificationReceiptRef: "cos://receipts/qualification.json", QualificationDigest: testDigest,
			ReleaseDigest: testDigest, QualificationReleaseDigest: testDigest,
		},
	}
}

func findCondition(t *testing.T, conditions []metav1.Condition, typ string) metav1.Condition {
	t.Helper()
	for _, condition := range conditions {
		if condition.Type == typ {
			return condition
		}
	}
	t.Fatalf("condition %q not found", typ)
	return metav1.Condition{}
}
