package runtimehost

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"velachat/agent/internal/common"
	"velachat/agent/internal/runtimeactor"
	"velachat/agent/internal/runtimeapi"
	"velachat/agent/internal/vela/platform"
)

func (a *Adapter) ReconcileTasks(ctx context.Context) error {
	if a == nil || ctx == nil || a.config.TaskClient == nil {
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
	values, err := a.config.TaskClient.ListRuntimeTasks(ctx, session.AccessToken)
	if err != nil {
		return err
	}
	var sweepError error
	active := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value.Status == platform.TaskDone || value.Status == platform.TaskClosed {
			continue
		}
		if value.ServerID != session.Agent.ServerID ||
			value.OwnerMemberID != session.Agent.ID {
			sweepError = errors.Join(sweepError, ErrSessionChanged)
			continue
		}
		active[value.ID] = struct{}{}
		if revision, delivered := a.config.TaskDeliveries.DeliveredRevision(value.ID); delivered && revision >= value.AssignmentRevision {
			continue
		}
		if err := a.dispatchTask(ctx, value); err != nil {
			sweepError = errors.Join(sweepError, err)
		}
	}
	if err := a.config.TaskDeliveries.PruneActive(active); err != nil {
		sweepError = errors.Join(sweepError, err)
	}
	return sweepError
}

func (a *Adapter) dispatchTask(
	ctx context.Context,
	value platform.Task,
) error {
	a.runtimeMu.Lock()
	defer a.runtimeMu.Unlock()
	a.mu.Lock()
	if a.session == nil || a.session.Agent.ID != value.OwnerMemberID ||
		a.session.Agent.ServerID != value.ServerID {
		a.mu.Unlock()
		return ErrSessionChanged
	}
	session := *a.session
	started := a.started
	a.mu.Unlock()
	resolved, ok := a.config.Runtimes.ResolveInternalRuntime(session.Agent.RuntimeKind)
	if !ok || resolved.LaunchPlanner == nil {
		return runtimeactor.ErrUnknownRuntime
	}
	wakeMessage, err := encodeTaskWakeMessage(value)
	if err != nil {
		return err
	}
	plan, err := resolved.LaunchPlanner.PlanLaunch(runtimeapi.LaunchInput{
		AgentID: a.config.AgentID, Runtime: resolved.ID, WakeMessage: wakeMessage,
		WakeMessageTransient: true,
	})
	if err != nil {
		return err
	}
	if !started {
		err = a.config.Actor.Start(ctx, runtimeactor.StartCommand{
			AgentID: a.config.AgentID, LaunchID: a.runtimeEpoch,
			OperationID: fmt.Sprintf("%s:%d", value.ID, value.AssignmentRevision), Runtime: resolved.ID,
			WorkingDirectory: a.config.WorkingDirectory,
			Prompt:           plan.Prompt, StandingPrompt: plan.StandingPrompt,
			Model: session.Agent.RuntimeModel, Environment: a.runtimeEnvironment(),
			RebindDelivery: plan.RebindDelivery, PostStartDelivery: plan.PostStartDelivery,
		})
	} else {
		delivery := runtimeapi.Delivery{Text: taskDeliveryText(value)}
		if plan.RebindDelivery != nil {
			delivery = *plan.RebindDelivery
		}
		err = a.config.Actor.Deliver(ctx, a.runtimeEpoch, delivery)
	}
	if err != nil {
		return err
	}
	a.mu.Lock()
	a.started = true
	a.mu.Unlock()
	return a.config.TaskDeliveries.RecordDelivered(value.ID, value.AssignmentRevision)
}

func encodeTaskWakeMessage(value platform.Task) ([]byte, error) {
	return common.Marshal(map[string]any{
		"channel_type": "task", "id": value.ID,
		"idempotency_key": fmt.Sprintf("%s:%d", value.ID, value.AssignmentRevision),
		"message_id":      fmt.Sprintf("%s:%d", value.ID, value.AssignmentRevision),
		"sender_name":     "platform", "source": "task",
		"target": "server:" + value.ServerID,
		"text":   taskDeliveryText(value),
	})
}

func taskDeliveryText(value platform.Task) string {
	description := ""
	if value.Description != nil && strings.TrimSpace(*value.Description) != "" {
		description = "\n\n" + strings.TrimSpace(*value.Description)
	}
	return fmt.Sprintf(
		"You were assigned Task #%d: %s%s\n\nFirst claim it with `vela task claim --target %q --number %d`. Work on it, then report progress with `vela task update --target %q --number %d --status in_review` or completion with status done.",
		value.Number, strings.TrimSpace(value.Title), description,
		"server:"+value.ServerID, value.Number,
		"server:"+value.ServerID, value.Number,
	)
}
