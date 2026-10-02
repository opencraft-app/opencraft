package fleetcontroller

import (
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	FDBAutoscalingDisabled    = "Disabled"
	FDBAutoscalingObserveOnly = "ObserveOnly"
	FDBAutoscalingAutomatic   = "Automatic"
	FDBVolumeGCObserveOnly    = "ObserveOnly"
	FDBVolumeGCAutomatic      = "Automatic"
	DefaultFDBVolumeRetention = 30 * 24 * time.Hour
)

// PlanFDBAutoscaling is deliberately pure. The FoundationDB Kubernetes
// Operator remains the only component that creates, excludes, drains and
// removes process groups. This planner only chooses the desired storage
// process count after sustained capacity evidence and safety gates.
func PlanFDBAutoscaling(in CellInput, reportValid bool) FDBAutoscalingStatus {
	policy := in.FDBAutoscalingPolicy
	previous := in.FDBAutoscalingStatus
	status := previous
	status.Mode = policy.Mode
	status.ObservedProcessCount = in.ObservedFDBProcesses
	status.VolumeRetentionSeconds = policy.VolumeRetentionSeconds
	status.VolumeGCMode = policy.VolumeGCMode

	if status.DesiredProcessCount == 0 {
		status.DesiredProcessCount = in.InitialFDBProcesses
	}
	if status.RecommendedProcessCount == 0 {
		status.RecommendedProcessCount = status.DesiredProcessCount
	}
	if policy.Mode == "" || policy.Mode == FDBAutoscalingDisabled {
		status.Mode = FDBAutoscalingDisabled
		status.Phase = "Disabled"
		status.DesiredProcessCount = in.InitialFDBProcesses
		status.RecommendedProcessCount = in.InitialFDBProcesses
		status.ScaleUpSignalSince = nil
		status.ScaleDownSignalSince = nil
		status.Reason = "autoscaling is disabled by the Cell profile"
		return status
	}
	if !validAutoscalingPolicy(policy, in.InitialFDBProcesses) {
		status.Phase = "Blocked"
		status.Reason = "autoscaling policy violates the three-zone FoundationDB safety contract"
		return status
	}
	if status.DesiredProcessCount < policy.MinProcessCount || status.DesiredProcessCount > policy.MaxProcessCount || status.DesiredProcessCount%policy.StepProcessCount != 0 {
		status.Phase = "Blocked"
		status.Reason = "persisted desired process count is outside the autoscaling policy"
		return status
	}
	if !reportValid || in.Report == nil || !in.Report.FDBCapacityEvidenceReady {
		status.Phase = "InsufficientData"
		status.Reason = "fresh Prometheus-backed FDB capacity evidence is required"
		status.ScaleUpSignalSince = nil
		status.ScaleDownSignalSince = nil
		return status
	}

	report := in.Report
	upSignal := report.FDBStorageHeadroomSamples >= policy.ScaleUpMinimumSamples &&
		(report.FDBStorageHeadroomBytes <= policy.ScaleUpHeadroomBytes ||
			(report.FDBStorageHeadroomETAKnown && report.FDBStorageHeadroomETASeconds <= policy.ScaleUpETASeconds))
	downSignal := report.FDBStorageHeadroomSamples >= policy.ScaleDownMinimumSamples &&
		report.FDBStorageHeadroomBytes >= policy.ScaleDownHeadroomBytes &&
		report.FDBWriteUtilizationPercent <= policy.ScaleDownWriteUtilizationPct

	status.ScaleUpSignalSince = sustainedSince(status.ScaleUpSignalSince, upSignal, in.Now)
	status.ScaleDownSignalSince = sustainedSince(status.ScaleDownSignalSince, downSignal && !upSignal, in.Now)
	status.RecommendedProcessCount = status.DesiredProcessCount

	safe := in.FDBOperatorFound && in.FDBOperatorReady && report.FDBAvailable && report.FDBHealthy &&
		report.BackupReady && !report.CorrectnessViolation && report.FDBDataMovementBytes == 0
	if !safe {
		status.Phase = "Blocked"
		status.Reason = "FDB, backup, identity or data-movement safety gate is not satisfied"
		return status
	}

	if signalMature(status.ScaleUpSignalSince, policy.ScaleUpSustain, in.Now) && cooldownElapsed(status.LastScaleTime, policy.ScaleUpCooldown, in.Now) {
		status.RecommendedProcessCount = min64(status.DesiredProcessCount+policy.StepProcessCount, policy.MaxProcessCount)
		status.Phase = "ScaleUpRecommended"
		status.Reason = "storage headroom or forecast remained below the scale-up threshold"
	} else if signalMature(status.ScaleDownSignalSince, policy.ScaleDownSustain, in.Now) && cooldownElapsed(status.LastScaleTime, policy.ScaleDownCooldown, in.Now) {
		status.RecommendedProcessCount = max64(status.DesiredProcessCount-policy.StepProcessCount, policy.MinProcessCount)
		status.Phase = "ScaleDownRecommended"
		status.Reason = "storage headroom and write utilization remained within the scale-down envelope"
	} else {
		status.Phase = "Stable"
		status.Reason = "capacity signals have not crossed a sustained scaling threshold"
	}

	if policy.Mode == FDBAutoscalingAutomatic && status.RecommendedProcessCount != status.DesiredProcessCount {
		direction := "Up"
		if status.RecommendedProcessCount < status.DesiredProcessCount {
			direction = "Down"
		}
		status.DesiredProcessCount = status.RecommendedProcessCount
		now := timeToMeta(in.Now)
		status.LastScaleTime = &now
		status.LastScaleDirection = direction
		status.ScaleUpSignalSince = nil
		status.ScaleDownSignalSince = nil
		status.Phase = "Scaling" + direction
	}
	return status
}

func validAutoscalingPolicy(policy FDBAutoscalingPolicy, initial int64) bool {
	return (policy.Mode == FDBAutoscalingObserveOnly || policy.Mode == FDBAutoscalingAutomatic) &&
		policy.MinProcessCount >= 9 && policy.MinProcessCount <= initial &&
		policy.MaxProcessCount >= initial && policy.MaxProcessCount >= policy.MinProcessCount &&
		policy.StepProcessCount >= 3 && policy.StepProcessCount%3 == 0 &&
		policy.MinProcessCount%3 == 0 && policy.MaxProcessCount%3 == 0 &&
		policy.ScaleUpHeadroomBytes > 0 && policy.ScaleUpETASeconds > 0 &&
		policy.ScaleUpSustain > 0 && policy.ScaleUpCooldown > 0 && policy.ScaleUpMinimumSamples > 0 &&
		policy.ScaleDownHeadroomBytes > policy.ScaleUpHeadroomBytes &&
		policy.ScaleDownWriteUtilizationPct >= 0 && policy.ScaleDownWriteUtilizationPct <= 100 &&
		policy.ScaleDownSustain > 0 && policy.ScaleDownCooldown > 0 && policy.ScaleDownMinimumSamples > 0 &&
		policy.VolumeRetentionSeconds >= 86400 &&
		(policy.VolumeGCMode == FDBVolumeGCObserveOnly || policy.VolumeGCMode == FDBVolumeGCAutomatic)
}

func sustainedSince(previous *metav1.Time, active bool, now time.Time) *metav1.Time {
	if !active {
		return nil
	}
	if previous != nil {
		copy := previous.DeepCopy()
		return copy
	}
	value := timeToMeta(now)
	return &value
}

func signalMature(since *metav1.Time, duration time.Duration, now time.Time) bool {
	return since != nil && !now.Before(since.Time.Add(duration))
}

func cooldownElapsed(last *metav1.Time, duration time.Duration, now time.Time) bool {
	return last == nil || !now.Before(last.Time.Add(duration))
}

func timeToMeta(value time.Time) metav1.Time { return metav1.NewTime(value.UTC()) }

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
