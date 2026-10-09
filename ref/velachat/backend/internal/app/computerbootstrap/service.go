// Package computerbootstrap 编排 claim 后、正式 Computer 控制面启用前的 provider 注册。
package computerbootstrap

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"time"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	computerauthport "chatserver/internal/ports/computerauth"
	bootstrapport "chatserver/internal/ports/computerbootstrap"
	idport "chatserver/internal/ports/id"
	tencenttatport "chatserver/internal/ports/tencenttat"

	"github.com/google/uuid"
)

type Config struct {
	Region        string
	LeaseTTL      time.Duration
	MaterialTTL   time.Duration
	MaxAttempts   int64
	EncryptionKey []byte
	Random        io.Reader
}

type Registration struct {
	Protocol  string
	Region    string
	CodeID    string
	CodeValue string
	Tags      []Tag
	ExpiresAt time.Time
}

type Tag struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type Result struct {
	Ready             bool
	OperationID       string
	State             string
	RetryAfterSeconds int
	Registration      Registration
}

type encryptedRegistration struct {
	Protocol  string    `json:"protocol"`
	Region    string    `json:"region"`
	CodeID    string    `json:"registerCodeId"`
	CodeValue string    `json:"registerCodeValue"`
	Tags      []Tag     `json:"tags"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type Service struct {
	repository bootstrapport.Repository
	registrar  tencenttatport.Registrar
	ids        idport.Generator
	clock      clockport.Clock
	aead       cipher.AEAD
	config     Config
}

var errProviderMaterialExpired = errors.New("Computer provider 注册材料已过期")

func NewService(
	repository bootstrapport.Repository,
	registrar tencenttatport.Registrar,
	ids idport.Generator,
	clock clockport.Clock,
	config Config,
) (*Service, error) {
	if repository == nil || registrar == nil || ids == nil || clock == nil || config.Random == nil ||
		strings.TrimSpace(config.Region) == "" || config.LeaseTTL <= 0 ||
		config.MaterialTTL <= 0 || config.MaterialTTL > 2*time.Hour ||
		config.MaxAttempts < 1 || config.MaxAttempts > 10 || len(config.EncryptionKey) != 32 {
		return nil, errors.New("Computer bootstrap 服务配置无效")
	}
	block, err := aes.NewCipher(config.EncryptionKey)
	if err != nil {
		return nil, errors.New("Computer bootstrap 加密配置无效")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("Computer bootstrap 加密配置无效")
	}
	return &Service{
		repository: repository, registrar: registrar, ids: ids, clock: clock,
		aead: aead, config: config,
	}, nil
}

func (service *Service) GetOrCreate(
	ctx context.Context,
	route computerauthport.Route,
) (Result, error) {
	if service == nil || ctx == nil || !validRoute(route) {
		return Result{}, apperror.New("computer_credential_invalid", "Computer credential 无效", nil)
	}
	operationID, err := service.ids.New()
	if err != nil || !uuidV7(operationID) {
		return Result{}, apperror.New("internal_error", "暂时无法创建 Computer 接入操作", err)
	}
	now := service.clock.Now().UTC()
	operation, err := service.repository.GetOrCreate(ctx, bootstrapport.StartCommand{
		ServerID: route.ServerID, ComputerID: route.ComputerID,
		CredentialVersion: route.Version, OperationID: operationID,
		IdempotencyKey: "computer-provider-enroll:" + route.ComputerID,
		CreatedAt:      now, DeadlineAt: now.Add(service.config.MaterialTTL),
	})
	if err != nil {
		return Result{}, mapRepositoryError(err)
	}
	if !validOperation(operation, route) {
		return Result{}, apperror.New("internal_error", "Computer 接入操作数据无效", nil)
	}
	return service.resultForOperation(ctx, operation, route, now, true)
}

func (service *Service) resultForOperation(
	ctx context.Context,
	operation bootstrapport.Operation,
	route computerauthport.Route,
	now time.Time,
	allowRenew bool,
) (Result, error) {
	switch operation.State {
	case "succeeded":
		result, err := service.recover(operation)
		if err == nil {
			reconcileOperationID, idErr := service.ids.New()
			if idErr != nil || !uuidV7(reconcileOperationID) {
				return Result{}, apperror.New(
					"internal_error", "暂时无法创建 Computer 注册对账操作", idErr,
				)
			}
			if ensureErr := service.repository.EnsureReconcile(
				ctx,
				bootstrapport.EnsureReconcileCommand{
					BootstrapOperationID: operation.ID,
					ReconcileOperationID: reconcileOperationID,
					ServerID:             route.ServerID,
					ComputerID:           route.ComputerID,
					CredentialVersion:    route.Version,
					MaterialFingerprint:  sha256.Sum256([]byte(operation.EncryptedResult)),
					MaterialExpiresAt:    result.Registration.ExpiresAt,
					CreatedAt:            now,
				},
			); ensureErr != nil {
				return Result{}, mapRepositoryError(ensureErr)
			}
			return result, nil
		}
		if !errors.Is(err, errProviderMaterialExpired) {
			return Result{}, err
		}
		if !allowRenew {
			return Result{}, apperror.New(
				"provider_registration_expired", "Computer 连接材料已过期", nil,
			)
		}
		current, _, err := service.repository.RenewExpired(
			ctx,
			bootstrapport.RenewExpiredCommand{
				OperationID: operation.ID, ServerID: route.ServerID,
				ComputerID: route.ComputerID, CredentialVersion: route.Version,
				ExpectedEncryptedResult: operation.EncryptedResult,
				RenewedAt:               now, DeadlineAt: now.Add(service.config.MaterialTTL),
			},
		)
		if err != nil {
			return Result{}, mapRepositoryError(err)
		}
		if !validOperation(current, route) {
			return Result{}, apperror.New("internal_error", "Computer 接入操作数据无效", nil)
		}
		return service.resultForOperation(ctx, current, route, now, false)
	case "failed":
		return Result{}, apperror.New(
			"provider_registration_failed", "Computer 连接服务注册失败", nil,
		)
	case "pending", "running", "retry_wait":
		if operation.NextAttemptAt != nil && operation.NextAttemptAt.After(now) {
			return pending(operation.ID, "retry_wait", now, *operation.NextAttemptAt), nil
		}
		return pending(operation.ID, "pending", now, now.Add(2*time.Second)), nil
	default:
		return Result{}, apperror.New("internal_error", "Computer 接入操作状态无效", nil)
	}
}

// ProcessOne 由独立后台 Worker 调用。HTTP 只创建/读取 Operation，绝不直接执行 provider 副作用。
func (service *Service) ProcessOne(ctx context.Context) (bool, error) {
	if service == nil || ctx == nil {
		return false, errors.New("Computer bootstrap Worker 上下文无效")
	}
	now := service.clock.Now().UTC()
	leaseOwner, err := service.ids.New()
	if err != nil || !uuidV7(leaseOwner) {
		return false, errors.New("无法创建 Computer bootstrap lease 身份")
	}
	operation, found, err := service.repository.ClaimNext(ctx, bootstrapport.ClaimCommand{
		LeaseOwner: leaseOwner, Now: now, LeaseExpiresAt: now.Add(service.config.LeaseTTL),
		MaxAttempts: service.config.MaxAttempts,
	})
	if err != nil || !found {
		return false, err
	}
	if !uuidV7(operation.ID) || !uuidV7(operation.ServerID) || !uuidV7(operation.ComputerID) ||
		operation.CredentialVersion == 0 || operation.LeaseOwner != leaseOwner || operation.State != "running" {
		return true, errors.New("Computer bootstrap lease 数据无效")
	}
	registration, err := service.registrar.CreateRegistration(ctx, tencenttatport.RegistrationRequest{
		Region: service.config.Region, Description: "Agent Network Computer " + operation.ComputerID,
		NamePrefix:    "an-" + strings.ReplaceAll(operation.ComputerID, "-", "")[:12],
		RegisterLimit: 1, EffectiveTime: service.config.MaterialTTL,
	})
	if err != nil {
		next := now.Add(2 * time.Second)
		terminal := operation.Attempts >= service.config.MaxAttempts
		if retryErr := service.repository.Retry(ctx, bootstrapport.RetryCommand{
			OperationID: operation.ID, LeaseOwner: leaseOwner,
			ErrorCode: "provider_registration_unavailable", NextAttemptAt: next,
			FailedAt: now, Terminal: terminal,
		}); retryErr != nil {
			return true, retryErr
		}
		return true, nil
	}
	if strings.TrimSpace(registration.CodeID) == "" || strings.TrimSpace(registration.CodeValue) == "" ||
		!registration.ExpiresAt.After(now) || registration.ExpiresAt.After(now.Add(2*service.config.MaterialTTL)) {
		if retryErr := service.repository.Retry(ctx, bootstrapport.RetryCommand{
			OperationID: operation.ID, LeaseOwner: leaseOwner,
			ErrorCode: "provider_registration_invalid", NextAttemptAt: now.Add(2 * time.Second),
			FailedAt: now, Terminal: operation.Attempts >= service.config.MaxAttempts,
		}); retryErr != nil {
			return true, retryErr
		}
		return true, nil
	}
	payload := encryptedRegistration{
		Protocol: "tencent-tat-register-v1", Region: service.config.Region,
		CodeID: registration.CodeID, CodeValue: registration.CodeValue,
		Tags:      []Tag{{Key: "agent-network-computer-id", Value: operation.ComputerID}},
		ExpiresAt: registration.ExpiresAt.UTC(),
	}
	sealed, err := service.seal(operation, payload)
	if err != nil {
		return true, errors.New("无法保护连接服务注册材料")
	}
	if err := service.repository.Complete(ctx, bootstrapport.CompleteCommand{
		OperationID: operation.ID, LeaseOwner: leaseOwner,
		EncryptedResult: sealed, ResultExpiresAt: payload.ExpiresAt, CompletedAt: now,
	}); err != nil {
		return true, err
	}
	return true, nil
}

func (service *Service) recover(operation bootstrapport.Operation) (Result, error) {
	if operation.EncryptedResult == "" {
		return Result{}, apperror.New("internal_error", "Computer 接入结果无法恢复", nil)
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(operation.EncryptedResult)
	if err != nil || len(raw) <= service.aead.NonceSize() {
		return Result{}, apperror.New("internal_error", "Computer 接入结果无法恢复", err)
	}
	nonce := raw[:service.aead.NonceSize()]
	plain, err := service.aead.Open(nil, nonce, raw[service.aead.NonceSize():], associatedData(operation))
	if err != nil {
		return Result{}, apperror.New("internal_error", "Computer 接入结果无法恢复", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(plain)))
	decoder.DisallowUnknownFields()
	var payload encryptedRegistration
	if err := decoder.Decode(&payload); err != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		!validRecoveredRegistration(payload, operation, service.config.Region) {
		return Result{}, apperror.New("internal_error", "Computer 接入结果结构无效", err)
	}
	if !payload.ExpiresAt.After(service.clock.Now().UTC()) {
		return Result{}, errProviderMaterialExpired
	}
	return readyResult(operation.ID, payload), nil
}

func validRecoveredRegistration(
	payload encryptedRegistration,
	operation bootstrapport.Operation,
	region string,
) bool {
	return payload.Protocol == "tencent-tat-register-v1" && payload.Region == region &&
		strings.TrimSpace(payload.CodeID) != "" && strings.TrimSpace(payload.CodeValue) != "" &&
		!payload.ExpiresAt.IsZero() && len(payload.Tags) == 1 &&
		payload.Tags[0].Key == "agent-network-computer-id" &&
		payload.Tags[0].Value == operation.ComputerID
}

func (service *Service) seal(operation bootstrapport.Operation, payload encryptedRegistration) (string, error) {
	plain, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, service.aead.NonceSize())
	if _, err := io.ReadFull(service.config.Random, nonce); err != nil {
		return "", err
	}
	sealed := service.aead.Seal(nil, nonce, plain, associatedData(operation))
	return base64.RawURLEncoding.EncodeToString(append(nonce, sealed...)), nil
}

func associatedData(operation bootstrapport.Operation) []byte {
	return []byte(operation.ID + "\x00" + operation.ServerID + "\x00" + operation.ComputerID + "\x00" +
		strconv.FormatUint(operation.CredentialVersion, 10))
}

func readyResult(operationID string, payload encryptedRegistration) Result {
	return Result{Ready: true, OperationID: operationID, State: "ready", Registration: Registration{
		Protocol: payload.Protocol, Region: payload.Region, CodeID: payload.CodeID,
		CodeValue: payload.CodeValue, Tags: append([]Tag(nil), payload.Tags...),
		ExpiresAt: payload.ExpiresAt,
	}}
}

func pending(operationID, state string, now, next time.Time) Result {
	seconds := int(next.Sub(now).Round(time.Second) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	if seconds > 30 {
		seconds = 30
	}
	return Result{OperationID: operationID, State: state, RetryAfterSeconds: seconds}
}

func validRoute(route computerauthport.Route) bool {
	return uuidV7(route.ServerID) && uuidV7(route.ComputerID) && route.Version > 0
}

func uuidV7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func validOperation(operation bootstrapport.Operation, route computerauthport.Route) bool {
	return uuidV7(operation.ID) && operation.ServerID == route.ServerID &&
		operation.ComputerID == route.ComputerID && operation.CredentialVersion == route.Version
}

func mapRepositoryError(err error) error {
	if errors.Is(err, bootstrapport.ErrNotEligible) {
		return apperror.New("computer_bootstrap_not_allowed", "Computer 当前不能继续连接", err)
	}
	if errors.Is(err, bootstrapport.ErrLeaseLost) {
		return apperror.New("provider_registration_pending", "Computer 连接服务正在处理中", err)
	}
	return apperror.New("internal_error", "暂时无法处理 Computer 接入", err)
}
