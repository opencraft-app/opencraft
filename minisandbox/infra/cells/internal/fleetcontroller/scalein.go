package fleetcontroller

import (
	"crypto/sha256"
	"fmt"
	"sort"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func PlanScaleIn(in PoolInput, capacityPressure bool, pendingClaims int64) (*ScaleInCandidate, *ScaleInRequest, string) {
	policy := in.ScaleInPolicy
	if policy.Mode != "Automatic" {
		return nil, nil, "automatic Cell scale-in is disabled"
	}
	if policy.EnterPercent <= 0 {
		policy.EnterPercent = 25
	}
	if policy.ExitPercent <= policy.EnterPercent {
		policy.ExitPercent = 40
	}
	if policy.Observation <= 0 {
		policy.Observation = 7 * 24 * time.Hour
	}
	if policy.MaxConcurrent <= 0 {
		policy.MaxConcurrent = 1
	}
	if policy.ReportFreshness <= 0 {
		policy.ReportFreshness = DefaultReportFreshness
	}

	draining := int64(0)
	ready := int64(0)
	byUID := make(map[string]PoolCell, len(in.Cells))
	for _, cell := range in.Cells {
		byUID[cell.UID] = cell
		if cell.Phase == "Draining" || cell.Phase == "Retired" {
			draining++
		}
		if cell.Phase == "Ready" {
			ready++
		}
		if cell.Phase == "Draining" && cell.RetirementProofReady && cell.RetirementRequestID != "" {
			return nil, &ScaleInRequest{CellName: cell.Name, CellUID: cell.UID, RequestID: cell.RetirementRequestID, DesiredState: "Retired"}, "the fully settled retirement proof is ready for generation verification"
		}
	}
	if capacityPressure || pendingClaims > 0 || ready <= in.MinCells || draining >= policy.MaxConcurrent {
		return nil, nil, "scale-in is blocked by pressure, provisioning, minimum capacity, or an existing drain"
	}

	load := func(cell PoolCell) int64 {
		return max(cell.PlacementUtilizationPercent, cell.RuntimeUtilizationPercent, cell.FDBWriteUtilizationPercent)
	}
	valid := func(cell PoolCell) bool {
		return cell.UID != "" && cell.Phase == "Ready" && cell.ReadyForPlacement && cell.CapacityRisk == "Normal" &&
			cell.ScaleInEvidenceReady && !cell.ReportObservedAt.IsZero() && !cell.ReportObservedAt.After(in.Now) &&
			in.Now.Sub(cell.ReportObservedAt) <= policy.ReportFreshness
	}

	if existing := in.ExistingScaleInCandidate; existing != nil {
		cell, found := byUID[existing.CellUID]
		if !found || cell.Name != existing.CellName || !valid(cell) || load(cell) > policy.ExitPercent {
			return nil, nil, "the low-load observation was reset by stale evidence, identity change, or exit-threshold load"
		}
		candidate := *existing
		candidate.CompositeLoadPct = load(cell)
		if in.Now.Sub(candidate.ObservedSince.Time) >= policy.Observation {
			return &candidate, &ScaleInRequest{CellName: candidate.CellName, CellUID: candidate.CellUID, RequestID: candidate.RequestID, DesiredState: "Draining"}, "the low-load observation crossed the drain boundary"
		}
		return &candidate, nil, "the low-load candidate remains inside the seven-day observation window"
	}

	type eligibleCell struct {
		cell PoolCell
		load int64
	}
	eligible := make([]eligibleCell, 0, len(in.Cells))
	for _, cell := range in.Cells {
		if valid(cell) && load(cell) < policy.EnterPercent {
			eligible = append(eligible, eligibleCell{cell: cell, load: load(cell)})
		}
	}
	if len(eligible) == 0 {
		return nil, nil, "no Cell is below the scale-in enter threshold with fresh complete evidence"
	}
	sort.Slice(eligible, func(i, j int) bool {
		if eligible[i].load != eligible[j].load {
			return eligible[i].load < eligible[j].load
		}
		return eligible[i].cell.Name < eligible[j].cell.Name
	})
	selected := eligible[0]
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s/%s/%d", in.UID, selected.cell.UID, in.Now.Unix())))
	candidate := &ScaleInCandidate{
		CellName: selected.cell.Name, CellUID: selected.cell.UID, RequestID: fmt.Sprintf("scalein-%x", digest[:8]),
		ObservedSince: metav1.NewTime(in.Now), CompositeLoadPct: selected.load,
	}
	return candidate, nil, "started a durable low-load observation with hysteresis"
}
