// Package computerv2 persists the separate LightVela-instance Computer model.
package computerv2

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"time"

	"git.woa.com/wisp/mono2/collaboration/internal/database"
	"git.woa.com/wisp/mono2/collaboration/internal/ent"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/accountservermembership"
	computerentity "git.woa.com/wisp/mono2/collaboration/internal/ent/computer"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/computerproviderbinding"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/idempotencyrecord"
	"git.woa.com/wisp/mono2/collaboration/internal/persistedjson"
	computerv2port "git.woa.com/wisp/mono2/collaboration/internal/ports/computerv2"
)

const attachScope = "computer-v2.attach"

// EntRepository writes the Server authority and provider-instance registry in
// one transaction. The binding_hash route is the global uniqueness authority.
type EntRepository struct{ handle *database.Handle }

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("ComputerV2 Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) Attach(
	ctx context.Context,
	command computerv2port.AttachCommand,
) (result computerv2port.Computer, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		if err := requireAdmin(ctx, tx, command.AccountID, command.ServerID); err != nil {
			return err
		}
		stored, err := tx.IdempotencyRecord.Query().Where(
			idempotencyrecord.PartitionKeyEQ(command.ServerID),
			idempotencyrecord.ScopeTypeEQ(attachScope),
			idempotencyrecord.ScopeIDEQ(command.ServerID),
			idempotencyrecord.IdempotencyKeyEQ(command.IdempotencyKey),
		).Only(ctx)
		if err == nil {
			if subtle.ConstantTimeCompare(stored.RequestHash, command.RequestHash[:]) != 1 {
				return computerv2port.ErrIdempotencyConflict
			}
			var body struct {
				ComputerID string `json:"computerId"`
			}
			if _, err := persistedjson.DecodeScoped(stored.ResponseBodyJSON, attachScope, &body); err != nil {
				return err
			}
			entity, err := tx.Computer.Query().Where(
				computerentity.IDEQ(body.ComputerID),
				computerentity.ServerIDEQ(command.ServerID),
				computerentity.KindEQ("lightvela_instance"),
			).Only(ctx)
			if ent.IsNotFound(err) {
				return computerv2port.ErrServerNotFound
			}
			if err != nil {
				return err
			}
			result = mapComputer(entity)
			return nil
		}
		if !ent.IsNotFound(err) {
			return err
		}

		bindingHash := providerBindingHash(command.Computer.Kind, command.Computer.InstanceID)
		_, err = tx.ComputerProviderBinding.Query().Where(
			computerproviderbinding.BindingHashEQ(bindingHash),
		).Only(ctx)
		switch {
		case err == nil:
			return computerv2port.ErrInstanceAlreadyAttached
		case !ent.IsNotFound(err):
			return err
		}

		now := command.CreatedAt.UTC()
		if _, err := tx.ComputerProviderBinding.Create().
			SetBindingHash(bindingHash).
			SetProviderKind(command.Computer.Kind).
			SetProviderInstanceID(command.Computer.InstanceID).
			SetServerID(command.ServerID).
			SetComputerID(command.Computer.ID).
			SetState("active").
			SetCreatedAt(now).
			SetUpdatedAt(now).
			Save(ctx); err != nil {
			if ent.IsConstraintError(err) {
				return computerv2port.ErrInstanceAlreadyAttached
			}
			return err
		}
		entity, err := tx.Computer.Create().
			SetID(command.Computer.ID).
			SetServerID(command.ServerID).
			SetName(command.Computer.Name).
			SetKind(command.Computer.Kind).
			SetProviderInstanceID(command.Computer.InstanceID).
			SetDesiredState("active").
			SetTatRegion("").
			SetTatInstanceKind("lightvela_instance").
			SetOsType("unknown").
			SetLifecycleState(command.Computer.LifecycleState).
			SetTatAgentState("unknown").
			SetRevision(1).
			SetCreatedAt(now).
			SetUpdatedAt(now).
			Save(ctx)
		if err != nil {
			return err
		}
		response, err := persistedjson.EncodeScoped(attachScope, struct {
			ComputerID string `json:"computerId"`
		}{ComputerID: entity.ID})
		if err != nil {
			return err
		}
		if _, err := tx.IdempotencyRecord.Create().
			SetPartitionKey(command.ServerID).
			SetScopeType(attachScope).
			SetScopeID(command.ServerID).
			SetIdempotencyKey(command.IdempotencyKey).
			SetRequestHash(command.RequestHash[:]).
			SetResponseStatus(201).
			SetResponseBodyJSON(response).
			SetExpiresAt(now.Add(24 * time.Hour)).
			SetCreatedAt(now).
			Save(ctx); err != nil {
			return err
		}
		result = mapComputer(entity)
		return nil
	})
	return result, returnErr
}

func (repository *EntRepository) List(
	ctx context.Context,
	accountID string,
	serverID string,
	options computerv2port.ListOptions,
) (computerv2port.Page, error) {
	exists, err := repository.handle.Client().AccountServerMembership.Query().Where(
		accountservermembership.AccountIDEQ(accountID),
		accountservermembership.ServerIDEQ(serverID),
		accountservermembership.StatusEQ("active"),
	).Exist(ctx)
	if err != nil {
		return computerv2port.Page{}, err
	}
	if !exists {
		return computerv2port.Page{}, computerv2port.ErrServerNotFound
	}
	limit := options.Limit
	if limit == 0 {
		limit = 50
	}
	query := repository.handle.Client().Computer.Query().Where(
		computerentity.ServerIDEQ(serverID),
		computerentity.KindEQ("lightvela_instance"),
		computerentity.LifecycleStateNEQ("removed"),
	)
	if options.AfterID != "" {
		query = query.Where(computerentity.IDGT(options.AfterID))
	}
	entities, err := query.Order(ent.Asc(computerentity.FieldID)).Limit(limit + 1).All(ctx)
	if err != nil {
		return computerv2port.Page{}, err
	}
	page := computerv2port.Page{Items: make([]computerv2port.Computer, 0, min(limit, len(entities)))}
	if len(entities) > limit {
		page.NextCursor = entities[limit-1].ID
		entities = entities[:limit]
	}
	for _, entity := range entities {
		page.Items = append(page.Items, mapComputer(entity))
	}
	return page, nil
}

func requireAdmin(ctx context.Context, tx *ent.Tx, accountID, serverID string) error {
	exists, err := tx.AccountServerMembership.Query().Where(
		accountservermembership.AccountIDEQ(accountID),
		accountservermembership.ServerIDEQ(serverID),
		accountservermembership.StatusEQ("active"),
		accountservermembership.RoleIn("owner", "admin"),
	).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return computerv2port.ErrAdminRequired
	}
	return nil
}

func mapComputer(entity *ent.Computer) computerv2port.Computer {
	instanceID := ""
	if entity.ProviderInstanceID != nil {
		instanceID = *entity.ProviderInstanceID
	}
	lastErrorCode := ""
	if entity.LastErrorCode != nil {
		lastErrorCode = *entity.LastErrorCode
	}
	return computerv2port.Computer{
		ID: entity.ID, ServerID: entity.ServerID, Kind: entity.Kind,
		InstanceID: instanceID, Name: entity.Name,
		LifecycleState: entity.LifecycleState, ObservedState: entity.TatAgentState,
		LastObservedAt: entity.LastObservedAt, LastErrorCode: lastErrorCode,
		Revision: entity.Revision, CreatedAt: entity.CreatedAt,
	}
}

func providerBindingHash(kind, instanceID string) string {
	digest := sha256.Sum256([]byte(kind + "\x00" + instanceID))
	return hex.EncodeToString(digest[:])
}
