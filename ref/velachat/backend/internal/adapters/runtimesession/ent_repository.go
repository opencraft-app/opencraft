// Package runtimesession 提供 Runtime Session Agent 事实的 Ent 实现。
package runtimesession

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/agent"
	"chatserver/internal/ent/agentimroute"
	"chatserver/internal/ent/agentruntimecredential"
	"chatserver/internal/ent/computer"
	runtimesessionport "chatserver/internal/ports/runtimesession"

	"github.com/google/uuid"
)

// EntRepository 按同一 server_id 分区读取 Agent、credential 与 Computer。
type EntRepository struct {
	handle *database.Handle
}

// NewEntRepository 创建 Runtime Session Repository。
func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Runtime Session Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

// FindCurrentAgent 精确校验 Agent 当前 credential version 并返回运行事实。
func (r *EntRepository) FindCurrentAgent(
	ctx context.Context,
	serverID string,
	agentID string,
	version uint64,
) (runtimesessionport.Agent, error) {
	if !validRoute(serverID, agentID, version) {
		return runtimesessionport.Agent{}, runtimesessionport.ErrNotCurrent
	}
	versionValue := int64(version)
	if _, err := r.handle.Client().AgentRuntimeCredential.Query().
		Where(
			agentruntimecredential.ServerIDEQ(serverID),
			agentruntimecredential.AgentIDEQ(agentID),
			agentruntimecredential.VersionEQ(versionValue),
			agentruntimecredential.StateEQ("active"),
			agentruntimecredential.RevokedAtIsNil(),
		).
		Only(ctx); ent.IsNotFound(err) {
		return runtimesessionport.Agent{}, runtimesessionport.ErrNotCurrent
	} else if err != nil {
		return runtimesessionport.Agent{}, err
	}
	entity, err := r.handle.Client().Agent.Query().
		Where(
			agent.IDEQ(agentID),
			agent.ServerIDEQ(serverID),
			agent.CredentialVersionEQ(versionValue),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return runtimesessionport.Agent{}, runtimesessionport.ErrNotCurrent
	}
	if err != nil {
		return runtimesessionport.Agent{}, err
	}

	result := runtimesessionport.Agent{
		ID:                entity.ID,
		ServerID:          entity.ServerID,
		IMUserID:          entity.ImUserID,
		IMState:           entity.ImState,
		RuntimeKind:       entity.RuntimeKind,
		ReplyPolicy:       entity.ReplyPolicy,
		DesiredState:      entity.DesiredState,
		ObservedState:     entity.ObservedState,
		CredentialVersion: version,
	}
	if entity.RuntimeModel != nil {
		result.RuntimeModel = *entity.RuntimeModel
	}
	if entity.ComputerID == nil || strings.TrimSpace(*entity.ComputerID) == "" {
		return result, nil
	}
	result.ComputerID = *entity.ComputerID
	machine, err := r.handle.Client().Computer.Query().
		Where(
			computer.IDEQ(*entity.ComputerID),
			computer.ServerIDEQ(serverID),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return result, nil
	}
	if err != nil {
		return runtimesessionport.Agent{}, err
	}
	result.ComputerReady = machine.LifecycleState == "active" &&
		machine.TatInstanceID != nil &&
		strings.TrimSpace(*machine.TatInstanceID) != ""
	return result, nil
}

// MarkCredentialUsed 在同一事务里复核生命周期和版本后更新 last_used_at。
func (r *EntRepository) MarkCredentialUsed(
	ctx context.Context,
	serverID string,
	agentID string,
	version uint64,
	at time.Time,
) (current bool, returnErr error) {
	if !validRoute(serverID, agentID, version) || at.IsZero() {
		return false, nil
	}
	versionValue := int64(version)
	returnErr = r.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		agentEntity, err := tx.Agent.Query().
			Where(
				agent.IDEQ(agentID),
				agent.ServerIDEQ(serverID),
				agent.CredentialVersionEQ(versionValue),
				agent.DesiredStateEQ("running"),
				agent.DeletedAtIsNil(),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		entity, err := tx.AgentRuntimeCredential.Query().
			Where(
				agentruntimecredential.ServerIDEQ(serverID),
				agentruntimecredential.AgentIDEQ(agentID),
				agentruntimecredential.VersionEQ(versionValue),
				agentruntimecredential.StateEQ("active"),
				agentruntimecredential.RevokedAtIsNil(),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err := tx.AgentRuntimeCredential.UpdateOne(entity).
			SetLastUsedAt(at.UTC()).
			Save(ctx); err != nil {
			return err
		}
		seenAt := at.UTC()
		routeExists, err := tx.AgentIMRoute.Query().
			Where(agentimroute.ImUserIDEQ(agentEntity.ImUserID)).
			Exist(ctx)
		if err != nil {
			return err
		}
		if !routeExists {
			if _, err := tx.AgentIMRoute.Create().
				SetID(agentEntity.ID).
				SetImUserID(agentEntity.ImUserID).
				SetServerID(agentEntity.ServerID).
				SetAgentID(agentEntity.ID).
				SetState("active").
				SetCreatedAt(seenAt).
				SetUpdatedAt(seenAt).
				Save(ctx); err != nil {
				return err
			}
		}
		current = true
		return nil
	})
	return current, returnErr
}

func validRoute(serverID string, agentID string, version uint64) bool {
	return version > 0 && version <= math.MaxInt64 &&
		validRuntimeID(serverID) &&
		validRuntimeID(agentID)
}

func validRuntimeID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

var _ runtimesessionport.Repository = (*EntRepository)(nil)
