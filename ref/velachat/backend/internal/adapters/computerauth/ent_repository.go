// Package computerauth provides Computer credential currentness from Ent.
package computerauth

import (
	"context"
	"errors"
	"math"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/computer"
	"chatserver/internal/ent/computerruntimecredential"
	"chatserver/internal/ent/predicate"
	clockport "chatserver/internal/ports/clock"
	computerauthport "chatserver/internal/ports/computerauth"

	"github.com/google/uuid"
)

type EntRepository struct {
	handle    *database.Handle
	clock     clockport.Clock
	bootstrap bool
}

func NewEntRepository(
	handle *database.Handle,
	clock clockport.Clock,
) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil || clock == nil {
		return nil, errors.New("Computer 认证 Repository 配置无效")
	}
	return &EntRepository{handle: handle, clock: clock}, nil
}

// NewBootstrapEntRepository 只认证已完成 claim、尚未取得 provider identity 的
// provisioning Computer。它不会放宽正式 Computer 控制面的 active 门禁。
func NewBootstrapEntRepository(
	handle *database.Handle,
	clock clockport.Clock,
) (*EntRepository, error) {
	repository, err := NewEntRepository(handle, clock)
	if err != nil {
		return nil, err
	}
	repository.bootstrap = true
	return repository, nil
}

func (repository *EntRepository) FindCurrent(
	ctx context.Context,
	route computerauthport.Route,
) (computerauthport.Credential, error) {
	if err := validateRoute(route); err != nil {
		return computerauthport.Credential{}, err
	}
	now := repository.clock.Now().UTC()
	entity, err := repository.handle.Client().ComputerRuntimeCredential.Query().
		Where(
			computerruntimecredential.ServerIDEQ(route.ServerID),
			computerruntimecredential.ComputerIDEQ(route.ComputerID),
			computerruntimecredential.VersionEQ(int64(route.Version)),
			computerruntimecredential.RevokedAtIsNil(),
			computerruntimecredential.Or(
				computerruntimecredential.And(
					computerruntimecredential.StateEQ("active"),
					computerruntimecredential.ExpiresAtGT(now),
				),
				computerruntimecredential.And(
					computerruntimecredential.StateEQ("grace"),
					computerruntimecredential.GraceExpiresAtGT(now),
				),
			),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return computerauthport.Credential{}, computerauthport.ErrCredentialNotCurrent
	}
	if err != nil {
		return computerauthport.Credential{}, err
	}
	if len(entity.SecretHash) != 32 {
		return computerauthport.Credential{}, errors.New("Computer credential 摘要长度无效")
	}
	computerPredicates := []predicate.Computer{
		computer.ServerIDEQ(route.ServerID),
		computer.IDEQ(route.ComputerID),
	}
	if repository.bootstrap {
		computerPredicates = append(computerPredicates,
			computer.LifecycleStateEQ("provisioning"),
			computer.TatInstanceKindEQ("managed"),
			computer.TatInstanceIDIsNil(),
			computer.EnrollmentClaimedAtNotNil(),
			computer.EnrollmentCredentialVersionEQ(int64(route.Version)),
		)
	} else {
		computerPredicates = append(
			computerPredicates,
			computer.LifecycleStateEQ("active"),
		)
	}
	if _, err := repository.handle.Client().Computer.Query().Where(
		computerPredicates...,
	).Only(ctx); ent.IsNotFound(err) {
		return computerauthport.Credential{}, computerauthport.ErrCredentialNotCurrent
	} else if err != nil {
		return computerauthport.Credential{}, err
	}
	var digest [32]byte
	copy(digest[:], entity.SecretHash)
	return computerauthport.Credential{Route: route, SecretDigest: digest}, nil
}

func (repository *EntRepository) ConfirmCurrent(
	ctx context.Context,
	route computerauthport.Route,
) (bool, error) {
	_, err := repository.FindCurrent(ctx, route)
	switch {
	case errors.Is(err, computerauthport.ErrCredentialNotCurrent):
		return false, nil
	case err != nil:
		return false, err
	default:
		return true, nil
	}
}

func validateRoute(route computerauthport.Route) error {
	if route.Version == 0 || route.Version > math.MaxInt64 ||
		!uuidV7(route.ServerID) || !uuidV7(route.ComputerID) {
		return computerauthport.ErrInvalidRoute
	}
	return nil
}

func uuidV7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}
