package fleetcontroller

import (
	"fmt"
	"sort"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func PlanCell(in CellInput) CellPlan {
	if in.ReportFreshness <= 0 {
		in.ReportFreshness = DefaultReportFreshness
	}
	status := CellStatus{
		ObservedGeneration: in.Generation,
		Phase:              phaseWithoutEvidence(in.DesiredState),
		CapacityRisk:       in.ExistingCapacityRisk,
		ScaleOutEpoch:      in.ExistingScaleOutEpoch,
		ProfileDigest:      in.ProfileDigest,
		FDBAutoscaling:     in.FDBAutoscalingStatus,
	}
	if !validCapacityRisk(status.CapacityRisk) {
		status.CapacityRisk = "Unknown"
	}

	reportValid, reportReason, reportMessage := validateReport(in)
	reportCondition := condition(in.ExistingConditions, in.Now, "ReportFresh", metav1.ConditionFalse, reportReason, reportMessage, in.Generation)
	profileCondition := condition(in.ExistingConditions, in.Now, "ProfileMatched", metav1.ConditionFalse, "ReportUnavailable", "a matching fresh report is required", in.Generation)
	healthCondition := condition(in.ExistingConditions, in.Now, "Healthy", metav1.ConditionFalse, "ReportUnavailable", "a matching fresh report is required", in.Generation)
	topologyStatus := metav1.ConditionFalse
	topologyReason := "SpecNonConforming"
	topologyMessage := "Cell node topology does not conform to the selected profile"
	if in.TopologyConforming {
		topologyStatus = metav1.ConditionTrue
		topologyReason = "SpecConforming"
		topologyMessage = "Cell node topology conforms to the selected profile"
	}
	topologyCondition := condition(in.ExistingConditions, in.Now, "TopologyConforming", topologyStatus, topologyReason, topologyMessage, in.Generation)
	placementCondition := condition(in.ExistingConditions, in.Now, "PlacementReady", metav1.ConditionFalse, "EvidenceMissing", "placement is closed until all readiness evidence passes", in.Generation)
	retirementCondition := condition(in.ExistingConditions, in.Now, "RetirementSafe", metav1.ConditionFalse, "ProofMissing", "retirement proof is incomplete", in.Generation)
	autoscalingCondition := condition(in.ExistingConditions, in.Now, "FDBAutoscalingReady", metav1.ConditionFalse, "Pending", "FoundationDB autoscaling has not been evaluated", in.Generation)
	capacityCondition := condition(in.ExistingConditions, in.Now, "CapacityEvidenceReady", metav1.ConditionFalse, "EvidenceMissing", "fresh Prometheus-backed capacity evidence is required", in.Generation)
	operatorReady := true
	operatorCondition := condition(in.ExistingConditions, in.Now, "FDBOperatorReady", metav1.ConditionTrue, "NotRequired", "Cell uses native fdbmonitor supervision", in.Generation)
	if in.FDBOperatorRequired {
		operatorReady = in.FDBOperatorFound && in.FDBOperatorReady
		operatorStatus := metav1.ConditionFalse
		reason := in.FDBOperatorReason
		message := in.FDBOperatorMessage
		if reason == "" {
			reason = "ClusterMissing"
		}
		if message == "" {
			message = "the bound FoundationDBCluster is missing or has not reconciled"
		}
		if operatorReady {
			operatorStatus = metav1.ConditionTrue
			reason = "Reconciled"
			message = "FoundationDBCluster generation, process groups, version and replication health are reconciled"
		}
		operatorCondition = condition(in.ExistingConditions, in.Now, "FDBOperatorReady", operatorStatus, reason, message, in.Generation)
	}
	status.FDBOperatorReady = operatorReady
	capacityPlan := PlanCellCapacity(in.CapacityPolicy, status.CapacityRisk, status.ScaleOutEpoch, in.Report, reportValid)
	status.CapacityRisk = capacityPlan.Risk
	status.ScaleOutEpoch = capacityPlan.ScaleOutEpoch
	if capacityPlan.EvidenceReady {
		capacityCondition = condition(in.ExistingConditions, in.Now, "CapacityEvidenceReady", metav1.ConditionTrue, "Derived", capacityPlan.Reason, in.Generation)
	}

	if reportValid {
		report := in.Report
		status.ReportObservedAt = &metav1.Time{Time: report.ObservedAt.UTC()}
		status.PlacementCount = report.PlacementCount
		status.PendingReservations = report.PendingReservations
		status.ActiveWriters = report.ActiveWriters
		status.InFlightCommits = report.InFlightCommits
		status.MigrationBacklog = report.MigrationBacklog
		status.CompactionBacklog = report.CompactionBacklog
		status.GCBacklog = report.GCBacklog
		status.ReconciliationBacklog = report.ReconciliationBacklog
		status.ScaleInEvidenceReady = report.ScaleInEvidenceReady
		status.PlacementUtilizationPercent = report.PlacementUtilizationPercent
		status.RuntimeUtilizationPercent = report.RuntimeUtilizationPercent
		status.FDBWriteUtilizationPercent = report.FDBWriteUtilizationPercent
		reportCondition = condition(in.ExistingConditions, in.Now, "ReportFresh", metav1.ConditionTrue, "Fresh", "report is fresh and bound to this Cell UID and generation", in.Generation)

		profileMatched := in.ProfileConforming && in.ProfileDigest == in.ProfileSpecDigest && report.ProfileDigest == in.ProfileDigest && report.ClusterIdentityHash == in.ClusterIdentityHash && in.ClusterIdentityHash != ""
		if profileMatched {
			profileCondition = condition(in.ExistingConditions, in.Now, "ProfileMatched", metav1.ConditionTrue, "Matched", "profile digest, Cell policy and FDB cluster identity match", in.Generation)
		} else {
			profileCondition = condition(in.ExistingConditions, in.Now, "ProfileMatched", metav1.ConditionFalse, "IdentityMismatch", "profile digest, Cell policy or FDB cluster identity does not match", in.Generation)
		}

		topologyOK := in.TopologyConforming && report.FDBTopologyConforming
		if topologyOK {
			topologyCondition = condition(in.ExistingConditions, in.Now, "TopologyConforming", metav1.ConditionTrue, "Conforming", "declared and observed FDB topology conform to the profile", in.Generation)
		} else {
			topologyCondition = condition(in.ExistingConditions, in.Now, "TopologyConforming", metav1.ConditionFalse, "NonConforming", "declared or observed FDB topology does not conform to the profile", in.Generation)
		}

		healthy := report.FDBAvailable && report.FDBHealthy && report.RuntimeReadyHosts >= in.MinRuntimeReadyHosts && report.BackupReady && report.CredentialsReady && !report.CorrectnessViolation
		if healthy {
			healthCondition = condition(in.ExistingConditions, in.Now, "Healthy", metav1.ConditionTrue, "Healthy", "FDB, runtime, backup and credentials report healthy", in.Generation)
		} else if report.CorrectnessViolation {
			healthCondition = condition(in.ExistingConditions, in.Now, "Healthy", metav1.ConditionFalse, "CorrectnessViolation", "a correctness signal closed placement", in.Generation)
		} else {
			healthCondition = condition(in.ExistingConditions, in.Now, "Healthy", metav1.ConditionFalse, "HealthGateFailed", "one or more FDB, runtime, backup or credential gates failed", in.Generation)
		}

		qualificationOK := report.QualificationReady && report.QualificationReceiptRef != "" && hasDigest(report.QualificationDigest) && hasDigest(report.ReleaseDigest) && report.QualificationReleaseDigest == report.ReleaseDigest
		ready := in.ProductionEligible && in.DesiredState == "Ready" && profileMatched && topologyOK && healthy && qualificationOK && operatorReady && capacityPlan.EvidenceReady && status.CapacityRisk == "Normal"
		status.ReadyForPlacement = ready
		if report.CorrectnessViolation {
			status.Phase = "Failed"
		} else if !topologyOK || !in.ProfileConforming || in.ProfileDigest != in.ProfileSpecDigest {
			status.Phase = "NonConforming"
		} else if ready {
			status.Phase = "Ready"
		} else {
			status.Phase = phaseWithEvidence(in.DesiredState)
		}

		if ready {
			placementCondition = condition(in.ExistingConditions, in.Now, "PlacementReady", metav1.ConditionTrue, "Ready", "Cell is eligible for new Actor placement", in.Generation)
		} else {
			reason := "DesiredStateClosed"
			message := fmt.Sprintf("desired state %s does not admit placement", in.DesiredState)
			switch {
			case report.CorrectnessViolation:
				reason, message = "CorrectnessViolation", "a correctness signal closed placement"
			case !in.ProductionEligible:
				reason, message = "QualificationOnly", "the selected profile is explicitly ineligible for production placement"
			case !capacityPlan.EvidenceReady:
				reason, message = "CapacityEvidenceMissing", capacityPlan.Reason
			case status.CapacityRisk != "Normal":
				reason, message = "CapacityRisk", "capacity risk is "+status.CapacityRisk
			case !qualificationOK:
				reason, message = "QualificationMissing", "an immutable successful qualification receipt is required"
			case !profileMatched || !topologyOK || !healthy || !operatorReady:
				reason, message = "SafetyGateFailed", "profile, topology or health evidence failed"
			}
			placementCondition = condition(in.ExistingConditions, in.Now, "PlacementReady", metav1.ConditionFalse, reason, message, in.Generation)
		}

		status.RetirementProofReady = retirementEvidenceValid(in, report)
		retirementOK := in.DesiredState == "Retired" && status.RetirementProofReady
		status.RetirementProofVerified = retirementOK
		if retirementOK {
			status.Phase = "Retired"
			retirementCondition = condition(in.ExistingConditions, in.Now, "RetirementSafe", metav1.ConditionTrue, "ProofVerified", "immutable retirement proof satisfies every destructive-action gate", in.Generation)
		}
	}
	status.FDBAutoscaling = PlanFDBAutoscaling(in, reportValid)
	switch status.FDBAutoscaling.Phase {
	case "Disabled":
		autoscalingCondition = condition(in.ExistingConditions, in.Now, "FDBAutoscalingReady", metav1.ConditionTrue, "Disabled", status.FDBAutoscaling.Reason, in.Generation)
	case "Stable", "ScaleUpRecommended", "ScaleDownRecommended", "ScalingUp", "ScalingDown":
		autoscalingCondition = condition(in.ExistingConditions, in.Now, "FDBAutoscalingReady", metav1.ConditionTrue, status.FDBAutoscaling.Phase, status.FDBAutoscaling.Reason, in.Generation)
	default:
		autoscalingCondition = condition(in.ExistingConditions, in.Now, "FDBAutoscalingReady", metav1.ConditionFalse, status.FDBAutoscaling.Phase, status.FDBAutoscaling.Reason, in.Generation)
	}

	status.Conditions = sortedConditions(reportCondition, profileCondition, topologyCondition, healthCondition, operatorCondition, capacityCondition, autoscalingCondition, placementCondition, retirementCondition)
	requeueAfter := in.ReportFreshness
	if reportValid {
		expiresAt := in.Report.ObservedAt.Add(in.ReportFreshness)
		requeueAfter = expiresAt.Sub(in.Now)
		if requeueAfter < time.Second {
			requeueAfter = time.Second
		}
	}
	return CellPlan{Status: status, RemoveFinalizer: status.RetirementProofVerified && in.DesiredState == "Retired", RequeueAfter: requeueAfter}
}

func validateReport(in CellInput) (bool, string, string) {
	if in.Report == nil {
		return false, "Missing", "RivetCellReport with the same name is missing"
	}
	report := in.Report
	if report.CellName != in.Name || report.CellUID != in.UID {
		return false, "CellReferenceMismatch", "report Cell name or UID does not match"
	}
	if report.ObservedCellGeneration != in.Generation {
		return false, "GenerationMismatch", "report does not observe the current Cell generation"
	}
	if report.ObservedAt.IsZero() {
		return false, "InvalidTimestamp", "report observedAt is missing or invalid"
	}
	if report.ObservedAt.After(in.Now.Add(30 * time.Second)) {
		return false, "ClockSkew", "report observedAt is too far in the future"
	}
	if in.Now.Sub(report.ObservedAt) > in.ReportFreshness {
		return false, "Expired", "report exceeded the freshness deadline"
	}
	return true, "Fresh", "report is fresh"
}

func retirementProofValid(in CellInput, report *CellReport) bool {
	return in.DesiredState == "Retired" && retirementEvidenceValid(in, report)
}

func retirementEvidenceValid(in CellInput, report *CellReport) bool {
	proof := report.Retirement
	return proof != nil &&
		proof.Generation == in.RetirementGeneration &&
		report.PlacementCount == 0 && report.PendingReservations == 0 &&
		report.ActiveWriters == 0 && report.InFlightCommits == 0 &&
		report.MigrationBacklog == 0 && report.CompactionBacklog == 0 &&
		report.GCBacklog == 0 && report.ReconciliationBacklog == 0 &&
		proof.ExactColdReachable && proof.ExactBackupReachable &&
		proof.OldGenerationRejected && proof.RollbackRetentionExpired &&
		proof.ArtifactsEnumerated && proof.FullySettled && proof.CrossCellRestoreVerified &&
		proof.ColdManifestRef != "" && hasDigest(proof.ColdManifestDigest) &&
		proof.ReceiptRef != "" && hasDigest(proof.ReceiptDigest)
}

func phaseWithoutEvidence(desired string) string {
	switch desired {
	case "Provisioning":
		return "Provisioning"
	case "Qualifying", "Ready":
		return "Qualifying"
	case "Draining", "Retired":
		return "Draining"
	case "Frozen":
		return "Frozen"
	default:
		return "Unknown"
	}
}

func phaseWithEvidence(desired string) string {
	switch desired {
	case "Provisioning", "Qualifying", "Draining", "Frozen":
		return desired
	case "Ready":
		return "Qualifying"
	case "Retired":
		return "Draining"
	default:
		return "Unknown"
	}
}

func PlanPool(in PoolInput) PoolPlan {
	if in.MaxConcurrentCellProvisioning <= 0 {
		in.MaxConcurrentCellProvisioning = 1
	}
	if in.ReportFreshness <= 0 {
		in.ReportFreshness = DefaultReportFreshness
	}
	status := PoolStatus{ObservedGeneration: in.Generation, AdmissionCandidates: []string{}}
	boundClaims := make(map[string]struct{}, len(in.Cells))
	memberClaimRefs := make([]string, 0, len(in.Cells))
	managementClusters := make(map[string]struct{}, len(in.ManagementClusters))
	for _, name := range in.ManagementClusters {
		managementClusters[name] = struct{}{}
	}

	validMembers := true
	capacityPressure := false
	pressureWithoutEpoch := false
	type candidate struct {
		name string
		load int64
	}
	var candidates []candidate
	for _, cell := range in.Cells {
		evidenceFresh := !cell.ReportObservedAt.IsZero() && !cell.ReportObservedAt.After(in.Now) && in.Now.Sub(cell.ReportObservedAt) <= in.ReportFreshness
		if cell.ClaimName != "" {
			key := claimIdentityKey(cell.ClaimName, cell.ClaimUID)
			boundClaims[key] = struct{}{}
			memberClaimRefs = append(memberClaimRefs, key)
		}
		status.TotalCells++
		status.PlacementCount += cell.PlacementCount
		status.PendingReservations += cell.PendingReservations
		if cell.ClassName != in.ClassName || cell.Region != in.Region {
			validMembers = false
		}
		if _, ok := managementClusters[cell.ManagementCluster]; !ok {
			validMembers = false
		}
		switch {
		case cell.Phase == "Ready" && evidenceFresh:
			status.ReadyCells++
		case cell.Phase == "Draining" || cell.Phase == "Retired":
			status.DrainingCells++
		default:
			status.PendingCells++
		}
		if evidenceFresh && (cell.CapacityRisk == "AdmissionClosed" || cell.CapacityRisk == "Protect" || cell.CapacityRisk == "Emergency") {
			capacityPressure = true
			if cell.ScaleOutEpoch <= 0 {
				pressureWithoutEpoch = true
			}
		}
		if evidenceFresh && cell.ReadyForPlacement && cell.CapacityRisk == "Normal" {
			candidates = append(candidates, candidate{name: cell.Name, load: cell.PlacementCount + cell.PendingReservations})
		}
	}

	handledTriggers := make(map[string]struct{}, len(in.Claims))
	knownClaims := make(map[string]struct{}, len(in.Claims))
	var pendingClaimsWithoutCell int64
	var failedClaimsWithoutCell int64
	for _, claim := range in.Claims {
		key := claimIdentityKey(claim.Name, claim.UID)
		knownClaims[key] = struct{}{}
		if claim.TriggerKey != "" {
			handledTriggers[claim.TriggerKey] = struct{}{}
		}
		_, hasCell := boundClaims[key]
		if claim.Phase == "Failed" {
			status.FailedClaims++
			if !hasCell {
				failedClaimsWithoutCell++
			}
		} else if claim.Phase != "Bound" {
			status.PendingClaims++
			if !hasCell {
				pendingClaimsWithoutCell++
			}
		}
	}
	for _, key := range memberClaimRefs {
		if key == "" {
			validMembers = false
			continue
		}
		if _, found := knownClaims[key]; !found {
			validMembers = false
		}
	}

	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].load == candidates[j].load {
			return candidates[i].name < candidates[j].name
		}
		return candidates[i].load < candidates[j].load
	})
	for _, candidate := range candidates {
		status.AdmissionCandidates = append(status.AdmissionCandidates, candidate.name)
	}

	// A logical Cell appears before its Claim is Bound. It counts once toward
	// desired capacity while the unbound Claim still consumes a provisioning
	// credit. Only Claims that do not yet have a logical Cell add another
	// effective capacity unit.
	effectiveCells := status.TotalCells + pendingClaimsWithoutCell
	attemptedCells := effectiveCells + failedClaimsWithoutCell
	requests := make([]ClaimRequest, 0)
	canProvision := func() bool {
		return status.PendingClaims+int64(len(requests)) < in.MaxConcurrentCellProvisioning
	}
	for canProvision() && attemptedCells+int64(len(requests)) < in.MinCells && attemptedCells+int64(len(requests)) < in.MaxCells {
		requests = append(requests, ClaimRequest{
			RequestID: fmt.Sprintf("minimum/%d", attemptedCells+int64(len(requests))+1),
			Reason:    "MinimumCells",
		})
	}
	sortedCells := append([]PoolCell(nil), in.Cells...)
	sort.Slice(sortedCells, func(i, j int) bool { return sortedCells[i].Name < sortedCells[j].Name })
	for _, cell := range sortedCells {
		if attemptedCells+int64(len(requests)) >= in.MaxCells || !canProvision() {
			break
		}
		if cell.ScaleOutEpoch <= 0 || (cell.CapacityRisk != "AdmissionClosed" && cell.CapacityRisk != "Protect" && cell.CapacityRisk != "Emergency") {
			continue
		}
		triggerKey := pressureTriggerKey(cell.UID, cell.ScaleOutEpoch)
		if _, handled := handledTriggers[triggerKey]; handled {
			continue
		}
		handledTriggers[triggerKey] = struct{}{}
		requests = append(requests, ClaimRequest{
			RequestID: "pressure/" + triggerKey, Reason: "CapacityPressure",
			CellName: cell.Name, CellUID: cell.UID, ScaleOutEpoch: cell.ScaleOutEpoch,
		})
	}
	status.DesiredCells = attemptedCells + int64(len(requests))
	if status.DesiredCells < in.MinCells {
		status.DesiredCells = in.MinCells
	}
	if status.DesiredCells > in.MaxCells {
		status.DesiredCells = in.MaxCells
	}
	status.DesiredAdditionalCells = int64(len(requests))
	status.AdmissionOpen = validMembers && status.ReadyCells >= in.MinCells && len(status.AdmissionCandidates) > 0

	membersCondition := condition(in.ExistingConditions, in.Now, "MembersValid", metav1.ConditionTrue, "Valid", "all adopted members match class, region and management cluster", in.Generation)
	if !validMembers {
		membersCondition = condition(in.ExistingConditions, in.Now, "MembersValid", metav1.ConditionFalse, "MemberMismatch", "one or more adopted members do not match Pool policy", in.Generation)
	}
	minimumCondition := condition(in.ExistingConditions, in.Now, "MinimumReady", metav1.ConditionFalse, "InsufficientReadyCells", fmt.Sprintf("%d ready Cells; at least %d required", status.ReadyCells, in.MinCells), in.Generation)
	if status.ReadyCells >= in.MinCells {
		minimumCondition = condition(in.ExistingConditions, in.Now, "MinimumReady", metav1.ConditionTrue, "Satisfied", "minimum ready Cell count is satisfied", in.Generation)
	}
	admissionCondition := condition(in.ExistingConditions, in.Now, "AdmissionOpen", metav1.ConditionFalse, "Closed", "Pool has no safe placement candidate or has not met minimum readiness", in.Generation)
	if status.AdmissionOpen {
		admissionCondition = condition(in.ExistingConditions, in.Now, "AdmissionOpen", metav1.ConditionTrue, "Open", "Pool has safe placement candidates", in.Generation)
	}
	scaleCondition := condition(in.ExistingConditions, in.Now, "ScaleOutRequired", metav1.ConditionFalse, "Satisfied", "no unhandled scale-out epoch requires another Cell claim", in.Generation)
	if status.DesiredAdditionalCells > 0 {
		scaleCondition = condition(in.ExistingConditions, in.Now, "ScaleOutRequired", metav1.ConditionTrue, "CapacityGap", fmt.Sprintf("%d additional Cell claim(s) required", status.DesiredAdditionalCells), in.Generation)
	} else if capacityPressure && effectiveCells >= in.MaxCells {
		scaleCondition = condition(in.ExistingConditions, in.Now, "ScaleOutRequired", metav1.ConditionFalse, "MaximumReached", "capacity is under pressure but maxCells prevents another claim", in.Generation)
	} else if pressureWithoutEpoch {
		scaleCondition = condition(in.ExistingConditions, in.Now, "ScaleOutRequired", metav1.ConditionFalse, "EpochMissing", "capacity is under pressure but no new scaleOutEpoch was published", in.Generation)
	}
	claimsCondition := condition(in.ExistingConditions, in.Now, "ClaimsHealthy", metav1.ConditionTrue, "Healthy", "no Cell claim reports provider failure", in.Generation)
	if status.FailedClaims > 0 {
		claimsCondition = condition(in.ExistingConditions, in.Now, "ClaimsHealthy", metav1.ConditionFalse, "ProviderFailure", fmt.Sprintf("%d Cell claim(s) failed; automatic retry is blocked until operator action", status.FailedClaims), in.Generation)
	}
	scaleInCandidate, scaleInRequest, scaleInReason := PlanScaleIn(in, capacityPressure, status.PendingClaims)
	status.ScaleInCandidate = scaleInCandidate
	scaleInCondition := condition(in.ExistingConditions, in.Now, "ScaleInCandidate", metav1.ConditionFalse, "Inactive", scaleInReason, in.Generation)
	if scaleInCandidate != nil {
		scaleInCondition = condition(in.ExistingConditions, in.Now, "ScaleInCandidate", metav1.ConditionTrue, "Observing", scaleInReason, in.Generation)
	}
	status.Conditions = sortedConditions(membersCondition, minimumCondition, admissionCondition, scaleCondition, claimsCondition, scaleInCondition)
	return PoolPlan{Status: status, ClaimRequests: requests, ScaleInRequest: scaleInRequest}
}

func pressureTriggerKey(cellUID string, epoch int64) string {
	if cellUID == "" || epoch <= 0 {
		return ""
	}
	return fmt.Sprintf("%s/%d", cellUID, epoch)
}

func claimIdentityKey(name, uid string) string {
	if name == "" || uid == "" {
		return ""
	}
	return name + "/" + uid
}
