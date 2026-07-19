package framework

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestRunnerSkipsDependentsAndPreservesResourcesOnCaseFailure(t *testing.T) {
	ctx := NewRunContext("run-failed", NewSanitizer())
	ctx.TrackResource(ResourceRef{Kind: "tenant", ID: "reg-run-failed-user"})
	cleaned := false
	safetyRestored := false
	ctx.DeferCleanup("delete tenant", func(context.Context) error {
		cleaned = true
		return nil
	})
	ctx.DeferSafetyCleanup("restore set-manager CronJob", func(context.Context) error {
		safetyRestored = true
		return nil
	})

	runner := NewRunner([]Case{
		CaseFunc{CaseID: "first", RunFunc: func(context.Context, *RunContext) (Observations, error) {
			return nil, errors.New("boom")
		}},
		CaseFunc{CaseID: "second", DependsOn: []string{"first"}, RunFunc: func(context.Context, *RunContext) (Observations, error) {
			t.Fatal("dependent case must not run")
			return nil, nil
		}},
	}, nil)

	report, err := runner.Run(t.Context(), Scenario{Name: "failed", Cases: []string{"first", "second"}}, ctx)
	if err == nil {
		t.Fatal("Run() error = nil")
	}
	if report.Status != RunStatusFailed {
		t.Fatalf("status = %q", report.Status)
	}
	if got := []CaseStatus{report.Cases[0].Status, report.Cases[1].Status}; !reflect.DeepEqual(got, []CaseStatus{CaseStatusFailed, CaseStatusSkippedDependency}) {
		t.Fatalf("case statuses = %v", got)
	}
	if cleaned {
		t.Fatal("failed run must preserve resources")
	}
	if !safetyRestored || report.Cleanup.Status != CleanupStatusPassed || len(report.Cleanup.Actions) != 1 {
		t.Fatalf("failed run safety cleanup=%v report=%+v", safetyRestored, report.Cleanup)
	}
	if len(report.RetainedResources) != 1 || report.RetainedResources[0].ID != "reg-run-failed-user" {
		t.Fatalf("retained resources = %+v", report.RetainedResources)
	}
}

func TestRunnerCleansUpSuccessfulRunInReverseOrder(t *testing.T) {
	ctx := NewRunContext("run-ok", NewSanitizer())
	var order []string
	ctx.DeferCleanup("first", func(context.Context) error { order = append(order, "first"); return nil })
	ctx.DeferCleanup("second", func(context.Context) error { order = append(order, "second"); return nil })
	runner := NewRunner([]Case{CaseFunc{CaseID: "pass", RunFunc: passCase}}, nil)

	report, err := runner.Run(t.Context(), Scenario{Name: "ok", Cases: []string{"pass"}}, ctx)
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != RunStatusPassed || report.Cleanup.Status != CleanupStatusPassed {
		t.Fatalf("report = %+v", report)
	}
	if !reflect.DeepEqual(order, []string{"second", "first"}) {
		t.Fatalf("cleanup order = %v", order)
	}
}

func TestRunnerSafetyCleanupSurvivesCanceledRunContext(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	run := NewRunContext("run-canceled", NewSanitizer())
	cleaned := false
	run.DeferSafetyCleanup("restore safety state", func(cleanupCtx context.Context) error {
		if err := cleanupCtx.Err(); err != nil {
			return err
		}
		cleaned = true
		return nil
	})
	runner := NewRunner([]Case{CaseFunc{CaseID: "cancel", RunFunc: func(context.Context, *RunContext) (Observations, error) {
		cancel()
		return nil, errors.New("interrupted")
	}}}, nil)

	report, err := runner.Run(ctx, Scenario{Name: "canceled", Cases: []string{"cancel"}}, run)
	if err == nil || !cleaned || report.Cleanup.Status != CleanupStatusPassed {
		t.Fatalf("error=%v cleaned=%v cleanup=%+v", err, cleaned, report.Cleanup)
	}
}

func TestRunnerReportsPartialCleanupAndCanResume(t *testing.T) {
	ctx := NewRunContext("run-cleanup", NewSanitizer())
	ctx.TrackResource(ResourceRef{Kind: "api_key", ID: "key-id"})
	ctx.TrackResource(ResourceRef{Kind: "tenant", ID: "tenant-id"})
	ctx.DeferCleanup("delete tenant", func(context.Context) error { return errors.New("worker timeout") })
	ctx.DeferCleanup("delete key", func(context.Context) error { return nil })
	runner := NewRunner([]Case{CaseFunc{CaseID: "pass", RunFunc: passCase}}, nil)

	report, err := runner.Run(t.Context(), Scenario{Name: "cleanup", Cases: []string{"pass"}}, ctx)
	if err == nil {
		t.Fatal("Run() error = nil")
	}
	if report.Status != RunStatusCleanupFailed || report.Cleanup.Status != CleanupStatusFailed {
		t.Fatalf("report = %+v", report)
	}
	if len(report.Cleanup.Actions) != 2 || report.Cleanup.Actions[0].Status != CleanupActionPassed || report.Cleanup.Actions[1].Status != CleanupActionFailed {
		t.Fatalf("cleanup actions = %+v", report.Cleanup.Actions)
	}
	if len(report.RetainedResources) != 2 {
		t.Fatalf("retained resources = %+v", report.RetainedResources)
	}
}

func TestRunnerRejectsMissingCapabilityBeforeCasesRun(t *testing.T) {
	runner := NewRunner([]Case{CaseFunc{
		CaseID: "rollout", Requires: []Capability{CapabilityKubernetesAPI, CapabilityClusterPodNetwork},
		RunFunc: func(context.Context, *RunContext) (Observations, error) {
			t.Fatal("case must not run")
			return nil, nil
		},
	}}, []Capability{CapabilityKubernetesAPI})

	_, err := runner.Run(t.Context(), Scenario{Name: "rollout", Cases: []string{"rollout"}}, NewRunContext("run-cap", NewSanitizer()))
	if err == nil || err.Error() != `case "rollout" requires capability "cluster_pod_network"` {
		t.Fatalf("Run() error = %v", err)
	}
}

func passCase(context.Context, *RunContext) (Observations, error) {
	return Observations{"verified": true}, nil
}
