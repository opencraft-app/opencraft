package fleetcontroller

import (
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestFDBAutoscalingObserveOnlyRecommendsWithoutMutatingDesiredCount(t *testing.T) {
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	in := autoscalingTestInput(now, FDBAutoscalingObserveOnly)
	since := metav1.NewTime(now.Add(-31 * time.Minute))
	in.FDBAutoscalingStatus.ScaleUpSignalSince = &since
	in.Report.FDBStorageHeadroomBytes = 32 << 30
	in.Report.FDBStorageHeadroomETASeconds = 2 * 24 * 60 * 60
	in.Report.FDBStorageHeadroomETAKnown = true

	status := PlanFDBAutoscaling(in, true)
	if status.Phase != "ScaleUpRecommended" || status.RecommendedProcessCount != 12 {
		t.Fatalf("unexpected recommendation: %#v", status)
	}
	if status.DesiredProcessCount != 9 || status.LastScaleTime != nil {
		t.Fatalf("ObserveOnly mutated desired capacity: %#v", status)
	}
}

func TestFDBAutoscalingAutomaticChangesOnlyOneThreeZoneStep(t *testing.T) {
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	in := autoscalingTestInput(now, FDBAutoscalingAutomatic)
	since := metav1.NewTime(now.Add(-31 * time.Minute))
	in.FDBAutoscalingStatus.ScaleUpSignalSince = &since
	in.Report.FDBStorageHeadroomBytes = 32 << 30

	status := PlanFDBAutoscaling(in, true)
	if status.Phase != "ScalingUp" || status.DesiredProcessCount != 12 || status.RecommendedProcessCount != 12 {
		t.Fatalf("unexpected automatic scale-up: %#v", status)
	}
	if status.LastScaleTime == nil || status.LastScaleDirection != "Up" {
		t.Fatalf("scale receipt state was not persisted: %#v", status)
	}
}

func TestFDBAutoscalingBlocksMutationDuringDataMovement(t *testing.T) {
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	in := autoscalingTestInput(now, FDBAutoscalingAutomatic)
	since := metav1.NewTime(now.Add(-31 * time.Minute))
	in.FDBAutoscalingStatus.ScaleUpSignalSince = &since
	in.Report.FDBStorageHeadroomBytes = 32 << 30
	in.Report.FDBDataMovementBytes = 1

	status := PlanFDBAutoscaling(in, true)
	if status.Phase != "Blocked" || status.DesiredProcessCount != 9 {
		t.Fatalf("data movement did not fence autoscaling: %#v", status)
	}
}

func TestFDBAutoscalingScaleDownHonorsMinimumAndLongCooldown(t *testing.T) {
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	in := autoscalingTestInput(now, FDBAutoscalingAutomatic)
	in.FDBAutoscalingStatus.DesiredProcessCount = 12
	in.FDBAutoscalingStatus.RecommendedProcessCount = 12
	in.ObservedFDBProcesses = 12
	since := metav1.NewTime(now.Add(-25 * time.Hour))
	in.FDBAutoscalingStatus.ScaleDownSignalSince = &since
	in.Report.FDBStorageHeadroomBytes = 180 << 30
	in.Report.FDBWriteUtilizationPercent = 10

	status := PlanFDBAutoscaling(in, true)
	if status.Phase != "ScalingDown" || status.DesiredProcessCount != 9 {
		t.Fatalf("unexpected scale-down: %#v", status)
	}

	in.FDBAutoscalingStatus = status
	in.FDBAutoscalingStatus.ScaleDownSignalSince = &since
	in.Now = now.Add(25 * time.Hour)
	status = PlanFDBAutoscaling(in, true)
	if status.DesiredProcessCount != 9 {
		t.Fatalf("scaled below the production minimum: %#v", status)
	}
}

func TestFDBAutoscalingDefaultVolumeRetentionIsThirtyDays(t *testing.T) {
	if got := int64(DefaultFDBVolumeRetention / time.Second); got != 2592000 {
		t.Fatalf("default volume retention = %d", got)
	}
}

func autoscalingTestInput(now time.Time, mode string) CellInput {
	return CellInput{
		Now:                  now,
		InitialFDBProcesses:  9,
		ObservedFDBProcesses: 9,
		FDBOperatorFound:     true,
		FDBOperatorReady:     true,
		FDBAutoscalingPolicy: FDBAutoscalingPolicy{
			Mode:                         mode,
			MinProcessCount:              9,
			MaxProcessCount:              30,
			StepProcessCount:             3,
			ScaleUpHeadroomBytes:         80 << 30,
			ScaleUpETASeconds:            72 * 60 * 60,
			ScaleUpSustain:               30 * time.Minute,
			ScaleUpCooldown:              2 * time.Hour,
			ScaleUpMinimumSamples:        600,
			ScaleDownHeadroomBytes:       160 << 30,
			ScaleDownWriteUtilizationPct: 20,
			ScaleDownSustain:             24 * time.Hour,
			ScaleDownCooldown:            7 * 24 * time.Hour,
			ScaleDownMinimumSamples:      1200,
			VolumeRetentionSeconds:       2592000,
			VolumeGCMode:                 FDBVolumeGCObserveOnly,
		},
		FDBAutoscalingStatus: FDBAutoscalingStatus{
			DesiredProcessCount:     9,
			RecommendedProcessCount: 9,
		},
		Report: &CellReport{
			FDBAvailable:               true,
			FDBHealthy:                 true,
			BackupReady:                true,
			FDBStorageHeadroomBytes:    120 << 30,
			FDBStorageHeadroomSamples:  1200,
			FDBWriteUtilizationPercent: 50,
			FDBDataMovementBytes:       0,
			FDBCapacityEvidenceReady:   true,
		},
	}
}
