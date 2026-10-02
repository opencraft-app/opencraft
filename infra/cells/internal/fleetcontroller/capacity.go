package fleetcontroller

// PlanCellCapacity is the authoritative admission-risk transition. Reporters
// publish observations; they do not choose policy or mint scale-out epochs.
func PlanCellCapacity(policy CellCapacityPolicy, previousRisk string, previousEpoch int64, report *CellReport, reportValid bool) CellCapacityPlan {
	if !validCapacityRisk(previousRisk) {
		previousRisk = "Unknown"
	}
	if previousEpoch < 0 {
		previousEpoch = 0
	}
	plan := CellCapacityPlan{
		Risk:          previousRisk,
		ScaleOutEpoch: previousEpoch,
		Reason:        "fresh Prometheus-backed capacity evidence is required",
	}
	if !validCellCapacityPolicy(policy) {
		plan.Reason = "Cell capacity policy thresholds are invalid"
		return plan
	}
	if !reportValid || report == nil || !report.FDBCapacityEvidenceReady ||
		report.FDBStorageHeadroomSamples <= 0 || report.FDBWriteUtilizationPercent < 0 ||
		report.FDBWriteUtilizationPercent > 100 {
		return plan
	}

	utilization := report.FDBWriteUtilizationPercent
	nextRisk := "Normal"
	switch {
	case utilization >= policy.ScaleOutAtPct:
		nextRisk = "Emergency"
	case utilization >= policy.DegradedWriteUtilizationLimitPct:
		nextRisk = "Protect"
	case utilization >= policy.HealthyWriteUtilizationLimitPct:
		nextRisk = "AdmissionClosed"
	}
	// Gasoline/FDB logical bytes are an application-retention budget, distinct
	// from physical FDB disk headroom. Crossing it closes only new placement;
	// existing Agents and recovery/pruning traffic retain service priority.
	if policy.FDBLogicalSoftBytes > 0 || policy.FDBLogicalHardBytes > 0 {
		if policy.FDBLogicalSoftBytes <= 0 || policy.FDBLogicalHardBytes <= policy.FDBLogicalSoftBytes ||
			!report.FDBLogicalBytesKnown || report.FDBLogicalBytes < 0 {
			plan.Reason = "Gasoline logical-byte policy or evidence is invalid"
			return plan
		}
		switch {
		case report.FDBLogicalBytes >= policy.FDBLogicalHardBytes:
			nextRisk = moreSevereCapacityRisk(nextRisk, "Emergency")
		case report.FDBLogicalBytes >= policy.FDBLogicalSoftBytes:
			nextRisk = moreSevereCapacityRisk(nextRisk, "AdmissionClosed")
		}
	}
	if capacityPressure(nextRisk) && !capacityPressure(previousRisk) {
		plan.ScaleOutEpoch++
	}
	plan.Risk = nextRisk
	plan.EvidenceReady = true
	plan.Reason = "capacity risk was derived from fresh Cell-bound evidence"
	return plan
}

func moreSevereCapacityRisk(left, right string) string {
	rank := map[string]int{"Unknown": 0, "Normal": 1, "AdmissionClosed": 2, "Protect": 3, "Emergency": 4}
	if rank[right] > rank[left] {
		return right
	}
	return left
}

func validCellCapacityPolicy(policy CellCapacityPolicy) bool {
	return policy.HealthyWriteUtilizationLimitPct > 0 &&
		policy.HealthyWriteUtilizationLimitPct <= policy.DegradedWriteUtilizationLimitPct &&
		policy.DegradedWriteUtilizationLimitPct <= policy.ScaleOutAtPct &&
		policy.ScaleOutAtPct <= 100
}

func validCapacityRisk(risk string) bool {
	switch risk {
	case "Unknown", "Normal", "AdmissionClosed", "Protect", "Emergency":
		return true
	default:
		return false
	}
}

func capacityPressure(risk string) bool {
	return risk == "AdmissionClosed" || risk == "Protect" || risk == "Emergency"
}
