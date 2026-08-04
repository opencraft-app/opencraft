// Package computer 使用 Ent/SQLite 保存 Computer 和可靠 TAT 刷新操作。
package computer

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"math"
	"path"
	"strings"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/accountservermembership"
	agententity "chatserver/internal/ent/agent"
	computerentity "chatserver/internal/ent/computer"
	"chatserver/internal/ent/computerruntimecredential"
	"chatserver/internal/ent/computersetupcode"
	"chatserver/internal/ent/idempotencyrecord"
	"chatserver/internal/ent/tencentoperation"
	"chatserver/internal/persistedjson"
	computerport "chatserver/internal/ports/computer"
)

// EntRepository 以 server_id 作为业务分区保存 Computer。
type EntRepository struct{ handle *database.Handle }

var errEnrollmentClaimRace = errors.New("Computer enrollment claim 并发冲突")

// NewEntRepository 创建 Computer Repository。
func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Computer Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

// Create 在 membership 授权和幂等门禁后创建 Computer。
func (repository *EntRepository) Create(
	ctx context.Context,
	command computerport.CreateCommand,
) (result computerport.Computer, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			if err := requireMembership(
				ctx, tx, command.AccountID, command.ServerID,
			); err != nil {
				return err
			}
			stored, err := tx.IdempotencyRecord.Query().
				Where(
					idempotencyrecord.PartitionKeyEQ(command.ServerID),
					idempotencyrecord.ScopeTypeEQ("computer.create"),
					idempotencyrecord.ScopeIDEQ(command.ServerID),
					idempotencyrecord.IdempotencyKeyEQ(command.IdempotencyKey),
				).
				Only(ctx)
			if err == nil {
				if subtle.ConstantTimeCompare(
					stored.RequestHash, command.RequestHash[:],
				) != 1 {
					return computerport.ErrIdempotencyConflict
				}
				computerID, err := decodeID(stored.ResponseBodyJSON, "computer.create", "computerId")
				if err != nil {
					return err
				}
				entity, err := tx.Computer.Query().
					Where(
						computerentity.IDEQ(computerID),
						computerentity.ServerIDEQ(command.ServerID),
					).
					Only(ctx)
				if ent.IsNotFound(err) {
					return computerport.ErrComputerNotFound
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
			if command.Computer.TATInstanceID != nil {
				instanceConflict, err := tx.Computer.Query().
					Where(
						computerentity.ServerIDEQ(command.ServerID),
						computerentity.TatRegionEQ(command.Computer.TATRegion),
						computerentity.TatInstanceIDEQ(
							*command.Computer.TATInstanceID,
						),
						computerentity.LifecycleStateNEQ("removed"),
					).
					Exist(ctx)
				if err != nil {
					return err
				}
				if instanceConflict {
					return computerport.ErrInstanceConflict
				}
			}
			now := command.CreatedAt.UTC()
			entity, err := tx.Computer.Create().
				SetID(command.Computer.ID).
				SetServerID(command.ServerID).
				SetName(command.Computer.Name).
				SetTatRegion(command.Computer.TATRegion).
				SetNillableTatInstanceID(command.Computer.TATInstanceID).
				SetTatInstanceKind(command.Computer.TATInstanceKind).
				SetOsType(command.Computer.OSType).
				SetLifecycleState(command.Computer.LifecycleState).
				SetTatAgentState("unknown").
				SetRevision(1).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx)
			if err != nil {
				if ent.IsConstraintError(err) {
					return computerport.ErrInstanceConflict
				}
				return err
			}
			response, err := encodeID("computer.create", "computerId", entity.ID)
			if err != nil {
				return err
			}
			if _, err := tx.IdempotencyRecord.Create().
				SetPartitionKey(command.ServerID).
				SetScopeType("computer.create").
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
		},
	)
	return result, returnErr
}

// List 列出 active membership 可见且未移除的 Computer。
func (repository *EntRepository) List(
	ctx context.Context,
	accountID string,
	serverID string,
) ([]computerport.Computer, error) {
	if err := repository.requireMembership(ctx, accountID, serverID); err != nil {
		return nil, err
	}
	entities, err := repository.handle.Client().Computer.Query().
		Where(
			computerentity.ServerIDEQ(serverID),
			computerentity.LifecycleStateNEQ("removed"),
		).
		Order(ent.Asc(computerentity.FieldID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	values := make([]computerport.Computer, 0, len(entities))
	for _, entity := range entities {
		values = append(values, mapComputer(entity))
	}
	return values, nil
}

// Release 将 Computer 写为 removed 墓碑，不销毁真实实例。
func (repository *EntRepository) Release(
	ctx context.Context,
	command computerport.ReleaseCommand,
) error {
	return repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		if err := requireAdmin(
			ctx, tx, command.AccountID, command.ServerID,
		); err != nil {
			return err
		}
		entity, err := tx.Computer.Query().
			Where(
				computerentity.IDEQ(command.ComputerID),
				computerentity.ServerIDEQ(command.ServerID),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			return computerport.ErrComputerNotFound
		}
		if err != nil {
			return err
		}
		if entity.LifecycleState == "removed" {
			return nil
		}
		bound, err := tx.Agent.Query().
			Where(
				agententity.ServerIDEQ(command.ServerID),
				agententity.ComputerIDEQ(command.ComputerID),
				agententity.DeletedAtIsNil(),
			).
			Exist(ctx)
		if err != nil {
			return err
		}
		if bound {
			return computerport.ErrComputerHasBoundAgents
		}
		releasedAt := command.ReleasedAt.UTC()
		if _, err := tx.ComputerRuntimeCredential.Update().
			Where(
				computerruntimecredential.ServerIDEQ(command.ServerID),
				computerruntimecredential.ComputerIDEQ(command.ComputerID),
				computerruntimecredential.StateNEQ("revoked"),
			).
			SetState("revoked").
			SetRevokedAt(releasedAt).
			Save(ctx); err != nil {
			return err
		}
		if _, err := tx.ComputerSetupCode.Delete().
			Where(
				computersetupcode.ServerIDEQ(command.ServerID),
				computersetupcode.ComputerIDEQ(command.ComputerID),
			).
			Exec(ctx); err != nil {
			return err
		}
		_, err = tx.Computer.UpdateOne(entity).
			SetLifecycleState("removed").
			SetTatAgentState("offline").
			ClearRegistrationExpiresAt().
			ClearEnrollmentTokenHash().
			ClearEnrollmentExpiresAt().
			AddRevision(1).
			SetUpdatedAt(releasedAt).
			Save(ctx)
		return err
	})
}

// Get 返回 membership 授权后的单个未移除 Computer。
func (repository *EntRepository) Get(
	ctx context.Context,
	accountID string,
	serverID string,
	computerID string,
) (computerport.Computer, error) {
	if err := repository.requireMembership(ctx, accountID, serverID); err != nil {
		return computerport.Computer{}, err
	}
	entity, err := repository.handle.Client().Computer.Query().
		Where(
			computerentity.IDEQ(computerID),
			computerentity.ServerIDEQ(serverID),
			computerentity.LifecycleStateNEQ("removed"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return computerport.Computer{}, computerport.ErrComputerNotFound
	}
	if err != nil {
		return computerport.Computer{}, err
	}
	return mapComputer(entity), nil
}

// GetForAdmin 只允许 active Owner/Admin 读取用于高权限终端签发的 Computer。
func (repository *EntRepository) GetForAdmin(
	ctx context.Context,
	accountID string,
	serverID string,
	computerID string,
) (computerport.Computer, error) {
	authorized, err := repository.handle.Client().AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
			accountservermembership.RoleIn("owner", "admin"),
		).
		Exist(ctx)
	if err != nil {
		return computerport.Computer{}, err
	}
	if !authorized {
		return computerport.Computer{}, computerport.ErrAdminRequired
	}
	entity, err := repository.handle.Client().Computer.Query().
		Where(
			computerentity.IDEQ(computerID),
			computerentity.ServerIDEQ(serverID),
			computerentity.LifecycleStateNEQ("removed"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return computerport.Computer{}, computerport.ErrComputerNotFound
	}
	if err != nil {
		return computerport.Computer{}, err
	}
	return mapComputer(entity), nil
}

// BeginEnrollment 以 Computer revision 和 generation 为门禁，原子固化一次安装批次。
// 数据库只保存完整 enrollment token 的摘要，绝不保存可重放的 token 明文。
func (repository *EntRepository) BeginEnrollment(
	ctx context.Context,
	command computerport.BeginEnrollmentCommand,
) (result computerport.Computer, returnErr error) {
	if !validBeginEnrollmentCommand(command) {
		return computerport.Computer{}, computerport.ErrEnrollmentRevisionConflict
	}
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		if err := requireAdmin(
			ctx, tx, command.AccountID, command.ServerID,
		); err != nil {
			return err
		}
		machine, err := tx.Computer.Query().
			Where(
				computerentity.IDEQ(command.ComputerID),
				computerentity.ServerIDEQ(command.ServerID),
				computerentity.LifecycleStateEQ("provisioning"),
				computerentity.TatInstanceKindEQ("managed"),
				computerentity.TatInstanceIDIsNil(),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			return computerport.ErrComputerNotFound
		}
		if err != nil {
			return err
		}
		if machine.EnrollmentClaimedAt != nil {
			return computerport.ErrComputerAlreadyClaimed
		}
		if machine.Revision != command.ExpectedRevision ||
			machine.EnrollmentGeneration < 0 ||
			uint64(machine.EnrollmentGeneration) != command.ExpectedGeneration {
			return computerport.ErrEnrollmentRevisionConflict
		}
		credentialExists, err := tx.ComputerRuntimeCredential.Query().
			Where(
				computerruntimecredential.ServerIDEQ(command.ServerID),
				computerruntimecredential.ComputerIDEQ(command.ComputerID),
				computerruntimecredential.RevokedAtIsNil(),
				computerruntimecredential.StateIn("active", "grace"),
			).
			Exist(ctx)
		if err != nil {
			return err
		}
		if credentialExists {
			return computerport.ErrComputerAlreadyClaimed
		}
		updated, err := tx.Computer.Update().
			Where(
				computerentity.IDEQ(command.ComputerID),
				computerentity.ServerIDEQ(command.ServerID),
				computerentity.RevisionEQ(command.ExpectedRevision),
				computerentity.EnrollmentGenerationEQ(int64(command.ExpectedGeneration)),
				computerentity.EnrollmentClaimedAtIsNil(),
			).
			SetEnrollmentGeneration(int64(command.Generation)).
			SetEnrollmentTokenHash(command.TokenHash[:]).
			SetEnrollmentExpiresAt(command.ExpiresAt.UTC()).
			ClearEnrollmentClaimedAt().
			ClearEnrollmentCredentialVersion().
			SetEnrollmentReleaseVersion(command.Release.Version).
			SetEnrollmentTarget(command.Release.Target).
			SetEnrollmentArchitecture(command.Release.Architecture).
			SetEnrollmentManifestObject(command.Release.Manifest.ObjectKey).
			SetEnrollmentManifestSha256(command.Release.Manifest.SHA256[:]).
			SetEnrollmentSignatureObject(command.Release.Signature.ObjectKey).
			SetEnrollmentSignatureSha256(command.Release.Signature.SHA256[:]).
			SetEnrollmentInstallerObject(command.Release.Installer.ObjectKey).
			SetEnrollmentInstallerSha256(command.Release.Installer.SHA256[:]).
			SetEnrollmentSigningKeyID(command.Release.SigningKeyID).
			SetEnrollmentProgramObject(command.Release.Program.ObjectKey).
			SetEnrollmentProgramSha256(command.Release.Program.SHA256[:]).
			SetEnrollmentProgramSize(command.Release.Program.Size).
			SetRevision(command.ExpectedRevision + 1).
			SetUpdatedAt(command.CreatedAt.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		if updated != 1 {
			return computerport.ErrEnrollmentRevisionConflict
		}
		machine, err = tx.Computer.Query().
			Where(
				computerentity.IDEQ(command.ComputerID),
				computerentity.ServerIDEQ(command.ServerID),
			).
			Only(ctx)
		if err != nil {
			return err
		}
		result = mapComputer(machine)
		return nil
	})
	return result, returnErr
}

// StoreSetupCode 写入独立 code_hash 分片；短码明文不会越过应用层。
func (repository *EntRepository) StoreSetupCode(
	ctx context.Context,
	command computerport.StoreSetupCodeCommand,
) error {
	if command.ID == "" || len(command.CodeHash) != 64 ||
		command.ServerID == "" || command.ComputerID == "" ||
		command.Generation == 0 || command.Generation > math.MaxInt64 ||
		!command.ExpiresAt.After(command.CreatedAt) {
		return computerport.ErrSetupCodeInvalid
	}
	_, err := repository.handle.Client().ComputerSetupCode.Create().
		SetID(command.ID).
		SetCodeHash(command.CodeHash).
		SetServerID(command.ServerID).
		SetComputerID(command.ComputerID).
		SetGeneration(int64(command.Generation)).
		SetExpiresAt(command.ExpiresAt.UTC()).
		SetCreatedAt(command.CreatedAt.UTC()).
		Save(ctx)
	if ent.IsConstraintError(err) {
		return computerport.ErrSetupCodeInvalid
	}
	return err
}

// ResolveSetupCode 使用不可逆摘要取得稳定路由，不访问 server_id 分片。
func (repository *EntRepository) ResolveSetupCode(
	ctx context.Context,
	command computerport.ResolveSetupCodeCommand,
) (computerport.SetupCodeRoute, error) {
	if len(command.CodeHash) != 64 || command.RequestedAt.IsZero() {
		return computerport.SetupCodeRoute{}, computerport.ErrSetupCodeInvalid
	}
	stored, err := repository.handle.Client().ComputerSetupCode.Query().
		Where(
			computersetupcode.CodeHashEQ(command.CodeHash),
			computersetupcode.ExpiresAtGT(command.RequestedAt.UTC()),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return computerport.SetupCodeRoute{}, computerport.ErrSetupCodeInvalid
	}
	if err != nil {
		return computerport.SetupCodeRoute{}, err
	}
	if stored.Generation < 1 {
		return computerport.SetupCodeRoute{}, computerport.ErrSetupCodeInvalid
	}
	return computerport.SetupCodeRoute{
		ServerID: stored.ServerID, ComputerID: stored.ComputerID,
		Generation: uint64(stored.Generation), ExpiresAt: stored.ExpiresAt.UTC(),
	}, nil
}

// ValidateSetupCode 在 server_id 分片内验证当前、未 claim 的 enrollment。
func (repository *EntRepository) ValidateSetupCode(
	ctx context.Context,
	command computerport.ValidateSetupCodeCommand,
) (computerport.SetupCodeRedemption, error) {
	if command.ServerID == "" || command.ComputerID == "" ||
		command.Generation == 0 || command.Generation > math.MaxInt64 ||
		command.TokenHash == [32]byte{} || command.RequestedAt.IsZero() {
		return computerport.SetupCodeRedemption{}, computerport.ErrSetupCodeInvalid
	}
	machine, err := repository.handle.Client().Computer.Query().
		Where(
			computerentity.ServerIDEQ(command.ServerID),
			computerentity.IDEQ(command.ComputerID),
			computerentity.EnrollmentGenerationEQ(int64(command.Generation)),
			computerentity.LifecycleStateEQ("provisioning"),
			computerentity.EnrollmentClaimedAtIsNil(),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return computerport.SetupCodeRedemption{}, computerport.ErrSetupCodeInvalid
	}
	if err != nil {
		return computerport.SetupCodeRedemption{}, err
	}
	if machine.TatAgentState == "online" || machine.EnrollmentTokenHash == nil ||
		len(*machine.EnrollmentTokenHash) != sha256.Size ||
		subtle.ConstantTimeCompare(*machine.EnrollmentTokenHash, command.TokenHash[:]) != 1 ||
		machine.EnrollmentExpiresAt == nil ||
		!machine.EnrollmentExpiresAt.After(command.RequestedAt.UTC()) ||
		machine.EnrollmentReleaseVersion == nil || machine.EnrollmentTarget == nil ||
		machine.EnrollmentInstallerSha256 == nil ||
		len(*machine.EnrollmentInstallerSha256) != sha256.Size {
		return computerport.SetupCodeRedemption{}, computerport.ErrSetupCodeInvalid
	}
	var installerSHA256 [32]byte
	copy(installerSHA256[:], *machine.EnrollmentInstallerSha256)
	return computerport.SetupCodeRedemption{
		ServerID: machine.ServerID, ComputerID: machine.ID,
		Generation: uint64(machine.EnrollmentGeneration),
		ExpiresAt:  machine.EnrollmentExpiresAt.UTC(),
		Release: computerport.SetupCodeRelease{
			Version: *machine.EnrollmentReleaseVersion, Target: *machine.EnrollmentTarget,
			InstallerSHA256: installerSHA256,
		},
	}, nil
}

// ClaimEnrollment 使用客户端生成的 credential 摘要完成一次性认领。
// 首次 claim 原子写入 Computer fencing 状态和 credential；在 TAT 尚未 online 前，
// 相同摘要可在 token 到期后恢复同一 credential 路由，但不同摘要永远冲突。
func (repository *EntRepository) ClaimEnrollment(
	ctx context.Context,
	command computerport.ClaimEnrollmentCommand,
) (result computerport.EnrollmentClaim, returnErr error) {
	if !validClaimEnrollmentCommand(command) {
		return computerport.EnrollmentClaim{}, computerport.ErrEnrollmentInvalid
	}
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		machine, err := loadEnrollmentComputer(
			ctx, tx, command.ServerID, command.ComputerID, command.Generation,
		)
		if err != nil {
			return err
		}
		if err := validateEnrollmentClaim(machine, command); err != nil {
			return err
		}
		if machine.EnrollmentClaimedAt != nil {
			result, err = replayEnrollmentClaim(ctx, tx, machine, command)
			return err
		}
		if machine.EnrollmentExpiresAt == nil ||
			!machine.EnrollmentExpiresAt.After(command.ClaimedAt.UTC()) {
			return computerport.ErrEnrollmentExpired
		}
		latest, err := tx.ComputerRuntimeCredential.Query().
			Where(
				computerruntimecredential.ServerIDEQ(command.ServerID),
				computerruntimecredential.ComputerIDEQ(command.ComputerID),
			).
			Order(ent.Desc(computerruntimecredential.FieldVersion)).
			First(ctx)
		version := int64(1)
		if err == nil {
			if latest.Version == math.MaxInt64 {
				return computerport.ErrEnrollmentInvalid
			}
			version = latest.Version + 1
		} else if !ent.IsNotFound(err) {
			return err
		}
		updated, err := tx.Computer.Update().
			Where(
				computerentity.IDEQ(command.ComputerID),
				computerentity.ServerIDEQ(command.ServerID),
				computerentity.EnrollmentGenerationEQ(int64(command.Generation)),
				computerentity.EnrollmentClaimedAtIsNil(),
			).
			SetEnrollmentClaimedAt(command.ClaimedAt.UTC()).
			SetEnrollmentCredentialVersion(version).
			SetRevision(machine.Revision + 1).
			SetUpdatedAt(command.ClaimedAt.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		if updated != 1 {
			return errEnrollmentClaimRace
		}
		credential, err := tx.ComputerRuntimeCredential.Create().
			SetID(command.CredentialID).
			SetServerID(command.ServerID).
			SetComputerID(command.ComputerID).
			SetVersion(version).
			SetSecretHash(command.CredentialDigest[:]).
			SetState("active").
			SetExpiresAt(command.CredentialExpiresAt.UTC()).
			SetCreatedAt(command.ClaimedAt.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		result = computerport.EnrollmentClaim{
			ServerID: command.ServerID, ComputerID: command.ComputerID,
			CredentialID: credential.ID, CredentialVersion: uint64(version),
			ExpiresAt: credential.ExpiresAt, Created: true,
		}
		return nil
	})
	if errors.Is(returnErr, errEnrollmentClaimRace) {
		return repository.recoverEnrollmentClaim(ctx, command)
	}
	return result, returnErr
}

// ResolveEnrollmentArtifact 只按 token 自带 server 分片和 generation 读取固化对象。
func (repository *EntRepository) ResolveEnrollmentArtifact(
	ctx context.Context,
	command computerport.ResolveArtifactCommand,
) (computerport.ArtifactAccess, error) {
	if command.ServerID == "" || command.ComputerID == "" ||
		command.Generation == 0 || command.Generation > math.MaxInt64 ||
		command.TokenHash == [32]byte{} || command.Version == "" ||
		command.Target == "" || command.File == "" || command.RequestedAt.IsZero() {
		return computerport.ArtifactAccess{}, computerport.ErrEnrollmentInvalid
	}
	machine, err := repository.handle.Client().Computer.Query().
		Where(
			computerentity.IDEQ(command.ComputerID),
			computerentity.ServerIDEQ(command.ServerID),
			computerentity.EnrollmentGenerationEQ(int64(command.Generation)),
			computerentity.LifecycleStateNEQ("removed"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return computerport.ArtifactAccess{}, computerport.ErrEnrollmentInvalid
	}
	if err != nil {
		return computerport.ArtifactAccess{}, err
	}
	if machine.EnrollmentTokenHash == nil ||
		len(*machine.EnrollmentTokenHash) != sha256.Size ||
		subtle.ConstantTimeCompare(*machine.EnrollmentTokenHash, command.TokenHash[:]) != 1 ||
		machine.EnrollmentReleaseVersion == nil ||
		*machine.EnrollmentReleaseVersion != command.Version ||
		machine.EnrollmentTarget == nil || *machine.EnrollmentTarget != command.Target ||
		machine.EnrollmentClaimedAt != nil || machine.TatAgentState == "online" {
		return computerport.ArtifactAccess{}, computerport.ErrEnrollmentInvalid
	}
	if machine.EnrollmentExpiresAt == nil ||
		!machine.EnrollmentExpiresAt.After(command.RequestedAt.UTC()) {
		return computerport.ArtifactAccess{}, computerport.ErrEnrollmentExpired
	}
	objectKey, digest, size, ok := storedEnrollmentArtifact(machine, command.File)
	if !ok {
		return computerport.ArtifactAccess{}, computerport.ErrEnrollmentInvalid
	}
	return computerport.ArtifactAccess{
		ObjectKey: objectKey, SHA256: digest, Size: size,
		ExpiresAt: machine.EnrollmentExpiresAt.UTC(),
	}, nil
}

func storedEnrollmentArtifact(
	machine *ent.Computer,
	file string,
) (string, [32]byte, int64, bool) {
	var objectKey *string
	var digest *[]byte
	var size int64
	switch file {
	case "manifest.json":
		objectKey, digest = machine.EnrollmentManifestObject, machine.EnrollmentManifestSha256
	case "manifest.sig":
		objectKey, digest = machine.EnrollmentSignatureObject, machine.EnrollmentSignatureSha256
	case "install.sh":
		objectKey, digest = machine.EnrollmentInstallerObject, machine.EnrollmentInstallerSha256
	case "vela-computer":
		objectKey, digest = machine.EnrollmentProgramObject, machine.EnrollmentProgramSha256
		if machine.EnrollmentProgramSize == nil || *machine.EnrollmentProgramSize <= 0 {
			return "", [32]byte{}, 0, false
		}
		size = *machine.EnrollmentProgramSize
	default:
		return "", [32]byte{}, 0, false
	}
	if objectKey == nil || digest == nil || len(*digest) != sha256.Size ||
		!validEnrollmentObjectKey(*objectKey) {
		return "", [32]byte{}, 0, false
	}
	var value [32]byte
	copy(value[:], *digest)
	return *objectKey, value, size, true
}

func validEnrollmentObjectKey(value string) bool {
	return value != "" && !path.IsAbs(value) && !strings.Contains(value, "..") &&
		!strings.ContainsAny(value, "\r\n\x00")
}

func (repository *EntRepository) recoverEnrollmentClaim(
	ctx context.Context,
	command computerport.ClaimEnrollmentCommand,
) (computerport.EnrollmentClaim, error) {
	machine, err := repository.handle.Client().Computer.Query().
		Where(
			computerentity.IDEQ(command.ComputerID),
			computerentity.ServerIDEQ(command.ServerID),
			computerentity.EnrollmentGenerationEQ(int64(command.Generation)),
			computerentity.LifecycleStateNEQ("removed"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return computerport.EnrollmentClaim{}, computerport.ErrEnrollmentInvalid
	}
	if err != nil {
		return computerport.EnrollmentClaim{}, err
	}
	if err := validateEnrollmentClaim(machine, command); err != nil {
		return computerport.EnrollmentClaim{}, err
	}
	if machine.EnrollmentClaimedAt == nil || machine.EnrollmentCredentialVersion == nil {
		return computerport.EnrollmentClaim{}, computerport.ErrEnrollmentClaimConflict
	}
	credential, err := repository.handle.Client().ComputerRuntimeCredential.Query().
		Where(
			computerruntimecredential.ServerIDEQ(command.ServerID),
			computerruntimecredential.ComputerIDEQ(command.ComputerID),
			computerruntimecredential.VersionEQ(*machine.EnrollmentCredentialVersion),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return computerport.EnrollmentClaim{}, computerport.ErrEnrollmentClaimConflict
	}
	if err != nil {
		return computerport.EnrollmentClaim{}, err
	}
	return enrollmentClaimFromCredential(machine, credential, command)
}

func loadEnrollmentComputer(
	ctx context.Context,
	tx *ent.Tx,
	serverID string,
	computerID string,
	generation uint64,
) (*ent.Computer, error) {
	machine, err := tx.Computer.Query().
		Where(
			computerentity.IDEQ(computerID),
			computerentity.ServerIDEQ(serverID),
			computerentity.EnrollmentGenerationEQ(int64(generation)),
			computerentity.LifecycleStateNEQ("removed"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return nil, computerport.ErrEnrollmentInvalid
	}
	return machine, err
}

func validateEnrollmentClaim(
	machine *ent.Computer,
	command computerport.ClaimEnrollmentCommand,
) error {
	if machine.TatAgentState == "online" || machine.EnrollmentTokenHash == nil ||
		len(*machine.EnrollmentTokenHash) != sha256.Size ||
		subtle.ConstantTimeCompare(*machine.EnrollmentTokenHash, command.TokenHash[:]) != 1 ||
		machine.OsType != command.OSType || machine.EnrollmentArchitecture == nil ||
		*machine.EnrollmentArchitecture != command.Architecture ||
		machine.EnrollmentReleaseVersion == nil ||
		*machine.EnrollmentReleaseVersion != command.InstallerVersion {
		return computerport.ErrEnrollmentInvalid
	}
	return nil
}

func replayEnrollmentClaim(
	ctx context.Context,
	tx *ent.Tx,
	machine *ent.Computer,
	command computerport.ClaimEnrollmentCommand,
) (computerport.EnrollmentClaim, error) {
	if machine.EnrollmentCredentialVersion == nil ||
		*machine.EnrollmentCredentialVersion < 1 {
		return computerport.EnrollmentClaim{}, computerport.ErrEnrollmentClaimConflict
	}
	credential, err := tx.ComputerRuntimeCredential.Query().
		Where(
			computerruntimecredential.ServerIDEQ(command.ServerID),
			computerruntimecredential.ComputerIDEQ(command.ComputerID),
			computerruntimecredential.VersionEQ(*machine.EnrollmentCredentialVersion),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return computerport.EnrollmentClaim{}, computerport.ErrEnrollmentClaimConflict
	}
	if err != nil {
		return computerport.EnrollmentClaim{}, err
	}
	return enrollmentClaimFromCredential(machine, credential, command)
}

func enrollmentClaimFromCredential(
	machine *ent.Computer,
	credential *ent.ComputerRuntimeCredential,
	command computerport.ClaimEnrollmentCommand,
) (computerport.EnrollmentClaim, error) {
	if len(credential.SecretHash) != sha256.Size ||
		subtle.ConstantTimeCompare(credential.SecretHash, command.CredentialDigest[:]) != 1 {
		return computerport.EnrollmentClaim{}, computerport.ErrEnrollmentClaimConflict
	}
	return computerport.EnrollmentClaim{
		ServerID: machine.ServerID, ComputerID: machine.ID,
		CredentialID: credential.ID, CredentialVersion: uint64(credential.Version),
		ExpiresAt: credential.ExpiresAt, Created: false,
	}, nil
}

func validBeginEnrollmentCommand(command computerport.BeginEnrollmentCommand) bool {
	return command.ExpectedRevision > 0 && command.ExpectedRevision < math.MaxInt64 &&
		command.ExpectedGeneration < math.MaxInt64 && command.Generation < math.MaxInt64 &&
		command.Generation == command.ExpectedGeneration+1 &&
		command.TokenHash != [32]byte{} && command.ExpiresAt.After(command.CreatedAt) &&
		validEnrollmentRelease(command.Release)
}

func validClaimEnrollmentCommand(command computerport.ClaimEnrollmentCommand) bool {
	return command.ServerID != "" && command.ComputerID != "" &&
		command.Generation > 0 && command.Generation <= math.MaxInt64 &&
		command.TokenHash != [32]byte{} && command.CredentialDigest != [32]byte{} &&
		command.OSType != "" && command.Architecture != "" &&
		command.InstallerVersion != "" && command.CredentialID != "" &&
		command.CredentialExpiresAt.After(command.ClaimedAt)
}

func validEnrollmentRelease(release computerport.ReleaseBinding) bool {
	if release.Version == "" || release.Target == "" || release.OSType == "" ||
		release.Architecture == "" || release.SigningKeyID == "" {
		return false
	}
	for _, artifact := range []computerport.ArtifactBinding{
		release.Manifest, release.Signature, release.Installer, release.Program,
	} {
		if artifact.ObjectKey == "" || path.IsAbs(artifact.ObjectKey) ||
			strings.Contains(artifact.ObjectKey, "..") ||
			strings.ContainsAny(artifact.ObjectKey, "\r\n\x00") ||
			artifact.SHA256 == [32]byte{} || artifact.Size <= 0 {
			return false
		}
	}
	return true
}

// IssueCredential creates a new version while keeping replayable plaintext out
// of the database. The idempotency record stores only credential ID/version;
// application code re-derives the handoff secret from the credential ID.
func (repository *EntRepository) IssueCredential(
	ctx context.Context,
	command computerport.CredentialCommand,
) (result computerport.Credential, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		authorized, err := tx.AccountServerMembership.Query().
			Where(
				accountservermembership.AccountIDEQ(command.AccountID),
				accountservermembership.ServerIDEQ(command.ServerID),
				accountservermembership.StatusEQ("active"),
				accountservermembership.RoleIn("owner", "admin"),
			).
			Exist(ctx)
		if err != nil {
			return err
		}
		if !authorized {
			return computerport.ErrAdminRequired
		}
		machine, err := tx.Computer.Query().
			Where(
				computerentity.IDEQ(command.ComputerID),
				computerentity.ServerIDEQ(command.ServerID),
				computerentity.LifecycleStateEQ("active"),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			return computerport.ErrComputerNotFound
		}
		if err != nil {
			return err
		}
		const scope = "computer.runtime-credential.issue"
		stored, err := tx.IdempotencyRecord.Query().
			Where(
				idempotencyrecord.PartitionKeyEQ(command.ServerID),
				idempotencyrecord.ScopeTypeEQ(scope),
				idempotencyrecord.ScopeIDEQ(command.ComputerID),
				idempotencyrecord.IdempotencyKeyEQ(command.IdempotencyKey),
			).
			Only(ctx)
		if err == nil {
			if subtle.ConstantTimeCompare(stored.RequestHash, command.RequestHash[:]) != 1 ||
				!stored.ExpiresAt.After(command.CreatedAt.UTC()) {
				return computerport.ErrIdempotencyConflict
			}
			var locator struct {
				CredentialID string `json:"credentialId"`
				Version      uint64 `json:"version"`
			}
			if _, err := persistedjson.DecodeScoped(stored.ResponseBodyJSON, scope, &locator); err != nil ||
				locator.CredentialID == "" || locator.Version == 0 {
				return errors.New("Computer credential 幂等记录无效")
			}
			credential, err := tx.ComputerRuntimeCredential.Query().
				Where(
					computerruntimecredential.ServerIDEQ(command.ServerID),
					computerruntimecredential.ComputerIDEQ(command.ComputerID),
					computerruntimecredential.IDEQ(locator.CredentialID),
					computerruntimecredential.VersionEQ(int64(locator.Version)),
				).
				Only(ctx)
			if err != nil {
				return err
			}
			result = computerport.Credential{
				ID: credential.ID, ServerID: credential.ServerID,
				ComputerID: credential.ComputerID,
				Version:    uint64(credential.Version), ExpiresAt: credential.ExpiresAt,
				GraceExpiresAt: credential.GraceExpiresAt, Created: false,
			}
			return nil
		}
		if !ent.IsNotFound(err) {
			return err
		}
		current, err := tx.ComputerRuntimeCredential.Query().
			Where(
				computerruntimecredential.ServerIDEQ(command.ServerID),
				computerruntimecredential.ComputerIDEQ(command.ComputerID),
				computerruntimecredential.RevokedAtIsNil(),
				computerruntimecredential.Or(
					computerruntimecredential.And(
						computerruntimecredential.StateEQ("active"),
						computerruntimecredential.ExpiresAtGT(command.CreatedAt.UTC()),
					),
					computerruntimecredential.And(
						computerruntimecredential.StateEQ("grace"),
						computerruntimecredential.GraceExpiresAtGT(command.CreatedAt.UTC()),
					),
				),
			).
			All(ctx)
		if err != nil {
			return err
		}
		if command.Mode == "bootstrap" && len(current) > 0 {
			return computerport.ErrCredentialExists
		}
		if command.Mode != "bootstrap" && command.Mode != "recover" {
			return computerport.ErrIdempotencyConflict
		}
		if command.Mode == "recover" && len(current) > 0 {
			if _, err := tx.ComputerRuntimeCredential.Update().
				Where(
					computerruntimecredential.ServerIDEQ(command.ServerID),
					computerruntimecredential.ComputerIDEQ(command.ComputerID),
					computerruntimecredential.RevokedAtIsNil(),
					computerruntimecredential.StateIn("active", "grace"),
				).
				SetState("revoked").
				SetRevokedAt(command.CreatedAt.UTC()).
				Save(ctx); err != nil {
				return err
			}
		}
		latest, err := tx.ComputerRuntimeCredential.Query().
			Where(
				computerruntimecredential.ServerIDEQ(command.ServerID),
				computerruntimecredential.ComputerIDEQ(command.ComputerID),
			).
			Order(ent.Desc(computerruntimecredential.FieldVersion)).
			First(ctx)
		version := int64(1)
		if err == nil {
			version = latest.Version + 1
		} else if !ent.IsNotFound(err) {
			return err
		}
		credential, err := tx.ComputerRuntimeCredential.Create().
			SetID(command.CredentialID).
			SetServerID(machine.ServerID).
			SetComputerID(machine.ID).
			SetVersion(version).
			SetSecretHash(command.SecretHash[:]).
			SetState("active").
			SetExpiresAt(command.ExpiresAt.UTC()).
			SetCreatedAt(command.CreatedAt.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		response, err := persistedjson.EncodeScoped(scope, struct {
			CredentialID string `json:"credentialId"`
			Version      int64  `json:"version"`
		}{CredentialID: credential.ID, Version: credential.Version})
		if err != nil {
			return err
		}
		if _, err := tx.IdempotencyRecord.Create().
			SetPartitionKey(command.ServerID).
			SetScopeType(scope).
			SetScopeID(command.ComputerID).
			SetIdempotencyKey(command.IdempotencyKey).
			SetRequestHash(command.RequestHash[:]).
			SetResponseStatus(201).
			SetResponseBodyJSON(response).
			SetExpiresAt(command.HandoffExpiresAt.UTC()).
			SetCreatedAt(command.CreatedAt.UTC()).
			Save(ctx); err != nil {
			return err
		}
		result = computerport.Credential{
			ID: credential.ID, ServerID: credential.ServerID,
			ComputerID: credential.ComputerID, Version: uint64(credential.Version),
			ExpiresAt: credential.ExpiresAt, Created: true,
		}
		return nil
	})
	return result, returnErr
}

// RotateCredential atomically moves the authenticated active version into a
// fixed reconnect grace and creates the next active version. Only an exact
// idempotent replay may succeed after the supplied version is no longer active.
func (repository *EntRepository) RotateCredential(
	ctx context.Context,
	command computerport.CredentialRotationCommand,
) (result computerport.Credential, returnErr error) {
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		const scope = "computer.runtime-credential.rotate"
		stored, err := tx.IdempotencyRecord.Query().
			Where(
				idempotencyrecord.PartitionKeyEQ(command.ServerID),
				idempotencyrecord.ScopeTypeEQ(scope),
				idempotencyrecord.ScopeIDEQ(command.ComputerID),
				idempotencyrecord.IdempotencyKeyEQ(command.IdempotencyKey),
			).
			Only(ctx)
		if err == nil {
			if subtle.ConstantTimeCompare(stored.RequestHash, command.RequestHash[:]) != 1 ||
				!stored.ExpiresAt.After(command.CreatedAt.UTC()) {
				return computerport.ErrIdempotencyConflict
			}
			var locator struct {
				CredentialID   string    `json:"credentialId"`
				Version        uint64    `json:"version"`
				GraceExpiresAt time.Time `json:"graceExpiresAt"`
			}
			if _, err := persistedjson.DecodeScoped(stored.ResponseBodyJSON, scope, &locator); err != nil ||
				locator.CredentialID == "" || locator.Version == 0 ||
				locator.GraceExpiresAt.IsZero() {
				return errors.New("Computer credential 轮换幂等记录无效")
			}
			credential, err := tx.ComputerRuntimeCredential.Query().
				Where(
					computerruntimecredential.ServerIDEQ(command.ServerID),
					computerruntimecredential.ComputerIDEQ(command.ComputerID),
					computerruntimecredential.IDEQ(locator.CredentialID),
					computerruntimecredential.VersionEQ(int64(locator.Version)),
				).
				Only(ctx)
			if err != nil {
				return err
			}
			graceExpiresAt := locator.GraceExpiresAt.UTC()
			result = computerport.Credential{
				ID: credential.ID, ServerID: credential.ServerID,
				ComputerID: credential.ComputerID,
				Version:    uint64(credential.Version), ExpiresAt: credential.ExpiresAt,
				GraceExpiresAt: &graceExpiresAt, Created: false,
			}
			return nil
		}
		if !ent.IsNotFound(err) {
			return err
		}
		if command.CurrentVersion == 0 || command.CurrentVersion > math.MaxInt64 ||
			!command.GraceExpiresAt.After(command.CreatedAt) ||
			!command.ExpiresAt.After(command.GraceExpiresAt) {
			return computerport.ErrCredentialNotCurrent
		}
		current, err := tx.ComputerRuntimeCredential.Query().
			Where(
				computerruntimecredential.ServerIDEQ(command.ServerID),
				computerruntimecredential.ComputerIDEQ(command.ComputerID),
				computerruntimecredential.VersionEQ(int64(command.CurrentVersion)),
				computerruntimecredential.StateEQ("active"),
				computerruntimecredential.RevokedAtIsNil(),
				computerruntimecredential.ExpiresAtGT(command.CreatedAt.UTC()),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			return computerport.ErrCredentialNotCurrent
		}
		if err != nil {
			return err
		}
		machineExists, err := tx.Computer.Query().
			Where(
				computerentity.ServerIDEQ(command.ServerID),
				computerentity.IDEQ(command.ComputerID),
				computerentity.LifecycleStateEQ("active"),
			).
			Exist(ctx)
		if err != nil {
			return err
		}
		if !machineExists {
			return computerport.ErrCredentialNotCurrent
		}
		if _, err := tx.ComputerRuntimeCredential.Update().
			Where(
				computerruntimecredential.ServerIDEQ(command.ServerID),
				computerruntimecredential.ComputerIDEQ(command.ComputerID),
				computerruntimecredential.StateEQ("grace"),
				computerruntimecredential.RevokedAtIsNil(),
			).
			SetState("revoked").
			SetRevokedAt(command.CreatedAt.UTC()).
			Save(ctx); err != nil {
			return err
		}
		if _, err := tx.ComputerRuntimeCredential.UpdateOne(current).
			SetState("grace").
			SetGraceExpiresAt(command.GraceExpiresAt.UTC()).
			Save(ctx); err != nil {
			return err
		}
		nextVersion := current.Version + 1
		if nextVersion <= current.Version {
			return errors.New("Computer credential 版本耗尽")
		}
		credential, err := tx.ComputerRuntimeCredential.Create().
			SetID(command.CredentialID).
			SetServerID(command.ServerID).
			SetComputerID(command.ComputerID).
			SetVersion(nextVersion).
			SetSecretHash(command.SecretHash[:]).
			SetState("active").
			SetExpiresAt(command.ExpiresAt.UTC()).
			SetCreatedAt(command.CreatedAt.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		response, err := persistedjson.EncodeScoped(scope, struct {
			CredentialID   string    `json:"credentialId"`
			Version        int64     `json:"version"`
			GraceExpiresAt time.Time `json:"graceExpiresAt"`
		}{
			CredentialID: credential.ID, Version: credential.Version,
			GraceExpiresAt: command.GraceExpiresAt.UTC(),
		})
		if err != nil {
			return err
		}
		if _, err := tx.IdempotencyRecord.Create().
			SetPartitionKey(command.ServerID).
			SetScopeType(scope).
			SetScopeID(command.ComputerID).
			SetIdempotencyKey(command.IdempotencyKey).
			SetRequestHash(command.RequestHash[:]).
			SetResponseStatus(201).
			SetResponseBodyJSON(response).
			SetExpiresAt(command.HandoffExpiresAt.UTC()).
			SetCreatedAt(command.CreatedAt.UTC()).
			Save(ctx); err != nil {
			return err
		}
		graceExpiresAt := command.GraceExpiresAt.UTC()
		result = computerport.Credential{
			ID: credential.ID, ServerID: credential.ServerID,
			ComputerID: credential.ComputerID,
			Version:    uint64(credential.Version), ExpiresAt: credential.ExpiresAt,
			GraceExpiresAt: &graceExpiresAt, Created: true,
		}
		return nil
	})
	return result, returnErr
}

// EnqueueRefresh 创建 computer 资源类型的可靠 TAT 查询操作。
func (repository *EntRepository) EnqueueRefresh(
	ctx context.Context,
	command computerport.RefreshCommand,
) (result computerport.Operation, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			if err := requireMembership(
				ctx, tx, command.AccountID, command.ServerID,
			); err != nil {
				return err
			}
			entity, err := tx.Computer.Query().
				Where(
					computerentity.IDEQ(command.ComputerID),
					computerentity.ServerIDEQ(command.ServerID),
					computerentity.LifecycleStateNEQ("removed"),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return computerport.ErrComputerNotFound
			}
			if err != nil {
				return err
			}
			requestHash := refreshHash(command.ComputerID, command.ComputerRevision)
			stored, err := tx.IdempotencyRecord.Query().
				Where(
					idempotencyrecord.PartitionKeyEQ(command.ServerID),
					idempotencyrecord.ScopeTypeEQ("computer.refresh"),
					idempotencyrecord.ScopeIDEQ(command.ComputerID),
					idempotencyrecord.IdempotencyKeyEQ(command.IdempotencyKey),
				).
				Only(ctx)
			if err == nil {
				if subtle.ConstantTimeCompare(
					stored.RequestHash, requestHash[:],
				) != 1 {
					return computerport.ErrIdempotencyConflict
				}
				operationID, err := decodeID(
					stored.ResponseBodyJSON, "computer.refresh", "operationId",
				)
				if err != nil {
					return err
				}
				operation, err := tx.TencentOperation.Query().
					Where(
						tencentoperation.IDEQ(operationID),
						tencentoperation.PartitionKeyEQ(command.ServerID),
					).
					Only(ctx)
				if err != nil {
					return err
				}
				result = mapOperation(operation)
				return nil
			}
			if !ent.IsNotFound(err) {
				return err
			}
			now := command.CreatedAt.UTC()
			operation, err := tx.TencentOperation.Create().
				SetID(command.OperationID).
				SetPartitionKey(command.ServerID).
				SetServerID(command.ServerID).
				SetService("tat").
				SetKind("tat.computer.refresh").
				SetResourceType("computer").
				SetResourceID(entity.ID).
				SetIdempotencyKey(
					"tat.computer.refresh:v1:" + entity.ID + ":" +
						command.IdempotencyKey,
				).
				SetDesiredRevision(command.ComputerRevision).
				SetState("pending").
				SetAttempts(0).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx)
			if err != nil {
				return err
			}
			if _, err := tx.OutboxEvent.Create().
				SetPartitionKey(command.ServerID).
				SetServerID(command.ServerID).
				SetEventType("tencent.operation.ready").
				SetAggregateType("tencent_operation").
				SetAggregateID(operation.ID).
				SetState("pending").
				SetAttempts(0).
				SetAvailableAt(now).
				SetCreatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			response, err := encodeID("computer.refresh", "operationId", operation.ID)
			if err != nil {
				return err
			}
			if _, err := tx.IdempotencyRecord.Create().
				SetPartitionKey(command.ServerID).
				SetScopeType("computer.refresh").
				SetScopeID(command.ComputerID).
				SetIdempotencyKey(command.IdempotencyKey).
				SetRequestHash(requestHash[:]).
				SetResponseStatus(202).
				SetResponseBodyJSON(response).
				SetExpiresAt(now.Add(24 * time.Hour)).
				SetCreatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			result = mapOperation(operation)
			return nil
		},
	)
	return result, returnErr
}

// BeginRegistration 记录非敏感到期时间并创建标签对账操作。
func (repository *EntRepository) BeginRegistration(
	ctx context.Context,
	command computerport.RegistrationCommand,
) (result computerport.Operation, returnErr error) {
	returnErr = repository.handle.WithTx(
		ctx,
		func(ctx context.Context, tx *ent.Tx) error {
			if err := requireMembership(
				ctx, tx, command.AccountID, command.ServerID,
			); err != nil {
				return err
			}
			entity, err := tx.Computer.Query().
				Where(
					computerentity.IDEQ(command.ComputerID),
					computerentity.ServerIDEQ(command.ServerID),
					computerentity.LifecycleStateEQ("provisioning"),
					computerentity.TatInstanceKindEQ("managed"),
					computerentity.TatInstanceIDIsNil(),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				return computerport.ErrComputerNotFound
			}
			if err != nil {
				return err
			}
			now := command.CreatedAt.UTC()
			if entity.Revision != command.ComputerRevision {
				return computerport.ErrRegistrationActive
			}
			if entity.RegistrationExpiresAt != nil &&
				entity.RegistrationExpiresAt.After(now) {
				return computerport.ErrRegistrationActive
			}
			nextRevision := entity.Revision + 1
			updated, err := tx.Computer.Update().
				Where(
					computerentity.IDEQ(entity.ID),
					computerentity.RevisionEQ(entity.Revision),
				).
				SetRegistrationExpiresAt(command.ExpiresAt.UTC()).
				SetRevision(nextRevision).
				SetUpdatedAt(now).
				Save(ctx)
			if err != nil {
				return err
			}
			if updated != 1 {
				return computerport.ErrRegistrationActive
			}
			operation, err := tx.TencentOperation.Create().
				SetID(command.OperationID).
				SetPartitionKey(command.ServerID).
				SetServerID(command.ServerID).
				SetService("tat").
				SetKind("tat.computer.registration.reconcile").
				SetResourceType("computer").
				SetResourceID(entity.ID).
				SetIdempotencyKey(
					"tat.computer.registration.reconcile:v1:" +
						command.OperationID,
				).
				SetDesiredRevision(nextRevision).
				SetState("pending").
				SetAttempts(0).
				SetDeadlineAt(command.ExpiresAt.UTC()).
				SetCreatedAt(now).
				SetUpdatedAt(now).
				Save(ctx)
			if err != nil {
				return err
			}
			if _, err := tx.OutboxEvent.Create().
				SetPartitionKey(command.ServerID).
				SetServerID(command.ServerID).
				SetEventType("tencent.operation.ready").
				SetAggregateType("tencent_operation").
				SetAggregateID(operation.ID).
				SetState("pending").
				SetAttempts(0).
				SetAvailableAt(now).
				SetCreatedAt(now).
				Save(ctx); err != nil {
				return err
			}
			result = mapOperation(operation)
			return nil
		},
	)
	return result, returnErr
}

func (repository *EntRepository) requireMembership(
	ctx context.Context,
	accountID string,
	serverID string,
) error {
	exists, err := repository.handle.Client().AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
		).
		Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return computerport.ErrServerNotFound
	}
	return nil
}

func requireMembership(
	ctx context.Context,
	tx *ent.Tx,
	accountID string,
	serverID string,
) error {
	exists, err := tx.AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
		).
		Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return computerport.ErrServerNotFound
	}
	return nil
}

func requireAdmin(
	ctx context.Context,
	tx *ent.Tx,
	accountID string,
	serverID string,
) error {
	exists, err := tx.AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(accountID),
			accountservermembership.ServerIDEQ(serverID),
			accountservermembership.StatusEQ("active"),
			accountservermembership.RoleIn("owner", "admin"),
		).
		Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return computerport.ErrAdminRequired
	}
	return nil
}

func mapComputer(entity *ent.Computer) computerport.Computer {
	enrollmentGeneration := uint64(0)
	if entity.EnrollmentGeneration > 0 {
		enrollmentGeneration = uint64(entity.EnrollmentGeneration)
	}
	return computerport.Computer{
		ID:                    entity.ID,
		ServerID:              entity.ServerID,
		Name:                  entity.Name,
		TATRegion:             entity.TatRegion,
		TATInstanceID:         entity.TatInstanceID,
		TATInstanceKind:       entity.TatInstanceKind,
		OSType:                entity.OsType,
		LifecycleState:        entity.LifecycleState,
		TATAgentState:         entity.TatAgentState,
		RegistrationExpiresAt: entity.RegistrationExpiresAt,
		HostLastSeenAt:        entity.HostLastSeenAt,
		LastObservedAt:        entity.LastObservedAt,
		LastErrorCode:         stringValue(entity.LastErrorCode),
		Revision:              entity.Revision,
		EnrollmentGeneration:  enrollmentGeneration,
		EnrollmentClaimedAt:   entity.EnrollmentClaimedAt,
	}
}

func mapOperation(entity *ent.TencentOperation) computerport.Operation {
	return computerport.Operation{
		ID:            entity.ID,
		ServerID:      stringValue(entity.ServerID),
		Service:       entity.Service,
		Kind:          entity.Kind,
		State:         entity.State,
		CreatedAt:     entity.CreatedAt,
		CompletedAt:   entity.CompletedAt,
		LastErrorCode: stringValue(entity.LastErrorCode),
	}
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func refreshHash(computerID string, revision int64) [32]byte {
	return sha256.Sum256(
		[]byte(computerID + "\x00" + time.Unix(revision, 0).UTC().String()),
	)
}

func encodeID(scope string, key string, value string) (string, error) {
	return persistedjson.EncodeScoped(scope, map[string]string{key: value})
}

func decodeID(value string, scope string, key string) (string, error) {
	var body map[string]string
	if _, err := persistedjson.DecodeScoped(value, scope, &body); err != nil {
		return "", err
	}
	if body[key] == "" {
		return "", errors.New("Computer 幂等记录无效")
	}
	return body[key], nil
}
