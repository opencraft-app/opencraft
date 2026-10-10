package daemon

import (
	"context"
	"errors"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
	"velachat/agent/internal/common"
	"velachat/agent/internal/filelock"
	rootstate "velachat/agent/internal/state"
	"velachat/agent/internal/vela/managementipc"
)

const (
	daemonLockPath   = "daemon.lock"
	daemonPIDPath    = "daemon.pid"
	daemonStatePath  = "daemon.state.json"
	assignmentCursor = "assignment.cursor.json"
)

var (
	ErrInvalidRunnerConfig  = errors.New("Vela daemon 配置无效")
	ErrDaemonAlreadyRunning = errors.New("daemon_already_running")
)

type PollRequest struct {
	SinceEpoch    string
	SinceRevision int64
	WaitSeconds   int
	ForceFull     bool
}

type PollResult struct {
	Snapshot *Snapshot
	NoChange bool
}

type AssignmentSource interface {
	Poll(context.Context, PollRequest) (PollResult, error)
}

type Component interface {
	Start(context.Context) (ComponentHandle, error)
}

type ComponentHandle interface {
	Close(context.Context) error
}

type HeartbeatAgent struct {
	AgentID           string
	AssignmentEpoch   string
	ConfigGeneration  int64
	CredentialVersion int64
	Attempt           int64
	LaunchID          string
}

type Heartbeat struct {
	HeartbeatID        string
	DaemonVersion      string
	DaemonBuildID      string
	AssignmentEpoch    string
	AssignmentRevision int64
	TATState           string
	ReconcileState     string
	ErrorCode          *string
	Agents             []HeartbeatAgent
}

type HeartbeatSink interface {
	Send(context.Context, Heartbeat) error
}

// CapabilitySink executes a Profile capability refresh carried by an accepted
// Assignment. Implementations own refresh-id idempotency and terminal result
// submission so the Assignment polling loop never blocks on Runtime discovery.
type CapabilitySink interface {
	Refresh(context.Context, AgentAssignment)
}

type RunnerConfig struct {
	StateRoot         string
	Version           string
	BuildID           string
	ComputerID        string
	Source            AssignmentSource
	Registry          *Registry
	Component         Component
	HeartbeatSink     HeartbeatSink
	CapabilitySink    CapabilitySink
	HeartbeatInterval time.Duration
	HeartbeatJitter   func(time.Duration) time.Duration
	Now               func() time.Time
	RetryDelay        func(int) time.Duration
}

type AssignmentStatus struct {
	Epoch        string `json:"epoch,omitempty"`
	Revision     int64  `json:"revision"`
	SnapshotHash string `json:"snapshotHash,omitempty"`
}

type Status struct {
	SchemaVersion  int              `json:"schemaVersion"`
	Online         bool             `json:"online"`
	PID            int              `json:"pid"`
	Version        string           `json:"version"`
	ComputerID     string           `json:"computerId"`
	StartedAt      time.Time        `json:"startedAt"`
	Assignment     AssignmentStatus `json:"assignment"`
	Agents         []AgentStatus    `json:"agents"`
	ReconcileState string           `json:"reconcileState"`
	ErrorCode      string           `json:"errorCode,omitempty"`
}

type assignmentCursorState struct {
	SchemaVersion           int       `json:"schemaVersion"`
	AssignmentSchemaVersion int       `json:"assignmentSchemaVersion,omitempty"`
	Epoch                   string    `json:"epoch"`
	Revision                int64     `json:"revision"`
	SnapshotHash            string    `json:"snapshotHash"`
	AppliedAt               time.Time `json:"appliedAt"`
}

type Runner struct {
	config        RunnerConfig
	mu            sync.RWMutex
	status        Status
	heartbeatWake chan struct{}
}

func NewRunner(config RunnerConfig) (*Runner, error) {
	if !filepath.IsAbs(config.StateRoot) ||
		config.Version == "" ||
		!isUUIDv7(config.ComputerID) ||
		config.Source == nil ||
		config.Registry == nil {
		return nil, ErrInvalidRunnerConfig
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.BuildID == "" {
		config.BuildID = config.Version
	}
	if config.RetryDelay == nil {
		config.RetryDelay = assignmentRetryDelay
	}
	if config.HeartbeatSink != nil && config.HeartbeatInterval <= 0 {
		config.HeartbeatInterval = 60 * time.Second
	}
	if config.HeartbeatSink != nil && config.HeartbeatJitter == nil {
		config.HeartbeatJitter = defaultHeartbeatJitter
	}
	return &Runner{
		config:        config,
		heartbeatWake: make(chan struct{}, 1),
	}, nil
}

func (r *Runner) Run(ctx context.Context) error {
	if r == nil || ctx == nil {
		return ErrInvalidRunnerConfig
	}
	lock, err := filelock.AcquireExclusive(
		filepath.Join(r.config.StateRoot, daemonLockPath),
	)
	if errors.Is(err, filelock.ErrLocked) {
		return ErrDaemonAlreadyRunning
	}
	if err != nil {
		return err
	}
	defer lock.Release()

	var component ComponentHandle
	if r.config.Component != nil {
		component, err = r.config.Component.Start(ctx)
		if err != nil {
			return err
		}
		defer func() {
			closeContext, cancel := context.WithTimeout(
				context.Background(),
				10*time.Second,
			)
			defer cancel()
			_ = component.Close(closeContext)
		}()
	}

	store := rootstate.New(r.config.StateRoot)
	startedAt := r.config.Now().UTC()
	r.setStatus(Status{
		SchemaVersion:  1,
		Online:         true,
		PID:            os.Getpid(),
		Version:        r.config.Version,
		ComputerID:     r.config.ComputerID,
		StartedAt:      startedAt,
		Agents:         []AgentStatus{},
		ReconcileState: "healthy",
	})
	if err := store.Write(daemonPIDPath, map[string]any{
		"pid":       os.Getpid(),
		"startedAt": startedAt,
	}); err != nil {
		return err
	}
	defer store.Remove(daemonPIDPath)
	if err := store.Write(daemonStatePath, r.Status()); err != nil {
		return err
	}
	defer store.Remove(daemonStatePath)

	server, err := managementipc.Listen(
		filepath.Join(r.config.StateRoot, "daemon.sock"),
		managementipc.HandlerFunc(r.handleManagement),
	)
	if err != nil {
		return err
	}
	defer server.Close()
	var heartbeatWait sync.WaitGroup
	if r.config.HeartbeatSink != nil {
		heartbeatContext, cancelHeartbeats := context.WithCancel(ctx)
		heartbeatWait.Add(1)
		go func() {
			defer heartbeatWait.Done()
			r.runHeartbeats(heartbeatContext)
		}()
		defer heartbeatWait.Wait()
		defer cancelHeartbeats()
	}
	defer func() {
		closeContext, cancel := context.WithTimeout(
			context.Background(),
			10*time.Second,
		)
		defer cancel()
		_ = r.config.Registry.Close(closeContext)
	}()

	cursor, err := loadAssignmentCursor(store, r.config.Now())
	if err != nil {
		return err
	}
	if cursor.Revision > 0 {
		status := r.Status()
		status.Assignment = AssignmentStatus{
			Epoch:        cursor.Epoch,
			Revision:     cursor.Revision,
			SnapshotHash: cursor.SnapshotHash,
		}
		r.setStatus(status)
		r.signalHeartbeat()
	}
	failures := 0
	firstPoll := true
	for {
		request := PollRequest{
			SinceEpoch:    cursor.Epoch,
			SinceRevision: cursor.Revision,
			WaitSeconds:   25,
			ForceFull:     firstPoll || cursor.Revision == 0,
		}
		result, err := r.config.Source.Poll(ctx, request)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			failures++
			if err := waitForRetry(
				ctx,
				r.config.RetryDelay(failures),
			); err != nil {
				return nil
			}
			continue
		}
		failures = 0
		if result.Snapshot == nil {
			continue
		}
		if err := validateSnapshotAgainstCursor(cursor, *result.Snapshot); err != nil {
			status := r.Status()
			status.ReconcileState = "degraded"
			status.ErrorCode = assignmentErrorCode(err)
			r.setStatus(status)
			if err := store.Write(daemonStatePath, status); err != nil {
				return err
			}
			continue
		}
		apply, err := r.config.Registry.Apply(ctx, *result.Snapshot)
		if err != nil {
			return err
		}
		if !apply.Accepted {
			status := r.Status()
			status.ReconcileState = "degraded"
			status.ErrorCode = apply.ErrorCode
			r.setStatus(status)
			if err := store.Write(daemonStatePath, status); err != nil {
				return err
			}
			continue
		}
		cursor = assignmentCursorState{
			SchemaVersion:           2,
			AssignmentSchemaVersion: result.Snapshot.SchemaVersion,
			Epoch:                   result.Snapshot.Epoch,
			Revision:                result.Snapshot.Revision,
			SnapshotHash:            result.Snapshot.SnapshotHash,
			AppliedAt:               r.config.Now().UTC(),
		}
		if err := store.Write(assignmentCursor, cursor); err != nil {
			return err
		}
		firstPoll = false
		status := r.Status()
		status.Assignment = AssignmentStatus{
			Epoch:        cursor.Epoch,
			Revision:     cursor.Revision,
			SnapshotHash: cursor.SnapshotHash,
		}
		status.ErrorCode = ""
		status.Agents = r.config.Registry.Status()
		status.ReconcileState, status.ErrorCode = projectReconcile(
			status.Agents,
			status.ErrorCode,
		)
		r.setStatus(status)
		if err := store.Write(daemonStatePath, status); err != nil {
			return err
		}
		if r.config.CapabilitySink != nil {
			for _, assignment := range result.Snapshot.Agents {
				if assignment.ProfileCapabilityRefresh == nil {
					continue
				}
				go r.config.CapabilitySink.Refresh(ctx, assignment)
			}
		}
		r.signalHeartbeat()
	}
}

func validateSnapshotAgainstCursor(
	cursor assignmentCursorState,
	snapshot Snapshot,
) error {
	if cursor.Revision == 0 || snapshot.Epoch != cursor.Epoch {
		return nil
	}
	switch {
	case snapshot.Revision < cursor.Revision:
		return ErrRevisionRegressed
	case snapshot.Revision == cursor.Revision &&
		snapshot.SnapshotHash != cursor.SnapshotHash &&
		cursor.AssignmentSchemaVersion == snapshot.SchemaVersion:
		return ErrRevisionCollision
	default:
		return nil
	}
}

func (r *Runner) runHeartbeats(ctx context.Context) {
	timer := time.NewTimer(r.nextHeartbeatInterval())
	defer timer.Stop()
	var lastSuccessfullySent heartbeatFence
	for {
		force := false
		select {
		case <-ctx.Done():
			return
		case <-r.heartbeatWake:
		case <-timer.C:
			force = true
		}
		sent, fence := r.sendLatestHeartbeat(
			ctx,
			force,
			lastSuccessfullySent,
		)
		if ctx.Err() != nil {
			return
		}
		if sent {
			lastSuccessfullySent = fence
			resetHeartbeatTimer(timer, r.nextHeartbeatInterval())
		} else if force {
			resetHeartbeatTimer(timer, r.nextHeartbeatInterval())
		}
	}
}

func (r *Runner) nextHeartbeatInterval() time.Duration {
	interval := r.config.HeartbeatInterval
	if r.config.HeartbeatJitter == nil {
		return interval
	}
	jittered := r.config.HeartbeatJitter(interval)
	if jittered <= 0 {
		return interval
	}
	return jittered
}

func defaultHeartbeatJitter(interval time.Duration) time.Duration {
	return jitterHeartbeatInterval(interval, rand.Float64())
}

func jitterHeartbeatInterval(
	interval time.Duration,
	sample float64,
) time.Duration {
	if interval <= 0 {
		return interval
	}
	if sample < 0 {
		sample = 0
	} else if sample > 1 {
		sample = 1
	}
	spread := interval / 10
	return interval - spread + time.Duration(float64(2*spread)*sample)
}

type heartbeatFence struct {
	epoch    string
	revision int64
}

func (r *Runner) sendLatestHeartbeat(
	ctx context.Context,
	force bool,
	lastSuccessfullySent heartbeatFence,
) (bool, heartbeatFence) {
	status := r.Status()
	fence := heartbeatFence{
		epoch: status.Assignment.Epoch, revision: status.Assignment.Revision,
	}
	if fence.revision < 1 || !force && fence == lastSuccessfullySent {
		return false, heartbeatFence{}
	}
	heartbeat, err := r.newHeartbeat(status)
	if err != nil {
		return false, heartbeatFence{}
	}
	failures := 0
	for {
		err = r.config.HeartbeatSink.Send(ctx, heartbeat)
		if err == nil {
			return true, fence
		}
		if ctx.Err() != nil {
			return false, heartbeatFence{}
		}
		failures++
		if waitForRetry(ctx, r.config.RetryDelay(failures)) != nil {
			return false, heartbeatFence{}
		}
		status = r.Status()
		currentFence := heartbeatFence{
			epoch:    status.Assignment.Epoch,
			revision: status.Assignment.Revision,
		}
		if currentFence.revision < 1 {
			continue
		}
		if currentFence != fence {
			fence = currentFence
			heartbeat, err = r.newHeartbeat(status)
			if err != nil {
				return false, heartbeatFence{}
			}
			failures = 0
		}
	}
}

func (r *Runner) signalHeartbeat() {
	if r == nil || r.heartbeatWake == nil {
		return
	}
	select {
	case r.heartbeatWake <- struct{}{}:
	default:
	}
}

func resetHeartbeatTimer(timer *time.Timer, interval time.Duration) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(interval)
}

func (r *Runner) newHeartbeat(status Status) (Heartbeat, error) {
	heartbeatID, err := uuid.NewV7()
	if err != nil {
		return Heartbeat{}, err
	}
	agents := make([]HeartbeatAgent, 0, len(status.Agents))
	for _, agent := range status.Agents {
		if agent.State != AgentStateRunning {
			continue
		}
		agents = append(agents, HeartbeatAgent{
			AgentID:           agent.AgentID,
			AssignmentEpoch:   agent.AssignmentEpoch,
			ConfigGeneration:  agent.ConfigGeneration,
			CredentialVersion: agent.CredentialVersion,
			Attempt:           agent.Attempt,
			LaunchID:          agent.LaunchID,
		})
	}
	reconcileState := "healthy"
	reconcileError := status.ErrorCode
	if status.ReconcileState != "healthy" {
		reconcileState = "error"
		if reconcileError == "" {
			reconcileError = "agent_reconciling"
		}
	}
	var errorCode *string
	if reconcileError != "" {
		value := reconcileError
		errorCode = &value
	}
	return Heartbeat{
		HeartbeatID:        heartbeatID.String(),
		DaemonVersion:      status.Version,
		DaemonBuildID:      r.config.BuildID,
		AssignmentEpoch:    status.Assignment.Epoch,
		AssignmentRevision: status.Assignment.Revision,
		TATState:           "online",
		ReconcileState:     reconcileState,
		ErrorCode:          errorCode,
		Agents:             agents,
	}, nil
}

func (r *Runner) Status() Status {
	r.mu.RLock()
	status := r.status
	r.mu.RUnlock()
	status.Agents = r.config.Registry.Status()
	status.ReconcileState, status.ErrorCode = projectReconcile(
		status.Agents,
		status.ErrorCode,
	)
	return status
}

func (r *Runner) setStatus(status Status) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.status = status
}

func projectReconcile(
	agents []AgentStatus,
	controlError string,
) (string, string) {
	if controlError != "" {
		return "degraded", controlError
	}
	reconciling := false
	for _, agent := range agents {
		if agent.Phase != "" || agent.Health != "" {
			switch agent.Health {
			case AgentHealthReconnecting,
				AgentHealthDegraded,
				AgentHealthBlocked:
				if agent.ErrorCode != "" {
					return "degraded", agent.ErrorCode
				}
				return "degraded", "agent_unhealthy"
			}
			switch agent.Phase {
			case AgentPhaseStarting,
				AgentPhaseStopping,
				AgentPhaseAbsent:
				reconciling = true
			}
			continue
		}
		switch agent.State {
		case AgentStateRetryWait, AgentStateBlocked:
			if agent.ErrorCode != "" {
				return "degraded", agent.ErrorCode
			}
			return "degraded", "agent_unhealthy"
		case AgentStateStarting,
			AgentStateStopping,
			AgentStateAbsent:
			reconciling = true
		}
	}
	if reconciling {
		return "reconciling", ""
	}
	return "healthy", ""
}

func (r *Runner) handleManagement(
	_ context.Context,
	request managementipc.Request,
	sender managementipc.Sender,
) error {
	switch request.Method {
	case "status.get":
		return sender.Result(r.Status())
	case "doctor.run":
		status := r.Status()
		return sender.Result(map[string]any{
			"ok":         status.Online,
			"daemon":     "online",
			"assignment": status.Assignment,
			"agentCount": len(status.Agents),
			"reconcile":  status.ReconcileState,
			"errorCode":  status.ErrorCode,
		})
	case "logs.tail":
		return sender.End()
	default:
		return sender.Error(managementipc.ErrorDetail{
			Code:    "unknown_method",
			Message: "未知的 daemon 管理方法",
		})
	}
}

func loadAssignmentCursor(
	store *rootstate.Store,
	now time.Time,
) (assignmentCursorState, error) {
	path := filepath.Join(store.Root(), assignmentCursor)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return assignmentCursorState{}, nil
		}
		return assignmentCursorState{}, err
	}
	var cursor assignmentCursorState
	if common.Unmarshal(data, &cursor) != nil ||
		(cursor.SchemaVersion != 1 && cursor.SchemaVersion != 2) ||
		(cursor.SchemaVersion == 2 &&
			(cursor.AssignmentSchemaVersion < AssignmentSchemaVersionV1 ||
				cursor.AssignmentSchemaVersion > AssignmentSchemaVersion)) ||
		!isUUIDv7(cursor.Epoch) ||
		cursor.Revision < 1 ||
		cursor.SnapshotHash == "" {
		if err := archiveCorruptCursor(path, now); err != nil {
			return assignmentCursorState{}, err
		}
		return assignmentCursorState{}, nil
	}
	return cursor, nil
}

func archiveCorruptCursor(path string, now time.Time) error {
	archive := filepath.Join(
		filepath.Dir(path),
		"assignment.cursor.corrupt-"+
			now.UTC().Format("20060102T150405.000000000Z")+
			".json",
	)
	if err := os.Rename(path, archive); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func assignmentRetryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := time.Second
	for index := 1; index < attempt && delay < 30*time.Second; index++ {
		delay *= 2
	}
	if delay > 30*time.Second {
		return 30 * time.Second
	}
	return delay
}

func waitForRetry(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			return nil
		}
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
