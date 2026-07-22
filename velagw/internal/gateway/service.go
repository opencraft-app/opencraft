package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/newapi"
	"git.woa.com/wisp/mono2/llmgateway/internal/observability"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otellog "go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/trace"
)

const consoleProxyPrefix = "/_llmgateway_console/"

const defaultUserLLMSettingsTrafficCacheTTL = 30 * time.Second

var (
	ErrPlanNotFound          = errors.New("plan not found")
	ErrPlanNotReady          = errors.New("plan is not ready in any active set")
	ErrPlanImmutableConflict = errors.New("plan id already exists with different entitlements")
	ErrSubscriptionNotFound  = errors.New("active subscription not found")
	ErrAPIKeyRandomCollision = errors.New("external api key random identity collision")
	ErrAPIKeyPurposeConflict = errors.New("external api key purpose already exists")
	ErrAPIKeyStateConflict   = errors.New("external api key state transition conflict")
	// stdout is reserved for canonical OTLP JSON envelopes. Legacy access logs
	// remain on stderr until the traffic-plane telemetry rollout is enabled.
	defaultAccessLogger = log.New(os.Stderr, "", 0)
)

type Service struct {
	store               Store
	transport           http.RoundTripper
	trafficManager      *TransportManager
	options             Options
	now                 func() time.Time
	migrationLocks      sync.Map
	llmRouteCache       sync.Map
	byokGroupLock       sync.Mutex
	trafficMetrics      *TrafficMetrics
	telemetryEmitter    TelemetryEventEmitter
	telemetrySanitizer  *observability.Sanitizer
	telemetryCorrelator *observability.Correlator
	releaseHealthGate   func(context.Context, ReleaseRollout) error
}

type userLLMSettingsTrafficCacheEntry struct {
	settings  UserLLMSettings
	ok        bool
	expiresAt time.Time
}

func NewService(store Store, transport http.RoundTripper, options Options) *Service {
	if transport == nil {
		transport = http.DefaultTransport
	}
	if options.RootUsername == "" {
		options.RootUsername = "set-root"
	}
	if options.TelemetrySanitizer == nil {
		options.TelemetrySanitizer = observability.NewSanitizer(observability.SanitizerConfig{})
	}
	if options.TelemetryEmitter == nil {
		options.TelemetryEmitter = observability.EmitEvent
	}
	return &Service{
		store:               store,
		transport:           transport,
		trafficManager:      options.TrafficTransportManager,
		options:             options,
		now:                 time.Now,
		trafficMetrics:      NewTrafficMetrics(),
		telemetryEmitter:    options.TelemetryEmitter,
		telemetrySanitizer:  options.TelemetrySanitizer,
		telemetryCorrelator: options.TelemetryCorrelator,
	}
}

func (s *Service) nowUTC() time.Time {
	if s.now == nil {
		return time.Now().UTC()
	}
	return s.now().UTC()
}

func startGatewaySpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	return otel.Tracer("git.woa.com/wisp/mono2/llmgateway/internal/gateway").Start(ctx, name, trace.WithAttributes(attrs...))
}

func finishGatewaySpan(span trace.Span, err error) {
	observability.FinishSpan(span, err, "gateway_operation_failed", nil)
}

func traceGatewayValue[T any](ctx context.Context, name string, fn func(context.Context) (T, error), attrs ...attribute.KeyValue) (T, error) {
	spanCtx, span := startGatewaySpan(ctx, name, attrs...)
	value, err := fn(spanCtx)
	finishGatewaySpan(span, err)
	return value, err
}

func traceGatewayVoid(ctx context.Context, name string, fn func(context.Context) error, attrs ...attribute.KeyValue) error {
	_, err := traceGatewayValue(ctx, name, func(spanCtx context.Context) (struct{}, error) {
		return struct{}{}, fn(spanCtx)
	}, attrs...)
	return err
}

func optionalNonNegativeInt(value *int) int {
	if value == nil || *value < 0 {
		return 0
	}
	return *value
}

func (s *Service) RegisterSet(ctx context.Context, input RegisterSetInput) error {
	if input.ID == "" {
		return fmt.Errorf("set id is required")
	}
	if input.BaseURL == "" {
		return fmt.Errorf("base url is required")
	}
	if input.Status == "" {
		input.Status = SetStatusActive
	}
	if _, err := url.ParseRequestURI(input.BaseURL); err != nil {
		return fmt.Errorf("invalid base url: %w", err)
	}
	input.TrafficBaseURL = strings.TrimRight(strings.TrimSpace(input.TrafficBaseURL), "/")
	if input.TrafficBaseURL != "" {
		if _, err := url.ParseRequestURI(input.TrafficBaseURL); err != nil {
			return fmt.Errorf("invalid traffic base url: %w", err)
		}
	}
	set := Set{
		ID:                           input.ID,
		Name:                         input.Name,
		BaseURL:                      strings.TrimRight(input.BaseURL, "/"),
		TrafficBaseURL:               input.TrafficBaseURL,
		Status:                       input.Status,
		MaxUsers:                     optionalNonNegativeInt(input.MaxUsers),
		WarnUsers:                    optionalNonNegativeInt(input.WarnUsers),
		ReservedUsers:                optionalNonNegativeInt(input.ReservedUsers),
		ShardID:                      strings.TrimSpace(input.ShardID),
		NewAPIReplicas:               optionalNonNegativeInt(input.NewAPIReplicas),
		SQLMaxOpenConns:              optionalNonNegativeInt(input.SQLMaxOpenConns),
		SQLMaxIdleConns:              optionalNonNegativeInt(input.SQLMaxIdleConns),
		SQLMaxLifetimeSeconds:        optionalNonNegativeInt(input.SQLMaxLifetimeSeconds),
		TrafficSQLMaxOpenConns:       optionalNonNegativeInt(input.TrafficSQLMaxOpenConns),
		TrafficSQLMaxIdleConns:       optionalNonNegativeInt(input.TrafficSQLMaxIdleConns),
		TrafficSQLMaxLifetimeSeconds: optionalNonNegativeInt(input.TrafficSQLMaxLifetimeSeconds),
		SubscriptionWriteConcurrency: optionalNonNegativeInt(input.SubscriptionWriteConcurrency),
	}
	if existing, ok, err := s.store.GetSet(ctx, input.ID); err != nil {
		return err
	} else if ok {
		set.LifecycleGeneration = existing.LifecycleGeneration
		if existing.Status == SetStatusDraining {
			set.Status = SetStatusDraining
		}
		if input.MaxUsers == nil {
			set.MaxUsers = existing.MaxUsers
		}
		if input.WarnUsers == nil {
			set.WarnUsers = existing.WarnUsers
		}
		if input.ReservedUsers == nil {
			set.ReservedUsers = existing.ReservedUsers
		}
		if strings.TrimSpace(input.ShardID) == "" {
			set.ShardID = existing.ShardID
		}
		if input.NewAPIReplicas == nil {
			set.NewAPIReplicas = existing.NewAPIReplicas
		}
		if input.SQLMaxOpenConns == nil {
			set.SQLMaxOpenConns = existing.SQLMaxOpenConns
		}
		if input.SQLMaxIdleConns == nil {
			set.SQLMaxIdleConns = existing.SQLMaxIdleConns
		}
		if input.SQLMaxLifetimeSeconds == nil {
			set.SQLMaxLifetimeSeconds = existing.SQLMaxLifetimeSeconds
		}
		if input.TrafficSQLMaxOpenConns == nil {
			set.TrafficSQLMaxOpenConns = existing.TrafficSQLMaxOpenConns
		}
		if input.TrafficSQLMaxIdleConns == nil {
			set.TrafficSQLMaxIdleConns = existing.TrafficSQLMaxIdleConns
		}
		if input.TrafficSQLMaxLifetimeSeconds == nil {
			set.TrafficSQLMaxLifetimeSeconds = existing.TrafficSQLMaxLifetimeSeconds
		}
		if input.SubscriptionWriteConcurrency == nil {
			set.SubscriptionWriteConcurrency = existing.SubscriptionWriteConcurrency
		}
		if set.TrafficBaseURL == "" {
			set.TrafficBaseURL = existing.TrafficBaseURL
		}
		set.AdmissionStatus = existing.AdmissionStatus
		set.AdmissionError = existing.AdmissionError
		set.AdmissionCheckedAt = existing.AdmissionCheckedAt
	}
	if err := s.store.SaveSet(ctx, set); err != nil {
		return err
	}
	return s.refreshSetTrafficRoutes(ctx, set.ID)
}

func (s *Service) ListSets(ctx context.Context) ([]Set, error) {
	return s.store.ListSets(ctx)
}

func (s *Service) UpsertShard(ctx context.Context, input UpsertShardInput) error {
	input.ID = strings.TrimSpace(input.ID)
	if input.ID == "" {
		return fmt.Errorf("shard id is required")
	}
	shard := Shard{
		ID:                           input.ID,
		Name:                         strings.TrimSpace(input.Name),
		Kind:                         strings.TrimSpace(input.Kind),
		Endpoint:                     strings.TrimSpace(input.Endpoint),
		RedisEndpoint:                strings.TrimSpace(input.RedisEndpoint),
		SecretName:                   strings.TrimSpace(input.SecretName),
		RedisDBStart:                 optionalNonNegativeInt(input.RedisDBStart),
		RedisDBLimit:                 optionalNonNegativeInt(input.RedisDBLimit),
		Status:                       strings.TrimSpace(input.Status),
		MaxConnections:               optionalNonNegativeInt(input.MaxConnections),
		ReservedConnections:          optionalNonNegativeInt(input.ReservedConnections),
		WarnRatio:                    optionalRatio(input.WarnRatio, 0.7),
		CriticalRatio:                optionalRatio(input.CriticalRatio, 0.85),
		MaxSets:                      optionalNonNegativeInt(input.MaxSets),
		AdminSQLMaxOpenConns:         optionalNonNegativeInt(input.AdminSQLMaxOpenConns),
		AdminSQLMaxIdleConns:         optionalNonNegativeInt(input.AdminSQLMaxIdleConns),
		AdminSQLMaxLifetimeSeconds:   optionalNonNegativeInt(input.AdminSQLMaxLifetimeSeconds),
		TrafficSQLMaxOpenConns:       optionalNonNegativeInt(input.TrafficSQLMaxOpenConns),
		TrafficSQLMaxIdleConns:       optionalNonNegativeInt(input.TrafficSQLMaxIdleConns),
		TrafficSQLMaxLifetimeSeconds: optionalNonNegativeInt(input.TrafficSQLMaxLifetimeSeconds),
		SubscriptionWriteConcurrency: optionalNonNegativeInt(input.SubscriptionWriteConcurrency),
	}
	if shard.Name == "" {
		shard.Name = shard.ID
	}
	if shard.Kind == "" {
		shard.Kind = ShardKindMySQL
	}
	if shard.Status == "" {
		shard.Status = ShardStatusActive
	}
	if existing, ok, err := s.store.GetShard(ctx, shard.ID); err != nil {
		return err
	} else if ok {
		if strings.TrimSpace(input.Name) == "" {
			shard.Name = existing.Name
		}
		if strings.TrimSpace(input.Kind) == "" {
			shard.Kind = existing.Kind
		}
		if strings.TrimSpace(input.Endpoint) == "" {
			shard.Endpoint = existing.Endpoint
		}
		if strings.TrimSpace(input.RedisEndpoint) == "" {
			shard.RedisEndpoint = existing.RedisEndpoint
		}
		if strings.TrimSpace(input.SecretName) == "" {
			shard.SecretName = existing.SecretName
		}
		if input.RedisDBStart == nil {
			shard.RedisDBStart = existing.RedisDBStart
		}
		if input.RedisDBLimit == nil {
			shard.RedisDBLimit = existing.RedisDBLimit
		}
		if strings.TrimSpace(input.Status) == "" {
			shard.Status = existing.Status
		}
		if input.MaxConnections == nil {
			shard.MaxConnections = existing.MaxConnections
		}
		if input.ReservedConnections == nil {
			shard.ReservedConnections = existing.ReservedConnections
		}
		if input.WarnRatio == nil {
			shard.WarnRatio = existing.WarnRatio
		}
		if input.CriticalRatio == nil {
			shard.CriticalRatio = existing.CriticalRatio
		}
		if input.MaxSets == nil {
			shard.MaxSets = existing.MaxSets
		}
		if input.AdminSQLMaxOpenConns == nil {
			shard.AdminSQLMaxOpenConns = existing.AdminSQLMaxOpenConns
		}
		if input.AdminSQLMaxIdleConns == nil {
			shard.AdminSQLMaxIdleConns = existing.AdminSQLMaxIdleConns
		}
		if input.AdminSQLMaxLifetimeSeconds == nil {
			shard.AdminSQLMaxLifetimeSeconds = existing.AdminSQLMaxLifetimeSeconds
		}
		if input.TrafficSQLMaxOpenConns == nil {
			shard.TrafficSQLMaxOpenConns = existing.TrafficSQLMaxOpenConns
		}
		if input.TrafficSQLMaxIdleConns == nil {
			shard.TrafficSQLMaxIdleConns = existing.TrafficSQLMaxIdleConns
		}
		if input.TrafficSQLMaxLifetimeSeconds == nil {
			shard.TrafficSQLMaxLifetimeSeconds = existing.TrafficSQLMaxLifetimeSeconds
		}
		if input.SubscriptionWriteConcurrency == nil {
			shard.SubscriptionWriteConcurrency = existing.SubscriptionWriteConcurrency
		}
	}
	if shard.MaxSets < 0 {
		return fmt.Errorf("max_sets must be greater than or equal to zero")
	}
	if shard.RedisDBLimit > 0 && shard.RedisDBLimit <= shard.RedisDBStart {
		return fmt.Errorf("redis DB range must be a non-empty half-open interval")
	}
	if shard.AdminSQLMaxOpenConns > 0 && shard.SubscriptionWriteConcurrency*2 > shard.AdminSQLMaxOpenConns {
		return fmt.Errorf("subscription_write_concurrency requires at least twice as many admin SQL connections")
	}
	if shard.WarnRatio <= 0 {
		shard.WarnRatio = 0.7
	}
	if shard.CriticalRatio <= 0 {
		shard.CriticalRatio = 0.85
	}
	if shard.CriticalRatio < shard.WarnRatio {
		shard.CriticalRatio = shard.WarnRatio
	}
	return s.store.SaveShard(ctx, shard)
}

func (s *Service) ListShardDetails(ctx context.Context) ([]ShardDetail, error) {
	shards, err := s.store.ListShards(ctx)
	if err != nil {
		return nil, err
	}
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return nil, err
	}
	leases, err := s.store.ListSetRuntimeLeases(ctx, SetRuntimeLeaseListOptions{})
	if err != nil {
		return nil, err
	}
	leaseBySet := runtimeLeaseBySetID(leases)
	details := make([]ShardDetail, 0, len(shards))
	for _, shard := range shards {
		details = append(details, buildShardDetail(shard, sets, leaseBySet))
	}
	return details, nil
}

func (s *Service) GetShardDetail(ctx context.Context, id string) (ShardDetail, error) {
	shard, ok, err := s.store.GetShard(ctx, strings.TrimSpace(id))
	if err != nil {
		return ShardDetail{}, err
	}
	if !ok {
		return ShardDetail{}, fmt.Errorf("shard %q not found", id)
	}
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return ShardDetail{}, err
	}
	leases, err := s.store.ListSetRuntimeLeases(ctx, SetRuntimeLeaseListOptions{})
	if err != nil {
		return ShardDetail{}, err
	}
	return buildShardDetail(shard, sets, runtimeLeaseBySetID(leases)), nil
}

func optionalRatio(value *float64, fallback float64) float64 {
	if value == nil {
		return fallback
	}
	if *value < 0 {
		return 0
	}
	if *value > 1 {
		return 1
	}
	return *value
}

func buildShardDetail(shard Shard, sets []Set, leaseBySet map[string]SetRuntimeLease) ShardDetail {
	allocatable := shard.MaxConnections - shard.ReservedConnections
	if allocatable < 0 {
		allocatable = 0
	}
	detail := ShardDetail{
		Shard:                  shard,
		AllocatableConnections: allocatable,
		CapacityStatus:         ShardCapacityUnknown,
	}
	for _, set := range sets {
		if set.ShardID != shard.ID {
			continue
		}
		logical := set.SQLMaxOpenConns
		if set.NewAPIReplicas > 0 && set.TrafficSQLMaxOpenConns > 0 {
			logical += set.NewAPIReplicas * set.TrafficSQLMaxOpenConns
		} else if set.NewAPIReplicas > 0 && set.SQLMaxOpenConns > 0 {
			// Older projections stored one shared pool value for every new-api Pod.
			logical = set.NewAPIReplicas * set.SQLMaxOpenConns
		}
		detail.LogicalConnections += logical
		lease := leaseBySet[set.ID]
		detail.Sets = append(detail.Sets, ShardSetBudget{
			SetID:              set.ID,
			Name:               set.Name,
			Status:             set.Status,
			Setup:              set.Setup,
			NewAPIReplicas:     set.NewAPIReplicas,
			SQLMaxOpenConns:    set.SQLMaxOpenConns,
			SQLMaxIdleConns:    set.SQLMaxIdleConns,
			LogicalConnections: logical,
			DatabaseName:       lease.DatabaseName,
			RedisDB:            lease.RedisDB,
		})
	}
	redisDBs := map[string]bool{}
	for _, set := range detail.Sets {
		if set.RedisDB != "" {
			redisDBs[set.RedisDB] = true
		}
	}
	detail.RedisDBAllocated = len(redisDBs)
	redisCapacity := shard.RedisDBLimit - shard.RedisDBStart
	if redisCapacity > 0 {
		detail.RedisDBAvailable = redisCapacity - detail.RedisDBAllocated
		if detail.RedisDBAvailable < 0 {
			detail.RedisDBAvailable = 0
		}
		detail.RedisDBUtilization = float64(detail.RedisDBAllocated) / float64(redisCapacity)
	}
	detail.RemainingConnections = allocatable - detail.LogicalConnections
	if detail.RemainingConnections < 0 {
		detail.RemainingConnections = 0
	}
	if allocatable <= 0 {
		return detail
	}
	detail.Utilization = float64(detail.LogicalConnections) / float64(allocatable)
	switch {
	case detail.Utilization >= shard.CriticalRatio:
		detail.CapacityStatus = ShardCapacityCritical
	case detail.Utilization >= shard.WarnRatio:
		detail.CapacityStatus = ShardCapacityWarn
	default:
		detail.CapacityStatus = ShardCapacityOK
	}
	return detail
}

func runtimeLeaseBySetID(leases []SetRuntimeLease) map[string]SetRuntimeLease {
	result := make(map[string]SetRuntimeLease, len(leases))
	for _, lease := range leases {
		result[lease.SetID] = lease
	}
	return result
}

func (s *Service) BootstrapSet(ctx context.Context, setID string) (Set, error) {
	set, ok, err := s.store.GetSet(ctx, setID)
	if err != nil {
		return Set{}, err
	}
	if !ok {
		return Set{}, fmt.Errorf("set %q not found", setID)
	}
	client := s.newAPIClient(set.BaseURL)
	setup, err := client.GetSetup(ctx)
	if err != nil {
		return Set{}, err
	}
	if !setup.Status || !setup.RootInit {
		if s.options.RootPassword == "" {
			return Set{}, fmt.Errorf("root password is required to bootstrap empty set")
		}
		if err := client.Setup(ctx, newapi.SetupRequest{
			Username:        s.options.RootUsername,
			Password:        s.options.RootPassword,
			ConfirmPassword: s.options.RootPassword,
		}); err != nil && !isNewAPIAlreadyInitializedError(err) {
			return Set{}, err
		}
	}
	session, err := s.loginRootSession(ctx, client, set)
	if err != nil {
		return Set{}, err
	}
	if err := client.ConfirmPaymentCompliance(ctx, session.UserID); err != nil {
		return Set{}, err
	}
	if err := client.UpdateOption(ctx, session.UserID, "theme.frontend", "default"); err != nil {
		return Set{}, err
	}
	if set.AdminTOTPSecret == "" {
		setup2FA, err := client.Setup2FA(ctx, session.UserID, "")
		if err != nil {
			return Set{}, err
		}
		code, err := generateTOTPCode(setup2FA.Secret, s.nowUTC())
		if err != nil {
			return Set{}, err
		}
		if err := client.Enable2FA(ctx, session.UserID, "", code); err != nil {
			return Set{}, err
		}
		set.AdminTOTPSecret = setup2FA.Secret
	}
	accessToken, err := client.GenerateAccessToken(ctx, session.UserID)
	if err != nil {
		return Set{}, err
	}
	set.Setup = true
	set.AdminUserID = session.UserID
	set.AdminUsername = session.Username
	set.AdminRole = session.Role
	set.AdminStatus = session.Status
	set.AdminGroup = session.Group
	set.AdminAccessToken = accessToken
	if err := s.store.SaveSet(ctx, set); err != nil {
		return Set{}, err
	}
	return set, nil
}

func (s *Service) loginRootSession(ctx context.Context, client *newapi.Client, set Set) (newapi.Session, error) {
	session, err := client.Login(ctx, s.options.RootUsername, s.options.RootPassword)
	if err != nil {
		return newapi.Session{}, err
	}
	if !session.Require2FA {
		return session, nil
	}
	if set.AdminTOTPSecret == "" {
		return newapi.Session{}, fmt.Errorf("set %q root login requires 2fa but no managed totp secret is stored", set.ID)
	}
	code, err := generateTOTPCode(set.AdminTOTPSecret, s.nowUTC())
	if err != nil {
		return newapi.Session{}, err
	}
	return client.Complete2FALogin(ctx, code)
}

func isNewAPIAlreadyInitializedError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "already initialized") ||
		strings.Contains(message, "already initialised") ||
		strings.Contains(message, "已经初始化")
}

func (s *Service) GetManagedChannelKey(ctx context.Context, setID string, remoteChannelID int) (string, error) {
	set, ok, err := s.store.GetSet(ctx, setID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("set %q not found", setID)
	}
	if set.AdminAccessToken == "" || set.AdminUserID == 0 {
		return "", fmt.Errorf("set %q is not bootstrapped", set.ID)
	}
	if set.AdminTOTPSecret == "" {
		return "", fmt.Errorf("set %q has no managed totp secret", set.ID)
	}
	code, err := generateTOTPCode(set.AdminTOTPSecret, s.nowUTC())
	if err != nil {
		return "", err
	}
	return s.newAPIClient(set.BaseURL).GetChannelKey(ctx, adminAuthForSet(set), remoteChannelID, code)
}

func (s *Service) EnsureUserBinding(ctx context.Context, externalUserID string) (UserBinding, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return UserBinding{}, fmt.Errorf("external user id is required")
	}
	if err := s.ensureTenantCanWrite(ctx, externalUserID); err != nil {
		return UserBinding{}, err
	}
	if _, err := s.EnsureTenant(ctx, Tenant{
		ExternalUserID: externalUserID,
		Source:         "binding",
	}); err != nil {
		return UserBinding{}, err
	}
	if binding, ok, err := s.store.GetUserBinding(ctx, externalUserID); err != nil {
		return UserBinding{}, err
	} else if ok {
		return binding, nil
	}
	assignment, err := s.GetUserAssignment(ctx, externalUserID)
	if err != nil {
		return UserBinding{}, err
	}
	set, err := s.pickSetForAssignment(ctx, assignment)
	if err != nil {
		return UserBinding{}, err
	}
	binding := UserBinding{
		ExternalUserID:  externalUserID,
		SetID:           set.ID,
		Username:        newAPIUsername(externalUserID),
		Password:        randomNewAPIPassword(),
		ProvisionStatus: BindingProvisionStatusAllocated,
	}
	if err := s.store.SaveUserBinding(ctx, binding); err != nil {
		return UserBinding{}, err
	}
	s.emitCommittedTransition(ctx, observability.ScopeTenantEntitlement, "llmgateway.tenant.state_changed",
		"user_binding", externalUserID, "", BindingProvisionStatusAllocated,
		attribute.String("llmgateway.user.id", externalUserID),
		attribute.String("llmgateway.set.id", set.ID),
	)
	return binding, nil
}

func (s *Service) HasUserBinding(ctx context.Context, externalUserID string) (bool, error) {
	_, ok, err := s.store.GetUserBinding(ctx, strings.TrimSpace(externalUserID))
	return ok, err
}

func (s *Service) GetUserAssignment(ctx context.Context, externalUserID string) (UserAssignment, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return UserAssignment{}, fmt.Errorf("external user id is required")
	}
	tenant, tenantOK, err := s.store.GetTenant(ctx, externalUserID)
	if err != nil {
		return UserAssignment{}, err
	}
	assignment, ok, err := s.store.GetUserAssignment(ctx, externalUserID)
	if err != nil {
		return UserAssignment{}, err
	}
	if tenantOK {
		normalized, err := normalizeTenant(tenant)
		if err != nil {
			return UserAssignment{}, err
		}
		result := UserAssignment{
			ExternalUserID: normalized.ExternalUserID,
			Backend:        normalized.Backend,
			SetID:          normalized.SetID,
			CreatedAt:      normalized.CreatedAt,
			UpdatedAt:      normalized.UpdatedAt,
		}
		if ok {
			result.MigratedAt = assignment.MigratedAt
			if !assignment.CreatedAt.IsZero() {
				result.CreatedAt = assignment.CreatedAt
			}
			if !assignment.UpdatedAt.IsZero() {
				result.UpdatedAt = assignment.UpdatedAt
			}
		}
		return result, nil
	}
	return UserAssignment{ExternalUserID: externalUserID, Backend: UserBackendPending}, nil
}

func (s *Service) SetUserAssignment(ctx context.Context, assignment UserAssignment) (UserAssignment, error) {
	assignment.ExternalUserID = strings.TrimSpace(assignment.ExternalUserID)
	assignment.Backend = strings.TrimSpace(strings.ToLower(assignment.Backend))
	assignment.SetID = strings.TrimSpace(assignment.SetID)
	if assignment.ExternalUserID == "" {
		return UserAssignment{}, fmt.Errorf("external user id is required")
	}
	if err := s.ensureTenantCanWrite(ctx, assignment.ExternalUserID); err != nil {
		return UserAssignment{}, err
	}
	previous, previousErr := s.GetUserAssignment(ctx, assignment.ExternalUserID)
	if previousErr != nil {
		return UserAssignment{}, previousErr
	}
	switch assignment.Backend {
	case UserBackendPending:
		assignment.SetID = ""
		assignment.MigratedAt = time.Time{}
	case UserBackendNew:
		if assignment.MigratedAt.IsZero() {
			assignment.MigratedAt = s.nowUTC()
		}
	default:
		return UserAssignment{}, fmt.Errorf("invalid user backend %q", assignment.Backend)
	}
	if err := s.store.SaveUserAssignment(ctx, assignment); err != nil {
		return UserAssignment{}, err
	}
	s.emitCommittedTransition(ctx, observability.ScopeTenantEntitlement, "llmgateway.tenant.state_changed",
		"user_assignment", assignment.ExternalUserID, previous.Backend, assignment.Backend,
		attribute.String("llmgateway.user.id", assignment.ExternalUserID),
		attribute.String("llmgateway.set.id", assignment.SetID),
	)
	result, err := s.GetUserAssignment(ctx, assignment.ExternalUserID)
	if err != nil {
		return UserAssignment{}, err
	}
	// The assignment controls tenant eligibility in the key route snapshot.
	// Refresh after the durable state changes so pending/new transitions cannot
	// leave a permanently disabled route in Redis.
	if err := s.refreshUserTrafficRoutes(ctx, assignment.ExternalUserID); err != nil {
		return UserAssignment{}, err
	}
	return result, nil
}

func (s *Service) MigrateUser(ctx context.Context, req MigrationRequest) (MigrationResult, error) {
	req.UserID = strings.TrimSpace(req.UserID)
	req.SetID = strings.TrimSpace(req.SetID)
	req.PlanID = strings.TrimSpace(req.PlanID)
	if req.UserID == "" {
		return MigrationResult{}, fmt.Errorf("user_id is required")
	}
	if err := s.ensureTenantCanWrite(ctx, req.UserID); err != nil {
		return MigrationResult{}, err
	}
	lock := s.migrationLock(req.UserID)
	lock.Lock()
	defer lock.Unlock()

	set, plan, upstreamPlanID, err := s.validateMigrationTarget(ctx, req)
	if err != nil {
		return MigrationResult{}, err
	}
	result := MigrationResult{
		UserID:         req.UserID,
		Backend:        UserBackendNew,
		SetID:          set.ID,
		PlanID:         plan.ID,
		UpstreamPlanID: upstreamPlanID,
		DryRun:         req.DryRun,
	}
	if req.DryRun {
		return result, nil
	}

	assignment, err := s.GetUserAssignment(ctx, req.UserID)
	if err != nil {
		return MigrationResult{}, err
	}
	if assignment.Backend == UserBackendNew {
		if assignment.SetID != set.ID {
			return MigrationResult{}, fmt.Errorf("user %q already migrated to set %q", req.UserID, assignment.SetID)
		}
		result.Migrated = true
		result.AlreadyMigrated = true
		result.Assignment = assignment
		if binding, ok, err := s.store.GetUserBinding(ctx, req.UserID); err != nil {
			return MigrationResult{}, err
		} else if ok {
			result.UpstreamUserID = binding.UpstreamUserID
		}
		s.enqueueTenantObservationEvent(ctx, req.UserID, assignment.SetID)
		return result, nil
	}

	binding, err := s.prepareMigrationBinding(ctx, req.UserID, set)
	if err != nil {
		return MigrationResult{}, err
	}
	client := s.newAPIClient(set.BaseURL)
	adminAuth := adminAuthForSet(set)
	if binding.UpstreamUserID == 0 {
		binding, err = s.ensureUpstreamUser(ctx, client, adminAuth, binding)
		if err != nil {
			return MigrationResult{}, err
		}
	}
	result.UpstreamUserID = binding.UpstreamUserID

	activeSubs, err := s.listActiveSubscriptions(ctx, client, adminAuth, binding.UpstreamUserID)
	if err != nil {
		return MigrationResult{}, err
	}
	alreadyHasPlan := false
	for _, sub := range activeSubs {
		if sub.PlanID == upstreamPlanID {
			alreadyHasPlan = true
			break
		}
	}
	if !alreadyHasPlan {
		if err := s.withSetSubscriptionWriteLease(ctx, set, func(leaseCtx context.Context) error {
			return client.AdminCreateUserSubscription(leaseCtx, adminAuth, binding.UpstreamUserID, newapi.AdminCreateUserSubscriptionRequest{PlanID: upstreamPlanID})
		}); err != nil {
			return MigrationResult{}, err
		}
	}
	binding.LastPlanID = plan.ID
	binding.LastExtendedPeriodEnd = time.Time{}
	if err := s.store.SaveUserBinding(ctx, binding); err != nil {
		return MigrationResult{}, err
	}

	var keyBinding APIKeyBinding
	if req.IssueKey {
		keyBinding, err = s.createExternalKeyForBinding(ctx, binding, set, "")
		if err != nil {
			return MigrationResult{}, err
		}
		result.APIKey = keyBinding.ExternalKey
		result.KeyID = keyBinding.ExternalKeyID
		result.KeyPrefix = migrationKeyPrefix(keyBinding.ExternalKey)
	}

	assignment, err = s.SetUserAssignment(ctx, UserAssignment{
		ExternalUserID: req.UserID,
		Backend:        UserBackendNew,
		SetID:          set.ID,
	})
	if err != nil {
		return MigrationResult{}, err
	}
	result.Migrated = true
	result.Assignment = assignment
	s.enqueueTenantObservationEvent(ctx, req.UserID, set.ID)
	return result, nil
}

func (s *Service) migrationLock(userID string) *sync.Mutex {
	lock, _ := s.migrationLocks.LoadOrStore(userID, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

func (s *Service) validateMigrationTarget(ctx context.Context, req MigrationRequest) (Set, Plan, int, error) {
	if req.SetID == "" || req.PlanID == "" {
		return Set{}, Plan{}, 0, fmt.Errorf("set_id and plan_id are required")
	}
	set, ok, err := s.store.GetSet(ctx, req.SetID)
	if err != nil {
		return Set{}, Plan{}, 0, err
	}
	if !ok {
		return Set{}, Plan{}, 0, fmt.Errorf("set %q not found", req.SetID)
	}
	if set.Status != SetStatusActive {
		return Set{}, Plan{}, 0, fmt.Errorf("set %q is not active", set.ID)
	}
	if set.AdminAccessToken == "" || set.AdminUserID == 0 {
		return Set{}, Plan{}, 0, fmt.Errorf("set %q is not bootstrapped", set.ID)
	}
	plan, err := s.activePlan(ctx, req.PlanID)
	if err != nil {
		return Set{}, Plan{}, 0, err
	}
	upstreamPlanID, err := s.readySetPlanID(ctx, plan.ID, set.ID)
	if err != nil {
		return Set{}, Plan{}, 0, err
	}
	return set, plan, upstreamPlanID, nil
}

func (s *Service) prepareMigrationBinding(ctx context.Context, externalUserID string, set Set) (UserBinding, error) {
	binding, ok, err := s.store.GetUserBinding(ctx, externalUserID)
	if err != nil {
		return UserBinding{}, err
	}
	if ok {
		if binding.SetID != set.ID && binding.UpstreamUserID > 0 {
			return UserBinding{}, fmt.Errorf("user %q already has upstream user in set %q", externalUserID, binding.SetID)
		}
		if binding.SetID != set.ID {
			binding.SetID = set.ID
		}
		if binding.Username == "" {
			binding.Username = newAPIUsername(externalUserID)
		}
		if binding.Password == "" {
			binding.Password = randomNewAPIPassword()
		}
		if binding.ProvisionStatus == "" {
			binding.ProvisionStatus = BindingProvisionStatusAllocated
		}
		return binding, nil
	}
	return UserBinding{
		ExternalUserID:  externalUserID,
		SetID:           set.ID,
		Username:        newAPIUsername(externalUserID),
		Password:        randomNewAPIPassword(),
		ProvisionStatus: BindingProvisionStatusAllocated,
	}, nil
}

func (s *Service) RegisterPlanMapping(ctx context.Context, plan PlanMapping) error {
	plan.ID = strings.TrimSpace(plan.ID)
	plan.Name = strings.TrimSpace(plan.Name)
	plan.PeriodUnit = strings.TrimSpace(plan.PeriodUnit)
	plan.SetID = strings.TrimSpace(plan.SetID)
	if plan.ID == "" {
		return fmt.Errorf("plan id is required")
	}
	if plan.Name == "" {
		plan.Name = plan.ID
	}
	if plan.PeriodValue == 0 {
		plan.PeriodValue = 1
	}
	if plan.PeriodUnit == "" {
		plan.PeriodUnit = "months"
	}
	if plan.UpstreamPlanID <= 0 && len(plan.UpstreamPlanIDs) == 0 {
		return fmt.Errorf("upstream plan id is required")
	}
	return s.store.SavePlanMapping(ctx, plan)
}

func normalizePlan(plan Plan) (Plan, error) {
	plan.ID = strings.TrimSpace(plan.ID)
	plan.Name = strings.TrimSpace(plan.Name)
	plan.PeriodUnit = normalizePeriodUnit(plan.PeriodUnit)
	if plan.ID == "" {
		return Plan{}, fmt.Errorf("plan id is required")
	}
	if plan.Name == "" {
		plan.Name = plan.ID
	}
	if plan.MonthlyTokens < 0 {
		return Plan{}, fmt.Errorf("monthly_tokens must not be negative")
	}
	if plan.PeriodValue <= 0 {
		plan.PeriodValue = 1
	}
	if plan.PeriodUnit == "" {
		plan.PeriodUnit = "months"
	}
	canonical := fmt.Sprintf("%s\x00%s\x00%d\x00%d\x00%s\x00%t",
		plan.ID, plan.Name, plan.MonthlyTokens, plan.PeriodValue, plan.PeriodUnit, plan.IsActive)
	plan.Fingerprint = fmt.Sprintf("%x", sha256.Sum256([]byte(canonical)))
	return plan, nil
}

func (s *Service) RegisterPlan(ctx context.Context, plan Plan) error {
	plan, err := normalizePlan(plan)
	if err != nil {
		return err
	}
	if existing, ok, err := s.store.GetPlan(ctx, plan.ID); err != nil {
		return err
	} else if ok {
		if existing.Fingerprint == plan.Fingerprint {
			return nil
		}
		return ErrPlanImmutableConflict
	}
	if err := s.store.SavePlan(ctx, plan); err != nil {
		return err
	}
	if !plan.IsActive {
		return nil
	}
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return err
	}
	for _, set := range sets {
		if set.Status != SetStatusActive {
			continue
		}
		if _, ok, err := s.store.GetSetPlan(ctx, plan.ID, set.ID); err != nil {
			return err
		} else if ok {
			continue
		}
		if err := s.store.SaveSetPlan(ctx, SetPlan{PlanID: plan.ID, SetID: set.ID, Status: SetPlanStatusPending}); err != nil {
			return err
		}
	}
	return nil
}

// CreatePlan 定义一个不可变权益模板。省略 ID 时由 LLMGateway 生成稳定编号；
// 显式 ID 继续沿用 RegisterPlan 的幂等和不可变语义。
func (s *Service) CreatePlan(ctx context.Context, plan Plan) (Plan, error) {
	if strings.TrimSpace(plan.ID) == "" {
		plan.ID = "plan-" + randomSecret()
	}
	if err := s.RegisterPlan(ctx, plan); err != nil {
		return Plan{}, err
	}
	return s.GetPlan(ctx, plan.ID)
}

func (s *Service) GetPlan(ctx context.Context, planID string) (Plan, error) {
	plan, ok, err := s.store.GetPlan(ctx, strings.TrimSpace(planID))
	if err != nil {
		return Plan{}, err
	}
	if !ok {
		return Plan{}, ErrPlanNotFound
	}
	return plan, nil
}

func (s *Service) ListPlans(ctx context.Context) ([]Plan, error) {
	return s.store.ListPlans(ctx)
}

func (s *Service) ListPlanSets(ctx context.Context, planID string) ([]SetPlan, error) {
	if _, err := s.GetPlan(ctx, planID); err != nil {
		return nil, err
	}
	return s.store.ListSetPlans(ctx, SetPlanListOptions{PlanID: strings.TrimSpace(planID)})
}

func (s *Service) QueuePlanSync(ctx context.Context, planID string, setIDs []string) ([]SetPlan, error) {
	plan, err := s.GetPlan(ctx, planID)
	if err != nil {
		return nil, err
	}
	if !plan.IsActive {
		return nil, ErrPlanNotFound
	}
	requested := make(map[string]struct{}, len(setIDs))
	for _, setID := range setIDs {
		if setID = strings.TrimSpace(setID); setID != "" {
			requested[setID] = struct{}{}
		}
	}
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return nil, err
	}
	queued := make([]SetPlan, 0, len(sets))
	for _, set := range sets {
		if len(requested) > 0 {
			if _, ok := requested[set.ID]; !ok {
				continue
			}
		}
		if set.Status != SetStatusActive {
			continue
		}
		state, ok, err := s.store.GetSetPlan(ctx, plan.ID, set.ID)
		if err != nil {
			return nil, err
		}
		if ok && state.Status == SetPlanStatusReady && state.UpstreamPlanID > 0 {
			queued = append(queued, state)
			continue
		}
		if !ok {
			state = SetPlan{PlanID: plan.ID, SetID: set.ID}
		}
		state.Status = SetPlanStatusPending
		state.LastError = ""
		if err := s.store.SaveSetPlan(ctx, state); err != nil {
			return nil, err
		}
		queued = append(queued, state)
	}
	if len(requested) > 0 && len(queued) != len(requested) {
		return nil, fmt.Errorf("one or more requested sets are missing or inactive")
	}
	return queued, nil
}

func (s *Service) GetPlanMapping(ctx context.Context, planID string) (PlanMapping, error) {
	plan, ok, err := s.store.GetPlanMapping(ctx, strings.TrimSpace(planID))
	if err != nil {
		return PlanMapping{}, err
	}
	if !ok {
		return PlanMapping{}, ErrPlanNotFound
	}
	return plan, nil
}

func (s *Service) ListPlanMappings(ctx context.Context) ([]PlanMapping, error) {
	return s.store.ListPlanMappings(ctx)
}

func (s *Service) ApplySubscription(ctx context.Context, req ApplySubscriptionRequest) (result Subscription, err error) {
	req.IdempotencyKey = strings.TrimSpace(req.IdempotencyKey)
	req.UserID = strings.TrimSpace(req.UserID)
	req.PlanID = strings.TrimSpace(req.PlanID)
	ctx, span := s.startTelemetrySpan(ctx, observability.ScopeTenantEntitlement, "llmgateway.subscription.apply",
		attribute.String("llmgateway.user.id", req.UserID),
		attribute.String("llmgateway.plan.id", req.PlanID),
	)
	defer func() { observability.FinishSpan(span, err, "subscription_apply_failed", s.telemetrySanitizer) }()
	idempotencyEnabled := req.IdempotencyKey != ""
	idempotencyRequestHash := ""
	if idempotencyEnabled {
		if err := validateSubscriptionIdempotencyKey(req.IdempotencyKey); err != nil {
			return Subscription{}, err
		}
	}
	if req.UserID == "" || req.PlanID == "" {
		return Subscription{}, fmt.Errorf("user_id and plan_id are required")
	}
	if idempotencyEnabled {
		now := s.nowUTC()
		requestHash := subscriptionRequestHash(req)
		idempotencyRequestHash = requestHash
		idempotency, acquired, err := s.store.TryBeginSubscriptionIdempotency(ctx, SubscriptionIdempotency{
			IdempotencyKey: req.IdempotencyKey,
			RequestHash:    requestHash,
			Status:         SubscriptionIdempotencyProcessing,
			CreatedAt:      now,
			UpdatedAt:      now,
		})
		if err != nil {
			return Subscription{}, err
		}
		if !acquired {
			if idempotency.RequestHash != requestHash {
				return Subscription{}, fmt.Errorf("%w: %s", ErrSubscriptionIdempotencyConflict, req.IdempotencyKey)
			}
			switch idempotency.Status {
			case SubscriptionIdempotencySucceeded:
				return s.GetActiveSubscription(ctx, req.UserID)
			case SubscriptionIdempotencyUnknown:
				return Subscription{}, fmt.Errorf("%w: %s", ErrSubscriptionOutcomeUnknown, req.IdempotencyKey)
			default:
				return Subscription{}, fmt.Errorf("%w: %s", ErrSubscriptionIdempotencyPending, req.IdempotencyKey)
			}
		}
		s.emitCommittedTransition(ctx, observability.ScopeTenantEntitlement, "llmgateway.subscription_idempotency.state_changed",
			"subscription_idempotency", requestHash, "", "processing",
			s.subscriptionIdempotencyTelemetryAttrs(req, requestHash)...,
		)
	}

	idempotencyFinalized := !idempotencyEnabled
	upstreamCreateAttempted := false
	defer func() {
		if idempotencyFinalized {
			return
		}
		status := SubscriptionIdempotencyFailed
		if upstreamCreateAttempted {
			status = SubscriptionIdempotencyUnknown
		}
		lastError := ""
		if err != nil {
			lastError = err.Error()
		}
		if finishErr := s.finishSubscriptionIdempotency(context.WithoutCancel(ctx), req, idempotencyRequestHash, status, lastError); finishErr != nil {
			err = errors.Join(err, fmt.Errorf("finish subscription idempotency: %w", finishErr))
		}
	}()
	if err := traceGatewayVoid(ctx, "llmgateway.ensure_tenant_can_write", func(spanCtx context.Context) error {
		return s.ensureTenantCanWrite(spanCtx, req.UserID)
	}); err != nil {
		return Subscription{}, err
	}
	plan, err := traceGatewayValue(ctx, "llmgateway.active_plan", func(spanCtx context.Context) (Plan, error) {
		return s.activePlan(spanCtx, req.PlanID)
	})
	if err != nil {
		return Subscription{}, err
	}
	resolvedTarget, err := s.resolvePlanTarget(ctx, req, plan)
	if err != nil {
		return Subscription{}, err
	}
	type bindingPlanTarget struct {
		Binding        UserBinding
		Set            Set
		UpstreamPlanID int
	}
	bindingTarget, err := traceGatewayValue(ctx, "llmgateway.ensure_binding_for_plan", func(spanCtx context.Context) (bindingPlanTarget, error) {
		binding, set, upstreamPlanID, targetErr := s.ensureBindingForPlanTarget(spanCtx, req.UserID, resolvedTarget)
		return bindingPlanTarget{Binding: binding, Set: set, UpstreamPlanID: upstreamPlanID}, targetErr
	})
	if err != nil {
		return Subscription{}, err
	}
	binding, set, upstreamPlanID := bindingTarget.Binding, bindingTarget.Set, bindingTarget.UpstreamPlanID
	span.SetAttributes(
		attribute.String("llmgateway.set.id", set.ID),
		attribute.Int("llmgateway.upstream_plan.id", upstreamPlanID),
	)
	client := s.newAPIClient(set.BaseURL)
	adminAuth := adminAuthForSet(set)
	hadUpstreamUser := binding.UpstreamUserID > 0
	if binding.UpstreamUserID == 0 {
		binding, err = traceGatewayValue(ctx, "llmgateway.ensure_upstream_user", func(spanCtx context.Context) (UserBinding, error) {
			return s.ensureUpstreamUser(spanCtx, client, adminAuth, binding)
		}, attribute.String("llmgateway.set.id", set.ID))
		if err != nil {
			return Subscription{}, err
		}
		span.SetAttributes(attribute.Int("llmgateway.upstream_user.id", binding.UpstreamUserID))
	}
	upstreamCreateAttempted = true
	if err := traceGatewayVoid(ctx, "newapi.admin_create_user_subscription", func(spanCtx context.Context) error {
		return s.withSetSubscriptionWriteLease(spanCtx, set, func(leaseCtx context.Context) error {
			return client.AdminCreateUserSubscription(leaseCtx, adminAuth, binding.UpstreamUserID, newapi.AdminCreateUserSubscriptionRequest{PlanID: upstreamPlanID})
		})
	}, attribute.String("llmgateway.set.id", set.ID), attribute.Int("llmgateway.upstream_user.id", binding.UpstreamUserID), attribute.Int("llmgateway.upstream_plan.id", upstreamPlanID)); err != nil {
		return Subscription{}, err
	}
	binding.LastPlanID = plan.ID
	binding.LastExtendedPeriodEnd = time.Time{}
	if err := traceGatewayVoid(ctx, "store.save_user_binding", func(spanCtx context.Context) error {
		return s.store.SaveUserBinding(spanCtx, binding)
	}); err != nil {
		return Subscription{}, err
	}
	periodStart := s.nowUTC()
	periodEnd, err := subscriptionPeriodEnd(periodStart, req, plan)
	if err != nil {
		return Subscription{}, err
	}
	if err := traceGatewayVoid(ctx, "store.save_subscription_period_overlay", func(spanCtx context.Context) error {
		return s.store.SaveSubscriptionPeriodOverlay(spanCtx, SubscriptionPeriodOverlay{
			ExternalUserID: binding.ExternalUserID,
			SetID:          binding.SetID,
			PeriodEnd:      periodEnd,
		})
	}); err != nil {
		return Subscription{}, err
	}
	if _, err := traceGatewayValue(ctx, "llmgateway.set_user_assignment", func(spanCtx context.Context) (UserAssignment, error) {
		return s.SetUserAssignment(spanCtx, UserAssignment{
			ExternalUserID: binding.ExternalUserID,
			Backend:        UserBackendNew,
			SetID:          binding.SetID,
		})
	}); err != nil {
		return Subscription{}, err
	}
	if !hadUpstreamUser {
		result = projectedSubscriptionFromPlan(binding, plan, periodStart, periodEnd)
	} else {
		result, err = traceGatewayValue(ctx, "llmgateway.get_active_subscription", func(spanCtx context.Context) (Subscription, error) {
			return s.GetActiveSubscription(spanCtx, binding.ExternalUserID)
		})
		if err != nil {
			return Subscription{}, err
		}
		result.PeriodStart = formatUnixTime(periodStart.Unix())
		result.PeriodEnd = formatUnixTime(periodEnd.Unix())
	}
	if idempotencyEnabled {
		if err := s.finishSubscriptionIdempotency(ctx, req, idempotencyRequestHash, SubscriptionIdempotencySucceeded, ""); err != nil {
			return Subscription{}, err
		}
		idempotencyFinalized = true
	}
	s.emitCommittedTransition(ctx, observability.ScopeTenantEntitlement, "llmgateway.entitlement.changed",
		"subscription", result.ID, "", result.Status,
		attribute.String("llmgateway.user.id", binding.ExternalUserID),
		attribute.String("llmgateway.set.id", binding.SetID),
		attribute.String("llmgateway.plan.id", plan.ID),
		attribute.Int("llmgateway.upstream_plan.id", upstreamPlanID),
	)
	s.enqueueTenantObservationEvent(ctx, binding.ExternalUserID, binding.SetID)
	return result, nil
}

func projectedSubscriptionFromPlan(binding UserBinding, plan Plan, periodStart time.Time, periodEnd time.Time) Subscription {
	sub := Subscription{
		ID:           "llmgw-sub-" + binding.SetID + "-" + binding.ExternalUserID,
		UserID:       binding.ExternalUserID,
		PlanID:       plan.ID,
		Status:       "active",
		TokenBalance: plan.MonthlyTokens,
		PeriodStart:  formatUnixTime(periodStart.UTC().Unix()),
		PeriodEnd:    formatUnixTime(periodEnd.UTC().Unix()),
	}
	if plan.MonthlyTokens == 0 {
		sub.Unlimited = true
	}
	return sub
}

func (s *Service) finishSubscriptionIdempotency(ctx context.Context, req ApplySubscriptionRequest, requestHash string, status int, lastError string) error {
	if err := s.store.FinishSubscriptionIdempotency(ctx, req.IdempotencyKey, status, lastError, s.nowUTC()); err != nil {
		return err
	}
	s.emitCommittedTransition(ctx, observability.ScopeTenantEntitlement, "llmgateway.subscription_idempotency.state_changed",
		"subscription_idempotency", requestHash, "processing", subscriptionIdempotencyStatusName(status),
		s.subscriptionIdempotencyTelemetryAttrs(req, requestHash)...,
	)
	return nil
}

func (s *Service) subscriptionIdempotencyTelemetryAttrs(req ApplySubscriptionRequest, requestHash string) []attribute.KeyValue {
	attrs := []attribute.KeyValue{
		attribute.String("llmgateway.user.id", req.UserID),
		attribute.String("llmgateway.plan.id", req.PlanID),
		attribute.String("llmgateway.subscription.request_hash", requestHash),
	}
	if hash, keyID, ok := s.telemetryCorrelator.Hash("subscription-idempotency", req.IdempotencyKey); ok {
		attrs = append(attrs,
			attribute.String("llmgateway.subscription.idempotency_hash", hash),
			attribute.String("llmgateway.hash_key.id", keyID),
		)
	}
	return attrs
}

func subscriptionIdempotencyStatusName(status int) string {
	switch status {
	case SubscriptionIdempotencyProcessing:
		return "processing"
	case SubscriptionIdempotencySucceeded:
		return "succeeded"
	case SubscriptionIdempotencyFailed:
		return "failed"
	case SubscriptionIdempotencyUnknown:
		return "unknown"
	default:
		return "invalid"
	}
}

func (s *Service) ExtendSubscription(ctx context.Context, req ExtendSubscriptionRequest) (result ExtendSubscriptionResponse, err error) {
	req.UserID = strings.TrimSpace(req.UserID)
	ctx, span := s.startTelemetrySpan(ctx, observability.ScopeTenantEntitlement, "llmgateway.subscription.extend",
		attribute.String("llmgateway.user.id", req.UserID),
	)
	defer func() { observability.FinishSpan(span, err, "subscription_extend_failed", s.telemetrySanitizer) }()
	if req.UserID == "" {
		return ExtendSubscriptionResponse{}, fmt.Errorf("user_id is required")
	}
	if req.NewPeriodEnd.IsZero() {
		return ExtendSubscriptionResponse{}, fmt.Errorf("new_period_end is required")
	}
	if err := s.ensureTenantCanWrite(ctx, req.UserID); err != nil {
		return ExtendSubscriptionResponse{}, err
	}
	current, err := s.GetActiveSubscription(ctx, req.UserID)
	if err != nil {
		return ExtendSubscriptionResponse{}, err
	}
	currentEnd, _ := time.Parse(time.RFC3339Nano, current.PeriodEnd)
	binding, ok, err := s.store.GetUserBinding(ctx, req.UserID)
	if err != nil {
		return ExtendSubscriptionResponse{}, err
	}
	if !ok {
		return ExtendSubscriptionResponse{}, ErrSubscriptionNotFound
	}
	targetEnd := req.NewPeriodEnd.UTC()
	if !currentEnd.IsZero() && targetEnd.Equal(currentEnd) {
		return ExtendSubscriptionResponse{Subscription: &current, Updated: false}, nil
	}
	periodStart, err := time.Parse(time.RFC3339Nano, current.PeriodStart)
	if err != nil || periodStart.IsZero() {
		periodStart = s.nowUTC()
	}
	binding.LastExtendedPeriodEnd = targetEnd
	if err := s.store.SaveUserBinding(ctx, binding); err != nil {
		return ExtendSubscriptionResponse{}, err
	}
	if err := s.store.SaveSubscriptionPeriodOverlay(ctx, SubscriptionPeriodOverlay{
		ExternalUserID: binding.ExternalUserID,
		SetID:          binding.SetID,
		PeriodEnd:      targetEnd,
	}); err != nil {
		return ExtendSubscriptionResponse{}, err
	}
	updated := current
	updated.PeriodStart = formatUnixTime(periodStart.UTC().Unix())
	updated.PeriodEnd = formatUnixTime(targetEnd.Unix())
	s.emitTelemetryEvent(ctx, observability.ScopeTenantEntitlement, observability.Event{
		Name: "llmgateway.entitlement.changed", Severity: otellog.SeverityInfo,
		Attributes: []attribute.KeyValue{
			attribute.String("llmgateway.entity.type", "subscription"),
			attribute.String("llmgateway.entity.id", updated.ID),
			attribute.String("llmgateway.user.id", binding.ExternalUserID),
			attribute.String("llmgateway.set.id", binding.SetID),
			attribute.String("llmgateway.plan.id", updated.PlanID),
			attribute.String("llmgateway.operation", "extend"),
			attribute.String("llmgateway.outcome", "success"),
		},
	})
	s.enqueueTenantObservationEvent(ctx, binding.ExternalUserID, binding.SetID)
	return ExtendSubscriptionResponse{Subscription: &updated, Updated: true}, nil
}

func (s *Service) CancelSubscription(ctx context.Context, externalUserID string) (err error) {
	externalUserID = strings.TrimSpace(externalUserID)
	ctx, span := s.startTelemetrySpan(ctx, observability.ScopeTenantEntitlement, "llmgateway.subscription.cancel",
		attribute.String("llmgateway.user.id", externalUserID),
	)
	defer func() { observability.FinishSpan(span, err, "subscription_cancel_failed", s.telemetrySanitizer) }()
	if externalUserID == "" {
		return fmt.Errorf("user_id is required")
	}
	binding, ok, err := s.store.GetUserBinding(ctx, externalUserID)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	set, ok, err := s.store.GetSet(ctx, binding.SetID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("set %q not found", binding.SetID)
	}
	if set.AdminAccessToken == "" || set.AdminUserID == 0 {
		return fmt.Errorf("set %q is not bootstrapped", set.ID)
	}
	if binding.UpstreamUserID == 0 {
		if err := s.store.DeleteSubscriptionPeriodOverlay(ctx, externalUserID); err != nil {
			return err
		}
		s.enqueueTenantObservationEvent(ctx, externalUserID, binding.SetID)
		s.emitCommittedTransition(ctx, observability.ScopeTenantEntitlement, "llmgateway.entitlement.changed",
			"subscription", externalUserID, "active", "cancelled",
			attribute.String("llmgateway.user.id", externalUserID),
			attribute.String("llmgateway.set.id", binding.SetID),
		)
		return nil
	}
	if err := s.invalidateActiveSubscriptions(ctx, s.newAPIClient(set.BaseURL), adminAuthForSet(set), binding.UpstreamUserID); err != nil {
		return err
	}
	if err := s.store.DeleteSubscriptionPeriodOverlay(ctx, externalUserID); err != nil {
		return err
	}
	s.emitCommittedTransition(ctx, observability.ScopeTenantEntitlement, "llmgateway.entitlement.changed",
		"subscription", externalUserID, "active", "cancelled",
		attribute.String("llmgateway.user.id", externalUserID),
		attribute.String("llmgateway.set.id", binding.SetID),
	)
	s.enqueueTenantObservationEvent(ctx, externalUserID, binding.SetID)
	return nil
}

func (s *Service) GetActiveSubscription(ctx context.Context, externalUserID string) (Subscription, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return Subscription{}, fmt.Errorf("user_id is required")
	}
	binding, ok, err := s.store.GetUserBinding(ctx, externalUserID)
	if err != nil {
		return Subscription{}, err
	}
	if !ok || binding.UpstreamUserID == 0 {
		return Subscription{}, ErrSubscriptionNotFound
	}
	set, ok, err := s.store.GetSet(ctx, binding.SetID)
	if err != nil {
		return Subscription{}, err
	}
	if !ok {
		return Subscription{}, fmt.Errorf("set %q not found", binding.SetID)
	}
	if set.AdminAccessToken == "" || set.AdminUserID == 0 {
		return Subscription{}, fmt.Errorf("set %q is not bootstrapped", set.ID)
	}
	subs, err := s.newAPIClient(set.BaseURL).AdminListUserSubscriptions(ctx, adminAuthForSet(set), binding.UpstreamUserID)
	if err != nil {
		return Subscription{}, err
	}
	sub, err := s.aggregateSubscription(ctx, binding, subs)
	if err != nil {
		return Subscription{}, err
	}
	return s.applySubscriptionPeriodOverlay(ctx, binding, sub)
}

func (s *Service) activePlan(ctx context.Context, planID string) (Plan, error) {
	plan, err := s.GetPlan(ctx, planID)
	if err != nil {
		return Plan{}, err
	}
	if !plan.IsActive {
		return Plan{}, ErrPlanNotFound
	}
	return plan, nil
}

func (s *Service) ensureBindingForPlan(ctx context.Context, externalUserID string, plan Plan) (UserBinding, Set, int, error) {
	return s.ensureBindingForPlanTarget(ctx, externalUserID, defaultPlanTarget(plan))
}

func (s *Service) ensureBindingForPlanTarget(ctx context.Context, externalUserID string, target planTarget) (UserBinding, Set, int, error) {
	if binding, ok, err := s.store.GetUserBinding(ctx, externalUserID); err != nil {
		return UserBinding{}, Set{}, 0, err
	} else if ok {
		if binding.UpstreamUserID == 0 {
			if set, setOK, setErr := s.store.GetSet(ctx, binding.SetID); setErr != nil {
				return UserBinding{}, Set{}, 0, setErr
			} else if !setOK || !setReadyForServing(set) {
				set, upstreamPlanID, err := s.pickSetForPlanTarget(ctx, target)
				if err != nil {
					return UserBinding{}, Set{}, 0, err
				}
				binding.SetID = set.ID
				binding.ProvisionStatus = BindingProvisionStatusAllocated
				binding.LastProvisionError = ""
				if err := s.store.SaveUserBinding(ctx, binding); err != nil {
					return UserBinding{}, Set{}, 0, err
				}
				return binding, set, upstreamPlanID, nil
			}
		}
		if _, readyErr := s.readySetPlanTargetID(ctx, target, binding.SetID); readyErr != nil && binding.UpstreamUserID == 0 {
			set, upstreamPlanID, err := s.pickSetForPlanTarget(ctx, target)
			if err != nil {
				return UserBinding{}, Set{}, 0, err
			}
			binding.SetID = set.ID
			binding.ProvisionStatus = BindingProvisionStatusAllocated
			if err := s.store.SaveUserBinding(ctx, binding); err != nil {
				return UserBinding{}, Set{}, 0, err
			}
			return binding, set, upstreamPlanID, nil
		}
		set, upstreamPlanID, err := s.setAndPlanForBindingTarget(ctx, binding, target)
		return binding, set, upstreamPlanID, err
	}

	set, upstreamPlanID, err := s.pickSetForPlanTarget(ctx, target)
	if err != nil {
		return UserBinding{}, Set{}, 0, err
	}
	binding := UserBinding{
		ExternalUserID:  externalUserID,
		SetID:           set.ID,
		Username:        newAPIUsername(externalUserID),
		Password:        randomNewAPIPassword(),
		ProvisionStatus: BindingProvisionStatusAllocated,
	}
	if err := s.store.SaveUserBinding(ctx, binding); err != nil {
		return UserBinding{}, Set{}, 0, err
	}
	return binding, set, upstreamPlanID, nil
}

func (s *Service) setAndPlanForBinding(ctx context.Context, binding UserBinding, plan Plan) (Set, int, error) {
	return s.setAndPlanForBindingTarget(ctx, binding, defaultPlanTarget(plan))
}

func (s *Service) setAndPlanForBindingTarget(ctx context.Context, binding UserBinding, target planTarget) (Set, int, error) {
	set, ok, err := s.store.GetSet(ctx, binding.SetID)
	if err != nil {
		return Set{}, 0, err
	}
	if !ok {
		return Set{}, 0, fmt.Errorf("set %q not found", binding.SetID)
	}
	if set.Status == SetStatusDisabled {
		return Set{}, 0, fmt.Errorf("set %q is disabled", set.ID)
	}
	if set.AdminAccessToken == "" || set.AdminUserID == 0 {
		return Set{}, 0, fmt.Errorf("set %q is not bootstrapped", set.ID)
	}
	upstreamPlanID, err := s.readySetPlanTargetID(ctx, target, set.ID)
	if err != nil {
		return Set{}, 0, err
	}
	return set, upstreamPlanID, nil
}

func (s *Service) pickSetForPlan(ctx context.Context, plan Plan) (Set, int, error) {
	return s.pickSetForPlanTarget(ctx, defaultPlanTarget(plan))
}

func (s *Service) pickSetForPlanTarget(ctx context.Context, target planTarget) (Set, int, error) {
	plan := target.Plan
	upstreamPlanIDs := map[string]int{}
	hasReadyActiveSet := false
	candidate, ok, err := s.capacityPicker().PickSet(ctx, func(set Set) bool {
		if set.Status != SetStatusActive {
			return false
		}
		upstreamPlanID, readyErr := s.readySetPlanTargetID(ctx, target, set.ID)
		if readyErr != nil {
			return false
		}
		hasReadyActiveSet = true
		upstreamPlanIDs[set.ID] = upstreamPlanID
		return true
	})
	if err != nil {
		return Set{}, 0, err
	}
	if ok {
		return candidate, upstreamPlanIDs[candidate.ID], nil
	}
	if hasReadyActiveSet {
		return Set{}, 0, fmt.Errorf("no active set has available capacity for plan %q", plan.ID)
	}
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return Set{}, 0, err
	}
	for _, set := range sets {
		if set.Status != SetStatusActive {
			continue
		}
		upstreamPlanID, readyErr := s.readySetPlanTargetID(ctx, target, set.ID)
		if readyErr != nil {
			continue
		}
		if set.AdminAccessToken == "" || set.AdminUserID == 0 {
			return Set{}, 0, fmt.Errorf("set %q is not bootstrapped", set.ID)
		}
		return set, upstreamPlanID, nil
	}
	return Set{}, 0, ErrPlanNotReady
}

func (s *Service) readySetPlanID(ctx context.Context, planID string, setID string) (int, error) {
	state, ok, err := s.store.GetSetPlan(ctx, planID, setID)
	if err != nil {
		return 0, err
	}
	if !ok || state.Status != SetPlanStatusReady || state.UpstreamPlanID <= 0 {
		return 0, ErrPlanNotReady
	}
	return state.UpstreamPlanID, nil
}

func normalizePeriodUnit(unit string) string {
	switch strings.ToLower(strings.TrimSpace(unit)) {
	case "m", "month", "months":
		return "months"
	case "d", "day", "days":
		return "days"
	case "y", "year", "years":
		return "years"
	case "h", "hour", "hours":
		return "hours"
	default:
		return strings.TrimSpace(unit)
	}
}

func subscriptionPeriodEnd(start time.Time, req ApplySubscriptionRequest, plan Plan) (time.Time, error) {
	value := req.PeriodValue
	if value == 0 {
		value = plan.PeriodValue
	}
	unit := normalizePeriodUnit(req.PeriodUnit)
	if unit == "" {
		unit = normalizePeriodUnit(plan.PeriodUnit)
	}
	return addSubscriptionPeriod(start, value, unit)
}

func addSubscriptionPeriod(start time.Time, value int, unit string) (time.Time, error) {
	if value <= 0 {
		return time.Time{}, fmt.Errorf("period value must be positive")
	}
	switch normalizePeriodUnit(unit) {
	case "months":
		return addMonthsNatural(start, value), nil
	case "days":
		return start.AddDate(0, 0, value), nil
	case "years":
		return start.AddDate(value, 0, 0), nil
	case "hours":
		return start.Add(time.Duration(value) * time.Hour), nil
	default:
		return time.Time{}, fmt.Errorf("unsupported period unit %q", unit)
	}
}

func addMonthsNatural(start time.Time, months int) time.Time {
	year, month, day := start.Date()
	targetYear, targetMonth := year, month+time.Month(months)
	for targetMonth > 12 {
		targetMonth -= 12
		targetYear++
	}
	maxDay := daysInMonth(targetYear, targetMonth)
	if day > maxDay {
		day = maxDay
	}
	return time.Date(targetYear, targetMonth, day,
		start.Hour(), start.Minute(), start.Second(), start.Nanosecond(), start.Location())
}

func daysInMonth(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func (s *Service) invalidateActiveSubscriptions(ctx context.Context, client *newapi.Client, auth newapi.AdminAuth, upstreamUserID int) error {
	subs, err := s.listActiveSubscriptions(ctx, client, auth, upstreamUserID)
	if err != nil {
		return err
	}
	for _, sub := range subs {
		if err := client.AdminInvalidateUserSubscription(ctx, auth, sub.ID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) listActiveSubscriptions(ctx context.Context, client *newapi.Client, auth newapi.AdminAuth, upstreamUserID int) ([]newapi.UserSubscription, error) {
	if upstreamUserID <= 0 {
		return nil, fmt.Errorf("upstream user id is required")
	}
	subs, err := client.AdminListUserSubscriptions(ctx, auth, upstreamUserID)
	if err != nil {
		return nil, err
	}
	now := s.nowUTC().Unix()
	active := make([]newapi.UserSubscription, 0, len(subs))
	for _, sub := range subs {
		if isActiveUpstreamSubscription(sub, now) {
			active = append(active, sub)
		}
	}
	return active, nil
}

func (s *Service) aggregateSubscription(ctx context.Context, binding UserBinding, subs []newapi.UserSubscription) (Subscription, error) {
	now := s.nowUTC().Unix()
	activeSubs := make([]newapi.UserSubscription, 0, len(subs))
	for _, sub := range subs {
		if isActiveUpstreamSubscription(sub, now) {
			activeSubs = append(activeSubs, sub)
		}
	}
	if len(activeSubs) == 0 {
		return Subscription{}, ErrSubscriptionNotFound
	}

	periodStart := activeSubs[0].StartTime
	periodEnd := activeSubs[0].EndTime
	tokenBalance := int64(0)
	unlimited := false
	planID := binding.LastPlanID
	for _, sub := range activeSubs {
		if sub.StartTime > 0 && (periodStart == 0 || sub.StartTime < periodStart) {
			periodStart = sub.StartTime
		}
		if sub.EndTime > periodEnd {
			periodEnd = sub.EndTime
		}
		if sub.AmountTotal == 0 {
			unlimited = true
			continue
		}
		remain := sub.AmountTotal - sub.AmountUsed
		if remain > 0 {
			tokenBalance += remain
		}
		if planID == "" {
			planID = s.externalPlanIDForUpstream(ctx, binding.SetID, sub.PlanID)
		}
	}
	if unlimited {
		tokenBalance = 0
	}
	if planID == "" {
		planID = strconv.Itoa(activeSubs[0].PlanID)
	}
	if periodStart == 0 {
		periodStart = now
	}
	if periodEnd == 0 {
		periodEnd = now
	}
	return Subscription{
		ID:           "llmgw-sub-" + binding.SetID + "-" + binding.ExternalUserID,
		UserID:       binding.ExternalUserID,
		PlanID:       planID,
		Status:       "active",
		TokenBalance: tokenBalance,
		Unlimited:    unlimited,
		PeriodStart:  formatUnixTime(periodStart),
		PeriodEnd:    formatUnixTime(periodEnd),
	}, nil
}

func (s *Service) applySubscriptionPeriodOverlay(ctx context.Context, binding UserBinding, sub Subscription) (Subscription, error) {
	overlay, ok, err := s.store.GetSubscriptionPeriodOverlay(ctx, binding.ExternalUserID)
	if err != nil {
		return Subscription{}, err
	}
	if !ok {
		return sub, nil
	}
	if overlay.SetID != "" && overlay.SetID != binding.SetID {
		return sub, nil
	}
	periodEnd := overlay.PeriodEnd.UTC()
	if periodEnd.IsZero() {
		return sub, nil
	}
	if !periodEnd.After(s.nowUTC()) {
		return Subscription{}, ErrSubscriptionNotFound
	}
	sub.PeriodEnd = formatUnixTime(periodEnd.Unix())
	return sub, nil
}

func (s *Service) externalPlanIDForUpstream(ctx context.Context, setID string, upstreamPlanID int) string {
	plans, err := s.store.ListPlans(ctx)
	if err != nil {
		return ""
	}
	for _, plan := range plans {
		id, readyErr := s.readySetPlanID(ctx, plan.ID, setID)
		if readyErr == nil && id == upstreamPlanID {
			return plan.ID
		}
	}
	return ""
}

func isActiveUpstreamSubscription(sub newapi.UserSubscription, now int64) bool {
	return sub.ID > 0 && sub.Status == "active" && (sub.EndTime == 0 || sub.EndTime > now)
}

func adminAuthForSet(set Set) newapi.AdminAuth {
	return newapi.AdminAuth{UserID: set.AdminUserID, AccessToken: set.AdminAccessToken}
}

func (s *Service) CreateExternalKey(ctx context.Context, externalUserID string) (result APIKeyBinding, err error) {
	return s.createExternalKey(ctx, externalUserID, "")
}

func (s *Service) createExternalKey(ctx context.Context, externalUserID string, purpose string) (result APIKeyBinding, err error) {
	externalUserID = strings.TrimSpace(externalUserID)
	ctx, span := s.startTelemetrySpan(ctx, observability.ScopeTenantEntitlement, "llmgateway.key.issue", attribute.String("llmgateway.user.id", externalUserID))
	defer func() { observability.FinishSpan(span, err, "key_issue_failed", s.telemetrySanitizer) }()
	if err := traceGatewayVoid(ctx, "llmgateway.ensure_tenant_can_write", func(spanCtx context.Context) error {
		return s.ensureTenantCanWrite(spanCtx, externalUserID)
	}); err != nil {
		return APIKeyBinding{}, err
	}
	binding, err := traceGatewayValue(ctx, "llmgateway.ensure_user_binding", func(spanCtx context.Context) (UserBinding, error) {
		return s.EnsureUserBinding(spanCtx, externalUserID)
	})
	if err != nil {
		return APIKeyBinding{}, err
	}
	span.SetAttributes(attribute.String("llmgateway.set.id", binding.SetID))
	set, err := traceGatewayValue(ctx, "store.get_set", func(spanCtx context.Context) (Set, error) {
		set, ok, storeErr := s.store.GetSet(spanCtx, binding.SetID)
		if storeErr != nil {
			return Set{}, storeErr
		}
		if !ok {
			return Set{}, fmt.Errorf("set %q not found", binding.SetID)
		}
		return set, nil
	}, attribute.String("llmgateway.set.id", binding.SetID))
	if err != nil {
		return APIKeyBinding{}, err
	}
	if set.AdminAccessToken == "" || set.AdminUserID == 0 {
		return APIKeyBinding{}, fmt.Errorf("set %q is not bootstrapped", set.ID)
	}
	client := s.newAPIClient(set.BaseURL)
	adminAuth := newapi.AdminAuth{UserID: set.AdminUserID, AccessToken: set.AdminAccessToken}
	if binding.UpstreamUserID == 0 {
		binding, err = traceGatewayValue(ctx, "llmgateway.ensure_upstream_user", func(spanCtx context.Context) (UserBinding, error) {
			return s.ensureUpstreamUser(spanCtx, client, adminAuth, binding)
		}, attribute.String("llmgateway.set.id", set.ID))
		if err != nil {
			return APIKeyBinding{}, err
		}
		span.SetAttributes(attribute.Int("llmgateway.upstream_user.id", binding.UpstreamUserID))
	}
	keyBinding, err := traceGatewayValue(ctx, "llmgateway.create_external_key_for_binding", func(spanCtx context.Context) (APIKeyBinding, error) {
		return s.createExternalKeyForBinding(spanCtx, binding, set, purpose)
	}, attribute.String("llmgateway.set.id", set.ID), attribute.Int("llmgateway.upstream_user.id", binding.UpstreamUserID))
	if err != nil {
		return APIKeyBinding{}, err
	}
	span.SetAttributes(attribute.String("llmgateway.external_key.id", keyBinding.ExternalKeyID))
	if _, err := traceGatewayValue(ctx, "llmgateway.set_user_assignment", func(spanCtx context.Context) (UserAssignment, error) {
		return s.SetUserAssignment(spanCtx, UserAssignment{
			ExternalUserID: externalUserID,
			Backend:        UserBackendNew,
			SetID:          set.ID,
		})
	}); err != nil {
		return APIKeyBinding{}, err
	}
	s.emitCommittedTransition(ctx, observability.ScopeTenantEntitlement, "llmgateway.key.changed",
		"external_key", keyBinding.ExternalKeyID, "", "issued",
		attribute.String("llmgateway.user.id", externalUserID),
		attribute.String("llmgateway.set.id", set.ID),
		attribute.String("llmgateway.external_key.id", keyBinding.ExternalKeyID),
	)
	return keyBinding, nil
}

func (s *Service) createExternalKeyForBinding(ctx context.Context, binding UserBinding, set Set, purpose string) (APIKeyBinding, error) {
	purpose, err := normalizeAPIKeyPurpose(purpose)
	if err != nil {
		return APIKeyBinding{}, err
	}
	if binding.ExternalUserID == "" {
		return APIKeyBinding{}, fmt.Errorf("external user id is required")
	}
	if binding.UpstreamUserID == 0 {
		return APIKeyBinding{}, fmt.Errorf("upstream user id is required")
	}
	if binding.Username == "" || binding.Password == "" {
		return APIKeyBinding{}, fmt.Errorf("upstream username and password are required")
	}
	client := s.newAPIClient(set.BaseURL)
	if _, err := traceGatewayValue(ctx, "newapi.user_login", func(spanCtx context.Context) (newapi.Session, error) {
		return client.Login(spanCtx, binding.Username, binding.Password)
	}, attribute.String("llmgateway.set.id", set.ID), attribute.Int("llmgateway.upstream_user.id", binding.UpstreamUserID)); err != nil {
		s.markBindingProvisionFailed(ctx, binding, err)
		return APIKeyBinding{}, err
	}
	userAccessToken, err := traceGatewayValue(ctx, "newapi.generate_access_token", func(spanCtx context.Context) (string, error) {
		return client.GenerateAccessToken(spanCtx, binding.UpstreamUserID)
	}, attribute.String("llmgateway.set.id", set.ID), attribute.Int("llmgateway.upstream_user.id", binding.UpstreamUserID))
	if err != nil {
		s.markBindingProvisionFailed(ctx, binding, err)
		return APIKeyBinding{}, err
	}
	keyBinding, err := s.reserveExternalKeyBinding(ctx, binding, set, purpose)
	if err != nil {
		return APIKeyBinding{}, err
	}
	externalKeyID := keyBinding.ExternalKeyID
	upstreamKey, err := traceGatewayValue(ctx, "newapi.create_user_token", func(spanCtx context.Context) (newapi.UpstreamKey, error) {
		return client.CreateUserToken(spanCtx, binding.UpstreamUserID, userAccessToken, newapi.CreateTokenRequest{
			Name:           newAPIExternalTokenName(externalKeyID),
			ExpiredTime:    -1,
			UnlimitedQuota: true,
			Group:          newAPIDefaultGroup,
		})
	}, attribute.String("llmgateway.set.id", set.ID), attribute.Int("llmgateway.upstream_user.id", binding.UpstreamUserID), attribute.String("llmgateway.external_key.id", externalKeyID))
	if err != nil {
		_, _ = s.store.TransitionAPIKeyBinding(context.WithoutCancel(ctx), externalKeyID, APIKeyStatusReserved, APIKeyStatusError, "", 0, err.Error(), s.nowUTC())
		s.markBindingProvisionFailed(ctx, binding, err)
		return APIKeyBinding{}, err
	}
	if _, err := traceGatewayValue(ctx, "store.save_api_key_upstream", func(spanCtx context.Context) (APIKeyBinding, error) {
		return s.store.TransitionAPIKeyBinding(spanCtx, externalKeyID, APIKeyStatusReserved, APIKeyStatusUpstreamReady, upstreamKey.Key, upstreamKey.ID, "", s.nowUTC())
	}, attribute.String("llmgateway.set.id", set.ID), attribute.String("llmgateway.external_key.id", externalKeyID)); err != nil {
		return APIKeyBinding{}, err
	}
	keyBinding.UpstreamKey = upstreamKey.Key
	keyBinding.UpstreamKeyID = upstreamKey.ID
	keyBinding.Status = APIKeyStatusUpstreamReady
	keyBinding.UpdatedAt = s.nowUTC()
	if _, err := s.store.TransitionAPIKeyBinding(ctx, externalKeyID, APIKeyStatusUpstreamReady, APIKeyStatusRoutePending, "", 0, "", s.nowUTC()); err != nil {
		return APIKeyBinding{}, err
	}
	keyBinding.Status = APIKeyStatusRoutePending
	if err := traceGatewayVoid(ctx, "route_cache.write_snapshot", func(spanCtx context.Context) error {
		return s.cacheTrafficRouteSnapshotForBinding(spanCtx, keyBinding, set)
	}, attribute.String("llmgateway.set.id", set.ID), attribute.String("llmgateway.external_key.id", externalKeyID)); err != nil {
		_, _ = s.store.TransitionAPIKeyBinding(context.WithoutCancel(ctx), externalKeyID, APIKeyStatusRoutePending, APIKeyStatusRoutePending, "", 0, err.Error(), s.nowUTC())
		return APIKeyBinding{}, fmt.Errorf("publish external key route: %w", err)
	}
	activated, err := s.activateAPIKeyBinding(ctx, externalKeyID)
	if err != nil {
		return APIKeyBinding{}, err
	}
	keyBinding.Status = activated.Status
	keyBinding.LastError = activated.LastError
	keyBinding.UpdatedAt = activated.UpdatedAt
	binding.ProvisionStatus = BindingProvisionStatusTokenReady
	binding.LastProvisionError = ""
	if err := traceGatewayVoid(ctx, "store.save_user_binding", func(spanCtx context.Context) error {
		return s.store.SaveUserBinding(spanCtx, binding)
	}, attribute.String("llmgateway.set.id", set.ID)); err != nil {
		return APIKeyBinding{}, err
	}
	return keyBinding, nil
}

func (s *Service) activateAPIKeyBinding(ctx context.Context, externalKeyID string) (APIKeyBinding, error) {
	binding, err := s.store.TransitionAPIKeyBinding(ctx, externalKeyID, APIKeyStatusRoutePending, APIKeyStatusActive, "", 0, "", s.nowUTC())
	if err == nil || !errors.Is(err, ErrAPIKeyStateConflict) {
		return binding, err
	}
	current, ok, getErr := s.store.GetAPIKeyBindingByExternalKeyID(ctx, externalKeyID)
	if getErr != nil {
		return APIKeyBinding{}, getErr
	}
	if !ok || current.Status != APIKeyStatusActive {
		return APIKeyBinding{}, err
	}
	return current, nil
}

const externalKeyReservationAttempts = 5

func newAPIExternalTokenName(externalKeyID string) string {
	const prefix = "sgw-"
	const maxNameLength = 20

	externalKeyID = strings.TrimSpace(externalKeyID)
	if len(externalKeyID) > maxNameLength-len(prefix) {
		externalKeyID = externalKeyID[:maxNameLength-len(prefix)]
	}
	return prefix + externalKeyID
}

func (s *Service) reserveExternalKeyBinding(ctx context.Context, binding UserBinding, set Set, purpose string) (APIKeyBinding, error) {
	for attempt := 0; attempt < externalKeyReservationAttempts; attempt++ {
		material, err := generateExternalKeyV2(s.options.ExternalKeyRandom)
		if err != nil {
			return APIKeyBinding{}, err
		}
		now := s.nowUTC()
		candidate := APIKeyBinding{
			ExternalKey:     material.ExternalKey,
			ExternalKeyHash: material.ExternalKeyHash,
			ExternalKeyID:   material.ExternalKeyID,
			SecretHash:      material.SecretHash,
			KeyVersion:      material.Version,
			RouteSlot:       material.RouteSlot,
			Purpose:         purpose,
			SetID:           set.ID,
			UserID:          binding.ExternalUserID,
			Status:          APIKeyStatusReserved,
			CreatedAt:       now,
			UpdatedAt:       now,
		}
		err = traceGatewayVoid(ctx, "store.reserve_api_key_binding", func(spanCtx context.Context) error {
			return s.store.ReserveAPIKeyBinding(spanCtx, candidate)
		}, attribute.String("llmgateway.set.id", set.ID), attribute.String("llmgateway.external_key.id", candidate.ExternalKeyID))
		if err == nil {
			return candidate, nil
		}
		if !errors.Is(err, ErrAPIKeyRandomCollision) {
			return APIKeyBinding{}, err
		}
	}
	return APIKeyBinding{}, fmt.Errorf("reserve external api key after %d attempts: %w", externalKeyReservationAttempts, ErrAPIKeyRandomCollision)
}

func (s *Service) RevokeExternalKey(ctx context.Context, externalKeyID string) (err error) {
	externalKeyID = strings.TrimSpace(externalKeyID)
	ctx, span := s.startTelemetrySpan(ctx, observability.ScopeTenantEntitlement, "llmgateway.key.revoke",
		attribute.String("llmgateway.external_key.id", externalKeyID),
	)
	defer func() { observability.FinishSpan(span, err, "key_revoke_failed", s.telemetrySanitizer) }()
	if externalKeyID == "" {
		return fmt.Errorf("external key id is required")
	}
	binding, ok, err := s.store.GetAPIKeyBindingByExternalKeyID(ctx, externalKeyID)
	if err != nil {
		return err
	}
	if ok {
		if err := s.deleteCachedAPIKeyBinding(ctx, binding); err != nil {
			return err
		}
		if err := s.deleteCachedTrafficRoute(ctx, binding); err != nil {
			return err
		}
	}
	if err := s.store.DeleteAPIKeyBindingByExternalKeyID(ctx, externalKeyID); err != nil {
		return err
	}
	if ok {
		s.emitCommittedTransition(ctx, observability.ScopeTenantEntitlement, "llmgateway.key.changed",
			"external_key", externalKeyID, "issued", "revoked",
			attribute.String("llmgateway.user.id", binding.UserID),
			attribute.String("llmgateway.set.id", binding.SetID),
			attribute.String("llmgateway.external_key.id", externalKeyID),
		)
	}
	if ok {
		if err := s.deleteCachedAPIKeyBinding(ctx, binding); err != nil {
			return err
		}
		if err := s.deleteCachedTrafficRoute(ctx, binding); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) ensureUpstreamUser(ctx context.Context, client *newapi.Client, adminAuth newapi.AdminAuth, binding UserBinding) (UserBinding, error) {
	if err := traceGatewayVoid(ctx, "newapi.admin_create_user", func(spanCtx context.Context) error {
		return client.CreateUser(spanCtx, adminAuth, newapi.CreateUserRequest{
			Username:    binding.Username,
			Password:    binding.Password,
			DisplayName: binding.Username,
			Role:        1,
		})
	}, attribute.String("llmgateway.set.id", binding.SetID)); err != nil {
		if !newapi.IsUsernameDuplicateError(err) {
			s.markBindingProvisionFailed(ctx, binding, err)
			return UserBinding{}, err
		}
		resolvedBinding, resolveErr := traceGatewayValue(ctx, "newapi.resolve_user_by_login", func(spanCtx context.Context) (UserBinding, error) {
			return s.resolveUpstreamUserByLogin(spanCtx, client, binding)
		}, attribute.String("llmgateway.set.id", binding.SetID), attribute.Bool("llmgateway.username.duplicate", true))
		if resolveErr == nil {
			return resolvedBinding, nil
		}
		return traceGatewayValue(ctx, "newapi.bind_existing_upstream_user", func(spanCtx context.Context) (UserBinding, error) {
			return s.bindExistingUpstreamUser(spanCtx, client, adminAuth, binding)
		}, attribute.String("llmgateway.set.id", binding.SetID))
	}
	resolvedBinding, err := traceGatewayValue(ctx, "newapi.resolve_user_by_login", func(spanCtx context.Context) (UserBinding, error) {
		return s.resolveUpstreamUserByLogin(spanCtx, client, binding)
	}, attribute.String("llmgateway.set.id", binding.SetID))
	if err == nil {
		return resolvedBinding, nil
	}
	return traceGatewayValue(ctx, "newapi.bind_existing_upstream_user", func(spanCtx context.Context) (UserBinding, error) {
		return s.bindExistingUpstreamUser(spanCtx, client, adminAuth, binding)
	}, attribute.String("llmgateway.set.id", binding.SetID))
}

func (s *Service) resolveUpstreamUserByLogin(ctx context.Context, client *newapi.Client, binding UserBinding) (UserBinding, error) {
	user, err := traceGatewayValue(ctx, "newapi.user_login_resolve_id", func(spanCtx context.Context) (newapi.User, error) {
		return client.ResolveUserByLogin(spanCtx, binding.Username, binding.Password)
	}, attribute.String("llmgateway.set.id", binding.SetID))
	if err != nil {
		return UserBinding{}, err
	}
	binding.UpstreamUserID = user.ID
	binding.ProvisionStatus = BindingProvisionStatusUserReady
	binding.LastProvisionError = ""
	if err := traceGatewayVoid(ctx, "store.save_user_binding", func(spanCtx context.Context) error {
		return s.store.SaveUserBinding(spanCtx, binding)
	}, attribute.String("llmgateway.set.id", binding.SetID), attribute.Int("llmgateway.upstream_user.id", binding.UpstreamUserID)); err != nil {
		return UserBinding{}, err
	}
	return binding, nil
}

func (s *Service) bindExistingUpstreamUser(ctx context.Context, client *newapi.Client, adminAuth newapi.AdminAuth, binding UserBinding) (UserBinding, error) {
	existingUser, err := traceGatewayValue(ctx, "newapi.find_user", func(spanCtx context.Context) (newapi.User, error) {
		return client.FindUser(spanCtx, adminAuth, binding.Username)
	}, attribute.String("llmgateway.set.id", binding.SetID))
	if err != nil {
		s.markBindingProvisionFailed(ctx, binding, err)
		return UserBinding{}, err
	}
	if err := traceGatewayVoid(ctx, "newapi.update_user_password", func(spanCtx context.Context) error {
		return client.UpdateUserPassword(spanCtx, adminAuth, existingUser, binding.Password)
	}, attribute.String("llmgateway.set.id", binding.SetID), attribute.Int("llmgateway.upstream_user.id", existingUser.ID)); err != nil {
		s.markBindingProvisionFailed(ctx, binding, err)
		return UserBinding{}, err
	}
	binding.UpstreamUserID = existingUser.ID
	binding.ProvisionStatus = BindingProvisionStatusUserReady
	binding.LastProvisionError = ""
	if err := traceGatewayVoid(ctx, "store.save_user_binding", func(spanCtx context.Context) error {
		return s.store.SaveUserBinding(spanCtx, binding)
	}, attribute.String("llmgateway.set.id", binding.SetID), attribute.Int("llmgateway.upstream_user.id", binding.UpstreamUserID)); err != nil {
		return UserBinding{}, err
	}
	return binding, nil
}

func (s *Service) markBindingProvisionFailed(ctx context.Context, binding UserBinding, cause error) {
	if strings.TrimSpace(binding.ExternalUserID) == "" {
		return
	}
	binding.ProvisionStatus = BindingProvisionStatusFailed
	if cause != nil {
		binding.LastProvisionError = cause.Error()
	}
	_ = s.store.SaveUserBinding(ctx, binding)
}

func (s *Service) ProxyHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	accessLog := AccessLog{
		Time:   start.UTC().Format(time.RFC3339Nano),
		Event:  "llmgateway_access",
		Method: r.Method,
		Path:   r.URL.Path,
		Status: http.StatusInternalServerError,
	}
	defer func() {
		accessLog.DurationMS = time.Since(start).Milliseconds()
		s.recordTrafficMetrics(accessLog)
		s.emitAccessLog(accessLog)
	}()

	externalKey := bearerToken(r.Header.Get("Authorization"))
	if externalKey == "" {
		accessLog.Status = http.StatusUnauthorized
		accessLog.ErrorType = "missing_bearer_token"
		http.Error(w, "missing bearer token", http.StatusUnauthorized)
		return
	}
	accessLog.ExternalKeyHashPrefix = externalKeyHashPrefix(externalKey)
	if _, handled := s.tryProxyWithTrafficRouteSnapshot(w, r, externalKey, &accessLog); handled {
		return
	}
	binding, ok, err := s.lookupAPIKeyBinding(r.Context(), externalKey)
	if err != nil {
		accessLog.Status = http.StatusInternalServerError
		accessLog.ErrorType = "store_error"
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok {
		accessLog.Status = http.StatusUnauthorized
		accessLog.ErrorType = "invalid_bearer_token"
		http.Error(w, "invalid bearer token", http.StatusUnauthorized)
		return
	}
	accessLog.ExternalKeyID = binding.ExternalKeyID
	accessLog.SetID = binding.SetID
	if err := s.ensureTenantCanUseTraffic(r.Context(), binding.UserID); err != nil {
		accessLog.Status = http.StatusForbidden
		accessLog.ErrorType = "tenant_inactive"
		http.Error(w, "tenant inactive", http.StatusForbidden)
		return
	}
	set, ok, err := s.store.GetSet(r.Context(), binding.SetID)
	if err != nil {
		accessLog.Status = http.StatusInternalServerError
		accessLog.ErrorType = "set_lookup_error"
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok || set.Status == SetStatusDisabled {
		accessLog.Status = http.StatusServiceUnavailable
		accessLog.ErrorType = "set_unavailable"
		http.Error(w, "set unavailable", http.StatusServiceUnavailable)
		return
	}
	snapshot, err := s.buildTrafficRouteSnapshot(r.Context(), binding, set)
	if err != nil {
		accessLog.Status = http.StatusInternalServerError
		accessLog.ErrorType = "llm_settings_lookup_error"
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = s.cacheTrafficRouteSnapshot(r.Context(), snapshot)
	s.proxyWithTrafficRouteSnapshot(w, r, snapshot, &accessLog)
}

func (s *Service) tryProxyWithTrafficRouteSnapshot(w http.ResponseWriter, r *http.Request, externalKey string, accessLog *AccessLog) (bool, bool) {
	if s.options.KeyRouteCache == nil {
		if s.options.TrafficRouteCacheOnly {
			accessLog.Status = http.StatusServiceUnavailable
			accessLog.ErrorType = "route_cache_unavailable"
			http.Error(w, "route cache unavailable", http.StatusServiceUnavailable)
			return false, true
		}
		return false, false
	}
	lookup := parseTrafficRouteLookup(externalKey)
	snapshot, ok, err := s.options.KeyRouteCache.GetRoute(r.Context(), lookup)
	if err != nil {
		s.recordKeyRouteCacheMetric("error")
		if s.options.TrafficRouteCacheOnly {
			accessLog.Status = http.StatusServiceUnavailable
			accessLog.ErrorType = "route_cache_error"
			http.Error(w, "route cache error", http.StatusServiceUnavailable)
			return false, true
		}
		return false, false
	}
	if !ok {
		s.recordKeyRouteCacheMetric("miss")
		if s.options.TrafficRouteCacheOnly {
			accessLog.Status = http.StatusUnauthorized
			accessLog.ErrorType = "invalid_bearer_token"
			http.Error(w, "invalid bearer token", http.StatusUnauthorized)
			return false, true
		}
		return false, false
	}
	s.recordKeyRouteCacheMetric("hit")
	s.proxyWithTrafficRouteSnapshot(w, r, snapshot, accessLog)
	return true, true
}

func (s *Service) proxyWithTrafficRouteSnapshot(w http.ResponseWriter, r *http.Request, snapshot TrafficRouteSnapshot, accessLog *AccessLog) {
	accessLog.ExternalKeyID = snapshot.ExternalKeyID
	accessLog.SetID = snapshot.SetID
	if !snapshot.Enabled {
		accessLog.Status = http.StatusServiceUnavailable
		accessLog.ErrorType = "route_disabled"
		http.Error(w, "route disabled", http.StatusServiceUnavailable)
		return
	}
	targetBaseURL := snapshot.SetBaseURL
	routeRevision := int64(0)
	if s.options.KeyRouteCache != nil {
		runtimeRoute, ok, err := s.options.KeyRouteCache.GetSetRuntime(r.Context(), snapshot.SetID)
		if err != nil {
			s.recordKeyRouteCacheMetric("error")
			accessLog.Status = http.StatusServiceUnavailable
			accessLog.ErrorType = "set_runtime_route_error"
			http.Error(w, "set runtime route unavailable", http.StatusServiceUnavailable)
			return
		}
		if ok {
			if !runtimeRoute.Enabled {
				accessLog.Status = http.StatusServiceUnavailable
				accessLog.ErrorType = "set_runtime_disabled"
				http.Error(w, "set runtime disabled", http.StatusServiceUnavailable)
				return
			}
			targetBaseURL = runtimeRoute.TrafficBaseURL
			routeRevision = runtimeRoute.RouteRevision
		} else if s.options.SetRuntimeRouteRequired {
			accessLog.Status = http.StatusServiceUnavailable
			accessLog.ErrorType = "set_runtime_route_missing"
			http.Error(w, "set runtime route missing", http.StatusServiceUnavailable)
			return
		}
	}
	target, err := url.Parse(targetBaseURL)
	if err != nil {
		accessLog.Status = http.StatusInternalServerError
		accessLog.ErrorType = "invalid_set_url"
		http.Error(w, "invalid set url", http.StatusInternalServerError)
		return
	}
	trafficTransport := s.transport
	if routeRevision > 0 && s.trafficManager != nil {
		trafficTransport, err = s.trafficManager.Get(snapshot.SetID, routeRevision)
		if err != nil {
			accessLog.Status = http.StatusServiceUnavailable
			accessLog.ErrorType = "traffic_transport_error"
			http.Error(w, "traffic transport unavailable", http.StatusServiceUnavailable)
			return
		}
	} else if routeRevision > 0 && s.options.SetRuntimeRouteRequired {
		accessLog.Status = http.StatusServiceUnavailable
		accessLog.ErrorType = "traffic_transport_unavailable"
		http.Error(w, "traffic transport unavailable", http.StatusServiceUnavailable)
		return
	}
	replayBody, replayable, err := readReplayBodyForPlatformFallback(r, snapshot)
	if err != nil {
		accessLog.Status = http.StatusBadRequest
		accessLog.ErrorType = "request_body_read_error"
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	resp, err := s.roundTripTrafficRequest(r, trafficTransport, target, snapshot.UpstreamKey, replayBody, replayable)
	if err != nil {
		accessLog.Status = http.StatusBadGateway
		accessLog.ErrorType = "upstream_roundtrip_error"
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if shouldFallbackBYOKToPlatform(snapshot, resp.StatusCode) && replayable {
		_ = resp.Body.Close()
		resp, err = s.roundTripTrafficRequest(r, trafficTransport, target, snapshot.PlatformKey, replayBody, replayable)
		if err != nil {
			accessLog.Status = http.StatusBadGateway
			accessLog.ErrorType = "platform_fallback_roundtrip_error"
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		accessLog.ErrorType = "byok_platform_fallback"
	}
	defer resp.Body.Close()
	accessLog.Status = resp.StatusCode
	accessLog.UpstreamStatus = resp.StatusCode
	accessLog.Streaming = shouldFlushResponse(resp)
	if accessLog.ErrorType == "" || resp.StatusCode >= 400 {
		accessLog.ErrorType = upstreamStatusErrorType(resp.StatusCode)
	}
	copyHeader(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	if err := copyResponseBody(w, resp); err != nil {
		accessLog.ErrorType = "response_copy_error"
	}
}

func (s *Service) roundTripTrafficRequest(r *http.Request, transport http.RoundTripper, target *url.URL, upstreamKey string, replayBody []byte, replayable bool) (*http.Response, error) {
	outReq := r.Clone(r.Context())
	outReq.URL.Scheme = target.Scheme
	outReq.URL.Host = target.Host
	outReq.URL.Path = singleJoiningSlash(target.Path, r.URL.Path)
	outReq.URL.RawQuery = r.URL.RawQuery
	outReq.Host = target.Host
	outReq.RequestURI = ""
	outReq.Header = r.Header.Clone()
	removeHopByHopHeaders(outReq.Header)
	outReq.Header.Set("Authorization", "Bearer "+upstreamKey)
	if replayable {
		outReq.Body = io.NopCloser(bytes.NewReader(replayBody))
		outReq.ContentLength = int64(len(replayBody))
		outReq.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(replayBody)), nil
		}
	}
	if transport == nil {
		return nil, fmt.Errorf("traffic transport unavailable")
	}
	return transport.RoundTrip(outReq)
}

func readReplayBodyForPlatformFallback(r *http.Request, snapshot TrafficRouteSnapshot) ([]byte, bool, error) {
	if !snapshot.canFallbackToPlatform() {
		return nil, false, nil
	}
	if r.Body == nil || r.Body == http.NoBody {
		return nil, true, nil
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, false, err
	}
	_ = r.Body.Close()
	return body, true, nil
}

func (snapshot TrafficRouteSnapshot) canFallbackToPlatform() bool {
	return snapshot.RouteMode == LLMRouteBYOKFirst &&
		strings.TrimSpace(snapshot.PlatformKey) != "" &&
		snapshot.PlatformKey != snapshot.UpstreamKey
}

func shouldFallbackBYOKToPlatform(snapshot TrafficRouteSnapshot, statusCode int) bool {
	if !snapshot.canFallbackToPlatform() {
		return false
	}
	return statusCode == http.StatusUnauthorized ||
		statusCode == http.StatusForbidden ||
		statusCode == http.StatusTooManyRequests ||
		statusCode >= http.StatusInternalServerError
}

func (s *Service) buildTrafficRouteSnapshot(ctx context.Context, binding APIKeyBinding, set Set) (TrafficRouteSnapshot, error) {
	upstreamKey, routeMode, err := s.upstreamKeyAndModeForTraffic(ctx, binding)
	if err != nil {
		return TrafficRouteSnapshot{}, err
	}
	lookup := parseTrafficRouteLookup(binding.ExternalKey)
	externalKeyHash := binding.ExternalKeyHash
	if externalKeyHash == "" {
		externalKeyHash = lookup.ExternalKeyHash
	}
	keyVersion := binding.KeyVersion
	routeSlot := binding.RouteSlot
	secretHash := binding.SecretHash
	if lookup.Valid {
		keyVersion = lookup.Version
		routeSlot = lookup.RouteSlot
		secretHash = lookup.SecretHash
	}
	if keyVersion != externalKeyVersionV2 || strings.TrimSpace(binding.ExternalKeyID) == "" || secretHash == "" {
		return TrafficRouteSnapshot{}, fmt.Errorf("external key %q has no valid v2 route identity", binding.ExternalKeyID)
	}
	enabled := set.Status != SetStatusDisabled
	if binding.UserID != "" {
		if err := s.ensureTenantCanUseTraffic(ctx, binding.UserID); err != nil {
			enabled = false
		}
	}
	return TrafficRouteSnapshot{
		ExternalKeyHash: externalKeyHash,
		ExternalKeyID:   binding.ExternalKeyID,
		SecretHash:      secretHash,
		KeyVersion:      keyVersion,
		RouteSlot:       routeSlot,
		SetID:           binding.SetID,
		SetBaseURL:      trafficBaseURLForSet(set),
		UserID:          binding.UserID,
		UpstreamKey:     upstreamKey,
		UpstreamKeyID:   binding.UpstreamKeyID,
		PlatformKey:     binding.UpstreamKey,
		PlatformKeyID:   binding.UpstreamKeyID,
		RouteMode:       routeMode,
		Enabled:         enabled,
		CreatedAt:       binding.CreatedAt,
		UpdatedAt:       s.nowUTC(),
	}, nil
}

func trafficBaseURLForSet(set Set) string {
	if strings.TrimSpace(set.TrafficBaseURL) != "" {
		return strings.TrimRight(strings.TrimSpace(set.TrafficBaseURL), "/")
	}
	return strings.TrimRight(strings.TrimSpace(set.BaseURL), "/")
}

func (s *Service) lookupAPIKeyBinding(ctx context.Context, externalKey string) (APIKeyBinding, bool, error) {
	lookup := parseTrafficRouteLookup(externalKey)
	if !lookup.Valid {
		return APIKeyBinding{}, false, nil
	}
	externalKeyHash := lookup.ExternalKeyHash
	if s.options.KeyRouteCache != nil {
		if binding, ok, err := s.options.KeyRouteCache.Get(ctx, externalKeyHash); err == nil && ok {
			s.recordKeyRouteCacheMetric("hit")
			binding.ExternalKey = externalKey
			binding.ExternalKeyHash = externalKeyHash
			return binding, true, nil
		} else if err != nil {
			s.recordKeyRouteCacheMetric("error")
		} else {
			s.recordKeyRouteCacheMetric("miss")
		}
	}
	binding, ok, err := s.store.GetAPIKeyBindingByExternalKey(ctx, externalKey)
	if err != nil || !ok {
		return binding, ok, err
	}
	if binding.ExternalKeyHash == "" {
		binding.ExternalKeyHash = externalKeyHash
	}
	_ = s.cacheAPIKeyBinding(ctx, binding)
	return binding, true, nil
}

func (s *Service) upstreamKeyForTraffic(ctx context.Context, binding APIKeyBinding) (string, error) {
	upstreamKey, _, err := s.upstreamKeyAndModeForTraffic(ctx, binding)
	return upstreamKey, err
}

func (s *Service) upstreamKeyAndModeForTraffic(ctx context.Context, binding APIKeyBinding) (string, string, error) {
	if strings.TrimSpace(binding.UserID) == "" {
		return binding.UpstreamKey, LLMRoutePlatformFirst, nil
	}
	settings, ok, err := s.getUserLLMSettingsForTraffic(ctx, binding.UserID)
	if err != nil {
		return "", "", err
	}
	if ok && settings.Routing.Mode == LLMRouteBYOKFirst && strings.TrimSpace(settings.BYOKUpstreamKey) != "" {
		return settings.BYOKUpstreamKey, LLMRouteBYOKFirst, nil
	}
	return binding.UpstreamKey, LLMRoutePlatformFirst, nil
}

func (s *Service) getUserLLMSettingsForTraffic(ctx context.Context, externalUserID string) (UserLLMSettings, bool, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return UserLLMSettings{}, false, nil
	}
	now := s.nowUTC()
	if cached, ok := s.llmRouteCache.Load(externalUserID); ok {
		entry := cached.(userLLMSettingsTrafficCacheEntry)
		if now.Before(entry.expiresAt) {
			return entry.settings, entry.ok, nil
		}
		s.llmRouteCache.Delete(externalUserID)
	}
	settings, ok, err := s.store.GetUserLLMSettings(ctx, externalUserID)
	if err != nil {
		return UserLLMSettings{}, false, err
	}
	if ok {
		settings = normalizeUserLLMSettings(settings, settings)
	}
	s.llmRouteCache.Store(externalUserID, userLLMSettingsTrafficCacheEntry{
		settings:  settings,
		ok:        ok,
		expiresAt: now.Add(defaultUserLLMSettingsTrafficCacheTTL),
	})
	return settings, ok, nil
}

func (s *Service) invalidateUserLLMSettingsTrafficCache(externalUserID string) {
	s.llmRouteCache.Delete(strings.TrimSpace(externalUserID))
}

func (s *Service) RecognizeExternalKey(ctx context.Context, externalKey string) (bool, error) {
	externalKey = strings.TrimSpace(externalKey)
	if externalKey == "" {
		return false, nil
	}
	lookup := parseTrafficRouteLookup(externalKey)
	if !lookup.Valid {
		return false, nil
	}
	if s.options.TrafficRouteCacheOnly {
		if s.options.KeyRouteCache == nil {
			return false, nil
		}
		_, ok, err := s.options.KeyRouteCache.GetRoute(ctx, lookup)
		return ok, err
	}
	_, ok, err := s.lookupAPIKeyBinding(ctx, externalKey)
	return ok, err
}

func (s *Service) cacheAPIKeyBinding(ctx context.Context, binding APIKeyBinding) error {
	if s.options.KeyRouteCache == nil {
		return nil
	}
	externalKeyHash := binding.ExternalKeyHash
	if externalKeyHash == "" && binding.ExternalKey != "" {
		externalKeyHash = hashExternalKey(binding.ExternalKey)
	}
	return s.options.KeyRouteCache.Set(ctx, externalKeyHash, binding)
}

func (s *Service) cacheTrafficRouteSnapshotForBinding(ctx context.Context, binding APIKeyBinding, set Set) error {
	snapshot, err := s.buildTrafficRouteSnapshot(ctx, binding, set)
	if err != nil {
		return err
	}
	return s.cacheTrafficRouteSnapshot(ctx, snapshot)
}

func (s *Service) cacheTrafficRouteSnapshot(ctx context.Context, snapshot TrafficRouteSnapshot) error {
	if s.options.KeyRouteCache == nil {
		return nil
	}
	if snapshot.ExternalKeyHash == "" && snapshot.ExternalKeyID == "" {
		return nil
	}
	if snapshot.ExternalKeyID != "" && snapshot.SecretHash == "" {
		existing, ok, err := s.options.KeyRouteCache.GetRoute(ctx, TrafficRouteLookup{
			ExternalKeyID: snapshot.ExternalKeyID,
			Version:       snapshot.KeyVersion,
			RouteSlot:     snapshot.RouteSlot,
			Valid:         snapshot.KeyVersion == externalKeyVersionV2,
		})
		if err != nil {
			return err
		}
		if !ok || existing.SecretHash == "" {
			return nil
		}
		snapshot.SecretHash = existing.SecretHash
		if snapshot.ExternalKeyHash == "" {
			snapshot.ExternalKeyHash = existing.ExternalKeyHash
		}
		if snapshot.KeyVersion == 0 {
			snapshot.KeyVersion = existing.KeyVersion
			snapshot.RouteSlot = existing.RouteSlot
		}
	}
	return s.options.KeyRouteCache.SetRoute(ctx, snapshot)
}

func (s *Service) refreshUserTrafficRoutes(ctx context.Context, externalUserID string) error {
	if s.options.KeyRouteCache == nil {
		return nil
	}
	bindings, err := s.store.ListAPIKeyBindingsByUser(ctx, externalUserID)
	if err != nil {
		return err
	}
	for _, binding := range bindings {
		set, ok, err := s.store.GetSet(ctx, binding.SetID)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		if err := s.cacheTrafficRouteSnapshotForBinding(ctx, binding, set); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) refreshSetTrafficRoutes(ctx context.Context, setID string) error {
	if s.options.KeyRouteCache == nil {
		return nil
	}
	set, ok, err := s.store.GetSet(ctx, setID)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	bindings, err := s.store.ListAPIKeyBindingsBySet(ctx, setID)
	if err != nil {
		return err
	}
	for _, binding := range bindings {
		if err := s.cacheTrafficRouteSnapshotForBinding(ctx, binding, set); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) deleteUserTrafficRoutes(ctx context.Context, externalUserID string) error {
	if s.options.KeyRouteCache == nil {
		return nil
	}
	bindings, err := s.store.ListAPIKeyBindingsByUser(ctx, externalUserID)
	if err != nil {
		return err
	}
	for _, binding := range bindings {
		if err := s.deleteCachedTrafficRoute(ctx, binding); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) deleteCachedAPIKeyBinding(ctx context.Context, binding APIKeyBinding) error {
	if s.options.KeyRouteCache == nil {
		return nil
	}
	externalKeyHash := binding.ExternalKeyHash
	if externalKeyHash == "" && binding.ExternalKey != "" {
		externalKeyHash = hashExternalKey(binding.ExternalKey)
	}
	return s.options.KeyRouteCache.Delete(ctx, externalKeyHash)
}

func (s *Service) deleteCachedTrafficRoute(ctx context.Context, binding APIKeyBinding) error {
	if s.options.KeyRouteCache == nil {
		return nil
	}
	lookup := parseTrafficRouteLookup(binding.ExternalKey)
	if !lookup.Valid {
		lookup = TrafficRouteLookup{
			ExternalKeyID: binding.ExternalKeyID,
			Version:       binding.KeyVersion,
			RouteSlot:     binding.RouteSlot,
			Valid:         binding.KeyVersion == externalKeyVersionV2 && binding.ExternalKeyID != "",
		}
	}
	if lookup.ExternalKeyHash == "" {
		lookup.ExternalKeyHash = binding.ExternalKeyHash
	}
	return s.options.KeyRouteCache.DeleteRoute(ctx, lookup)
}

func (s *Service) emitAccessLog(entry AccessLog) {
	if s.options.AccessLogger != nil {
		s.options.AccessLogger(entry)
		return
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		return
	}
	defaultAccessLogger.Println(string(raw))
}

func (s *Service) recordTrafficMetrics(entry AccessLog) {
	if s.trafficMetrics == nil {
		return
	}
	s.trafficMetrics.Record(entry)
}

func (s *Service) recordKeyRouteCacheMetric(result string) {
	if s.trafficMetrics == nil {
		return
	}
	s.trafficMetrics.RecordKeyRouteLookup(result)
}

func (s *Service) PrometheusMetrics() string {
	var builder strings.Builder
	if s.trafficMetrics != nil {
		builder.WriteString(s.trafficMetrics.PrometheusText())
	}
	builder.WriteString(s.storePrometheusMetrics(context.Background()))
	return builder.String()
}

func (s *Service) CloseIdleConnections() {
	if s.trafficManager != nil {
		s.trafficManager.Close()
	}
	if closer, ok := s.transport.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
	if closer, ok := s.options.KeyRouteCache.(interface{ Close() error }); ok {
		_ = closer.Close()
	}
}

func (s *Service) ProxyConsoleHTTP(w http.ResponseWriter, r *http.Request, setID string, upstreamPath string) {
	set, ok, err := s.store.GetSet(r.Context(), setID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok || set.Status == SetStatusDisabled {
		http.Error(w, "set unavailable", http.StatusServiceUnavailable)
		return
	}
	if upstreamPath == "" {
		upstreamPath = "/"
	}
	if !strings.HasPrefix(upstreamPath, "/") {
		upstreamPath = "/" + upstreamPath
	}
	if isConsolePasskeyStatusProbe(r.Method, upstreamPath) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true,"message":"","data":{"enabled":false}}`))
		return
	}
	target, err := url.Parse(set.BaseURL)
	if err != nil {
		http.Error(w, "invalid set url", http.StatusInternalServerError)
		return
	}
	var bodyBytes []byte
	if r.Body != nil {
		bodyBytes, err = io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		_ = r.Body.Close()
	}

	buildRequest := func(activeSet Set) *http.Request {
		outReq := r.Clone(r.Context())
		outReq.URL.Scheme = target.Scheme
		outReq.URL.Host = target.Host
		outReq.URL.Path = singleJoiningSlash(target.Path, upstreamPath)
		outReq.URL.RawQuery = upstreamConsoleRawQuery(r)
		outReq.Host = target.Host
		outReq.RequestURI = ""
		outReq.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		outReq.ContentLength = int64(len(bodyBytes))
		outReq.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(bodyBytes)), nil
		}
		outReq.Header = r.Header.Clone()
		outReq.Header.Set("X-LLMGateway-Set", activeSet.ID)
		outReq.Header.Set("Accept-Encoding", "identity")
		if isConsoleAPIPath(upstreamPath) && activeSet.AdminAccessToken != "" && activeSet.AdminUserID != 0 {
			outReq.Header.Set("Authorization", "Bearer "+activeSet.AdminAccessToken)
			outReq.Header.Set("New-Api-User", strconv.Itoa(activeSet.AdminUserID))
		}
		return outReq
	}

	resp, body, err := s.roundTripConsoleRequest(buildRequest(set))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if isConsoleAPIPath(upstreamPath) && isInvalidAccessTokenResponse(resp.StatusCode, body) {
		if freshSet, refreshErr := s.BootstrapSet(r.Context(), setID); refreshErr == nil {
			set = freshSet
			resp, body, err = s.roundTripConsoleRequest(buildRequest(set))
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
		}
	}
	if isConsoleAPIPath(upstreamPath) && isDashboardSessionRequiredResponse(resp.StatusCode, body) {
		resp, body, err = s.roundTripConsoleDashboardSession(r.Context(), set, r, upstreamPath, bodyBytes)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
	}
	copyHeader(w.Header(), resp.Header)
	if isHTML(resp.Header.Get("Content-Type")) {
		body = rewriteInitialConsoleAssets(body, setID)
		body = injectConsoleBridge(body, set)
		w.Header().Del("Content-Encoding")
		w.Header().Del("Content-Length")
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(body)
}

func (s *Service) roundTripConsoleRequest(outReq *http.Request) (*http.Response, []byte, error) {
	resp, err := s.transport.RoundTrip(outReq)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, err
	}
	return resp, body, nil
}

func (s *Service) roundTripConsoleDashboardSession(ctx context.Context, set Set, original *http.Request, upstreamPath string, body []byte) (*http.Response, []byte, error) {
	client := s.newAPIClient(set.BaseURL)
	session, err := s.loginRootSession(ctx, client, set)
	if err != nil {
		return nil, nil, err
	}
	headers := original.Header.Clone()
	headers.Del("Authorization")
	headers.Del("Cookie")
	headers.Set("X-LLMGateway-Set", set.ID)
	headers.Set("Accept-Encoding", "identity")
	headers.Set("New-Api-User", strconv.Itoa(session.UserID))
	return client.DoRaw(ctx, original.Method, upstreamPath, upstreamConsoleRawQuery(original), headers, body)
}

func (s *Service) newAPIClient(baseURL string) *newapi.Client {
	timeout := s.options.NewAPIClientTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	return newapi.NewClient(baseURL, &http.Client{Transport: s.transport, Timeout: timeout})
}

func (s *Service) capacityPicker() SetCapacityPicker {
	return NewStoreSetCapacityPicker(s.store, s.nowUTC)
}

func (s *Service) pickSet(ctx context.Context) (Set, error) {
	set, ok, err := s.capacityPicker().PickSet(ctx, func(set Set) bool { return set.Status == SetStatusActive })
	if err != nil {
		return Set{}, err
	}
	if !ok {
		return Set{}, fmt.Errorf("no active set has available capacity")
	}
	return set, nil
}

func (s *Service) pickSetForAssignment(ctx context.Context, assignment UserAssignment) (Set, error) {
	if assignment.Backend != UserBackendNew || strings.TrimSpace(assignment.SetID) == "" {
		return s.pickSet(ctx)
	}
	setID := strings.TrimSpace(assignment.SetID)
	set, ok, err := s.capacityPicker().PickSet(ctx, func(set Set) bool {
		return set.ID == setID && set.Status == SetStatusActive
	})
	if err != nil {
		return Set{}, err
	}
	if !ok {
		return Set{}, fmt.Errorf("assigned set %q is unavailable or has no capacity", setID)
	}
	return set, nil
}

func bearerToken(header string) string {
	header = strings.TrimSpace(header)
	if strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return strings.TrimSpace(header[7:])
	}
	return header
}

func externalKeyHashPrefix(externalKey string) string {
	if externalKey == "" {
		return ""
	}
	hash := hashExternalKey(externalKey)
	if len(hash) <= 12 {
		return hash
	}
	return hash[:12]
}

func migrationKeyPrefix(key string) string {
	if len(key) <= 12 {
		return key
	}
	return key[:12]
}

func upstreamStatusErrorType(status int) string {
	switch {
	case status >= 500:
		return "upstream_5xx"
	case status >= 400:
		return "upstream_4xx"
	default:
		return ""
	}
}

func randomSecret() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "Qq373866172!"
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func randomNewAPIPassword() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "Qq373866172!"
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func newAPIUsername(externalUserID string) string {
	candidate := "sgw-" + strings.TrimSpace(externalUserID)
	if len(candidate) <= 20 {
		return candidate
	}
	sum := sha256.Sum256([]byte(externalUserID))
	return "sgw-" + base64.RawURLEncoding.EncodeToString(sum[:])[:16]
}

func formatUnixTime(ts int64) string {
	return time.Unix(ts, 0).UTC().Format(time.RFC3339Nano)
}

func singleJoiningSlash(a, b string) string {
	aslash := strings.HasSuffix(a, "/")
	bslash := strings.HasPrefix(b, "/")
	switch {
	case aslash && bslash:
		return a + b[1:]
	case !aslash && !bslash:
		return a + "/" + b
	default:
		return a + b
	}
}

func copyHeader(dst, src http.Header) {
	clean := src.Clone()
	removeHopByHopHeaders(clean)
	for k, vv := range clean {
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}

func removeHopByHopHeaders(header http.Header) {
	for _, value := range header.Values("Connection") {
		for _, field := range strings.Split(value, ",") {
			if name := strings.TrimSpace(field); name != "" {
				header.Del(name)
			}
		}
	}
	for key := range header {
		if isHopByHopHeader(key) {
			header.Del(key)
		}
	}
}

func isHopByHopHeader(key string) bool {
	switch strings.ToLower(key) {
	case "connection",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"proxy-connection",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade":
		return true
	default:
		return false
	}
}

func copyResponseBody(w http.ResponseWriter, resp *http.Response) error {
	if shouldFlushResponse(resp) {
		return copyAndFlush(w, resp.Body)
	}
	_, err := io.Copy(w, resp.Body)
	return err
}

func shouldFlushResponse(resp *http.Response) bool {
	return strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream")
}

func copyAndFlush(w http.ResponseWriter, src io.Reader) error {
	flusher, ok := w.(http.Flusher)
	if !ok {
		_, err := io.Copy(w, src)
		return err
	}
	buf := make([]byte, 32*1024)
	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return writeErr
			}
			flusher.Flush()
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}

func isHTML(contentType string) bool {
	return strings.Contains(strings.ToLower(contentType), "text/html")
}

func injectConsoleBridge(body []byte, set Set) []byte {
	marker := []byte("window.__LLMGATEWAY_CONSOLE_SET__")
	if strings.Contains(string(body), string(marker)) {
		return body
	}
	script := consoleBridgeScript(set)
	html := string(body)
	lower := strings.ToLower(html)
	if idx := strings.Index(lower, "<script"); idx >= 0 {
		return []byte(html[:idx] + script + html[idx:])
	}
	if idx := strings.Index(lower, "</head>"); idx >= 0 {
		return []byte(html[:idx] + script + html[idx:])
	}
	if strings.Contains(html, "</body>") {
		return []byte(strings.Replace(html, "</body>", script+"</body>", 1))
	}
	return []byte(script + html)
}

func consoleBridgeScript(set Set) string {
	userJSON := "null"
	uid := ""
	if set.AdminUserID != 0 {
		uid = strconv.Itoa(set.AdminUserID)
		username := set.AdminUsername
		if username == "" {
			username = "set-root"
		}
		role := set.AdminRole
		if role == 0 {
			role = 100
		}
		status := set.AdminStatus
		if status == 0 {
			status = 1
		}
		group := set.AdminGroup
		if group == "" {
			group = "default"
		}
		raw, err := json.Marshal(map[string]any{
			"id":       set.AdminUserID,
			"username": username,
			"role":     role,
			"status":   status,
			"group":    group,
		})
		if err == nil {
			userJSON = string(raw)
		}
	}
	return fmt.Sprintf(`<script>
(function () {
  var setId = %q;
  var adminUser = %s;
  window.__LLMGATEWAY_CONSOLE_SET__ = setId;
  var consolePrefix = '/_llmgateway_console/' + encodeURIComponent(setId);
  if (window.location.pathname === consolePrefix || window.location.pathname.indexOf(consolePrefix + '/') === 0) {
    var appURL = new URL(window.location.href);
    appURL.pathname = window.location.pathname.slice(consolePrefix.length) || '/';
    appURL.searchParams.set('llmgateway_console_set', setId);
    window.history.replaceState(window.history.state, '', appURL.pathname + appURL.search + appURL.hash);
  }
  if (adminUser && adminUser.id) {
    localStorage.setItem('uid', '%s');
    localStorage.setItem('user', JSON.stringify(adminUser));
  }
  if ('serviceWorker' in navigator) {
    var announceSet = function (controller) {
      if (controller) controller.postMessage({ type: 'llmgateway-console-set', setId: setId });
    };
    navigator.serviceWorker.register('/console-sw.js').then(function (registration) {
      announceSet(navigator.serviceWorker.controller || registration.active);
      navigator.serviceWorker.ready.then(function (readyRegistration) {
        announceSet(navigator.serviceWorker.controller || readyRegistration.active);
      });
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        announceSet(navigator.serviceWorker.controller);
      });
      window.setInterval(function () {
        announceSet(navigator.serviceWorker.controller || registration.active);
      }, 5000);
    }).catch(function (error) {
      console.warn('[llmgateway] console service worker registration failed', error);
    });
  }
})();
</script>`, set.ID, userJSON, uid)
}

func rewriteInitialConsoleAssets(body []byte, setID string) []byte {
	prefix := consoleProxyPrefix + url.PathEscape(setID)
	html := string(body)
	replacer := strings.NewReplacer(
		`href="/static/`, `href="`+prefix+`/static/`,
		`src="/static/`, `src="`+prefix+`/static/`,
		`href='/static/`, `href='`+prefix+`/static/`,
		`src='/static/`, `src='`+prefix+`/static/`,
		`href="/logo.png"`, `href="`+prefix+`/logo.png"`,
		`href='/logo.png'`, `href='`+prefix+`/logo.png'`,
		`href="/favicon.ico"`, `href="`+prefix+`/favicon.ico"`,
		`href='/favicon.ico'`, `href='`+prefix+`/favicon.ico'`,
		`href="/manifest.json"`, `href="`+prefix+`/manifest.json"`,
		`href='/manifest.json'`, `href='`+prefix+`/manifest.json'`,
	)
	return []byte(replacer.Replace(html))
}

func upstreamConsoleRawQuery(r *http.Request) string {
	query := r.URL.Query()
	query.Del("llmgateway_console_set")
	return query.Encode()
}

func isConsoleAPIPath(path string) bool {
	return path == "/api" || strings.HasPrefix(path, "/api/")
}

func isInvalidAccessTokenResponse(statusCode int, body []byte) bool {
	if statusCode == http.StatusUnauthorized {
		return true
	}
	var resp struct {
		Success *bool  `json:"success"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return false
	}
	if resp.Success == nil || *resp.Success {
		return false
	}
	message := strings.ToLower(resp.Message)
	return strings.Contains(message, "access token") &&
		(strings.Contains(message, "invalid") || strings.Contains(message, "无效"))
}

func isDashboardSessionRequiredResponse(statusCode int, body []byte) bool {
	if statusCode != http.StatusForbidden {
		return false
	}
	var resp struct {
		Success *bool  `json:"success"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return false
	}
	if resp.Success == nil || *resp.Success {
		return false
	}
	message := strings.ToLower(resp.Message)
	return strings.Contains(message, "dashboard session") &&
		strings.Contains(message, "access token") &&
		strings.Contains(message, "not allowed")
}

func isConsolePasskeyStatusProbe(method string, path string) bool {
	return method == http.MethodGet && path == "/api/user/passkey"
}
