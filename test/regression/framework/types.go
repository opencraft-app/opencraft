package framework

import (
	"context"
	"time"
)

type Capability string

const (
	CapabilityKubernetesAPI        Capability = "kubernetes_api"
	CapabilityClusterPodNetwork    Capability = "cluster_pod_network"
	CapabilityDisruptiveKubernetes Capability = "disruptive_kubernetes"
)

type CaseStatus string

const (
	CaseStatusPassed            CaseStatus = "passed"
	CaseStatusFailed            CaseStatus = "failed"
	CaseStatusSkippedDependency CaseStatus = "skipped_dependency"
)

type RunStatus string

const (
	RunStatusPassed        RunStatus = "passed"
	RunStatusFailed        RunStatus = "failed"
	RunStatusCleanupFailed RunStatus = "cleanup_failed"
)

type CleanupStatus string

const (
	CleanupStatusNotRun CleanupStatus = "not_run"
	CleanupStatusPassed CleanupStatus = "passed"
	CleanupStatusFailed CleanupStatus = "failed"
)

type CleanupActionStatus string

const (
	CleanupActionPassed CleanupActionStatus = "passed"
	CleanupActionFailed CleanupActionStatus = "failed"
)

type Observations map[string]any

type Case interface {
	ID() string
	Dependencies() []string
	Capabilities() []Capability
	Run(context.Context, *RunContext) (Observations, error)
}

type CaseFunc struct {
	CaseID    string
	DependsOn []string
	Requires  []Capability
	RunFunc   func(context.Context, *RunContext) (Observations, error)
}

func (c CaseFunc) ID() string                 { return c.CaseID }
func (c CaseFunc) Dependencies() []string     { return append([]string(nil), c.DependsOn...) }
func (c CaseFunc) Capabilities() []Capability { return append([]Capability(nil), c.Requires...) }
func (c CaseFunc) Run(ctx context.Context, run *RunContext) (Observations, error) {
	return c.RunFunc(ctx, run)
}

type Scenario struct {
	Name  string   `json:"name" yaml:"name"`
	Cases []string `json:"cases" yaml:"cases"`
}

type CaseResult struct {
	ID           string        `json:"case_id"`
	Status       CaseStatus    `json:"status"`
	StartedAt    time.Time     `json:"started_at,omitempty"`
	FinishedAt   time.Time     `json:"finished_at,omitempty"`
	Duration     time.Duration `json:"duration,omitempty"`
	Error        string        `json:"error,omitempty"`
	Observations Observations  `json:"observations,omitempty"`
}

type CleanupActionResult struct {
	Name   string              `json:"name"`
	Status CleanupActionStatus `json:"status"`
	Error  string              `json:"error,omitempty"`
}

type CleanupResult struct {
	Status  CleanupStatus         `json:"status"`
	Actions []CleanupActionResult `json:"actions,omitempty"`
}

type ResourceRef struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	SetID string `json:"set_id,omitempty"`
}

type Report struct {
	RunID             string        `json:"run_id"`
	Scenario          string        `json:"scenario"`
	Status            RunStatus     `json:"status"`
	StartedAt         time.Time     `json:"started_at"`
	FinishedAt        time.Time     `json:"finished_at"`
	Cases             []CaseResult  `json:"cases"`
	Cleanup           CleanupResult `json:"cleanup"`
	RetainedResources []ResourceRef `json:"retained_resources,omitempty"`
	Error             string        `json:"error,omitempty"`
}
