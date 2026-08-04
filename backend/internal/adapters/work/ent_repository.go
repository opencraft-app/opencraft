// Package work 使用 Ent 保存 Work 业务事实。
package work

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"sort"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/accountservermembership"
	"chatserver/internal/ent/agent"
	channelentity "chatserver/internal/ent/channel"
	"chatserver/internal/ent/channelmember"
	"chatserver/internal/ent/idempotencyrecord"
	"chatserver/internal/ent/member"
	"chatserver/internal/ent/messagethreadread"
	"chatserver/internal/ent/messagethreadref"
	"chatserver/internal/ent/reminder"
	"chatserver/internal/ent/reminderoccurrence"
	"chatserver/internal/ent/server"
	"chatserver/internal/ent/task"
	"chatserver/internal/persistedjson"
	workport "chatserver/internal/ports/work"
)

type EntRepository struct{ handle *database.Handle }

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Work Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) EnsureThread(
	ctx context.Context,
	mutation workport.Mutation,
	channelID string,
	draft workport.ThreadDraft,
) (result workport.MessageThread, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		membership, err := requireChannelAccess(
			ctx, tx, mutation.AccountID, mutation.ServerID, channelID,
		)
		if err != nil {
			return err
		}
		result, err = ensureThreadForMember(
			ctx, tx, mutation, channelID, draft, membership.MemberID,
		)
		return err
	})
	return result, returnErr
}

func ensureThreadForMember(
	ctx context.Context,
	tx *ent.Tx,
	mutation workport.Mutation,
	channelID string,
	draft workport.ThreadDraft,
	memberID string,
) (workport.MessageThread, error) {
	if resourceID, found, err := loadIdempotency(
		ctx, tx, mutation, "thread.ensure", channelID,
	); err != nil {
		return workport.MessageThread{}, err
	} else if found {
		root, err := loadThreadRoot(ctx, tx, mutation.ServerID, channelID, resourceID)
		if err != nil {
			return workport.MessageThread{}, err
		}
		return threadValue(ctx, tx, root, memberID)
	}
	root, err := tx.MessageThreadRef.Query().Where(
		messagethreadref.ServerIDEQ(mutation.ServerID),
		messagethreadref.ChannelIDEQ(channelID),
		messagethreadref.RoleEQ("root"),
		messagethreadref.MessageIDEQ(draft.RootMessageRef.MessageID),
	).Only(ctx)
	if err == nil {
		if !messageRefsEqual(draft.RootMessageRef, messageRefValue(root)) {
			return workport.MessageThread{}, workport.ErrRevisionConflict
		}
		if err := saveIdempotency(
			ctx, tx, mutation, "thread.ensure", channelID, root.ID,
		); err != nil {
			return workport.MessageThread{}, err
		}
		return threadValue(ctx, tx, root, memberID)
	}
	if !ent.IsNotFound(err) {
		return workport.MessageThread{}, err
	}
	root, err = tx.MessageThreadRef.Create().
		SetID(draft.ID).
		SetServerID(mutation.ServerID).
		SetChannelID(channelID).
		SetThreadID(draft.ID).
		SetRole("root").
		SetMessageKind(draft.RootMessageRef.Kind).
		SetMessageID(draft.RootMessageRef.MessageID).
		SetNillableGroupID(draft.RootMessageRef.GroupID).
		SetNillableTopicID(draft.RootMessageRef.TopicID).
		SetNillableSenderUserID(draft.RootMessageRef.SenderUserID).
		SetMessageSequence(*draft.RootMessageRef.Sequence).
		SetMessageTimestamp(*draft.RootMessageRef.Timestamp).
		SetCreatedByMemberID(memberID).
		SetReplyCount(0).
		SetCreatedAt(mutation.Now).
		SetUpdatedAt(mutation.Now).
		Save(ctx)
	if err != nil {
		return workport.MessageThread{}, err
	}
	if err := saveIdempotency(
		ctx, tx, mutation, "thread.ensure", channelID, root.ID,
	); err != nil {
		return workport.MessageThread{}, err
	}
	return threadValue(ctx, tx, root, memberID)
}

func (repository *EntRepository) GetThread(
	ctx context.Context,
	accountID, serverID, channelID, threadID string,
) (workport.MessageThread, error) {
	membership, err := requireChannelAccessClient(
		ctx,
		repository.handle.Client(),
		accountID,
		serverID,
		channelID,
	)
	if err != nil {
		return workport.MessageThread{}, err
	}
	root, err := repository.handle.Client().MessageThreadRef.Query().Where(
		messagethreadref.IDEQ(threadID),
		messagethreadref.ServerIDEQ(serverID),
		messagethreadref.ChannelIDEQ(channelID),
		messagethreadref.RoleEQ("root"),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return workport.MessageThread{}, workport.ErrNotFound
	}
	if err != nil {
		return workport.MessageThread{}, err
	}
	return threadValueClient(
		ctx, repository.handle.Client(), root, membership.MemberID,
	)
}

func (repository *EntRepository) ListThreadReplies(
	ctx context.Context,
	accountID, serverID, channelID, threadID string,
	options workport.ThreadReplyListOptions,
) (workport.ThreadReplyPage, error) {
	if _, err := requireChannelAccessClient(
		ctx,
		repository.handle.Client(),
		accountID,
		serverID,
		channelID,
	); err != nil {
		return workport.ThreadReplyPage{}, err
	}
	exists, err := repository.handle.Client().MessageThreadRef.Query().Where(
		messagethreadref.IDEQ(threadID),
		messagethreadref.ServerIDEQ(serverID),
		messagethreadref.ChannelIDEQ(channelID),
		messagethreadref.RoleEQ("root"),
	).Exist(ctx)
	if err != nil {
		return workport.ThreadReplyPage{}, err
	}
	if !exists {
		return workport.ThreadReplyPage{}, workport.ErrNotFound
	}
	query := repository.handle.Client().MessageThreadRef.Query().Where(
		messagethreadref.ServerIDEQ(serverID),
		messagethreadref.ChannelIDEQ(channelID),
		messagethreadref.ThreadIDEQ(threadID),
		messagethreadref.RoleEQ("reply"),
	)
	if options.AfterSequence != nil && options.AfterID != "" {
		query = query.Where(
			messagethreadref.Or(
				messagethreadref.MessageSequenceLT(*options.AfterSequence),
				messagethreadref.And(
					messagethreadref.MessageSequenceEQ(*options.AfterSequence),
					messagethreadref.IDLT(options.AfterID),
				),
			),
		)
	}
	entities, err := query.
		Order(
			ent.Desc(messagethreadref.FieldMessageSequence),
			ent.Desc(messagethreadref.FieldID),
		).
		Limit(options.Limit + 1).
		All(ctx)
	if err != nil {
		return workport.ThreadReplyPage{}, err
	}
	hasMore := len(entities) > options.Limit
	if hasMore {
		entities = entities[:options.Limit]
	}
	var nextSequence *int64
	nextID := ""
	if hasMore && len(entities) > 0 {
		value := entities[len(entities)-1].MessageSequence
		nextSequence, nextID = &value, entities[len(entities)-1].ID
	}
	items := make([]workport.ThreadReplyReference, 0, len(entities))
	for index := len(entities) - 1; index >= 0; index-- {
		items = append(items, threadReplyValue(entities[index]))
	}
	return workport.ThreadReplyPage{
		Items: items, NextSequence: nextSequence, NextID: nextID,
	}, nil
}

func (repository *EntRepository) RegisterThreadReply(
	ctx context.Context,
	mutation workport.Mutation,
	channelID, threadID string,
	draft workport.ThreadReplyDraft,
) (result workport.ThreadReplyReference, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		membership, err := requireChannelAccess(
			ctx, tx, mutation.AccountID, mutation.ServerID, channelID,
		)
		if err != nil {
			return err
		}
		result, err = registerThreadReplyForMember(
			ctx, tx, mutation, channelID, threadID, draft, membership.MemberID,
		)
		return err
	})
	return result, returnErr
}

func registerThreadReplyForMember(
	ctx context.Context,
	tx *ent.Tx,
	mutation workport.Mutation,
	channelID string,
	threadID string,
	draft workport.ThreadReplyDraft,
	memberID string,
) (workport.ThreadReplyReference, error) {
	scope := "thread.reply.register"
	if resourceID, found, err := loadIdempotency(
		ctx, tx, mutation, scope, threadID,
	); err != nil {
		return workport.ThreadReplyReference{}, err
	} else if found {
		entity, err := tx.MessageThreadRef.Query().Where(
			messagethreadref.IDEQ(resourceID),
			messagethreadref.ServerIDEQ(mutation.ServerID),
			messagethreadref.ThreadIDEQ(threadID),
			messagethreadref.RoleEQ("reply"),
		).Only(ctx)
		if err != nil {
			return workport.ThreadReplyReference{}, err
		}
		return threadReplyValue(entity), nil
	}
	root, err := loadThreadRoot(ctx, tx, mutation.ServerID, channelID, threadID)
	if err != nil {
		return workport.ThreadReplyReference{}, err
	}
	entity, err := tx.MessageThreadRef.Query().Where(
		messagethreadref.ServerIDEQ(mutation.ServerID),
		messagethreadref.ChannelIDEQ(channelID),
		messagethreadref.MessageIDEQ(draft.MessageRef.MessageID),
	).Only(ctx)
	if err == nil {
		if entity.Role != "reply" || entity.ThreadID != threadID ||
			!messageRefsEqual(draft.MessageRef, messageRefValue(entity)) {
			return workport.ThreadReplyReference{}, workport.ErrRevisionConflict
		}
		if err := saveIdempotency(
			ctx, tx, mutation, scope, threadID, entity.ID,
		); err != nil {
			return workport.ThreadReplyReference{}, err
		}
		return threadReplyValue(entity), nil
	}
	if !ent.IsNotFound(err) {
		return workport.ThreadReplyReference{}, err
	}
	entity, err = tx.MessageThreadRef.Create().
		SetID(draft.ID).
		SetServerID(mutation.ServerID).
		SetChannelID(channelID).
		SetThreadID(threadID).
		SetRole("reply").
		SetMessageKind(draft.MessageRef.Kind).
		SetMessageID(draft.MessageRef.MessageID).
		SetNillableGroupID(draft.MessageRef.GroupID).
		SetNillableTopicID(draft.MessageRef.TopicID).
		SetNillableSenderUserID(draft.MessageRef.SenderUserID).
		SetMessageSequence(*draft.MessageRef.Sequence).
		SetMessageTimestamp(*draft.MessageRef.Timestamp).
		SetCreatedByMemberID(memberID).
		SetReplyCount(0).
		SetCreatedAt(mutation.Now).
		SetUpdatedAt(mutation.Now).
		Save(ctx)
	if err != nil {
		return workport.ThreadReplyReference{}, err
	}
	if _, err := root.Update().
		AddReplyCount(1).
		SetLastReplyAt(mutation.Now).
		SetUpdatedAt(mutation.Now).
		Save(ctx); err != nil {
		return workport.ThreadReplyReference{}, err
	}
	if err := saveIdempotency(
		ctx, tx, mutation, scope, threadID, entity.ID,
	); err != nil {
		return workport.ThreadReplyReference{}, err
	}
	return threadReplyValue(entity), nil
}

// EnsureRuntimeThread is the Agent-scoped variant. It uses the authenticated
// Agent member directly and verifies that the Tencent route belongs to the
// authorized Channel before any reference is persisted.
func (repository *EntRepository) EnsureRuntimeThread(
	ctx context.Context,
	agentID string,
	mutation workport.Mutation,
	channelID string,
	draft workport.ThreadDraft,
) (result workport.MessageThread, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		access, err := requireRuntimeChannelAccess(
			ctx, tx, mutation.ServerID, agentID, channelID,
		)
		if err != nil {
			return err
		}
		if !runtimeMessageRefMatchesChannel(draft.RootMessageRef, access.channel) {
			return workport.ErrForbidden
		}
		result, err = ensureThreadForMember(
			ctx, tx, mutation, channelID, draft, access.member.ID,
		)
		return err
	})
	return result, returnErr
}

func (repository *EntRepository) RegisterRuntimeThreadReply(
	ctx context.Context,
	agentID string,
	mutation workport.Mutation,
	channelID string,
	threadID string,
	draft workport.ThreadReplyDraft,
) (result workport.ThreadReplyReference, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		access, err := requireRuntimeChannelAccess(
			ctx, tx, mutation.ServerID, agentID, channelID,
		)
		if err != nil {
			return err
		}
		if !runtimeMessageRefMatchesChannel(draft.MessageRef, access.channel) ||
			draft.MessageRef.SenderUserID == nil ||
			*draft.MessageRef.SenderUserID != access.agent.ImUserID {
			return workport.ErrForbidden
		}
		result, err = registerThreadReplyForMember(
			ctx, tx, mutation, channelID, threadID, draft, access.member.ID,
		)
		return err
	})
	return result, returnErr
}

type runtimeChannelAccess struct {
	member  *ent.Member
	agent   *ent.Agent
	channel *ent.Channel
}

type runtimeAgentAccess struct {
	member *ent.Member
	agent  *ent.Agent
}

func requireRuntimeAgent(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	agentID string,
) (runtimeAgentAccess, error) {
	memberEntity, err := tx.Member.Query().Where(
		member.IDEQ(agentID), member.ServerIDEQ(serverID),
		member.KindEQ("agent"), member.StatusEQ("active"), member.ImStateEQ("ready"),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return runtimeAgentAccess{}, workport.ErrForbidden
	}
	if err != nil {
		return runtimeAgentAccess{}, err
	}
	agentEntity, err := tx.Agent.Query().Where(
		agent.IDEQ(agentID), agent.ServerIDEQ(serverID), agent.ImStateEQ("ready"),
		agent.DeletedAtIsNil(),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return runtimeAgentAccess{}, workport.ErrForbidden
	}
	if err != nil {
		return runtimeAgentAccess{}, err
	}
	return runtimeAgentAccess{member: memberEntity, agent: agentEntity}, nil
}

func requireRuntimeAgentClient(
	ctx context.Context,
	client *ent.Client,
	serverID string,
	agentID string,
) error {
	memberReady, err := client.Member.Query().Where(
		member.IDEQ(agentID), member.ServerIDEQ(serverID),
		member.KindEQ("agent"), member.StatusEQ("active"), member.ImStateEQ("ready"),
	).Exist(ctx)
	if err != nil {
		return err
	}
	agentReady, err := client.Agent.Query().Where(
		agent.IDEQ(agentID), agent.ServerIDEQ(serverID), agent.ImStateEQ("ready"),
		agent.DeletedAtIsNil(),
	).Exist(ctx)
	if err != nil {
		return err
	}
	if !memberReady || !agentReady {
		return workport.ErrForbidden
	}
	return nil
}

func requireRuntimeChannelAccess(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	agentID string,
	channelID string,
) (runtimeChannelAccess, error) {
	identity, err := requireRuntimeAgent(ctx, tx, serverID, agentID)
	if err != nil {
		return runtimeChannelAccess{}, err
	}
	channelEntity, err := tx.Channel.Query().Where(
		channelentity.IDEQ(channelID), channelentity.ServerIDEQ(serverID),
		channelentity.ImStateEQ("ready"),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return runtimeChannelAccess{}, workport.ErrNotFound
	}
	if err != nil {
		return runtimeChannelAccess{}, err
	}
	root := channelEntity.SystemKey != nil && *channelEntity.SystemKey == "all"
	if !root {
		allowed, err := tx.ChannelMember.Query().Where(
			channelmember.ServerIDEQ(serverID),
			channelmember.ChannelIDEQ(channelID),
			channelmember.MemberIDEQ(agentID),
			channelmember.StateEQ("active"),
			channelmember.ImStateEQ("ready"),
		).Exist(ctx)
		if err != nil {
			return runtimeChannelAccess{}, err
		}
		if !allowed {
			return runtimeChannelAccess{}, workport.ErrForbidden
		}
	}
	return runtimeChannelAccess{
		member: identity.member, agent: identity.agent, channel: channelEntity,
	}, nil
}

func runtimeMessageRefMatchesChannel(
	reference workport.MessageRef,
	channel *ent.Channel,
) bool {
	if channel == nil || reference.Kind != "group" || reference.GroupID == nil ||
		*reference.GroupID != channel.ImGroupID {
		return false
	}
	if channel.ImTopicID == nil {
		return reference.TopicID == nil
	}
	return reference.TopicID != nil && *reference.TopicID == *channel.ImTopicID
}

func validateRuntimeReminderAnchor(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	agentID string,
	anchor *workport.ReminderAnchor,
) error {
	if anchor == nil {
		return nil
	}
	access, err := requireRuntimeChannelAccess(
		ctx, tx, serverID, agentID, anchor.ChannelID,
	)
	if err != nil {
		return err
	}
	if !runtimeMessageRefMatchesChannel(anchor.MessageRef, access.channel) {
		return workport.ErrForbidden
	}
	switch anchor.Kind {
	case "message":
		if anchor.ThreadID != nil {
			return workport.ErrForbidden
		}
		return nil
	case "thread":
		if anchor.ThreadID == nil {
			return workport.ErrForbidden
		}
		root, err := loadThreadRoot(
			ctx, tx, serverID, anchor.ChannelID, *anchor.ThreadID,
		)
		if err != nil {
			return err
		}
		if !messageRefsEqual(anchor.MessageRef, messageRefValue(root)) {
			return workport.ErrForbidden
		}
		return nil
	default:
		return workport.ErrForbidden
	}
}

func messageRefsEqual(left workport.MessageRef, right workport.MessageRef) bool {
	return left.Kind == right.Kind && left.MessageID == right.MessageID &&
		optionalStringEqual(left.GroupID, right.GroupID) &&
		optionalStringEqual(left.TopicID, right.TopicID) &&
		optionalStringEqual(left.SenderUserID, right.SenderUserID) &&
		optionalInt64Equal(left.Sequence, right.Sequence) &&
		optionalInt64Equal(left.Timestamp, right.Timestamp)
}

func optionalStringEqual(left *string, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func optionalInt64Equal(left *int64, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func (repository *EntRepository) MarkThreadRead(
	ctx context.Context,
	mutation workport.Mutation,
	channelID, threadID, lastReadRefID string,
) (returnErr error) {
	return repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		membership, err := requireChannelAccess(
			ctx, tx, mutation.AccountID, mutation.ServerID, channelID,
		)
		if err != nil {
			return err
		}
		scope := "thread.read"
		if _, found, err := loadIdempotency(
			ctx, tx, mutation, scope, threadID,
		); err != nil || found {
			return err
		}
		if _, err := loadThreadRoot(
			ctx, tx, mutation.ServerID, channelID, threadID,
		); err != nil {
			return err
		}
		ref, err := tx.MessageThreadRef.Query().Where(
			messagethreadref.IDEQ(lastReadRefID),
			messagethreadref.ServerIDEQ(mutation.ServerID),
			messagethreadref.ChannelIDEQ(channelID),
			messagethreadref.ThreadIDEQ(threadID),
			messagethreadref.RoleEQ("reply"),
		).Only(ctx)
		if ent.IsNotFound(err) {
			return workport.ErrNotFound
		}
		if err != nil {
			return err
		}
		read, err := tx.MessageThreadRead.Query().Where(
			messagethreadread.ServerIDEQ(mutation.ServerID),
			messagethreadread.ThreadIDEQ(threadID),
			messagethreadread.MemberIDEQ(membership.MemberID),
		).Only(ctx)
		if ent.IsNotFound(err) {
			_, err = tx.MessageThreadRead.Create().
				SetServerID(mutation.ServerID).
				SetThreadID(threadID).
				SetMemberID(membership.MemberID).
				SetLastReadRefID(ref.ID).
				SetLastReadSequence(ref.MessageSequence).
				SetLastReadAt(mutation.Now).
				SetRevision(1).
				SetCreatedAt(mutation.Now).
				SetUpdatedAt(mutation.Now).
				Save(ctx)
		} else if err == nil && ref.MessageSequence > read.LastReadSequence {
			_, err = read.Update().
				SetLastReadRefID(ref.ID).
				SetLastReadSequence(ref.MessageSequence).
				SetLastReadAt(mutation.Now).
				SetRevision(read.Revision + 1).
				SetUpdatedAt(mutation.Now).
				Save(ctx)
		}
		if err != nil {
			return err
		}
		return saveIdempotency(
			ctx, tx, mutation, scope, threadID, lastReadRefID,
		)
	})
}

func (repository *EntRepository) ListTasks(
	ctx context.Context,
	accountID, serverID string,
	options workport.TaskListOptions,
) (workport.TaskPage, error) {
	if _, err := repository.membership(ctx, accountID, serverID); err != nil {
		return workport.TaskPage{}, err
	}
	query := repository.handle.Client().Task.Query().Where(task.ServerIDEQ(serverID))
	if options.OwnerMemberID != nil {
		query = query.Where(task.OwnerMemberIDEQ(*options.OwnerMemberID))
	}
	if options.UpdatedAfter != nil {
		query = query.Where(task.UpdatedAtGT(*options.UpdatedAfter))
	}
	if options.AfterUpdatedAt != nil && options.AfterID != "" {
		query = query.Where(task.Or(
			task.UpdatedAtLT(*options.AfterUpdatedAt),
			task.And(task.UpdatedAtEQ(*options.AfterUpdatedAt), task.IDLT(options.AfterID)),
		))
	}
	entities, err := query.
		Order(ent.Desc(task.FieldUpdatedAt), ent.Desc(task.FieldID)).
		Limit(options.Limit + 1).
		All(ctx)
	if err != nil {
		return workport.TaskPage{}, err
	}
	return taskPage(entities, options.Limit)
}

func (repository *EntRepository) GetTask(
	ctx context.Context,
	accountID, serverID, taskID string,
) (workport.Task, error) {
	if _, err := repository.membership(ctx, accountID, serverID); err != nil {
		return workport.Task{}, err
	}
	entity, err := repository.handle.Client().Task.Query().
		Where(task.IDEQ(taskID), task.ServerIDEQ(serverID)).
		Only(ctx)
	if ent.IsNotFound(err) {
		return workport.Task{}, workport.ErrNotFound
	}
	if err != nil {
		return workport.Task{}, err
	}
	return mapTask(entity)
}

// ListRuntimeTasks only projects Tasks assigned to the authenticated Agent.
func (repository *EntRepository) ListRuntimeTasks(
	ctx context.Context,
	serverID string,
	agentID string,
	options workport.TaskListOptions,
) (workport.TaskPage, error) {
	query := repository.handle.Client().Task.Query().Where(
		task.ServerIDEQ(serverID),
		task.OwnerMemberIDEQ(agentID),
	)
	if options.UpdatedAfter != nil {
		query = query.Where(task.UpdatedAtGT(*options.UpdatedAfter))
	}
	if options.AfterUpdatedAt != nil && options.AfterID != "" {
		query = query.Where(task.Or(
			task.UpdatedAtLT(*options.AfterUpdatedAt),
			task.And(task.UpdatedAtEQ(*options.AfterUpdatedAt), task.IDLT(options.AfterID)),
		))
	}
	entities, err := query.Order(ent.Desc(task.FieldUpdatedAt), ent.Desc(task.FieldID)).
		Limit(options.Limit + 1).All(ctx)
	if err != nil {
		return workport.TaskPage{}, err
	}
	return taskPage(entities, options.Limit)
}

func taskPage(entities []*ent.Task, limit int) (workport.TaskPage, error) {
	page := workport.TaskPage{Items: make([]workport.Task, 0, min(limit, len(entities)))}
	if len(entities) > limit {
		last := entities[limit-1]
		updatedAt := last.UpdatedAt.UTC()
		page.NextUpdatedAt, page.NextID = &updatedAt, last.ID
		entities = entities[:limit]
	}
	items, err := mapTasks(entities)
	page.Items = items
	return page, err
}

func (repository *EntRepository) GetRuntimeTask(
	ctx context.Context,
	serverID string,
	agentID string,
	taskID string,
) (workport.Task, error) {
	entity, err := repository.handle.Client().Task.Query().Where(
		task.IDEQ(taskID),
		task.ServerIDEQ(serverID),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return workport.Task{}, workport.ErrNotFound
	}
	if err != nil {
		return workport.Task{}, err
	}
	if entity.OwnerMemberID == nil || *entity.OwnerMemberID != agentID {
		return workport.Task{}, workport.ErrForbidden
	}
	return mapTask(entity)
}

func (repository *EntRepository) ClaimRuntimeTask(
	ctx context.Context,
	serverID string,
	agentID string,
	taskID string,
	now time.Time,
) (result workport.Task, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		entity, err := tx.Task.Query().Where(
			task.IDEQ(taskID),
			task.ServerIDEQ(serverID),
		).Only(ctx)
		if ent.IsNotFound(err) {
			return workport.ErrNotFound
		}
		if err != nil {
			return err
		}
		if entity.OwnerMemberID == nil || *entity.OwnerMemberID != agentID {
			return workport.ErrForbidden
		}
		switch entity.Status {
		case "in_progress", "in_review":
			result, err = mapTask(entity)
			return err
		case "done", "closed":
			return workport.ErrRevisionConflict
		case "todo":
		default:
			return workport.ErrRevisionConflict
		}
		updated, err := tx.Task.Update().Where(
			task.IDEQ(entity.ID),
			task.ServerIDEQ(serverID),
			task.OwnerMemberIDEQ(agentID),
			task.RevisionEQ(entity.Revision),
			task.StatusEQ("todo"),
		).SetStatus("in_progress").
			SetUpdatedByMemberID(agentID).
			SetRevision(entity.Revision + 1).
			SetUpdatedAt(now.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		if updated != 1 {
			return workport.ErrRevisionConflict
		}
		entity, err = tx.Task.Query().Where(task.IDEQ(entity.ID)).Only(ctx)
		if err != nil {
			return err
		}
		result, err = mapTask(entity)
		return err
	})
	return result, returnErr
}

func (repository *EntRepository) UpdateRuntimeTaskStatus(
	ctx context.Context,
	serverID string,
	agentID string,
	taskID string,
	revision int64,
	status string,
	now time.Time,
) (result workport.Task, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		entity, err := tx.Task.Query().Where(
			task.IDEQ(taskID),
			task.ServerIDEQ(serverID),
		).Only(ctx)
		if ent.IsNotFound(err) {
			return workport.ErrNotFound
		}
		if err != nil {
			return err
		}
		if entity.OwnerMemberID == nil || *entity.OwnerMemberID != agentID {
			return workport.ErrForbidden
		}
		// Retrying the same semantic write is a no-op even if the resource revision is stale.
		if entity.Status == status {
			result, err = mapTask(entity)
			return err
		}
		if entity.Revision != revision || !runtimeTaskTransition(entity.Status, status) {
			return workport.ErrRevisionConflict
		}
		updated, err := tx.Task.Update().Where(
			task.IDEQ(entity.ID),
			task.ServerIDEQ(serverID),
			task.OwnerMemberIDEQ(agentID),
			task.RevisionEQ(revision),
			task.StatusEQ(entity.Status),
		).SetStatus(status).
			SetUpdatedByMemberID(agentID).
			SetRevision(entity.Revision + 1).
			SetUpdatedAt(now.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		if updated != 1 {
			return workport.ErrRevisionConflict
		}
		entity, err = tx.Task.Query().Where(task.IDEQ(entity.ID)).Only(ctx)
		if err != nil {
			return err
		}
		result, err = mapTask(entity)
		return err
	})
	return result, returnErr
}

func runtimeTaskTransition(from string, to string) bool {
	switch from {
	case "todo":
		return to == "in_progress"
	case "in_progress":
		return to == "in_review" || to == "done"
	case "in_review":
		return to == "in_progress" || to == "done"
	default:
		return false
	}
}

func (repository *EntRepository) CreateTask(
	ctx context.Context,
	mutation workport.Mutation,
	draft workport.TaskDraft,
) (result workport.Task, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		membership, err := requireMembership(ctx, tx, mutation.AccountID, mutation.ServerID)
		if err != nil {
			return err
		}
		if resourceID, found, err := loadIdempotency(
			ctx, tx, mutation, "task.create", mutation.ServerID,
		); err != nil {
			return err
		} else if found {
			entity, err := tx.Task.Query().Where(
				task.IDEQ(resourceID), task.ServerIDEQ(mutation.ServerID),
			).Only(ctx)
			if err != nil {
				return err
			}
			result, err = mapTask(entity)
			return err
		}
		if err := validateOwner(ctx, tx, mutation.ServerID, draft.OwnerMemberID); err != nil {
			return err
		}
		serverEntity, err := tx.Server.Query().
			Where(server.IDEQ(mutation.ServerID)).Only(ctx)
		if ent.IsNotFound(err) {
			return workport.ErrForbidden
		}
		if err != nil {
			return err
		}
		number := serverEntity.NextTaskNumber
		if number < 1 {
			number = 1
		}
		if _, err := serverEntity.Update().
			SetNextTaskNumber(number + 1).
			SetUpdatedAt(mutation.Now).
			Save(ctx); err != nil {
			return err
		}
		sourceJSON, err := encodeMessageRef(draft.SourceMessageRef)
		if err != nil {
			return err
		}
		builder := tx.Task.Create().
			SetID(draft.ID).
			SetServerID(mutation.ServerID).
			SetNumber(number).
			SetTitle(draft.Title).
			SetNillableDescription(draft.Description).
			SetStatus("todo").
			SetNillableOwnerMemberID(draft.OwnerMemberID).
			SetAssignmentRevision(1).
			SetCreatedByMemberID(membership.MemberID).
			SetUpdatedByMemberID(membership.MemberID).
			SetNillableSourceMessageRefJSON(sourceJSON).
			SetRevision(1).
			SetCreatedAt(mutation.Now).
			SetUpdatedAt(mutation.Now)
		entity, err := builder.Save(ctx)
		if err != nil {
			return err
		}
		if draft.OwnerMemberID != nil {
			isAgent, err := tx.Agent.Query().Where(
				agent.IDEQ(*draft.OwnerMemberID),
				agent.ServerIDEQ(mutation.ServerID),
				agent.DeletedAtIsNil(),
			).Exist(ctx)
			if err != nil {
				return err
			}
			if isAgent {
				if err := createTaskNotificationOperation(
					ctx,
					tx,
					entity,
					draft.NotificationOperationID,
					mutation.Now,
				); err != nil {
					return err
				}
			}
		}
		if err := saveIdempotency(
			ctx, tx, mutation, "task.create", mutation.ServerID, entity.ID,
		); err != nil {
			return err
		}
		result, err = mapTask(entity)
		return err
	})
	return result, returnErr
}

func (repository *EntRepository) UpdateTask(
	ctx context.Context,
	mutation workport.Mutation,
	taskID string,
	revision int64,
	patch workport.TaskPatch,
) (result workport.Task, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		membership, err := requireMembership(ctx, tx, mutation.AccountID, mutation.ServerID)
		if err != nil {
			return err
		}
		scope := "task.update"
		if resourceID, found, err := loadIdempotency(ctx, tx, mutation, scope, taskID); err != nil {
			return err
		} else if found {
			entity, err := tx.Task.Query().Where(task.IDEQ(resourceID)).Only(ctx)
			if err != nil {
				return err
			}
			result, err = mapTask(entity)
			return err
		}
		entity, err := tx.Task.Query().Where(
			task.IDEQ(taskID), task.ServerIDEQ(mutation.ServerID),
		).Only(ctx)
		if ent.IsNotFound(err) {
			return workport.ErrNotFound
		}
		if err != nil {
			return err
		}
		if entity.Revision != revision {
			return workport.ErrRevisionConflict
		}
		if err := validateOwnerPatch(ctx, tx, mutation.ServerID, patch.OwnerMemberID); err != nil {
			return err
		}
		update := entity.Update().
			SetUpdatedByMemberID(membership.MemberID).
			SetRevision(entity.Revision + 1).
			SetUpdatedAt(mutation.Now)
		if patch.Title != nil {
			update.SetTitle(*patch.Title)
		}
		if patch.Description != nil {
			if *patch.Description == nil {
				update.ClearDescription()
			} else {
				update.SetDescription(**patch.Description)
			}
		}
		if patch.Status != nil {
			update.SetStatus(*patch.Status)
		}
		if patch.OwnerMemberID != nil {
			update.SetAssignmentRevision(entity.AssignmentRevision + 1)
			if *patch.OwnerMemberID == nil {
				update.ClearOwnerMemberID()
			} else {
				update.SetOwnerMemberID(**patch.OwnerMemberID)
			}
		}
		entity, err = update.Save(ctx)
		if err != nil {
			return err
		}
		if patch.OwnerMemberID != nil && *patch.OwnerMemberID != nil {
			isAgent, err := tx.Agent.Query().Where(
				agent.IDEQ(**patch.OwnerMemberID),
				agent.ServerIDEQ(mutation.ServerID),
				agent.DeletedAtIsNil(),
			).Exist(ctx)
			if err != nil {
				return err
			}
			if isAgent {
				if err := createTaskNotificationOperation(
					ctx,
					tx,
					entity,
					patch.NotificationOperationID,
					mutation.Now,
				); err != nil {
					return err
				}
			}
		}
		if err := saveIdempotency(ctx, tx, mutation, scope, taskID, entity.ID); err != nil {
			return err
		}
		result, err = mapTask(entity)
		return err
	})
	return result, returnErr
}

func createTaskNotificationOperation(
	ctx context.Context,
	tx *ent.Tx,
	entity *ent.Task,
	operationID *string,
	now time.Time,
) error {
	if operationID == nil {
		return errors.New("Agent Task 缺少通知 Operation ID")
	}
	_, err := tx.TencentOperation.Create().
		SetID(*operationID).
		SetPartitionKey(entity.ServerID).
		SetServerID(entity.ServerID).
		SetService("im").
		SetKind("im.agent.task.assigned").
		SetResourceType("task").
		SetResourceID(entity.ID).
		SetIdempotencyKey(fmt.Sprintf(
			"task.assigned:v1:%s:%d",
			entity.ID,
			entity.AssignmentRevision,
		)).
		SetDesiredRevision(entity.AssignmentRevision).
		SetState("pending").
		SetAttempts(0).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx)
	return err
}

func (repository *EntRepository) ListReminders(
	ctx context.Context,
	accountID, serverID string,
) ([]workport.Reminder, error) {
	if _, err := repository.membership(ctx, accountID, serverID); err != nil {
		return nil, err
	}
	entities, err := repository.handle.Client().Reminder.Query().
		Where(reminder.ServerIDEQ(serverID)).
		Order(ent.Desc(reminder.FieldUpdatedAt), ent.Desc(reminder.FieldID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	values := make([]workport.Reminder, 0, len(entities))
	for _, entity := range entities {
		value, err := mapReminder(entity)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, nil
}

func (repository *EntRepository) GetReminder(
	ctx context.Context,
	accountID, serverID, reminderID string,
) (workport.Reminder, error) {
	if _, err := repository.membership(ctx, accountID, serverID); err != nil {
		return workport.Reminder{}, err
	}
	entity, err := repository.handle.Client().Reminder.Query().
		Where(reminder.IDEQ(reminderID), reminder.ServerIDEQ(serverID)).
		Only(ctx)
	if ent.IsNotFound(err) {
		return workport.Reminder{}, workport.ErrNotFound
	}
	if err != nil {
		return workport.Reminder{}, err
	}
	return mapReminder(entity)
}

func (repository *EntRepository) CreateReminder(
	ctx context.Context,
	mutation workport.Mutation,
	draft workport.ReminderDraft,
) (result workport.Reminder, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		membership, err := requireMembership(ctx, tx, mutation.AccountID, mutation.ServerID)
		if err != nil {
			return err
		}
		if resourceID, found, err := loadIdempotency(
			ctx, tx, mutation, "reminder.create", mutation.ServerID,
		); err != nil {
			return err
		} else if found {
			entity, err := tx.Reminder.Query().Where(reminder.IDEQ(resourceID)).Only(ctx)
			if err != nil {
				return err
			}
			result, err = mapReminder(entity)
			return err
		}
		if err := validateAgent(ctx, tx, mutation.ServerID, draft.AgentID); err != nil {
			return err
		}
		anchorKind, anchorChannelID, anchorThreadID, anchorMessageRefJSON, err :=
			encodeReminderAnchor(draft.Anchor)
		if err != nil {
			return err
		}
		entity, err := tx.Reminder.Create().
			SetID(draft.ID).
			SetServerID(mutation.ServerID).
			SetAgentID(draft.AgentID).
			SetCreatedByMemberID(membership.MemberID).
			SetScheduleKind(draft.ScheduleKind).
			SetSchedule(draft.Schedule).
			SetTimezone(draft.Timezone).
			SetText(draft.Text).
			SetStatus("active").
			SetNillableNextFireAt(draft.NextFireAt).
			SetNillableAnchorKind(anchorKind).
			SetNillableAnchorChannelID(anchorChannelID).
			SetNillableAnchorThreadID(anchorThreadID).
			SetNillableAnchorMessageRefJSON(anchorMessageRefJSON).
			SetRevision(1).
			SetCreatedAt(mutation.Now).
			SetUpdatedAt(mutation.Now).
			Save(ctx)
		if err != nil {
			return err
		}
		if err := saveIdempotency(
			ctx, tx, mutation, "reminder.create", mutation.ServerID, entity.ID,
		); err != nil {
			return err
		}
		result, err = mapReminder(entity)
		return err
	})
	return result, returnErr
}

func (repository *EntRepository) UpdateReminder(
	ctx context.Context,
	mutation workport.Mutation,
	reminderID string,
	revision int64,
	patch workport.ReminderPatch,
) (result workport.Reminder, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		if _, err := requireMembership(ctx, tx, mutation.AccountID, mutation.ServerID); err != nil {
			return err
		}
		scope := "reminder.update"
		if resourceID, found, err := loadIdempotency(ctx, tx, mutation, scope, reminderID); err != nil {
			return err
		} else if found {
			entity, err := tx.Reminder.Query().Where(reminder.IDEQ(resourceID)).Only(ctx)
			if err != nil {
				return err
			}
			result, err = mapReminder(entity)
			return err
		}
		entity, err := tx.Reminder.Query().Where(
			reminder.IDEQ(reminderID), reminder.ServerIDEQ(mutation.ServerID),
		).Only(ctx)
		if ent.IsNotFound(err) {
			return workport.ErrNotFound
		}
		if err != nil {
			return err
		}
		if entity.Revision != revision {
			return workport.ErrRevisionConflict
		}
		update := entity.Update().SetRevision(entity.Revision + 1).SetUpdatedAt(mutation.Now)
		if patch.Schedule != nil {
			update.SetSchedule(*patch.Schedule)
		}
		if patch.Timezone != nil {
			update.SetTimezone(*patch.Timezone)
		}
		if patch.Text != nil {
			update.SetText(*patch.Text)
		}
		if patch.Status != nil {
			update.SetStatus(*patch.Status)
		}
		if patch.NextFireAt != nil {
			if *patch.NextFireAt == nil {
				update.ClearNextFireAt()
			} else {
				update.SetNextFireAt(**patch.NextFireAt)
			}
		}
		if patch.Anchor != nil {
			if *patch.Anchor == nil {
				update.ClearAnchorKind().ClearAnchorChannelID().
					ClearAnchorThreadID().ClearAnchorMessageRefJSON()
			} else {
				anchorKind, anchorChannelID, anchorThreadID, anchorMessageRefJSON, err :=
					encodeReminderAnchor(*patch.Anchor)
				if err != nil {
					return err
				}
				update.SetNillableAnchorKind(anchorKind).
					SetNillableAnchorChannelID(anchorChannelID).
					SetNillableAnchorMessageRefJSON(anchorMessageRefJSON)
				if anchorThreadID == nil {
					update.ClearAnchorThreadID()
				} else {
					update.SetAnchorThreadID(*anchorThreadID)
				}
			}
		}
		entity, err = update.Save(ctx)
		if err != nil {
			return err
		}
		if err := saveIdempotency(ctx, tx, mutation, scope, reminderID, entity.ID); err != nil {
			return err
		}
		result, err = mapReminder(entity)
		return err
	})
	return result, returnErr
}

// ListRuntimeReminders only projects reminders owned by the authenticated Agent.
func (repository *EntRepository) ListRuntimeReminders(
	ctx context.Context,
	serverID string,
	agentID string,
) ([]workport.Reminder, error) {
	if err := requireRuntimeAgentClient(
		ctx, repository.handle.Client(), serverID, agentID,
	); err != nil {
		return nil, err
	}
	entities, err := repository.handle.Client().Reminder.Query().Where(
		reminder.ServerIDEQ(serverID),
		reminder.AgentIDEQ(agentID),
	).Order(ent.Desc(reminder.FieldUpdatedAt), ent.Desc(reminder.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	values := make([]workport.Reminder, 0, len(entities))
	for _, entity := range entities {
		value, err := mapReminder(entity)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, nil
}

func (repository *EntRepository) GetRuntimeReminder(
	ctx context.Context,
	serverID string,
	agentID string,
	reminderID string,
) (workport.Reminder, error) {
	if err := requireRuntimeAgentClient(
		ctx, repository.handle.Client(), serverID, agentID,
	); err != nil {
		return workport.Reminder{}, err
	}
	entity, err := repository.handle.Client().Reminder.Query().Where(
		reminder.IDEQ(reminderID), reminder.ServerIDEQ(serverID),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return workport.Reminder{}, workport.ErrNotFound
	}
	if err != nil {
		return workport.Reminder{}, err
	}
	if entity.AgentID != agentID {
		return workport.Reminder{}, workport.ErrForbidden
	}
	return mapReminder(entity)
}

func (repository *EntRepository) CreateRuntimeReminder(
	ctx context.Context,
	agentID string,
	mutation workport.Mutation,
	draft workport.ReminderDraft,
) (result workport.Reminder, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		identity, err := requireRuntimeAgent(ctx, tx, mutation.ServerID, agentID)
		if err != nil {
			return err
		}
		if mutation.AccountID != agentID || draft.AgentID != agentID {
			return workport.ErrForbidden
		}
		if err := validateRuntimeReminderAnchor(
			ctx, tx, mutation.ServerID, agentID, draft.Anchor,
		); err != nil {
			return err
		}
		if resourceID, found, err := loadIdempotency(
			ctx, tx, mutation, "runtime.reminder.create", agentID,
		); err != nil {
			return err
		} else if found {
			entity, err := tx.Reminder.Query().Where(
				reminder.IDEQ(resourceID),
				reminder.ServerIDEQ(mutation.ServerID),
				reminder.AgentIDEQ(agentID),
			).Only(ctx)
			if ent.IsNotFound(err) {
				return workport.ErrForbidden
			}
			if err != nil {
				return err
			}
			result, err = mapReminder(entity)
			return err
		}
		anchorKind, anchorChannelID, anchorThreadID, anchorMessageRefJSON, err :=
			encodeReminderAnchor(draft.Anchor)
		if err != nil {
			return err
		}
		entity, err := tx.Reminder.Create().
			SetID(draft.ID).
			SetServerID(mutation.ServerID).
			SetAgentID(agentID).
			SetCreatedByMemberID(identity.member.ID).
			SetScheduleKind(draft.ScheduleKind).
			SetSchedule(draft.Schedule).
			SetTimezone(draft.Timezone).
			SetText(draft.Text).
			SetStatus("active").
			SetNillableNextFireAt(draft.NextFireAt).
			SetNillableAnchorKind(anchorKind).
			SetNillableAnchorChannelID(anchorChannelID).
			SetNillableAnchorThreadID(anchorThreadID).
			SetNillableAnchorMessageRefJSON(anchorMessageRefJSON).
			SetRevision(1).
			SetCreatedAt(mutation.Now).
			SetUpdatedAt(mutation.Now).
			Save(ctx)
		if err != nil {
			return err
		}
		if err := saveIdempotency(
			ctx, tx, mutation, "runtime.reminder.create", agentID, entity.ID,
		); err != nil {
			return err
		}
		result, err = mapReminder(entity)
		return err
	})
	return result, returnErr
}

func (repository *EntRepository) UpdateRuntimeReminder(
	ctx context.Context,
	agentID string,
	mutation workport.Mutation,
	reminderID string,
	revision int64,
	patch workport.ReminderPatch,
) (result workport.Reminder, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		if _, err := requireRuntimeAgent(ctx, tx, mutation.ServerID, agentID); err != nil {
			return err
		}
		if mutation.AccountID != agentID {
			return workport.ErrForbidden
		}
		if patch.Anchor != nil {
			if err := validateRuntimeReminderAnchor(
				ctx, tx, mutation.ServerID, agentID, *patch.Anchor,
			); err != nil {
				return err
			}
		}
		if resourceID, found, err := loadIdempotency(
			ctx, tx, mutation, "runtime.reminder.update", reminderID,
		); err != nil {
			return err
		} else if found {
			entity, err := tx.Reminder.Query().Where(
				reminder.IDEQ(resourceID),
				reminder.ServerIDEQ(mutation.ServerID),
				reminder.AgentIDEQ(agentID),
			).Only(ctx)
			if ent.IsNotFound(err) {
				return workport.ErrForbidden
			}
			if err != nil {
				return err
			}
			result, err = mapReminder(entity)
			return err
		}
		entity, err := tx.Reminder.Query().Where(
			reminder.IDEQ(reminderID), reminder.ServerIDEQ(mutation.ServerID),
		).Only(ctx)
		if ent.IsNotFound(err) {
			return workport.ErrNotFound
		}
		if err != nil {
			return err
		}
		if entity.AgentID != agentID {
			return workport.ErrForbidden
		}
		if entity.Revision != revision {
			return workport.ErrRevisionConflict
		}
		update := entity.Update().SetRevision(entity.Revision + 1).SetUpdatedAt(mutation.Now)
		if patch.Schedule != nil {
			update.SetSchedule(*patch.Schedule)
		}
		if patch.Timezone != nil {
			update.SetTimezone(*patch.Timezone)
		}
		if patch.Text != nil {
			update.SetText(*patch.Text)
		}
		if patch.Status != nil {
			update.SetStatus(*patch.Status)
		}
		if patch.NextFireAt != nil {
			if *patch.NextFireAt == nil {
				update.ClearNextFireAt()
			} else {
				update.SetNextFireAt(**patch.NextFireAt)
			}
		}
		if patch.Anchor != nil {
			if *patch.Anchor == nil {
				update.ClearAnchorKind().ClearAnchorChannelID().
					ClearAnchorThreadID().ClearAnchorMessageRefJSON()
			} else {
				anchorKind, anchorChannelID, anchorThreadID, anchorMessageRefJSON, err :=
					encodeReminderAnchor(*patch.Anchor)
				if err != nil {
					return err
				}
				update.SetNillableAnchorKind(anchorKind).
					SetNillableAnchorChannelID(anchorChannelID).
					SetNillableAnchorMessageRefJSON(anchorMessageRefJSON)
				if anchorThreadID == nil {
					update.ClearAnchorThreadID()
				} else {
					update.SetAnchorThreadID(*anchorThreadID)
				}
			}
		}
		entity, err = update.Save(ctx)
		if err != nil {
			return err
		}
		if err := saveIdempotency(
			ctx, tx, mutation, "runtime.reminder.update", reminderID, entity.ID,
		); err != nil {
			return err
		}
		result, err = mapReminder(entity)
		return err
	})
	return result, returnErr
}

func (repository *EntRepository) ListRuntimeReminderLog(
	ctx context.Context,
	serverID string,
	agentID string,
	reminderID string,
	options workport.ReminderLogListOptions,
) (workport.ReminderLogPage, error) {
	if _, err := repository.GetRuntimeReminder(ctx, serverID, agentID, reminderID); err != nil {
		return workport.ReminderLogPage{}, err
	}
	query := repository.handle.Client().ReminderOccurrence.Query().Where(
		reminderoccurrence.ServerIDEQ(serverID),
		reminderoccurrence.AgentIDEQ(agentID),
		reminderoccurrence.ReminderIDEQ(reminderID),
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
		Limit(options.Limit + 1).All(ctx)
	if err != nil {
		return workport.ReminderLogPage{}, err
	}
	page := workport.ReminderLogPage{Items: make([]workport.ReminderLogEntry, 0, min(options.Limit, len(entities)))}
	if len(entities) > options.Limit {
		last := entities[options.Limit-1]
		scheduledAt := last.ScheduledFireAt.UTC()
		page.NextScheduledFireAt, page.NextID = &scheduledAt, last.ID
		entities = entities[:options.Limit]
	}
	for _, entity := range entities {
		page.Items = append(page.Items, workport.ReminderLogEntry{
			ID: entity.ID, ServerID: entity.ServerID,
			ReminderID: entity.ReminderID, AgentID: entity.AgentID,
			ScheduledFireAt: entity.ScheduledFireAt, State: entity.State,
			AcknowledgedAt: entity.AcknowledgedAt, ResultCode: entity.ResultCode,
			Text: entity.TextSnapshot, CreatedAt: entity.CreatedAt,
			UpdatedAt: entity.UpdatedAt,
		})
	}
	return page, nil
}

func (repository *EntRepository) CancelReminder(
	ctx context.Context,
	mutation workport.Mutation,
	reminderID string,
	revision int64,
) (returnErr error) {
	return repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		if _, err := requireMembership(ctx, tx, mutation.AccountID, mutation.ServerID); err != nil {
			return err
		}
		scope := "reminder.cancel"
		if _, found, err := loadIdempotency(ctx, tx, mutation, scope, reminderID); err != nil || found {
			return err
		}
		entity, err := tx.Reminder.Query().Where(
			reminder.IDEQ(reminderID), reminder.ServerIDEQ(mutation.ServerID),
		).Only(ctx)
		if ent.IsNotFound(err) {
			return workport.ErrNotFound
		}
		if err != nil {
			return err
		}
		if entity.Revision != revision {
			return workport.ErrRevisionConflict
		}
		affected, err := tx.Reminder.Update().Where(
			reminder.IDEQ(reminderID),
			reminder.ServerIDEQ(mutation.ServerID),
			reminder.RevisionEQ(revision),
		).
			SetStatus("canceled").
			ClearNextFireAt().
			SetRevision(revision + 1).
			SetUpdatedAt(mutation.Now).
			Save(ctx)
		if err != nil {
			return err
		}
		if affected == 0 {
			return workport.ErrRevisionConflict
		}
		return saveIdempotency(ctx, tx, mutation, scope, reminderID, entity.ID)
	})
}

func (repository *EntRepository) ListInbox(
	ctx context.Context,
	accountID, serverID string,
) ([]workport.InboxItem, error) {
	membership, err := repository.membership(ctx, accountID, serverID)
	if err != nil {
		return nil, err
	}
	entities, err := repository.handle.Client().Task.Query().
		Where(
			task.ServerIDEQ(serverID),
			task.OwnerMemberIDEQ(membership.MemberID),
			task.StatusIn("todo", "in_progress", "in_review"),
		).
		Order(ent.Desc(task.FieldUpdatedAt), ent.Desc(task.FieldID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	values := make([]workport.InboxItem, 0, len(entities))
	for _, entity := range entities {
		values = append(values, workport.InboxItem{
			ID: entity.ID, ServerID: serverID, Kind: "task",
			Title:  fmt.Sprintf("#%d %s", entity.Number, entity.Title),
			Status: entity.Status, ResourceID: entity.ID, UpdatedAt: entity.UpdatedAt,
		})
	}
	return values, nil
}

func (repository *EntRepository) ListActivity(
	ctx context.Context,
	accountID, serverID string,
) ([]workport.ActivityItem, error) {
	if _, err := repository.membership(ctx, accountID, serverID); err != nil {
		return nil, err
	}
	tasks, err := repository.handle.Client().Task.Query().
		Where(task.ServerIDEQ(serverID)).
		Order(ent.Desc(task.FieldUpdatedAt)).
		Limit(50).
		All(ctx)
	if err != nil {
		return nil, err
	}
	reminders, err := repository.handle.Client().Reminder.Query().
		Where(reminder.ServerIDEQ(serverID)).
		Order(ent.Desc(reminder.FieldUpdatedAt)).
		Limit(50).
		All(ctx)
	if err != nil {
		return nil, err
	}
	values := make([]workport.ActivityItem, 0, len(tasks)+len(reminders))
	for _, entity := range tasks {
		values = append(values, workport.ActivityItem{
			ID: entity.ID, ServerID: serverID, Kind: "task.changed",
			ResourceID: entity.ID, ResourceType: "task",
			Summary:    fmt.Sprintf("Task #%d · %s · %s", entity.Number, entity.Title, entity.Status),
			OccurredAt: entity.UpdatedAt,
		})
	}
	for _, entity := range reminders {
		values = append(values, workport.ActivityItem{
			ID: entity.ID, ServerID: serverID, Kind: "reminder.changed",
			ResourceID: entity.ID, ResourceType: "reminder",
			Summary:    fmt.Sprintf("Reminder · %s · %s", entity.Text, entity.Status),
			OccurredAt: entity.UpdatedAt,
		})
	}
	sort.Slice(values, func(i, j int) bool {
		return values[i].OccurredAt.After(values[j].OccurredAt)
	})
	if len(values) > 100 {
		values = values[:100]
	}
	return values, nil
}

func requireChannelAccess(
	ctx context.Context,
	tx *ent.Tx,
	accountID, serverID, channelID string,
) (*ent.AccountServerMembership, error) {
	membership, err := requireMembership(ctx, tx, accountID, serverID)
	if err != nil {
		return nil, err
	}
	entity, err := tx.Channel.Query().Where(
		channelentity.IDEQ(channelID),
		channelentity.ServerIDEQ(serverID),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, workport.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	root := entity.SystemKey != nil && *entity.SystemKey == "all"
	if root {
		return membership, nil
	}
	allowed, err := tx.ChannelMember.Query().Where(
		channelmember.ServerIDEQ(serverID),
		channelmember.ChannelIDEQ(channelID),
		channelmember.MemberIDEQ(membership.MemberID),
		channelmember.StateEQ("active"),
		channelmember.ImStateEQ("ready"),
	).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, workport.ErrForbidden
	}
	return membership, nil
}

func requireChannelAccessClient(
	ctx context.Context,
	client *ent.Client,
	accountID, serverID, channelID string,
) (*ent.AccountServerMembership, error) {
	membership, err := client.AccountServerMembership.Query().Where(
		accountservermembership.AccountIDEQ(accountID),
		accountservermembership.ServerIDEQ(serverID),
		accountservermembership.StatusEQ("active"),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, workport.ErrForbidden
	}
	if err != nil {
		return nil, err
	}
	entity, err := client.Channel.Query().Where(
		channelentity.IDEQ(channelID),
		channelentity.ServerIDEQ(serverID),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, workport.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	root := entity.SystemKey != nil && *entity.SystemKey == "all"
	if root {
		return membership, nil
	}
	allowed, err := client.ChannelMember.Query().Where(
		channelmember.ServerIDEQ(serverID),
		channelmember.ChannelIDEQ(channelID),
		channelmember.MemberIDEQ(membership.MemberID),
		channelmember.StateEQ("active"),
		channelmember.ImStateEQ("ready"),
	).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, workport.ErrForbidden
	}
	return membership, nil
}

func loadThreadRoot(
	ctx context.Context,
	tx *ent.Tx,
	serverID, channelID, threadID string,
) (*ent.MessageThreadRef, error) {
	entity, err := tx.MessageThreadRef.Query().Where(
		messagethreadref.IDEQ(threadID),
		messagethreadref.ServerIDEQ(serverID),
		messagethreadref.ChannelIDEQ(channelID),
		messagethreadref.RoleEQ("root"),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, workport.ErrNotFound
	}
	return entity, err
}

func threadValue(
	ctx context.Context,
	tx *ent.Tx,
	root *ent.MessageThreadRef,
	memberID string,
) (workport.MessageThread, error) {
	read, err := tx.MessageThreadRead.Query().Where(
		messagethreadread.ServerIDEQ(root.ServerID),
		messagethreadread.ThreadIDEQ(root.ID),
		messagethreadread.MemberIDEQ(memberID),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return mapThread(root, root.ReplyCount), nil
	}
	if err != nil {
		return workport.MessageThread{}, err
	}
	unread, err := tx.MessageThreadRef.Query().Where(
		messagethreadref.ServerIDEQ(root.ServerID),
		messagethreadref.ThreadIDEQ(root.ID),
		messagethreadref.RoleEQ("reply"),
		messagethreadref.MessageSequenceGT(read.LastReadSequence),
	).Count(ctx)
	if err != nil {
		return workport.MessageThread{}, err
	}
	return mapThread(root, int64(unread)), nil
}

func threadValueClient(
	ctx context.Context,
	client *ent.Client,
	root *ent.MessageThreadRef,
	memberID string,
) (workport.MessageThread, error) {
	read, err := client.MessageThreadRead.Query().Where(
		messagethreadread.ServerIDEQ(root.ServerID),
		messagethreadread.ThreadIDEQ(root.ID),
		messagethreadread.MemberIDEQ(memberID),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return mapThread(root, root.ReplyCount), nil
	}
	if err != nil {
		return workport.MessageThread{}, err
	}
	unread, err := client.MessageThreadRef.Query().Where(
		messagethreadref.ServerIDEQ(root.ServerID),
		messagethreadref.ThreadIDEQ(root.ID),
		messagethreadref.RoleEQ("reply"),
		messagethreadref.MessageSequenceGT(read.LastReadSequence),
	).Count(ctx)
	if err != nil {
		return workport.MessageThread{}, err
	}
	return mapThread(root, int64(unread)), nil
}

func mapThread(
	root *ent.MessageThreadRef,
	unreadCount int64,
) workport.MessageThread {
	return workport.MessageThread{
		ID: root.ID, ServerID: root.ServerID, ChannelID: root.ChannelID,
		RootMessageRef: messageRefValue(root),
		ReplyCount:     root.ReplyCount,
		UnreadCount:    unreadCount,
		LastReplyAt:    root.LastReplyAt,
		CreatedAt:      root.CreatedAt,
	}
}

func threadReplyValue(
	entity *ent.MessageThreadRef,
) workport.ThreadReplyReference {
	return workport.ThreadReplyReference{
		ID: entity.ID, ThreadID: entity.ThreadID,
		MessageRef: messageRefValue(entity), CreatedAt: entity.CreatedAt,
	}
}

func messageRefValue(entity *ent.MessageThreadRef) workport.MessageRef {
	sequence := entity.MessageSequence
	timestamp := entity.MessageTimestamp
	return workport.MessageRef{
		Kind: entity.MessageKind, MessageID: entity.MessageID,
		GroupID: entity.GroupID, TopicID: entity.TopicID,
		SenderUserID: entity.SenderUserID,
		Sequence:     &sequence, Timestamp: &timestamp,
	}
}

func (repository *EntRepository) membership(
	ctx context.Context,
	accountID, serverID string,
) (*ent.AccountServerMembership, error) {
	entity, err := repository.handle.Client().AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
		).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, workport.ErrForbidden
	}
	return entity, err
}

func requireMembership(
	ctx context.Context,
	tx *ent.Tx,
	accountID, serverID string,
) (*ent.AccountServerMembership, error) {
	entity, err := tx.AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
		).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, workport.ErrForbidden
	}
	return entity, err
}

func validateOwner(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	ownerID *string,
) error {
	if ownerID == nil {
		return nil
	}
	exists, err := tx.Member.Query().Where(
		member.IDEQ(*ownerID), member.ServerIDEQ(serverID), member.StatusEQ("active"),
	).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return workport.ErrInvalidOwner
	}
	return nil
}

func validateOwnerPatch(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	owner **string,
) error {
	if owner == nil {
		return nil
	}
	return validateOwner(ctx, tx, serverID, *owner)
}

func validateAgent(ctx context.Context, tx *ent.Tx, serverID, agentID string) error {
	exists, err := tx.Agent.Query().Where(
		agent.IDEQ(agentID), agent.ServerIDEQ(serverID),
		agent.DeletedAtIsNil(),
	).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return workport.ErrInvalidAgent
	}
	return nil
}

type idempotencyLocator struct {
	ResourceID string `json:"resourceId"`
}

func loadIdempotency(
	ctx context.Context,
	tx *ent.Tx,
	mutation workport.Mutation,
	scopeType, scopeID string,
) (string, bool, error) {
	entity, err := tx.IdempotencyRecord.Query().Where(
		idempotencyrecord.PartitionKeyEQ(mutation.ServerID),
		idempotencyrecord.ScopeTypeEQ(scopeType),
		idempotencyrecord.ScopeIDEQ(scopeID),
		idempotencyrecord.IdempotencyKeyEQ(mutation.IdempotencyKey),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if subtle.ConstantTimeCompare(entity.RequestHash, mutation.RequestHash[:]) != 1 {
		return "", false, workport.ErrIdempotencyConflict
	}
	var locator idempotencyLocator
	if _, err := persistedjson.DecodeScoped(entity.ResponseBodyJSON, scopeType, &locator); err != nil {
		return "", false, err
	}
	return locator.ResourceID, true, nil
}

func saveIdempotency(
	ctx context.Context,
	tx *ent.Tx,
	mutation workport.Mutation,
	scopeType, scopeID, resourceID string,
) error {
	body, err := persistedjson.EncodeScoped(scopeType, idempotencyLocator{ResourceID: resourceID})
	if err != nil {
		return err
	}
	_, err = tx.IdempotencyRecord.Create().
		SetPartitionKey(mutation.ServerID).
		SetScopeType(scopeType).
		SetScopeID(scopeID).
		SetIdempotencyKey(mutation.IdempotencyKey).
		SetRequestHash(mutation.RequestHash[:]).
		SetResponseStatus(200).
		SetResponseBodyJSON(body).
		SetExpiresAt(mutation.Now.Add(24 * time.Hour)).
		SetCreatedAt(mutation.Now).
		Save(ctx)
	return err
}

func mapTasks(entities []*ent.Task) ([]workport.Task, error) {
	values := make([]workport.Task, 0, len(entities))
	for _, entity := range entities {
		value, err := mapTask(entity)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, nil
}

func mapTask(entity *ent.Task) (workport.Task, error) {
	ref, err := decodeMessageRef(entity.SourceMessageRefJSON)
	if err != nil {
		return workport.Task{}, err
	}
	return workport.Task{
		ID: entity.ID, ServerID: entity.ServerID, Number: entity.Number,
		Title: entity.Title, Description: entity.Description, Status: entity.Status,
		OwnerMemberID:      entity.OwnerMemberID,
		AssignmentRevision: entity.AssignmentRevision,
		CreatedByMemberID:  entity.CreatedByMemberID,
		UpdatedByMemberID:  entity.UpdatedByMemberID,
		SourceMessageRef:   ref, Revision: entity.Revision,
		CreatedAt: entity.CreatedAt, UpdatedAt: entity.UpdatedAt,
	}, nil
}

func mapReminder(entity *ent.Reminder) (workport.Reminder, error) {
	anchor, err := decodeReminderAnchor(entity)
	if err != nil {
		return workport.Reminder{}, err
	}
	return workport.Reminder{
		ID: entity.ID, ServerID: entity.ServerID, AgentID: entity.AgentID,
		CreatedByMemberID: entity.CreatedByMemberID,
		ScheduleKind:      entity.ScheduleKind, Schedule: entity.Schedule,
		Timezone: entity.Timezone, Text: entity.Text, Status: entity.Status,
		NextFireAt: entity.NextFireAt, Revision: entity.Revision,
		CreatedAt: entity.CreatedAt, UpdatedAt: entity.UpdatedAt,
		Anchor: anchor,
	}, nil
}

func encodeReminderAnchor(
	value *workport.ReminderAnchor,
) (kind *string, channelID *string, threadID *string, messageRefJSON *string, err error) {
	if value == nil {
		return nil, nil, nil, nil, nil
	}
	kind = &value.Kind
	channelID = &value.ChannelID
	threadID = value.ThreadID
	messageRefJSON, err = encodeMessageRef(&value.MessageRef)
	return kind, channelID, threadID, messageRefJSON, err
}

func decodeReminderAnchor(entity *ent.Reminder) (*workport.ReminderAnchor, error) {
	if entity.AnchorKind == nil && entity.AnchorChannelID == nil &&
		entity.AnchorThreadID == nil && entity.AnchorMessageRefJSON == nil {
		return nil, nil
	}
	if entity.AnchorKind == nil || entity.AnchorChannelID == nil ||
		entity.AnchorMessageRefJSON == nil {
		return nil, errors.New("Reminder 锚点数据不完整")
	}
	reference, err := decodeMessageRef(entity.AnchorMessageRefJSON)
	if err != nil {
		return nil, err
	}
	if reference == nil {
		return nil, errors.New("Reminder 锚点缺少消息引用")
	}
	return &workport.ReminderAnchor{
		Kind: *entity.AnchorKind, ChannelID: *entity.AnchorChannelID,
		ThreadID: entity.AnchorThreadID, MessageRef: *reference,
	}, nil
}

func encodeMessageRef(value *workport.MessageRef) (*string, error) {
	if value == nil {
		return nil, nil
	}
	encoded, err := persistedjson.Encode(value)
	if err != nil {
		return nil, err
	}
	return &encoded, nil
}

func decodeMessageRef(value *string) (*workport.MessageRef, error) {
	if value == nil {
		return nil, nil
	}
	var result workport.MessageRef
	if _, err := persistedjson.Decode(*value, &result); err != nil {
		return nil, err
	}
	return &result, nil
}
