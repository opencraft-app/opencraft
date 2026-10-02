package meshharness

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

const DefaultEnvironmentFreshness = 2 * time.Minute

type EnvironmentObservation struct {
	Name                      string
	UID                       string
	Generation                int64
	ObservedGeneration        int64
	ObservedAt                time.Time
	Region                    string
	Reachable                 bool
	APIReady                  bool
	CellControllerReady       bool
	FDBOperatorReady          bool
	MaxCells                  int64
	CurrentCells              int64
	ProvisioningCells         int64
	AvailableCellSlots        int64
	AllocatableCellUnits      int64
	MaxConcurrentProvisioning int64
}

type PlacementPlan struct {
	TargetClusterUID        string
	TargetCluster           string
	TargetClusterGeneration int64
	EnvironmentGeneration   int64
	Blocked                 bool
	Reason                  string
}

// PlanPlacement applies fail-closed eligibility gates before a deterministic
// ordering. A caller persists the returned identity before any external side
// effect; subsequent reconciles must use the persisted decision, not rerun it.
func PlanPlacement(allowed []string, region string, now time.Time, freshness time.Duration, environments []EnvironmentObservation) PlacementPlan {
	if freshness <= 0 {
		freshness = DefaultEnvironmentFreshness
	}
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, name := range allowed {
		allowedSet[name] = struct{}{}
	}
	eligible := make([]EnvironmentObservation, 0, len(environments))
	for _, environment := range environments {
		_, allowed := allowedSet[environment.Name]
		fresh := !environment.ObservedAt.IsZero() && !environment.ObservedAt.After(now) && now.Sub(environment.ObservedAt) <= freshness
		identityFresh := environment.UID != "" && environment.Generation > 0 && environment.ObservedGeneration == environment.Generation
		concurrency := environment.MaxConcurrentProvisioning > 0 && environment.ProvisioningCells < environment.MaxConcurrentProvisioning
		capacity := environment.MaxCells > 0 && environment.CurrentCells+environment.ProvisioningCells < environment.MaxCells && environment.AvailableCellSlots > 0
		if allowed && environment.Region == region && fresh && identityFresh && concurrency && capacity &&
			environment.Reachable && environment.APIReady && environment.CellControllerReady && environment.FDBOperatorReady {
			eligible = append(eligible, environment)
		}
	}
	if len(eligible) == 0 {
		return PlacementPlan{Blocked: true, Reason: "no fresh eligible management cluster has Cell capacity"}
	}
	sort.Slice(eligible, func(i, j int) bool {
		left, right := eligible[i], eligible[j]
		if left.AvailableCellSlots != right.AvailableCellSlots {
			return left.AvailableCellSlots > right.AvailableCellSlots
		}
		if left.AllocatableCellUnits != right.AllocatableCellUnits {
			return left.AllocatableCellUnits > right.AllocatableCellUnits
		}
		if left.CurrentCells != right.CurrentCells {
			return left.CurrentCells < right.CurrentCells
		}
		return left.Name < right.Name
	})
	selected := eligible[0]
	return PlacementPlan{
		TargetCluster: selected.Name, TargetClusterUID: selected.UID,
		TargetClusterGeneration: selected.Generation, EnvironmentGeneration: selected.ObservedGeneration,
		Reason: "persist deterministic placement before creating a logical Cell or ManifestWork",
	}
}

type ClaimObservation struct {
	Namespace               string
	Name                    string
	UID                     string
	Phase                   string
	ProviderRef             string
	BoundCellUID            string
	LogicalCellUID          string
	SpokeCellUID            string
	SpokeCellGeneration     int64
	WorkUID                 string
	TargetCluster           string
	TargetClusterUID        string
	TargetClusterGeneration int64
	TargetCell              string
}

type WorkObservation struct {
	Exists                      bool
	UID                         string
	ProviderRef                 string
	ClaimUID                    string
	TargetClusterUID            string
	TargetClusterGeneration     int64
	CellName                    string
	CellUID                     string
	LogicalCellUID              string
	CellGeneration              int64
	Ready                       bool
	Phase                       string
	CapacityRisk                string
	ScaleOutEpoch               int64
	PlacementCount              int64
	PendingReservations         int64
	ReportObservedAt            string
	ScaleInEvidenceReady        bool
	PlacementUtilizationPercent int64
	RuntimeUtilizationPercent   int64
	FDBWriteUtilizationPercent  int64
	ActiveWriters               int64
	InFlightCommits             int64
	MigrationBacklog            int64
	CompactionBacklog           int64
	GCBacklog                   int64
	ReconciliationBacklog       int64
	RetirementProofVerified     bool
	RetirementProofReady        bool
}

type ClaimPlan struct {
	ProviderRef        string
	PersistProviderRef bool
	EnsureWork         bool
	BindClaim          bool
	BoundCellUID       string
	Blocked            bool
	Reason             string
}

// PlanClaim defines the durable OCM boundary. Persisting providerRef and
// creating ManifestWork are deliberately separate reconciles so a retry can
// always recover the intended external identity before issuing side effects.
func PlanClaim(claim ClaimObservation, work WorkObservation) ClaimPlan {
	providerRef, err := providerRef(claim)
	if err != nil {
		return ClaimPlan{Blocked: true, Reason: err.Error()}
	}
	plan := ClaimPlan{ProviderRef: providerRef}
	if claim.Phase == "Bound" {
		if claim.BoundCellUID == "" {
			plan.Blocked, plan.Reason = true, "Bound Claim has no Cell UID"
		} else if work.Exists && (claim.WorkUID == "" || work.UID != claim.WorkUID ||
			work.ClaimUID != claim.UID || work.LogicalCellUID != claim.BoundCellUID ||
			work.TargetClusterUID != claim.TargetClusterUID || work.TargetClusterGeneration != claim.TargetClusterGeneration ||
			claim.SpokeCellUID == "" || work.CellUID != claim.SpokeCellUID ||
			claim.SpokeCellGeneration <= 0 || work.CellGeneration < claim.SpokeCellGeneration) {
			plan.Blocked, plan.Reason = true, "stale OCM feedback conflicts with the bound Claim identity"
		}
		return plan
	}
	if claim.ProviderRef == "" {
		plan.PersistProviderRef = true
		plan.Reason = "persist deterministic provider identity before OCM side effects"
		return plan
	}
	if claim.ProviderRef != providerRef {
		plan.Blocked, plan.Reason = true, "Claim providerRef differs from its deterministic OCM identity"
		return plan
	}
	if !work.Exists {
		plan.EnsureWork = true
		plan.Reason = "ensure deterministic ManifestWork"
		return plan
	}
	if work.ProviderRef != providerRef || work.ClaimUID != claim.UID || work.CellName != claim.TargetCell {
		plan.Blocked, plan.Reason = true, "ManifestWork identity does not match the Claim operation"
		return plan
	}
	if claim.WorkUID != "" && work.UID != claim.WorkUID {
		plan.Blocked, plan.Reason = true, "ManifestWork UID changed after its identity was persisted"
		return plan
	}
	if work.TargetClusterUID != claim.TargetClusterUID || work.TargetClusterGeneration != claim.TargetClusterGeneration {
		plan.Blocked, plan.Reason = true, "ManifestWork target cluster identity does not match the persisted placement"
		return plan
	}
	if work.Ready {
		if work.CellUID == "" || work.CellGeneration <= 0 {
			plan.Blocked, plan.Reason = true, "ready ManifestWork feedback has no exact Cell identity"
			return plan
		}
		if claim.LogicalCellUID == "" || work.LogicalCellUID != claim.LogicalCellUID {
			plan.Blocked, plan.Reason = true, "ready feedback does not match the Hub logical Cell UID"
			return plan
		}
		plan.BindClaim = true
		plan.BoundCellUID = claim.LogicalCellUID
		plan.Reason = "bind exact Cell UID from matching OCM feedback"
		return plan
	}
	plan.Reason = "wait for matching Cell readiness feedback"
	return plan
}

func providerRef(claim ClaimObservation) (string, error) {
	if claim.Namespace == "" || claim.Name == "" || claim.UID == "" || claim.TargetCluster == "" || claim.TargetCell == "" {
		return "", fmt.Errorf("Claim, target cluster and target Cell identities are required")
	}
	uid := strings.ToLower(claim.UID)
	uid = strings.NewReplacer("/", "-", ":", "-", "_", "-").Replace(uid)
	if len(uid) > 12 {
		uid = uid[:12]
	}
	return fmt.Sprintf("ocm://%s/manifestworks/%s-%s", claim.TargetCluster, claim.TargetCell, uid), nil
}

type RetirementPlan struct {
	DeleteWork bool
	RetainFDB  bool
	RetainCBS  bool
	RetainCOS  bool
	Reason     string
}

// PlanRetirement removes only the OCM-delivered compute envelope after the
// Cell controller has verified the complete retirement proof. Durable storage
// always remains under its independent quarantine and exact-key GC protocols.
func PlanRetirement(proofVerified, workExists bool) RetirementPlan {
	plan := RetirementPlan{RetainFDB: true, RetainCBS: true, RetainCOS: true}
	if !proofVerified {
		plan.Reason = "retirement proof has not crossed the durable safety boundary"
		return plan
	}
	plan.DeleteWork = workExists
	plan.Reason = "delete only the OCM compute envelope"
	return plan
}
