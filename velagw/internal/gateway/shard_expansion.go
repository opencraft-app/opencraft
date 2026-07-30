package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	ShardExpansionStatusRequested              = "requested"
	ShardExpansionStatusWaitingInfrastructure  = "waiting_infrastructure"
	ShardExpansionStatusInfrastructureReady    = "infrastructure_ready"
	ShardExpansionStatusWaitingFleetProjection = "waiting_fleet_projection"
	ShardExpansionStatusVerifying              = "verifying"
	ShardExpansionStatusReady                  = "ready"
	ShardExpansionStatusError                  = "error"
	ShardExpansionStatusCancelled              = "cancelled"
)

var ErrShardExpansionIdempotencyConflict = errors.New("shard expansion idempotency key conflicts with a different request")
var ErrShardExpansionAlreadyActive = errors.New("another shard expansion workflow is already active for this shard")

type ShardExpansion struct {
	ID                           string    `json:"id"`
	IdempotencyKey               string    `json:"idempotency_key"`
	RequestHash                  string    `json:"-"`
	ShardID                      string    `json:"shard_id"`
	Name                         string    `json:"name"`
	Status                       string    `json:"status"`
	RetryStatus                  string    `json:"retry_status,omitempty"`
	FailedStep                   string    `json:"failed_step,omitempty"`
	LastError                    string    `json:"last_error,omitempty"`
	MaxSets                      int       `json:"max_sets"`
	RedisDBStart                 int       `json:"redis_db_start"`
	RedisDBLimit                 int       `json:"redis_db_limit"`
	MaxConnections               int       `json:"max_connections,omitempty"`
	ReservedConnections          int       `json:"reserved_connections,omitempty"`
	AdminSQLMaxOpenConns         int       `json:"admin_sql_max_open_conns,omitempty"`
	TrafficSQLMaxOpenConns       int       `json:"traffic_sql_max_open_conns,omitempty"`
	SubscriptionWriteConcurrency int       `json:"subscription_write_concurrency,omitempty"`
	MySQLEndpoint                string    `json:"mysql_endpoint,omitempty"`
	RedisEndpoint                string    `json:"redis_endpoint,omitempty"`
	SecretName                   string    `json:"secret_name,omitempty"`
	TerraformRun                 string    `json:"terraform_run,omitempty"`
	VerificationEvidence         string    `json:"verification_evidence,omitempty"`
	FleetProjectedAt             time.Time `json:"fleet_projected_at,omitempty"`
	VerifiedAt                   time.Time `json:"verified_at,omitempty"`
	Version                      int64     `json:"version"`
	CreatedAt                    time.Time `json:"created_at"`
	UpdatedAt                    time.Time `json:"updated_at"`
}

type CreateShardExpansionInput struct {
	IdempotencyKey               string `json:"idempotency_key"`
	ShardID                      string `json:"shard_id"`
	Name                         string `json:"name"`
	MaxSets                      int    `json:"max_sets"`
	RedisDBStart                 int    `json:"redis_db_start"`
	RedisDBLimit                 int    `json:"redis_db_limit"`
	MaxConnections               int    `json:"max_connections,omitempty"`
	ReservedConnections          int    `json:"reserved_connections,omitempty"`
	AdminSQLMaxOpenConns         int    `json:"admin_sql_max_open_conns,omitempty"`
	TrafficSQLMaxOpenConns       int    `json:"traffic_sql_max_open_conns,omitempty"`
	SubscriptionWriteConcurrency int    `json:"subscription_write_concurrency,omitempty"`
}

type RecordShardExpansionInfrastructureInput struct {
	MySQLEndpoint string `json:"mysql_endpoint"`
	RedisEndpoint string `json:"redis_endpoint"`
	SecretName    string `json:"secret_name"`
	TerraformRun  string `json:"terraform_run,omitempty"`
}

type RecordShardExpansionVerificationInput struct {
	Success  bool   `json:"success"`
	Evidence string `json:"evidence,omitempty"`
}

type ShardExpansionListOptions struct {
	Statuses []string
	Limit    int
}

type ShardExpansionReconcileResult struct {
	Scanned  int `json:"scanned"`
	Advanced int `json:"advanced"`
	Failed   int `json:"failed"`
}

func (s *Service) CreateShardExpansion(ctx context.Context, input CreateShardExpansionInput) (ShardExpansion, error) {
	normalizeShardExpansionInput(&input)
	if err := validateShardExpansionInput(input); err != nil {
		return ShardExpansion{}, err
	}
	requestHash := shardExpansionRequestHash(input)
	if existing, ok, err := s.store.GetShardExpansionByIdempotencyKey(ctx, input.IdempotencyKey); err != nil {
		return ShardExpansion{}, err
	} else if ok {
		if existing.RequestHash != requestHash {
			return ShardExpansion{}, ErrShardExpansionIdempotencyConflict
		}
		return existing, nil
	}
	if _, ok, err := s.store.GetShard(ctx, input.ShardID); err != nil {
		return ShardExpansion{}, err
	} else if ok {
		return ShardExpansion{}, fmt.Errorf("shard %q already exists", input.ShardID)
	}
	now := s.nowUTC()
	expansion := ShardExpansion{
		ID: "shard-expand-" + randomSecret(), IdempotencyKey: input.IdempotencyKey,
		RequestHash: requestHash, ShardID: input.ShardID, Name: input.Name,
		Status: ShardExpansionStatusRequested, MaxSets: input.MaxSets,
		RedisDBStart: input.RedisDBStart, RedisDBLimit: input.RedisDBLimit,
		MaxConnections: input.MaxConnections, ReservedConnections: input.ReservedConnections,
		AdminSQLMaxOpenConns: input.AdminSQLMaxOpenConns, TrafficSQLMaxOpenConns: input.TrafficSQLMaxOpenConns,
		SubscriptionWriteConcurrency: input.SubscriptionWriteConcurrency,
		Version:                      1, CreatedAt: now, UpdatedAt: now,
	}
	result, created, err := s.store.CreateShardExpansion(ctx, expansion)
	if err != nil {
		return ShardExpansion{}, err
	}
	if !created && result.RequestHash != expansion.RequestHash {
		return ShardExpansion{}, ErrShardExpansionIdempotencyConflict
	}
	return result, nil
}

func (s *Service) GetShardExpansion(ctx context.Context, id string) (ShardExpansion, error) {
	expansion, ok, err := s.store.GetShardExpansion(ctx, strings.TrimSpace(id))
	if err != nil {
		return ShardExpansion{}, err
	}
	if !ok {
		return ShardExpansion{}, fmt.Errorf("shard expansion %q not found", id)
	}
	return expansion, nil
}

func (s *Service) ListShardExpansions(ctx context.Context, options ShardExpansionListOptions) ([]ShardExpansion, error) {
	if options.Limit <= 0 || options.Limit > 500 {
		options.Limit = 100
	}
	return s.store.ListShardExpansions(ctx, options)
}

func (s *Service) RecordShardExpansionInfrastructure(ctx context.Context, id string, input RecordShardExpansionInfrastructureInput) (ShardExpansion, error) {
	input.MySQLEndpoint = strings.TrimSpace(input.MySQLEndpoint)
	input.RedisEndpoint = strings.TrimSpace(input.RedisEndpoint)
	input.SecretName = strings.TrimSpace(input.SecretName)
	input.TerraformRun = strings.TrimSpace(input.TerraformRun)
	if input.MySQLEndpoint == "" || input.RedisEndpoint == "" || input.SecretName == "" {
		return ShardExpansion{}, fmt.Errorf("mysql_endpoint, redis_endpoint and secret_name are required")
	}
	expansion, err := s.GetShardExpansion(ctx, id)
	if err != nil {
		return ShardExpansion{}, err
	}
	if expansion.Status != ShardExpansionStatusRequested && expansion.Status != ShardExpansionStatusWaitingInfrastructure {
		return ShardExpansion{}, fmt.Errorf("cannot record infrastructure while status is %q", expansion.Status)
	}
	expansion.MySQLEndpoint = input.MySQLEndpoint
	expansion.RedisEndpoint = input.RedisEndpoint
	expansion.SecretName = input.SecretName
	expansion.TerraformRun = input.TerraformRun
	expansion.Status = ShardExpansionStatusInfrastructureReady
	expansion.LastError = ""
	expansion.FailedStep = ""
	return s.updateShardExpansion(ctx, expansion)
}

func (s *Service) RecordShardExpansionVerification(ctx context.Context, id string, input RecordShardExpansionVerificationInput) (ShardExpansion, error) {
	expansion, err := s.GetShardExpansion(ctx, id)
	if err != nil {
		return ShardExpansion{}, err
	}
	if expansion.Status != ShardExpansionStatusVerifying {
		return ShardExpansion{}, fmt.Errorf("cannot record verification while status is %q", expansion.Status)
	}
	expansion.VerificationEvidence = strings.TrimSpace(input.Evidence)
	if input.Success {
		expansion.Status = ShardExpansionStatusReady
		expansion.VerifiedAt = s.nowUTC()
		expansion.RetryStatus = ""
		expansion.FailedStep = ""
		expansion.LastError = ""
	} else {
		expansion.Status = ShardExpansionStatusError
		expansion.RetryStatus = ShardExpansionStatusVerifying
		expansion.FailedStep = "verification"
		expansion.LastError = expansion.VerificationEvidence
		if expansion.LastError == "" {
			expansion.LastError = "verification failed"
		}
	}
	return s.updateShardExpansion(ctx, expansion)
}

func (s *Service) RetryShardExpansion(ctx context.Context, id string) (ShardExpansion, error) {
	expansion, err := s.GetShardExpansion(ctx, id)
	if err != nil {
		return ShardExpansion{}, err
	}
	if expansion.Status != ShardExpansionStatusError || expansion.RetryStatus == "" {
		return ShardExpansion{}, fmt.Errorf("shard expansion is not retryable")
	}
	expansion.Status = expansion.RetryStatus
	expansion.RetryStatus = ""
	expansion.FailedStep = ""
	expansion.LastError = ""
	return s.updateShardExpansion(ctx, expansion)
}

func (s *Service) CancelShardExpansion(ctx context.Context, id string) (ShardExpansion, error) {
	expansion, err := s.GetShardExpansion(ctx, id)
	if err != nil {
		return ShardExpansion{}, err
	}
	if expansion.Status == ShardExpansionStatusReady || expansion.Status == ShardExpansionStatusCancelled {
		return ShardExpansion{}, fmt.Errorf("shard expansion cannot be cancelled while status is %q", expansion.Status)
	}
	expansion.Status = ShardExpansionStatusCancelled
	expansion.RetryStatus = ""
	return s.updateShardExpansion(ctx, expansion)
}

func (s *Service) ReconcileShardExpansions(ctx context.Context, limit int) (ShardExpansionReconcileResult, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	expansions, err := s.store.ListShardExpansions(ctx, ShardExpansionListOptions{
		Statuses: []string{ShardExpansionStatusRequested, ShardExpansionStatusInfrastructureReady, ShardExpansionStatusWaitingFleetProjection},
		Limit:    limit,
	})
	if err != nil {
		return ShardExpansionReconcileResult{}, err
	}
	result := ShardExpansionReconcileResult{Scanned: len(expansions)}
	for _, expansion := range expansions {
		changed := false
		switch expansion.Status {
		case ShardExpansionStatusRequested:
			expansion.Status = ShardExpansionStatusWaitingInfrastructure
			changed = true
		case ShardExpansionStatusInfrastructureReady:
			expansion.Status = ShardExpansionStatusWaitingFleetProjection
			changed = true
		case ShardExpansionStatusWaitingFleetProjection:
			shard, ok, getErr := s.store.GetShard(ctx, expansion.ShardID)
			if getErr != nil {
				result.Failed++
				continue
			}
			if !ok {
				continue
			}
			if mismatch := shardExpansionProjectionMismatch(expansion, shard); mismatch != "" {
				expansion.Status = ShardExpansionStatusError
				expansion.RetryStatus = ShardExpansionStatusWaitingFleetProjection
				expansion.FailedStep = "fleet_projection"
				expansion.LastError = mismatch
				changed = true
				result.Failed++
			} else {
				expansion.Status = ShardExpansionStatusVerifying
				expansion.FleetProjectedAt = s.nowUTC()
				expansion.LastError = ""
				expansion.FailedStep = ""
				changed = true
			}
		}
		if !changed {
			continue
		}
		if _, err := s.updateShardExpansion(ctx, expansion); err != nil {
			result.Failed++
			continue
		}
		result.Advanced++
	}
	return result, nil
}

func (s *Service) updateShardExpansion(ctx context.Context, expansion ShardExpansion) (ShardExpansion, error) {
	updated, ok, err := s.store.UpdateShardExpansion(ctx, expansion, expansion.Version)
	if err != nil {
		return ShardExpansion{}, err
	}
	if !ok {
		return ShardExpansion{}, fmt.Errorf("shard expansion changed concurrently")
	}
	return updated, nil
}

func normalizeShardExpansionInput(input *CreateShardExpansionInput) {
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	input.ShardID = strings.TrimSpace(input.ShardID)
	input.Name = strings.TrimSpace(input.Name)
}

func validateShardExpansionInput(input CreateShardExpansionInput) error {
	if input.IdempotencyKey == "" || input.ShardID == "" || input.Name == "" {
		return fmt.Errorf("idempotency_key, shard_id and name are required")
	}
	if len(input.IdempotencyKey) > 191 || len(input.ShardID) > 128 {
		return fmt.Errorf("idempotency_key or shard_id is too long")
	}
	if input.MaxSets <= 0 {
		return fmt.Errorf("max_sets must be greater than zero")
	}
	if input.RedisDBStart < 0 || input.RedisDBLimit <= input.RedisDBStart {
		return fmt.Errorf("redis DB range must be a non-empty half-open interval")
	}
	if input.ReservedConnections < 0 || input.MaxConnections < 0 || input.ReservedConnections > input.MaxConnections && input.MaxConnections > 0 {
		return fmt.Errorf("invalid MySQL connection budget")
	}
	return nil
}

func shardExpansionRequestHash(input CreateShardExpansionInput) string {
	raw := fmt.Sprintf("%s\x00%s\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d",
		input.ShardID, input.Name, input.MaxSets, input.RedisDBStart, input.RedisDBLimit,
		input.MaxConnections, input.ReservedConnections, input.AdminSQLMaxOpenConns,
		input.TrafficSQLMaxOpenConns, input.SubscriptionWriteConcurrency)
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:])
}

func shardExpansionProjectionMismatch(expansion ShardExpansion, shard Shard) string {
	if strings.TrimSpace(shard.Endpoint) != expansion.MySQLEndpoint {
		return fmt.Sprintf("MySQL endpoint mismatch: projected %q", shard.Endpoint)
	}
	if strings.TrimSpace(shard.RedisEndpoint) != expansion.RedisEndpoint {
		return fmt.Sprintf("Redis endpoint mismatch: projected %q", shard.RedisEndpoint)
	}
	if shard.RedisDBStart != expansion.RedisDBStart || shard.RedisDBLimit != expansion.RedisDBLimit {
		return fmt.Sprintf("Redis DB range mismatch: projected [%d,%d)", shard.RedisDBStart, shard.RedisDBLimit)
	}
	if expansion.SecretName != "" && shard.SecretName != expansion.SecretName {
		return fmt.Sprintf("secret name mismatch: projected %q", shard.SecretName)
	}
	return ""
}
