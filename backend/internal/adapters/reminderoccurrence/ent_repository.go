// Package reminderoccurrence 提供 Reminder occurrence 的 Ent 持久化实现。
package reminderoccurrence

import (
	"context"
	"errors"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/agent"
	"chatserver/internal/ent/outboxevent"
	"chatserver/internal/ent/reminder"
	"chatserver/internal/ent/reminderoccurrence"
	idport "chatserver/internal/ports/id"
	occurrenceport "chatserver/internal/ports/reminderoccurrence"
	"chatserver/internal/schedule"
)

type EntRepository struct {
	handle *database.Handle
	ids    idport.Generator
}

func NewEntRepository(
	handle *database.Handle,
	ids idport.Generator,
) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil || ids == nil {
		return nil, errors.New("Reminder occurrence Repository 配置无效")
	}
	return &EntRepository{handle: handle, ids: ids}, nil
}

// ProcessOne 在单个事务中把一个到期 Reminder 物化为 occurrence，并推进调度。
func (repository *EntRepository) ProcessOne(
	ctx context.Context,
	now time.Time,
) (processed bool, returnErr error) {
	now = now.UTC()
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		current, err := tx.Reminder.Query().
			Where(
				reminder.StatusEQ("active"),
				reminder.NextFireAtNotNil(),
				reminder.NextFireAtLTE(now),
			).
			Order(ent.Asc(reminder.FieldNextFireAt), ent.Asc(reminder.FieldID)).
			First(ctx)
		if ent.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		scheduledFireAt := *current.NextFireAt
		update := tx.Reminder.Update().
			Where(
				reminder.IDEQ(current.ID),
				reminder.RevisionEQ(current.Revision),
				reminder.StatusEQ("active"),
				reminder.NextFireAtEQ(scheduledFireAt),
			).
			SetRevision(current.Revision + 1).
			SetUpdatedAt(now)
		switch current.ScheduleKind {
		case "once":
			update.SetStatus("completed").ClearNextFireAt()
		case "cron":
			next, err := schedule.NextReminderFire(
				"cron",
				current.Schedule,
				current.Timezone,
				now,
			)
			if err != nil {
				return err
			}
			update.SetNextFireAt(next)
		default:
			return errors.New("Reminder 调度类型无效")
		}
		affected, err := update.Save(ctx)
		if err != nil {
			return err
		}
		if affected == 0 {
			return nil
		}
		id, err := repository.ids.New()
		if err != nil {
			return err
		}
		if _, err := tx.ReminderOccurrence.Create().
			SetID(id).
			SetServerID(current.ServerID).
			SetReminderID(current.ID).
			SetAgentID(current.AgentID).
			SetScheduledFireAt(scheduledFireAt).
			SetState("due").
			SetTextSnapshot(current.Text).
			SetCreatedAt(now).
			SetUpdatedAt(now).
			Save(ctx); err != nil {
			return err
		}
		eventID, err := repository.ids.New()
		if err != nil {
			return err
		}
		if _, err := tx.OutboxEvent.Create().
			SetID(eventID).
			SetPartitionKey(current.ServerID).
			SetServerID(current.ServerID).
			SetEventType("reminder.agent-notification.requested").
			SetAggregateType("reminder_occurrence").
			SetAggregateID(id).
			SetState("pending").
			SetAttempts(0).
			SetAvailableAt(now).
			SetCreatedAt(now).
			Save(ctx); err != nil {
			return err
		}
		processed = true
		return nil
	})
	return processed, returnErr
}

func (repository *EntRepository) ClaimNotification(
	ctx context.Context,
	claim occurrenceport.NotificationClaim,
) (work occurrenceport.NotificationWork, claimed bool, returnErr error) {
	if claim.LeaseOwner == "" || claim.Now.IsZero() ||
		!claim.LeaseExpiresAt.After(claim.Now) {
		return work, false, errors.New("Reminder notification claim 无效")
	}
	now := claim.Now.UTC()
	leaseExpiresAt := claim.LeaseExpiresAt.UTC()
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		due := outboxevent.Or(
			outboxevent.And(
				outboxevent.StateEQ("pending"),
				outboxevent.AvailableAtLTE(now),
			),
			outboxevent.And(
				outboxevent.StateEQ("processing"),
				outboxevent.LeaseExpiresAtNotNil(),
				outboxevent.LeaseExpiresAtLTE(now),
			),
		)
		event, err := tx.OutboxEvent.Query().
			Where(
				outboxevent.EventTypeEQ("reminder.agent-notification.requested"),
				outboxevent.AggregateTypeEQ("reminder_occurrence"),
				due,
			).
			Order(ent.Asc(outboxevent.FieldAvailableAt), ent.Asc(outboxevent.FieldID)).
			First(ctx)
		if ent.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		affected, err := tx.OutboxEvent.Update().
			Where(
				outboxevent.IDEQ(event.ID),
				outboxevent.EventTypeEQ("reminder.agent-notification.requested"),
				due,
			).
			SetState("processing").
			SetAttempts(event.Attempts + 1).
			SetLeaseOwner(claim.LeaseOwner).
			SetLeaseExpiresAt(leaseExpiresAt).
			Save(ctx)
		if err != nil {
			return err
		}
		if affected == 0 {
			return nil
		}
		occurrence, err := tx.ReminderOccurrence.Query().
			Where(
				reminderoccurrence.IDEQ(event.AggregateID),
				reminderoccurrence.ServerIDEQ(event.PartitionKey),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			_, updateErr := tx.OutboxEvent.UpdateOneID(event.ID).
				SetState("dead").
				SetLastErrorCode("reminder_occurrence_missing").
				ClearLeaseOwner().
				ClearLeaseExpiresAt().
				Save(ctx)
			return updateErr
		}
		if err != nil {
			return err
		}
		if occurrence.State != "due" {
			_, err = tx.OutboxEvent.UpdateOneID(event.ID).
				SetState("processed").
				SetProcessedAt(now).
				ClearLeaseOwner().
				ClearLeaseExpiresAt().
				Save(ctx)
			return err
		}
		recipient, err := tx.Agent.Query().
			Where(
				agent.IDEQ(occurrence.AgentID),
				agent.ServerIDEQ(occurrence.ServerID),
				agent.DeletedAtIsNil(),
			).
			Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return err
		}
		work = occurrenceport.NotificationWork{
			EventID: event.ID, LeaseOwner: claim.LeaseOwner,
			ServerID: occurrence.ServerID,
			AgentID:  occurrence.AgentID, ResourceID: occurrence.ID,
			Revision: 1, Attempts: event.Attempts + 1,
		}
		if recipient != nil && recipient.ImState == "ready" {
			work.RecipientUserID = recipient.ImUserID
		}
		claimed = true
		return nil
	})
	return work, claimed, returnErr
}

func (repository *EntRepository) CompleteNotification(
	ctx context.Context,
	eventID string,
	leaseOwner string,
	now time.Time,
) error {
	affected, err := repository.handle.Client().OutboxEvent.Update().
		Where(
			outboxevent.IDEQ(eventID),
			outboxevent.EventTypeEQ("reminder.agent-notification.requested"),
			outboxevent.StateEQ("processing"),
			outboxevent.LeaseOwnerEQ(leaseOwner),
		).
		SetState("processed").
		SetProcessedAt(now.UTC()).
		ClearLeaseOwner().
		ClearLeaseExpiresAt().
		ClearLastErrorCode().
		Save(ctx)
	if err != nil {
		return err
	}
	if affected == 0 {
		return occurrenceport.ErrNotificationLeaseLost
	}
	return nil
}

func (repository *EntRepository) NotificationCurrent(
	ctx context.Context,
	work occurrenceport.NotificationWork,
	now time.Time,
) (bool, error) {
	if now.IsZero() {
		return false, errors.New("Reminder notification current check 无效")
	}
	eventCurrent, err := repository.handle.Client().OutboxEvent.Query().Where(
		outboxevent.IDEQ(work.EventID),
		outboxevent.PartitionKeyEQ(work.ServerID),
		outboxevent.AggregateIDEQ(work.ResourceID),
		outboxevent.EventTypeEQ("reminder.agent-notification.requested"),
		outboxevent.StateEQ("processing"),
		outboxevent.LeaseOwnerEQ(work.LeaseOwner),
		outboxevent.LeaseExpiresAtNotNil(),
		outboxevent.LeaseExpiresAtGT(now.UTC()),
	).Exist(ctx)
	if err != nil || !eventCurrent {
		return false, err
	}
	occurrenceCurrent, err := repository.handle.Client().ReminderOccurrence.Query().Where(
		reminderoccurrence.IDEQ(work.ResourceID),
		reminderoccurrence.ServerIDEQ(work.ServerID),
		reminderoccurrence.AgentIDEQ(work.AgentID),
		reminderoccurrence.StateEQ("due"),
	).Exist(ctx)
	if err != nil || !occurrenceCurrent {
		return false, err
	}
	return repository.handle.Client().Agent.Query().Where(
		agent.IDEQ(work.AgentID),
		agent.ServerIDEQ(work.ServerID),
		agent.DeletedAtIsNil(),
		agent.ImStateEQ("ready"),
		agent.ImUserIDEQ(work.RecipientUserID),
	).Exist(ctx)
}

func (repository *EntRepository) RetryNotification(
	ctx context.Context,
	eventID string,
	leaseOwner string,
	availableAt time.Time,
	errorCode string,
	dead bool,
) error {
	update := repository.handle.Client().OutboxEvent.Update().
		Where(
			outboxevent.IDEQ(eventID),
			outboxevent.EventTypeEQ("reminder.agent-notification.requested"),
			outboxevent.StateEQ("processing"),
			outboxevent.LeaseOwnerEQ(leaseOwner),
		).
		SetAvailableAt(availableAt.UTC()).
		SetLastErrorCode(errorCode).
		ClearLeaseOwner().
		ClearLeaseExpiresAt()
	if dead {
		update.SetState("dead")
	} else {
		update.SetState("pending")
	}
	affected, err := update.Save(ctx)
	if err != nil {
		return err
	}
	if affected == 0 {
		return occurrenceport.ErrNotificationLeaseLost
	}
	return nil
}

func (repository *EntRepository) ListDue(
	ctx context.Context,
	serverID string,
	agentID string,
	options occurrenceport.ListOptions,
) (occurrenceport.Page, error) {
	query := repository.handle.Client().ReminderOccurrence.Query().
		Where(
			reminderoccurrence.ServerIDEQ(serverID),
			reminderoccurrence.AgentIDEQ(agentID),
			reminderoccurrence.StateEQ("due"),
		)
	if options.AfterScheduledFireAt != nil && options.AfterID != "" {
		query = query.Where(reminderoccurrence.Or(
			reminderoccurrence.ScheduledFireAtGT(*options.AfterScheduledFireAt),
			reminderoccurrence.And(
				reminderoccurrence.ScheduledFireAtEQ(*options.AfterScheduledFireAt),
				reminderoccurrence.IDGT(options.AfterID),
			),
		))
	}
	entities, err := query.
		Order(ent.Asc(reminderoccurrence.FieldScheduledFireAt), ent.Asc(reminderoccurrence.FieldID)).
		Limit(options.Limit + 1).
		All(ctx)
	if err != nil {
		return occurrenceport.Page{}, err
	}
	page := occurrenceport.Page{Items: make([]occurrenceport.Occurrence, 0, min(options.Limit, len(entities)))}
	if len(entities) > options.Limit {
		last := entities[options.Limit-1]
		scheduledAt := last.ScheduledFireAt.UTC()
		page.NextScheduledFireAt, page.NextID = &scheduledAt, last.ID
		entities = entities[:options.Limit]
	}
	for _, entity := range entities {
		page.Items = append(page.Items, mapOccurrence(entity))
	}
	return page, nil
}

func (repository *EntRepository) Acknowledge(
	ctx context.Context,
	serverID string,
	agentID string,
	occurrenceID string,
	resultCode *string,
	now time.Time,
) (result occurrenceport.Occurrence, returnErr error) {
	now = now.UTC()
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		entity, err := tx.ReminderOccurrence.Query().
			Where(
				reminderoccurrence.IDEQ(occurrenceID),
				reminderoccurrence.ServerIDEQ(serverID),
				reminderoccurrence.AgentIDEQ(agentID),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			return occurrenceport.ErrNotFound
		}
		if err != nil {
			return err
		}
		if entity.State != "due" {
			result = mapOccurrence(entity)
			return nil
		}
		update := tx.ReminderOccurrence.Update().
			Where(
				reminderoccurrence.IDEQ(occurrenceID),
				reminderoccurrence.ServerIDEQ(serverID),
				reminderoccurrence.AgentIDEQ(agentID),
				reminderoccurrence.StateEQ("due"),
			).
			SetState("acknowledged").
			SetAcknowledgedAt(now).
			SetUpdatedAt(now)
		if resultCode == nil {
			update.ClearResultCode()
		} else {
			update.SetResultCode(*resultCode)
		}
		affected, err := update.Save(ctx)
		if err != nil {
			return err
		}
		if affected == 0 {
			entity, err = tx.ReminderOccurrence.Query().
				Where(
					reminderoccurrence.IDEQ(occurrenceID),
					reminderoccurrence.ServerIDEQ(serverID),
					reminderoccurrence.AgentIDEQ(agentID),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return occurrenceport.ErrNotFound
			}
			if err != nil {
				return err
			}
			result = mapOccurrence(entity)
			return nil
		}
		entity, err = tx.ReminderOccurrence.Get(ctx, occurrenceID)
		if err != nil {
			return err
		}
		result = mapOccurrence(entity)
		return nil
	})
	return result, returnErr
}

func mapOccurrence(entity *ent.ReminderOccurrence) occurrenceport.Occurrence {
	return occurrenceport.Occurrence{
		ID: entity.ID, ServerID: entity.ServerID,
		ReminderID: entity.ReminderID, AgentID: entity.AgentID,
		ScheduledFireAt: entity.ScheduledFireAt, State: entity.State,
		AcknowledgedAt: entity.AcknowledgedAt, ResultCode: entity.ResultCode,
		Text: entity.TextSnapshot, CreatedAt: entity.CreatedAt, UpdatedAt: entity.UpdatedAt,
	}
}

var _ occurrenceport.Repository = (*EntRepository)(nil)
