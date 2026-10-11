// Package runtimeauth 提供 Agent credential currentness 的 Ent 实现。
package runtimeauth

import (
	"context"
	"errors"
	"math"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/agent"
	"chatserver/internal/ent/agentruntimecredential"
	"chatserver/internal/ent/computer"
	runtimeauthport "chatserver/internal/ports/runtimeauth"

	"github.com/google/uuid"
)

// EntRepository 只按 server_id、agent_id、version 点查凭据。
type EntRepository struct {
	handle *database.Handle
}

// NewEntRepository 创建 Runtime 认证 Repository。
func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Runtime 认证 Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

// FindCurrent 返回精确路由所指向的当前 active credential 摘要。
func (r *EntRepository) FindCurrent(
	ctx context.Context,
	route runtimeauthport.Route,
) (runtimeauthport.Credential, error) {
	if err := validateRoute(route); err != nil {
		return runtimeauthport.Credential{}, err
	}
	version := int64(route.Version)
	entity, err := r.handle.Client().AgentRuntimeCredential.Query().
		Where(
			agentruntimecredential.ServerIDEQ(route.ServerID),
			agentruntimecredential.AgentIDEQ(route.AgentID),
			agentruntimecredential.VersionEQ(version),
			agentruntimecredential.StateEQ("active"),
			agentruntimecredential.RevokedAtIsNil(),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return runtimeauthport.Credential{},
			runtimeauthport.ErrCredentialNotCurrent
	}
	if err != nil {
		return runtimeauthport.Credential{}, err
	}
	if len(entity.SecretHash) != 32 {
		return runtimeauthport.Credential{},
			errors.New("Agent credential 摘要长度无效")
	}
	if _, err := r.handle.Client().Agent.Query().
		Where(
			agent.IDEQ(route.AgentID),
			agent.ServerIDEQ(route.ServerID),
			agent.CredentialVersionEQ(version),
			agent.DesiredStateEQ("running"),
			agent.DeletedAtIsNil(),
		).
		Only(ctx); ent.IsNotFound(err) {
		return runtimeauthport.Credential{},
			runtimeauthport.ErrCredentialNotCurrent
	} else if err != nil {
		return runtimeauthport.Credential{}, err
	}

	var digest [32]byte
	copy(digest[:], entity.SecretHash)
	return runtimeauthport.Credential{
		Route:        route,
		SecretDigest: digest,
	}, nil
}

// ConfirmCurrent 在验密后重新点查，关闭与凭据轮换之间的窗口。
func (r *EntRepository) ConfirmCurrent(
	ctx context.Context,
	route runtimeauthport.Route,
) (bool, error) {
	_, err := r.FindCurrent(ctx, route)
	switch {
	case errors.Is(err, runtimeauthport.ErrCredentialNotCurrent):
		return false, nil
	case err != nil:
		return false, err
	default:
		return true, nil
	}
}

// ConfirmCurrentLaunch 在同一事务快照内验证 Computer、Agent、Credential
// 与短期 Runtime Token 携带的完整 Launch Fence 仍精确一致。
func (r *EntRepository) ConfirmCurrentLaunch(
	ctx context.Context,
	route runtimeauthport.LaunchRoute,
) (bool, error) {
	if err := validateLaunchRoute(route); err != nil {
		return false, err
	}
	current := false
	err := r.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		computerCurrent, err := tx.Computer.Query().Where(
			computer.ServerIDEQ(route.ServerID),
			computer.IDEQ(route.ComputerID),
			computer.LifecycleStateEQ("active"),
			computer.AssignmentEpochEQ(route.AssignmentEpoch),
		).Exist(ctx)
		if err != nil || !computerCurrent {
			return err
		}
		agentCurrent, err := tx.Agent.Query().Where(
			agent.ServerIDEQ(route.ServerID),
			agent.IDEQ(route.AgentID),
			agent.ComputerIDEQ(route.ComputerID),
			agent.DesiredStateEQ("running"),
			agent.DeletedAtIsNil(),
			agent.RevisionEQ(route.ConfigGeneration),
			agent.CredentialVersionEQ(int64(route.CredentialVersion)),
			agent.CurrentLaunchIDEQ(route.LaunchID),
			agent.CurrentLaunchAssignmentEpochEQ(route.AssignmentEpoch),
			agent.CurrentLaunchGenerationEQ(route.ConfigGeneration),
			agent.CurrentLaunchCredentialVersionEQ(int64(route.CredentialVersion)),
			agent.CurrentLaunchAttemptEQ(route.Attempt),
			agent.CurrentLaunchUpdatedAtNotNil(),
		).Exist(ctx)
		if err != nil || !agentCurrent {
			return err
		}
		credentialCurrent, err := tx.AgentRuntimeCredential.Query().Where(
			agentruntimecredential.ServerIDEQ(route.ServerID),
			agentruntimecredential.AgentIDEQ(route.AgentID),
			agentruntimecredential.VersionEQ(int64(route.CredentialVersion)),
			agentruntimecredential.StateEQ("active"),
			agentruntimecredential.RevokedAtIsNil(),
		).Exist(ctx)
		if err != nil {
			return err
		}
		current = credentialCurrent
		return nil
	})
	return current, err
}

func validateRoute(route runtimeauthport.Route) error {
	if route.Version == 0 || route.Version > math.MaxInt64 ||
		!runtimeUUIDv7(route.ServerID) ||
		!runtimeUUIDv7(route.AgentID) {
		return runtimeauthport.ErrInvalidRoute
	}
	return nil
}

func validateLaunchRoute(route runtimeauthport.LaunchRoute) error {
	if route.CredentialVersion == 0 || route.CredentialVersion > math.MaxInt64 ||
		route.ConfigGeneration < 1 || route.Attempt < 1 ||
		!runtimeUUIDv7(route.ServerID) || !runtimeUUIDv7(route.ComputerID) ||
		!runtimeUUIDv7(route.AgentID) || !runtimeUUIDv7(route.LaunchID) ||
		!runtimeUUIDv7(route.AssignmentEpoch) {
		return runtimeauthport.ErrInvalidRoute
	}
	return nil
}

func runtimeUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}
