// Package agentpresence 提供 Agent 在线事实的 Ent 实现。
package agentpresence

import (
	"context"
	"errors"

	"git.woa.com/wisp/mono2/collaboration/internal/database"
	"git.woa.com/wisp/mono2/collaboration/internal/ent"
	agententity "git.woa.com/wisp/mono2/collaboration/internal/ent/agent"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/agentimroute"
	agentpresenceport "git.woa.com/wisp/mono2/collaboration/internal/ports/agentpresence"
)

type EntRepository struct {
	handle *database.Handle
}

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Agent 在线投影 Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) ApplyIMPresence(
	ctx context.Context,
	observation agentpresenceport.IMObservation,
) (changed bool, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			route, err := tx.AgentIMRoute.Query().
				Where(
					agentimroute.ImUserIDEQ(observation.IMUserID),
					agentimroute.StateEQ("active"),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return nil
			}
			if err != nil {
				return err
			}
			entity, err := tx.Agent.Query().
				Where(
					agententity.IDEQ(route.AgentID),
					agententity.ServerIDEQ(route.ServerID),
					agententity.DeletedAtIsNil(),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return nil
			}
			if err != nil {
				return err
			}
			at := observation.ObservedAt.UTC()
			if entity.ImPresenceUpdatedAt != nil &&
				!at.After(entity.ImPresenceUpdatedAt.UTC()) {
				return nil
			}
			updated, err := tx.Agent.Update().
				Where(
					agententity.IDEQ(entity.ID),
					agententity.ServerIDEQ(entity.ServerID),
					agententity.Or(
						agententity.ImPresenceUpdatedAtIsNil(),
						agententity.ImPresenceUpdatedAtLT(at),
					),
				).
				SetImPresence(observation.Presence).
				SetImPresenceUpdatedAt(at).
				Save(ctx)
			if err != nil {
				return err
			}
			changed = updated == 1
			return nil
		},
	)
	return changed, returnErr
}

var _ agentpresenceport.Repository = (*EntRepository)(nil)
