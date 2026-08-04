package runtimehost

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeactor"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/runtimeapi"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/platform"
	velastate "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/state"
)

const ReminderWakeCustomType = "platform.reminder.v1"
const TaskWakeCustomType = "platform.task.v1"

func isPlatformWakeHint(message im.IncomingMessage) bool {
	if len(message.Elements) == 0 {
		return false
	}
	for _, element := range message.Elements {
		if element.Type != im.ElementCustom ||
			(element.CustomType != ReminderWakeCustomType &&
				element.CustomType != TaskWakeCustomType) {
			return false
		}
	}
	return true
}

func (a *Adapter) runReminders() {
	defer close(a.reminderStopped)
	if a.config.ReminderClient == nil && a.config.TaskClient == nil {
		<-a.reminderContext.Done()
		return
	}
	ticker := time.NewTicker(a.config.ReminderInterval)
	defer ticker.Stop()
	for {
		select {
		case <-a.reminderContext.Done():
			return
		case <-a.reminderWake:
			a.reconcileScheduledInputs(a.reminderContext)
		case <-ticker.C:
			a.reconcileScheduledInputs(a.reminderContext)
		}
	}
}

func (a *Adapter) wakeReminders() {
	if a == nil || a.config.ReminderClient == nil && a.config.TaskClient == nil {
		return
	}
	select {
	case a.reminderWake <- struct{}{}:
	default:
	}
}

func (a *Adapter) reconcileScheduledInputs(ctx context.Context) {
	if a.config.ReminderClient != nil {
		_ = a.ReconcileReminders(ctx)
	}
	if a.config.TaskClient != nil {
		_ = a.ReconcileTasks(ctx)
	}
}

// ReconcileReminders is exported for deterministic host tests and diagnostics.
// The mutex is per Agent Adapter, so Runtime execution and ACK never overlap
// with another occurrence sweep for the same Agent.
func (a *Adapter) ReconcileReminders(ctx context.Context) error {
	if a == nil || ctx == nil || a.config.ReminderClient == nil {
		return ErrInvalidConfig
	}
	a.reminderMu.Lock()
	defer a.reminderMu.Unlock()

	a.mu.Lock()
	if a.session == nil {
		a.mu.Unlock()
		return ErrSessionMissing
	}
	session := *a.session
	a.mu.Unlock()

	var sweepError error
	for _, reference := range a.config.Occurrences.Snapshot() {
		if reference.AgentID != a.config.AgentID ||
			reference.State != velastate.OccurrenceCompletedPendingAck {
			continue
		}
		if err := a.ackOccurrence(ctx, session, reference); err != nil {
			sweepError = errors.Join(sweepError, err)
		}
	}

	occurrences, err := a.config.ReminderClient.ListAllReminderOccurrences(
		ctx,
		session.AccessToken,
	)
	if err != nil {
		return errors.Join(sweepError, err)
	}
	for _, occurrence := range occurrences {
		if occurrence.AgentID != session.Agent.ID ||
			occurrence.ServerID != session.Agent.ServerID {
			sweepError = errors.Join(sweepError, ErrSessionChanged)
			continue
		}
		reference, _, observeErr := a.config.Occurrences.Observe(
			velastate.OccurrenceInput{
				AgentID:      occurrence.AgentID,
				OccurrenceID: occurrence.ID,
				ReminderID:   occurrence.ReminderID,
				ScheduledAt:  occurrence.ScheduledFireAt,
			},
		)
		if observeErr != nil {
			sweepError = errors.Join(sweepError, observeErr)
			continue
		}
		switch reference.State {
		case velastate.OccurrenceExecuting:
			continue
		case velastate.OccurrenceCompletedPendingAck:
			if err := a.ackOccurrence(ctx, session, reference); err != nil {
				sweepError = errors.Join(sweepError, err)
			}
			continue
		case velastate.OccurrenceDue,
			velastate.OccurrenceNeedsAttention:
			if !reference.NextAttemptAt.IsZero() &&
				reference.NextAttemptAt.After(a.config.Now().UTC()) {
				continue
			}
			if err := a.dispatchOccurrence(ctx, occurrence, reference); err != nil {
				sweepError = errors.Join(sweepError, err)
			}
		}
	}
	return sweepError
}

func (a *Adapter) ackOccurrence(
	ctx context.Context,
	session platform.RuntimeSession,
	reference velastate.OccurrenceRecord,
) error {
	acknowledged, err := a.config.ReminderClient.AcknowledgeReminderOccurrence(
		ctx,
		session.AccessToken,
		reference.OccurrenceID,
	)
	if err != nil {
		return err
	}
	if acknowledged.ID != reference.OccurrenceID ||
		acknowledged.State != platform.ReminderOccurrenceAcknowledged ||
		acknowledged.ResultCode != "completed" {
		return platform.ErrInvalidReminderOccurrence
	}
	_, err = a.config.Occurrences.Acknowledge(reference.OccurrenceID)
	return err
}

func (a *Adapter) dispatchOccurrence(
	ctx context.Context,
	occurrence platform.ReminderOccurrence,
	reference velastate.OccurrenceRecord,
) error {
	a.runtimeMu.Lock()
	defer a.runtimeMu.Unlock()
	a.mu.Lock()
	if a.session == nil ||
		a.session.Agent.ID != occurrence.AgentID ||
		a.session.Agent.ServerID != occurrence.ServerID {
		a.mu.Unlock()
		return ErrSessionChanged
	}
	session := *a.session
	started := a.started
	a.mu.Unlock()
	resolved, ok := a.config.Runtimes.ResolveInternalRuntime(
		session.Agent.RuntimeKind,
	)
	if !ok || resolved.LaunchPlanner == nil {
		return a.recordOccurrenceFailure(reference, runtimeactor.ErrUnknownRuntime)
	}
	wakeMessage, err := encodeReminderWakeMessage(occurrence)
	if err != nil {
		return a.recordOccurrenceFailure(reference, err)
	}
	plan, err := resolved.LaunchPlanner.PlanLaunch(runtimeapi.LaunchInput{
		AgentID:              a.config.AgentID,
		Runtime:              resolved.ID,
		WakeMessage:          wakeMessage,
		WakeMessageTransient: true,
	})
	if err != nil {
		return a.recordOccurrenceFailure(reference, err)
	}
	reference, err = a.config.Occurrences.Start(
		reference.OccurrenceID,
		a.runtimeEpoch,
		a.config.Now().UTC(),
	)
	if err != nil {
		return err
	}
	if !started {
		err = a.config.Actor.Start(ctx, runtimeactor.StartCommand{
			AgentID:           a.config.AgentID,
			LaunchID:          a.runtimeEpoch,
			OperationID:       reference.OccurrenceID,
			Runtime:           resolved.ID,
			WorkingDirectory:  a.config.WorkingDirectory,
			Prompt:            plan.Prompt,
			StandingPrompt:    plan.StandingPrompt,
			Model:             session.Agent.RuntimeModel,
			Environment:       a.runtimeEnvironment(),
			RebindDelivery:    plan.RebindDelivery,
			PostStartDelivery: plan.PostStartDelivery,
		})
	} else {
		err = a.config.Actor.Deliver(ctx, a.runtimeEpoch, runtimeapi.Delivery{
			Text: reminderDeliveryText(occurrence),
		})
	}
	if err != nil {
		return a.recordOccurrenceFailure(reference, err)
	}
	a.mu.Lock()
	a.started = true
	a.mu.Unlock()
	_, err = a.config.Occurrences.Complete(
		reference.OccurrenceID,
		a.runtimeEpoch,
	)
	if err == nil {
		a.wakeReminders()
	}
	return err
}

func (a *Adapter) recordOccurrenceFailure(
	reference velastate.OccurrenceRecord,
	cause error,
) error {
	if reference.State != velastate.OccurrenceExecuting {
		started, err := a.config.Occurrences.Start(
			reference.OccurrenceID,
			a.runtimeEpoch,
			a.config.Now().UTC(),
		)
		if err != nil {
			return errors.Join(cause, err)
		}
		reference = started
	}
	_, err := a.failOccurrence(reference)
	return errors.Join(cause, err)
}

func (a *Adapter) failOccurrence(
	reference velastate.OccurrenceRecord,
) (velastate.OccurrenceRecord, error) {
	attempt := reference.FailureCount + 1
	delay := occurrenceBackoff(attempt)
	return a.config.Occurrences.Fail(
		reference.OccurrenceID,
		a.runtimeEpoch,
		a.config.Now().UTC().Add(delay),
		attempt >= 5,
	)
}

func occurrenceBackoff(attempt int) time.Duration {
	switch attempt {
	case 1:
		return time.Second
	case 2:
		return 5 * time.Second
	case 3:
		return 30 * time.Second
	case 4:
		return 2 * time.Minute
	default:
		return 10 * time.Minute
	}
}

func encodeReminderWakeMessage(
	occurrence platform.ReminderOccurrence,
) ([]byte, error) {
	return common.Marshal(map[string]any{
		"channel_type":      "reminder",
		"id":                occurrence.ID,
		"idempotency_key":   occurrence.ID,
		"message_id":        occurrence.ID,
		"occurrence_id":     occurrence.ID,
		"reminder_id":       occurrence.ReminderID,
		"scheduled_fire_at": occurrence.ScheduledFireAt.UTC().Format(time.RFC3339),
		"sender_name":       "platform",
		"source":            "reminder",
		"target":            "reminder:" + occurrence.ID,
		"text":              occurrence.Text,
	})
}

func reminderDeliveryText(occurrence platform.ReminderOccurrence) string {
	return fmt.Sprintf(
		"[Reminder occurrence %s; idempotency key %s; scheduled %s]\n%s",
		occurrence.ID,
		occurrence.ID,
		occurrence.ScheduledFireAt.UTC().Format(time.RFC3339),
		strings.TrimSpace(occurrence.Text),
	)
}
