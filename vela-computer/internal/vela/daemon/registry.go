package daemon

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

var ErrInvalidRegistryConfig = errors.New("Vela Agent Registry 配置无效")

type RegistryConfig struct {
	Factory       AgentFactory
	MaxConcurrent int
	RetryDelay    func(int) time.Duration
	StartTimeout  time.Duration
}

type ApplyResult struct {
	Accepted  bool
	ErrorCode string
}

type Registry struct {
	mu            sync.Mutex
	factory       AgentFactory
	maxConcurrent int
	retryDelay    func(int) time.Duration
	startTimeout  time.Duration
	computerID    string
	epoch         string
	revision      int64
	snapshotHash  string
	cells         map[string]*agentCell
}

func NewRegistry(config RegistryConfig) (*Registry, error) {
	if config.Factory == nil ||
		config.MaxConcurrent < 1 ||
		config.MaxConcurrent > DefaultMaximumAgents ||
		config.StartTimeout < 0 {
		return nil, ErrInvalidRegistryConfig
	}
	if config.RetryDelay == nil {
		config.RetryDelay = agentRetryDelay
	}
	if config.StartTimeout == 0 {
		config.StartTimeout = 30 * time.Second
	}
	return &Registry{
		factory:       config.Factory,
		maxConcurrent: config.MaxConcurrent,
		retryDelay:    config.RetryDelay,
		startTimeout:  config.StartTimeout,
		cells:         make(map[string]*agentCell),
	}, nil
}

func (r *Registry) Apply(
	ctx context.Context,
	snapshot Snapshot,
) (ApplyResult, error) {
	if r == nil || ctx == nil {
		return ApplyResult{}, ErrInvalidRegistryConfig
	}
	r.mu.Lock()
	expectedComputerID := r.computerID
	if expectedComputerID == "" {
		expectedComputerID = snapshot.ComputerID
	}
	if err := ValidateSnapshot(snapshot, expectedComputerID); err != nil {
		r.mu.Unlock()
		return rejectedApply(err), nil
	}
	running := 0
	for _, assignment := range snapshot.Agents {
		if assignment.DesiredState == DesiredRunning {
			running++
		}
	}
	if running > r.maxConcurrent {
		r.mu.Unlock()
		return rejectedApply(ErrCapacityExceeded), nil
	}
	if snapshot.Epoch == r.epoch {
		switch {
		case snapshot.Revision < r.revision:
			r.mu.Unlock()
			return rejectedApply(ErrRevisionRegressed), nil
		case snapshot.Revision == r.revision &&
			snapshot.SnapshotHash != r.snapshotHash:
			r.mu.Unlock()
			return rejectedApply(ErrRevisionCollision), nil
		case snapshot.Revision == r.revision:
			r.mu.Unlock()
			return ApplyResult{Accepted: true}, nil
		}
		if err := r.validateGenerations(snapshot); err != nil {
			r.mu.Unlock()
			return rejectedApply(err), nil
		}
	}

	desired := make(map[string]desiredAgent, len(snapshot.Agents))
	for _, assignment := range snapshot.Agents {
		if assignment.DesiredState != DesiredRunning {
			continue
		}
		desired[assignment.AgentID] = desiredAgent{
			assignment: assignment,
			epoch:      snapshot.Epoch,
			revision:   snapshot.Revision,
		}
	}
	retiring := make([]cellRetirement, 0)
	for agentID, cell := range r.cells {
		if _, exists := desired[agentID]; exists {
			continue
		}
		cell.ClearDesired()
		retiring = append(retiring, cellRetirement{
			agentID: agentID,
			cell:    cell,
		})
	}
	for _, agentID := range sortedDesiredIDs(desired) {
		cell := r.cells[agentID]
		if cell == nil {
			cell = newAgentCell(agentCellConfig{
				agentID:      agentID,
				factory:      r.factory,
				retryDelay:   r.retryDelay,
				startTimeout: r.startTimeout,
			})
			r.cells[agentID] = cell
		}
		cell.SetDesired(desired[agentID])
	}
	r.computerID = snapshot.ComputerID
	r.epoch = snapshot.Epoch
	r.revision = snapshot.Revision
	r.snapshotHash = snapshot.SnapshotHash
	r.mu.Unlock()

	// Desired mutations only update immutable memory and a coalesced wake-up.
	// All file/network/IM work remains inside each Cell Supervisor.
	for _, retirement := range retiring {
		go r.retireCell(retirement.agentID, retirement.cell)
	}
	return ApplyResult{Accepted: true}, nil
}

func (r *Registry) validateGenerations(snapshot Snapshot) error {
	for _, next := range snapshot.Agents {
		cell := r.cells[next.AgentID]
		if cell == nil {
			continue
		}
		current, ok := cell.Desired()
		if !ok {
			continue
		}
		switch {
		case next.ConfigGeneration < current.assignment.ConfigGeneration:
			return ErrGenerationRegressed
		case next.ConfigGeneration == current.assignment.ConfigGeneration &&
			!assignmentsEqual(current.assignment, next):
			return ErrGenerationCollision
		}
	}
	return nil
}

func (r *Registry) Status() []AgentStatus {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	ids := make([]string, 0, len(r.cells))
	cells := make(map[string]*agentCell, len(r.cells))
	for agentID, cell := range r.cells {
		if _, desired := cell.Desired(); !desired {
			continue
		}
		ids = append(ids, agentID)
		cells[agentID] = cell
	}
	r.mu.Unlock()
	sort.Strings(ids)
	status := make([]AgentStatus, 0, len(ids))
	for _, agentID := range ids {
		status = append(status, cells[agentID].Snapshot())
	}
	return status
}

func (r *Registry) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if ctx == nil {
		return ErrInvalidRegistryConfig
	}
	r.mu.Lock()
	cells := make([]*agentCell, 0, len(r.cells))
	for _, cell := range r.cells {
		cells = append(cells, cell)
	}
	r.cells = make(map[string]*agentCell)
	r.mu.Unlock()

	sem := make(chan struct{}, 2)
	errorsOut := make(chan error, len(cells))
	var wait sync.WaitGroup
	for _, cell := range cells {
		wait.Add(1)
		go func(current *agentCell) {
			defer wait.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				errorsOut <- ctx.Err()
				return
			}
			if err := current.Close(ctx); err != nil {
				errorsOut <- err
			}
		}(cell)
	}
	wait.Wait()
	close(errorsOut)
	for err := range errorsOut {
		return err
	}
	return nil
}

type cellRetirement struct {
	agentID string
	cell    *agentCell
}

func (r *Registry) retireCell(agentID string, cell *agentCell) {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		phase := cell.Snapshot().Phase
		if phase == AgentPhaseAbsent || phase == AgentPhaseStopped {
			break
		}
		select {
		case <-cell.done:
			break
		case <-ticker.C:
			continue
		}
		break
	}
	r.mu.Lock()
	current := r.cells[agentID]
	_, desired := cell.Desired()
	if current != cell || desired {
		r.mu.Unlock()
		return
	}
	delete(r.cells, agentID)
	r.mu.Unlock()
	closeCell(cell)
}

func sortedDesiredIDs(values map[string]desiredAgent) []string {
	ids := make([]string, 0, len(values))
	for agentID := range values {
		ids = append(ids, agentID)
	}
	sort.Strings(ids)
	return ids
}

func assignmentsEqual(left, right AgentAssignment) bool {
	if left.AgentID != right.AgentID ||
		left.ServerID != right.ServerID ||
		left.DesiredState != right.DesiredState ||
		left.ConfigGeneration != right.ConfigGeneration ||
		left.CredentialVersion != right.CredentialVersion ||
		left.Runtime.Kind != right.Runtime.Kind ||
		left.ReplyPolicy != right.ReplyPolicy {
		return false
	}
	if left.Runtime.Model == nil || right.Runtime.Model == nil {
		return left.Runtime.Model == nil && right.Runtime.Model == nil
	}
	return *left.Runtime.Model == *right.Runtime.Model
}

func newLaunchID() (string, error) {
	value, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	return value.String(), nil
}

func rejectedApply(err error) ApplyResult {
	return ApplyResult{Accepted: false, ErrorCode: assignmentErrorCode(err)}
}

func assignmentErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrCapacityExceeded):
		return "assignment_capacity_exceeded"
	case errors.Is(err, ErrRevisionRegressed):
		return "assignment_revision_regressed"
	case errors.Is(err, ErrRevisionCollision):
		return "assignment_revision_collision"
	case errors.Is(err, ErrGenerationRegressed):
		return "assignment_generation_regressed"
	case errors.Is(err, ErrGenerationCollision):
		return "assignment_generation_collision"
	default:
		return "assignment_invalid"
	}
}

func agentRetryDelay(failures int) time.Duration {
	if failures < 1 {
		failures = 1
	}
	delay := time.Second << min(failures-1, 4)
	if delay > 30*time.Second {
		return 30 * time.Second
	}
	return delay
}

func closeCell(cell *agentCell) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = cell.Close(ctx)
}
