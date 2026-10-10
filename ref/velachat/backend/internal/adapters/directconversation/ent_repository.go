// Package directconversation 使用 Ent 保存 Server 内私信与可靠腾讯 Work 群操作。
package directconversation

import (
	"context"
	"crypto/subtle"
	"errors"
	"strings"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/account"
	"chatserver/internal/ent/accountservermembership"
	"chatserver/internal/ent/agent"
	directentity "chatserver/internal/ent/directconversation"
	"chatserver/internal/ent/idempotencyrecord"
	"chatserver/internal/ent/member"
	"chatserver/internal/ent/tencentoperation"
	"chatserver/internal/persistedjson"
	directport "chatserver/internal/ports/directconversation"
)

type EntRepository struct{ handle *database.Handle }

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Server 内私信 Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) ResolveParticipants(
	ctx context.Context,
	accountID, serverID, peerMemberID string,
) (directport.Participants, error) {
	membership, err := activeMembership(ctx, repository.handle.Client(), accountID, serverID)
	if err != nil {
		return directport.Participants{}, err
	}
	self, err := loadMember(ctx, repository.handle.Client(), serverID, membership.MemberID)
	if err != nil {
		return directport.Participants{}, err
	}
	peer, err := loadMember(ctx, repository.handle.Client(), serverID, peerMemberID)
	if err != nil {
		return directport.Participants{}, err
	}
	if self.Status != "active" || peer.Status != "active" {
		return directport.Participants{}, directport.ErrMemberRemoved
	}
	if self.IMState != "ready" || peer.IMState != "ready" || self.IMUserID == "" || peer.IMUserID == "" {
		return directport.Participants{}, directport.ErrIMIdentityNotReady
	}
	return directport.Participants{Self: self, Peer: peer}, nil
}

func (repository *EntRepository) Create(
	ctx context.Context,
	command directport.CreateCommand,
) (result directport.CreateResult, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		client := tx.Client()
		membership, err := activeMembership(ctx, client, command.AccountID, command.ServerID)
		if err != nil {
			return err
		}
		if membership.MemberID != command.MemberAID && membership.MemberID != command.MemberBID {
			return directport.ErrMemberNotFound
		}
		if command.PeerMemberID != command.MemberAID && command.PeerMemberID != command.MemberBID {
			return directport.ErrMemberNotFound
		}
		if command.MemberAID >= command.MemberBID || membership.MemberID == command.PeerMemberID {
			return directport.ErrMemberNotFound
		}
		if _, err := requireReadyPair(ctx, client, command.ServerID, command.MemberAID, command.MemberBID); err != nil {
			return err
		}

		stored, err := client.IdempotencyRecord.Query().Where(
			idempotencyrecord.PartitionKeyEQ(command.ServerID),
			idempotencyrecord.ScopeTypeEQ("direct-conversation.create"),
			idempotencyrecord.ScopeIDEQ(command.ServerID),
			idempotencyrecord.IdempotencyKeyEQ(command.IdempotencyKey),
		).Only(ctx)
		if err == nil {
			if subtle.ConstantTimeCompare(stored.RequestHash, command.RequestHash[:]) != 1 {
				return directport.ErrIdempotencyConflict
			}
			directID, operationIDs, decodeErr := decodeLocator(stored.ResponseBodyJSON, "direct-conversation.create")
			if decodeErr != nil {
				return decodeErr
			}
			return loadResult(ctx, client, command.ServerID, membership.MemberID, directID, operationIDs, stored.ResponseStatus == 202, &result)
		}
		if !ent.IsNotFound(err) {
			return err
		}

		conversation, err := client.DirectConversation.Query().Where(
			directentity.ServerIDEQ(command.ServerID),
			directentity.MemberAIDEQ(command.MemberAID),
			directentity.MemberBIDEQ(command.MemberBID),
		).Only(ctx)
		if err == nil {
			return repository.bindCreateKey(ctx, client, membership.MemberID, command, conversation, &result)
		}
		if !ent.IsNotFound(err) {
			return err
		}

		now := command.CreatedAt.UTC()
		conversation, err = client.DirectConversation.Create().
			SetID(command.DirectConversationID).
			SetServerID(command.ServerID).
			SetMemberAID(command.MemberAID).
			SetMemberBID(command.MemberBID).
			SetImGroupID(command.IMGroupID).
			SetStatus("active").
			SetImState("provisioning").
			SetRevision(1).
			SetCreatedAt(now).
			SetUpdatedAt(now).
			Save(ctx)
		if err != nil {
			if !ent.IsConstraintError(err) {
				return err
			}
			conversation, err = client.DirectConversation.Query().Where(
				directentity.ServerIDEQ(command.ServerID),
				directentity.MemberAIDEQ(command.MemberAID),
				directentity.MemberBIDEQ(command.MemberBID),
			).Only(ctx)
			if err != nil {
				return err
			}
			return repository.bindCreateKey(ctx, client, membership.MemberID, command, conversation, &result)
		}
		operation, err := createEnsureOperation(ctx, client, command.ServerID, conversation.ID, command.OperationID, 1, now)
		if err != nil {
			return err
		}
		if err := createOutbox(ctx, client, command.ServerID, operation.ID, now); err != nil {
			return err
		}
		if err := saveLocator(
			ctx, client, command.ServerID, "direct-conversation.create", command.ServerID,
			command.IdempotencyKey, command.RequestHash, 202, conversation.ID, []string{operation.ID}, now,
		); err != nil {
			return err
		}
		value, err := mapConversation(ctx, client, conversation)
		if err != nil {
			return err
		}
		result = directport.CreateResult{Conversation: value, Operations: []directport.Operation{mapOperation(operation)}, Accepted: true}
		return nil
	})
	return result, returnErr
}

func (repository *EntRepository) bindCreateKey(
	ctx context.Context,
	client *ent.Client,
	actorMemberID string,
	command directport.CreateCommand,
	conversation *ent.DirectConversation,
	result *directport.CreateResult,
) error {
	operations, accepted, err := currentOperations(ctx, client, command.ServerID, conversation)
	if err != nil {
		return err
	}
	operationIDs := make([]string, 0, len(operations))
	for _, operation := range operations {
		operationIDs = append(operationIDs, operation.ID)
	}
	status := 200
	if accepted {
		status = 202
	}
	if err := saveLocator(
		ctx, client, command.ServerID, "direct-conversation.create", command.ServerID,
		command.IdempotencyKey, command.RequestHash, status, conversation.ID, operationIDs, command.CreatedAt.UTC(),
	); err != nil {
		return err
	}
	return loadResult(ctx, client, command.ServerID, actorMemberID, conversation.ID, operationIDs, accepted, result)
}

func (repository *EntRepository) Retry(
	ctx context.Context,
	command directport.RetryCommand,
) (result directport.CreateResult, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		client := tx.Client()
		membership, err := activeMembership(ctx, client, command.AccountID, command.ServerID)
		if err != nil {
			return err
		}
		stored, err := client.IdempotencyRecord.Query().Where(
			idempotencyrecord.PartitionKeyEQ(command.ServerID),
			idempotencyrecord.ScopeTypeEQ("direct-conversation.retry"),
			idempotencyrecord.ScopeIDEQ(command.DirectConversationID),
			idempotencyrecord.IdempotencyKeyEQ(command.IdempotencyKey),
		).Only(ctx)
		if err == nil {
			if subtle.ConstantTimeCompare(stored.RequestHash, command.RequestHash[:]) != 1 {
				return directport.ErrIdempotencyConflict
			}
			directID, operationIDs, decodeErr := decodeLocator(stored.ResponseBodyJSON, "direct-conversation.retry")
			if decodeErr != nil {
				return decodeErr
			}
			return loadResult(ctx, client, command.ServerID, membership.MemberID, directID, operationIDs, true, &result)
		}
		if !ent.IsNotFound(err) {
			return err
		}
		conversation, err := client.DirectConversation.Query().Where(
			directentity.IDEQ(command.DirectConversationID),
			directentity.ServerIDEQ(command.ServerID),
		).Only(ctx)
		if ent.IsNotFound(err) {
			return directport.ErrConversationNotFound
		}
		if err != nil {
			return err
		}
		if membership.MemberID != conversation.MemberAID && membership.MemberID != conversation.MemberBID {
			return directport.ErrConversationNotFound
		}
		if conversation.Status == "closing" {
			return directport.ErrConversationClosing
		}
		allowed := conversation.Status == "active" && conversation.ImState == "error" ||
			conversation.Status == "closed" && (conversation.ImState == "deleted" || conversation.ImState == "error")
		if !allowed {
			return directport.ErrRetryNotAllowed
		}
		if _, err := requireReadyPair(ctx, client, command.ServerID, conversation.MemberAID, conversation.MemberBID); err != nil {
			return err
		}
		now := command.RequestedAt.UTC()
		updatedCount, err := client.DirectConversation.Update().Where(
			directentity.IDEQ(conversation.ID),
			directentity.ServerIDEQ(command.ServerID),
			directentity.RevisionEQ(conversation.Revision),
		).SetStatus("active").SetImState("provisioning").AddRevision(1).SetUpdatedAt(now).Save(ctx)
		if err != nil {
			return err
		}
		if updatedCount != 1 {
			return directport.ErrRetryNotAllowed
		}
		conversation, err = client.DirectConversation.Get(ctx, conversation.ID)
		if err != nil {
			return err
		}
		operation, err := createEnsureOperation(
			ctx, client, command.ServerID, conversation.ID, command.OperationID, conversation.Revision, now,
		)
		if err != nil {
			return err
		}
		if err := createOutbox(ctx, client, command.ServerID, operation.ID, now); err != nil {
			return err
		}
		if err := saveLocator(
			ctx, client, command.ServerID, "direct-conversation.retry", conversation.ID,
			command.IdempotencyKey, command.RequestHash, 202, conversation.ID, []string{operation.ID}, now,
		); err != nil {
			return err
		}
		value, err := mapConversation(ctx, client, conversation)
		if err != nil {
			return err
		}
		result = directport.CreateResult{Conversation: value, Operations: []directport.Operation{mapOperation(operation)}, Accepted: true}
		return nil
	})
	return result, returnErr
}

func (repository *EntRepository) List(ctx context.Context, request directport.PageRequest) (directport.Page, error) {
	membership, err := activeMembership(ctx, repository.handle.Client(), request.AccountID, request.ServerID)
	if err != nil {
		return directport.Page{}, err
	}
	query := repository.handle.Client().DirectConversation.Query().Where(
		directentity.ServerIDEQ(request.ServerID),
		directentity.StatusNEQ("closed"),
		directentity.Or(
			directentity.MemberAIDEQ(membership.MemberID),
			directentity.MemberBIDEQ(membership.MemberID),
		),
	)
	if request.AfterUpdatedAt != nil && request.AfterID != "" {
		query = query.Where(directentity.Or(
			directentity.UpdatedAtLT(request.AfterUpdatedAt.UTC()),
			directentity.And(
				directentity.UpdatedAtEQ(request.AfterUpdatedAt.UTC()),
				directentity.IDLT(request.AfterID),
			),
		))
	}
	entities, err := query.Order(
		ent.Desc(directentity.FieldUpdatedAt), ent.Desc(directentity.FieldID),
	).Limit(request.Limit + 1).All(ctx)
	if err != nil {
		return directport.Page{}, err
	}
	page := directport.Page{Items: make([]directport.Conversation, 0, min(request.Limit, len(entities)))}
	if len(entities) > request.Limit {
		last := entities[request.Limit-1]
		next := last.UpdatedAt.UTC()
		page.NextUpdatedAt, page.NextID = &next, last.ID
		entities = entities[:request.Limit]
	}
	for _, entity := range entities {
		value, mapErr := mapConversation(ctx, repository.handle.Client(), entity)
		if mapErr != nil {
			return directport.Page{}, mapErr
		}
		page.Items = append(page.Items, value)
	}
	return page, nil
}

func (repository *EntRepository) Get(
	ctx context.Context,
	accountID, serverID, directConversationID string,
) (directport.Conversation, error) {
	membership, err := activeMembership(ctx, repository.handle.Client(), accountID, serverID)
	if err != nil {
		return directport.Conversation{}, err
	}
	entity, err := repository.handle.Client().DirectConversation.Query().Where(
		directentity.IDEQ(directConversationID), directentity.ServerIDEQ(serverID),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return directport.Conversation{}, directport.ErrConversationNotFound
	}
	if err != nil {
		return directport.Conversation{}, err
	}
	if membership.MemberID != entity.MemberAID && membership.MemberID != entity.MemberBID {
		return directport.Conversation{}, directport.ErrConversationNotFound
	}
	return mapConversation(ctx, repository.handle.Client(), entity)
}

func activeMembership(ctx context.Context, client *ent.Client, accountID, serverID string) (*ent.AccountServerMembership, error) {
	value, err := client.AccountServerMembership.Query().Where(
		accountservermembership.AccountIDEQ(accountID),
		accountservermembership.ServerIDEQ(serverID),
		accountservermembership.StatusEQ("active"),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, directport.ErrServerNotFound
	}
	return value, err
}

func requireReadyPair(ctx context.Context, client *ent.Client, serverID, memberAID, memberBID string) ([2]directport.Member, error) {
	memberA, err := loadMember(ctx, client, serverID, memberAID)
	if err != nil {
		return [2]directport.Member{}, err
	}
	memberB, err := loadMember(ctx, client, serverID, memberBID)
	if err != nil {
		return [2]directport.Member{}, err
	}
	if memberA.Status != "active" || memberB.Status != "active" {
		return [2]directport.Member{}, directport.ErrMemberRemoved
	}
	if memberA.IMState != "ready" || memberB.IMState != "ready" || memberA.IMUserID == "" || memberB.IMUserID == "" {
		return [2]directport.Member{}, directport.ErrIMIdentityNotReady
	}
	return [2]directport.Member{memberA, memberB}, nil
}

func loadMember(ctx context.Context, client *ent.Client, serverID, memberID string) (directport.Member, error) {
	entity, err := client.Member.Query().Where(member.IDEQ(memberID), member.ServerIDEQ(serverID)).Only(ctx)
	if ent.IsNotFound(err) {
		return directport.Member{}, directport.ErrMemberNotFound
	}
	if err != nil {
		return directport.Member{}, err
	}
	value := directport.Member{
		ID: entity.ID, ServerID: entity.ServerID, AccountID: entity.AccountID, Kind: entity.Kind, Role: entity.Role,
		DisplayName: entity.DisplayName, Handle: entity.Handle,
		Status: entity.Status, IMState: entity.ImState, Revision: entity.Revision,
	}
	switch entity.Kind {
	case "human":
		if entity.AccountID == nil {
			return directport.Member{}, directport.ErrIMIdentityNotReady
		}
		accountEntity, queryErr := client.Account.Query().Where(account.IDEQ(*entity.AccountID)).Only(ctx)
		if ent.IsNotFound(queryErr) {
			return directport.Member{}, directport.ErrIMIdentityNotReady
		}
		if queryErr != nil {
			return directport.Member{}, queryErr
		}
		if accountEntity.ImState != "ready" {
			return directport.Member{}, directport.ErrIMIdentityNotReady
		}
		value.IMUserID = accountEntity.ImUserID
	case "agent":
		agentEntity, queryErr := client.Agent.Query().Where(
			agent.IDEQ(entity.ID), agent.ServerIDEQ(serverID), agent.DeletedAtIsNil(),
		).Only(ctx)
		if ent.IsNotFound(queryErr) {
			return directport.Member{}, directport.ErrIMIdentityNotReady
		}
		if queryErr != nil {
			return directport.Member{}, queryErr
		}
		if agentEntity.ImState != "ready" {
			return directport.Member{}, directport.ErrIMIdentityNotReady
		}
		value.IMUserID = agentEntity.ImUserID
	default:
		return directport.Member{}, directport.ErrMemberNotFound
	}
	return value, nil
}

func mapConversation(ctx context.Context, client *ent.Client, entity *ent.DirectConversation) (directport.Conversation, error) {
	members, err := requireReadyPair(ctx, client, entity.ServerID, entity.MemberAID, entity.MemberBID)
	if err != nil && entity.Status == "active" {
		return directport.Conversation{}, err
	}
	if err != nil {
		memberA, firstErr := loadMember(ctx, client, entity.ServerID, entity.MemberAID)
		if firstErr != nil {
			return directport.Conversation{}, firstErr
		}
		memberB, secondErr := loadMember(ctx, client, entity.ServerID, entity.MemberBID)
		if secondErr != nil {
			return directport.Conversation{}, secondErr
		}
		members = [2]directport.Member{memberA, memberB}
	}
	return directport.Conversation{
		ID: entity.ID, ServerID: entity.ServerID, MemberA: members[0], MemberB: members[1],
		Status: entity.Status, IMGroupID: entity.ImGroupID, IMState: entity.ImState,
		Revision: entity.Revision, CreatedAt: entity.CreatedAt, UpdatedAt: entity.UpdatedAt,
	}, nil
}

func currentOperations(ctx context.Context, client *ent.Client, serverID string, conversation *ent.DirectConversation) ([]directport.Operation, bool, error) {
	if conversation.Status == "active" && conversation.ImState == "ready" {
		return nil, false, nil
	}
	operation, err := client.TencentOperation.Query().Where(
		tencentoperation.PartitionKeyEQ(serverID),
		tencentoperation.KindEQ("im.direct.ensure"),
		tencentoperation.ResourceTypeEQ("direct_conversation"),
		tencentoperation.ResourceIDEQ(conversation.ID),
	).Order(ent.Desc(tencentoperation.FieldCreatedAt), ent.Desc(tencentoperation.FieldID)).First(ctx)
	if ent.IsNotFound(err) {
		return nil, false, errors.New("Server 内私信缺少 ensure operation")
	}
	if err != nil {
		return nil, false, err
	}
	return []directport.Operation{mapOperation(operation)}, true, nil
}

func createEnsureOperation(
	ctx context.Context, client *ent.Client,
	serverID, conversationID, operationID string,
	revision int64, now time.Time,
) (*ent.TencentOperation, error) {
	return client.TencentOperation.Create().
		SetID(operationID).SetPartitionKey(serverID).SetServerID(serverID).
		SetService("im").SetKind("im.direct.ensure").
		SetResourceType("direct_conversation").SetResourceID(conversationID).
		SetIdempotencyKey("im.direct.ensure:v1:" + conversationID + ":" + stringRevision(revision)).
		SetDesiredRevision(revision).SetState("pending").SetAttempts(0).
		SetCreatedAt(now).SetUpdatedAt(now).Save(ctx)
}

func createOutbox(ctx context.Context, client *ent.Client, serverID, operationID string, now time.Time) error {
	_, err := client.OutboxEvent.Create().SetPartitionKey(serverID).SetServerID(serverID).
		SetEventType("tencent.operation.ready").SetAggregateType("tencent_operation").
		SetAggregateID(operationID).SetState("pending").SetAttempts(0).
		SetAvailableAt(now).SetCreatedAt(now).Save(ctx)
	return err
}

func saveLocator(
	ctx context.Context, client *ent.Client,
	partitionKey, scopeType, scopeID, idempotencyKey string,
	requestHash [32]byte, responseStatus int,
	conversationID string, operationIDs []string, now time.Time,
) error {
	raw, err := encodeLocator(scopeType, conversationID, operationIDs)
	if err != nil {
		return err
	}
	_, err = client.IdempotencyRecord.Create().SetPartitionKey(partitionKey).
		SetScopeType(scopeType).SetScopeID(scopeID).SetIdempotencyKey(idempotencyKey).
		SetRequestHash(requestHash[:]).SetResponseStatus(responseStatus).SetResponseBodyJSON(raw).
		SetExpiresAt(now.Add(24 * time.Hour)).SetCreatedAt(now).Save(ctx)
	return err
}

func encodeLocator(scope, conversationID string, operationIDs []string) (string, error) {
	return persistedjson.EncodeScoped(scope, struct {
		DirectConversationID string   `json:"directConversationId"`
		OperationIDs         []string `json:"operationIds"`
	}{DirectConversationID: conversationID, OperationIDs: operationIDs})
}

func decodeLocator(raw, scope string) (string, []string, error) {
	var value struct {
		DirectConversationID string   `json:"directConversationId"`
		OperationIDs         []string `json:"operationIds"`
	}
	if _, err := persistedjson.DecodeScoped(raw, scope, &value); err != nil {
		return "", nil, err
	}
	if strings.TrimSpace(value.DirectConversationID) == "" {
		return "", nil, errors.New("私信幂等记录无效")
	}
	for _, operationID := range value.OperationIDs {
		if strings.TrimSpace(operationID) == "" {
			return "", nil, errors.New("私信幂等记录无效")
		}
	}
	return value.DirectConversationID, value.OperationIDs, nil
}

func loadResult(
	ctx context.Context, client *ent.Client,
	serverID, actorMemberID, conversationID string,
	operationIDs []string, accepted bool,
	result *directport.CreateResult,
) error {
	entity, err := client.DirectConversation.Query().Where(
		directentity.IDEQ(conversationID), directentity.ServerIDEQ(serverID),
	).Only(ctx)
	if err != nil {
		return err
	}
	if actorMemberID != entity.MemberAID && actorMemberID != entity.MemberBID {
		return directport.ErrConversationNotFound
	}
	value, err := mapConversation(ctx, client, entity)
	if err != nil {
		return err
	}
	operations := make([]directport.Operation, 0, len(operationIDs))
	for _, operationID := range operationIDs {
		operation, queryErr := client.TencentOperation.Query().Where(
			tencentoperation.IDEQ(operationID), tencentoperation.PartitionKeyEQ(serverID),
		).Only(ctx)
		if queryErr != nil {
			return queryErr
		}
		operations = append(operations, mapOperation(operation))
	}
	*result = directport.CreateResult{Conversation: value, Operations: operations, Accepted: accepted}
	return nil
}

func mapOperation(entity *ent.TencentOperation) directport.Operation {
	return directport.Operation{
		ID: entity.ID, ServerID: optionalString(entity.ServerID), Service: entity.Service,
		Kind: entity.Kind, State: entity.State, CreatedAt: entity.CreatedAt,
		CompletedAt: entity.CompletedAt, LastErrorCode: entity.LastErrorCode,
	}
}

func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func stringRevision(value int64) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	position := len(digits)
	for value > 0 {
		position--
		digits[position] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[position:])
}

var _ directport.Repository = (*EntRepository)(nil)
