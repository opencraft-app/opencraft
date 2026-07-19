package framework

import (
	"context"
	"errors"
	"fmt"
	"time"
)

type Runner struct {
	cases        map[string]Case
	capabilities map[Capability]struct{}
	now          func() time.Time
}

func NewRunner(cases []Case, capabilities []Capability) *Runner {
	registry := make(map[string]Case, len(cases))
	for _, item := range cases {
		registry[item.ID()] = item
	}
	available := make(map[Capability]struct{}, len(capabilities))
	for _, capability := range capabilities {
		available[capability] = struct{}{}
	}
	return &Runner{cases: registry, capabilities: available, now: func() time.Time { return time.Now().UTC() }}
}

func (r *Runner) Run(ctx context.Context, scenario Scenario, run *RunContext) (Report, error) {
	if run == nil {
		return Report{}, errors.New("run context is required")
	}
	if err := r.validate(scenario); err != nil {
		return Report{}, err
	}
	report := Report{
		RunID: run.RunID, Scenario: scenario.Name, Status: RunStatusPassed,
		StartedAt: r.now(), Cleanup: CleanupResult{Status: CleanupStatusNotRun},
	}
	statuses := map[string]CaseStatus{}
	var runErr error
	for _, id := range scenario.Cases {
		item := r.cases[id]
		if dependencyFailed(item.Dependencies(), statuses) {
			result := CaseResult{ID: id, Status: CaseStatusSkippedDependency}
			report.Cases = append(report.Cases, result)
			statuses[id] = result.Status
			continue
		}
		result := r.runCase(ctx, item, run)
		report.Cases = append(report.Cases, result)
		statuses[id] = result.Status
		if result.Status == CaseStatusFailed && runErr == nil {
			runErr = errors.New(result.Error)
		}
	}
	if runErr != nil {
		report.Status = RunStatusFailed
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
		safetyCleanup, safetyErr := r.cleanup(cleanupCtx, run, true)
		cancel()
		report.Cleanup = safetyCleanup
		if safetyErr != nil {
			runErr = errors.Join(runErr, safetyErr)
		}
		report.Error = run.Sanitizer.String(runErr.Error())
		report.RetainedResources = run.Resources()
	} else {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
		cleanup, cleanupErr := r.cleanup(cleanupCtx, run, false)
		cancel()
		report.Cleanup = cleanup
		if cleanupErr != nil {
			runErr = cleanupErr
			report.Status = RunStatusCleanupFailed
			report.Error = run.Sanitizer.String(cleanupErr.Error())
			report.RetainedResources = run.Resources()
		}
	}
	report.FinishedAt = r.now()
	return report, runErr
}

func (r *Runner) validate(scenario Scenario) error {
	seen := map[string]struct{}{}
	for _, id := range scenario.Cases {
		item, ok := r.cases[id]
		if !ok {
			return fmt.Errorf("scenario %q references unknown case %q", scenario.Name, id)
		}
		for _, capability := range item.Capabilities() {
			if _, ok := r.capabilities[capability]; !ok {
				return fmt.Errorf("case %q requires capability %q", id, capability)
			}
		}
		for _, dependency := range item.Dependencies() {
			if _, ok := seen[dependency]; !ok {
				return fmt.Errorf("case %q dependency %q must appear earlier in scenario", id, dependency)
			}
		}
		seen[id] = struct{}{}
	}
	return nil
}

func (r *Runner) runCase(ctx context.Context, item Case, run *RunContext) (result CaseResult) {
	result = CaseResult{ID: item.ID(), Status: CaseStatusPassed, StartedAt: r.now()}
	defer func() {
		if recovered := recover(); recovered != nil {
			result.Status = CaseStatusFailed
			result.Error = run.Sanitizer.String(fmt.Sprintf("panic: %v", recovered))
		}
		result.FinishedAt = r.now()
		result.Duration = result.FinishedAt.Sub(result.StartedAt)
	}()
	observations, err := item.Run(ctx, run)
	result.Observations = observations
	if err != nil {
		result.Status = CaseStatusFailed
		result.Error = run.Sanitizer.String(err.Error())
	}
	return result
}

func (r *Runner) cleanup(ctx context.Context, run *RunContext, safetyOnly bool) (CleanupResult, error) {
	result := CleanupResult{Status: CleanupStatusPassed}
	actions := run.cleanupActions()
	var joined error
	for index := len(actions) - 1; index >= 0; index-- {
		action := actions[index]
		if safetyOnly && !action.safety {
			continue
		}
		item := CleanupActionResult{Name: action.name, Status: CleanupActionPassed}
		if err := action.run(ctx); err != nil {
			item.Status = CleanupActionFailed
			item.Error = run.Sanitizer.String(err.Error())
			joined = errors.Join(joined, fmt.Errorf("%s: %w", action.name, err))
		}
		result.Actions = append(result.Actions, item)
	}
	if joined != nil {
		result.Status = CleanupStatusFailed
	}
	return result, joined
}

func dependencyFailed(dependencies []string, statuses map[string]CaseStatus) bool {
	for _, dependency := range dependencies {
		if statuses[dependency] != CaseStatusPassed {
			return true
		}
	}
	return false
}
