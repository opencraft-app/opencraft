package instance

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/metric"
	"ctl/pkg/resource"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

const (
	churnEventCreateSuccess = "create_success"
	churnEventDestroyAccept = "destroy_accepted"
	poolPressureStateHot    = "hot"
	poolPressureStateCold   = "cold"
	churnCounterKeyPrefix   = "openclaw:instance:churn:v1"
	poolPressureSnapshotKey = "openclaw:instance:pool-pressure:v1:snapshot"
	userAbuseCooldownPrefix = "openclaw:instance:user-abuse:v1"
	// Allow a tiny grace window so API readers do not flap to "stale" exactly on the
	// TTL boundary while the bypass refresher is concurrently publishing the next snapshot.
	poolPressureStaleFudge = 2 * time.Second
)

type retryAfterProvider interface {
	RetryAfterSeconds() int
}

type instanceChurnLimitedError struct {
	retryAfterSeconds int
}

func newInstanceChurnLimitedError(retryAfter time.Duration) error {
	seconds := int(math.Ceil(retryAfter.Seconds()))
	if seconds <= 0 {
		seconds = 1
	}
	return &instanceChurnLimitedError{retryAfterSeconds: seconds}
}

func (e *instanceChurnLimitedError) Error() string {
	return errcode.ErrInstanceChurnLimited.Message
}

func (e *instanceChurnLimitedError) Unwrap() error {
	return errcode.ErrInstanceChurnLimited
}

func (e *instanceChurnLimitedError) RetryAfterSeconds() int {
	if e.retryAfterSeconds <= 0 {
		return 1
	}
	return e.retryAfterSeconds
}

type poolPressurePoolSnapshot struct {
	PoolID          string `json:"pool_id"`
	Status          string `json:"status"`
	PauseReason     string `json:"pause_reason,omitempty"`
	DesiredCapacity int    `json:"desired_capacity"`
	Clean           int    `json:"clean"`
	Allocated       int    `json:"allocated"`
	Creating        int    `json:"creating"`
	Dry             int    `json:"dry"`
	Resetting       int    `json:"resetting"`
}

type poolPressureSnapshot struct {
	RefreshedAt time.Time                  `json:"refreshed_at"`
	State       string                     `json:"state"`
	Candidate   []string                   `json:"candidate_pools"`
	Pools       []poolPressurePoolSnapshot `json:"pools"`
}

type orderedCandidatePools struct {
	Pools               []string
	UsedSnapshot        bool
	AttemptLimit        int
	SnapshotRefreshedAt time.Time
}

type churnGuardDecision struct {
	Allow          bool
	Reason         string
	RetryAfter     time.Duration
	CreateCount    int64
	DestroyCount   int64
	PressureState  string
	CandidatePools []string
}

type userChurnCounter interface {
	RecordEvent(ctx context.Context, userID, eventType, eventID string, now time.Time, window time.Duration) error
	Count(ctx context.Context, userID, eventType string, now time.Time, window time.Duration) (int64, error)
	RetryAfter(ctx context.Context, userID, eventType string, threshold int, now time.Time, window time.Duration) (time.Duration, error)
}

type poolPressureSnapshotStore interface {
	Save(ctx context.Context, snapshot *poolPressureSnapshot, ttl time.Duration) error
	Load(ctx context.Context) (*poolPressureSnapshot, error)
}

type poolPressureFetcher interface {
	ListPools(ctx context.Context) ([]psandbox.Pool, error)
	ListPoolInstances(ctx context.Context, poolID string) ([]psandbox.PoolInstance, error)
}

type createChurnGuard struct {
	conf      *config.InstanceAPIConfig
	counter   userChurnCounter
	cooldowns userAbuseCooldownStore
	snapshots poolPressureSnapshotStore
	logger    *zap.Logger
}

type poolPressureRefresher struct {
	conf      *config.InstanceAPIConfig
	fetcher   poolPressureFetcher
	snapshots poolPressureSnapshotStore
	logger    *zap.Logger
}

type redisUserChurnCounter struct {
	client *redis.Client
	prefix string
}

type redisPoolPressureSnapshotStore struct {
	client *redis.Client
	key    string
}

type userAbuseCooldownStore interface {
	Activate(ctx context.Context, userID string, now time.Time, ttl time.Duration) (time.Duration, bool, error)
	Remaining(ctx context.Context, userID string, now time.Time) (time.Duration, bool, error)
	ActiveCount(ctx context.Context, now time.Time) (int64, error)
}

type redisUserAbuseCooldownStore struct {
	client      *redis.Client
	keyPrefix   string
	activeIndex string
}

func newCreateChurnGuard(conf *config.InstanceAPIConfig, logger *zap.Logger) *createChurnGuard {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &createChurnGuard{
		conf:      conf,
		counter:   newRedisUserChurnCounter(resource.RedisMainClient),
		cooldowns: newRedisUserAbuseCooldownStore(resource.RedisMainClient),
		snapshots: newRedisPoolPressureSnapshotStore(resource.RedisMainClient),
		logger:    logger.With(zap.String("component", "instance-churn-guard")),
	}
}

func newPoolPressureRefresher(conf *config.InstanceAPIConfig, fetcher poolPressureFetcher, logger *zap.Logger) *poolPressureRefresher {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &poolPressureRefresher{
		conf:      conf,
		fetcher:   fetcher,
		snapshots: newRedisPoolPressureSnapshotStore(resource.RedisMainClient),
		logger:    logger.With(zap.String("component", "pool-pressure-refresher")),
	}
}

func newRedisUserChurnCounter(client *redis.Client) userChurnCounter {
	if client == nil {
		return nil
	}
	return &redisUserChurnCounter{client: client, prefix: churnCounterKeyPrefix}
}

func newRedisPoolPressureSnapshotStore(client *redis.Client) poolPressureSnapshotStore {
	if client == nil {
		return nil
	}
	return &redisPoolPressureSnapshotStore{client: client, key: poolPressureSnapshotKey}
}

func newRedisUserAbuseCooldownStore(client *redis.Client) userAbuseCooldownStore {
	if client == nil {
		return nil
	}
	return &redisUserAbuseCooldownStore{
		client:      client,
		keyPrefix:   userAbuseCooldownPrefix,
		activeIndex: userAbuseCooldownPrefix + ":cooldown:index",
	}
}

func (g *createChurnGuard) EvaluateCreate(ctx pctx.Context, candidatePools []string) (churnGuardDecision, error) {
	decision := churnGuardDecision{
		Allow:          true,
		Reason:         "disabled",
		CandidatePools: append([]string(nil), candidatePools...),
		PressureState:  poolPressureStateCold,
	}
	if g == nil || g.conf == nil || (!g.conf.IsChurnGuardEnabled() && !g.conf.IsUserAbuseGuardEnabled()) {
		metric.OpenClawInstanceChurnGuardEvalTotal.WithLabelValues("allow").Inc()
		metric.OpenClawInstanceUserAbuseGuardEvalTotal.WithLabelValues("allow").Inc()
		return decision, nil
	}
	if g.counter == nil || (g.conf.IsChurnGuardEnabled() && g.snapshots == nil) || (g.conf.IsUserAbuseGuardEnabled() && g.cooldowns == nil) {
		metric.OpenClawInstanceChurnGuardEvalTotal.WithLabelValues("fail_open").Inc()
		metric.OpenClawInstanceUserAbuseGuardEvalTotal.WithLabelValues("fail_open").Inc()
		return decision, nil
	}

	now := time.Now()
	window := time.Duration(g.conf.ChurnWindowSeconds) * time.Second
	createCount, err := g.counter.Count(ctx, ctx.GetUserID(), churnEventCreateSuccess, now, window)
	if err != nil {
		g.logger.Warn("count create churn events failed", zap.Error(err), zap.String("user_id", ctx.GetUserID()))
		metric.OpenClawInstanceChurnGuardEvalTotal.WithLabelValues("fail_open").Inc()
		metric.OpenClawInstanceUserAbuseGuardEvalTotal.WithLabelValues("fail_open").Inc()
		return decision, nil
	}
	destroyCount, err := g.counter.Count(ctx, ctx.GetUserID(), churnEventDestroyAccept, now, window)
	if err != nil {
		g.logger.Warn("count destroy churn events failed", zap.Error(err), zap.String("user_id", ctx.GetUserID()))
		metric.OpenClawInstanceChurnGuardEvalTotal.WithLabelValues("fail_open").Inc()
		metric.OpenClawInstanceUserAbuseGuardEvalTotal.WithLabelValues("fail_open").Inc()
		return decision, nil
	}
	decision.CreateCount = createCount
	decision.DestroyCount = destroyCount

	if g.conf.IsUserAbuseGuardEnabled() {
		remaining, active, err := g.cooldowns.Remaining(ctx, ctx.GetUserID(), now)
		if err != nil {
			g.logger.Warn("load user abuse cooldown failed", zap.Error(err), zap.String("user_id", ctx.GetUserID()))
			metric.OpenClawInstanceUserAbuseGuardEvalTotal.WithLabelValues("fail_open").Inc()
			return decision, nil
		}
		if active {
			decision.Allow = false
			decision.Reason = "user_abuse_cooldown_active"
			decision.RetryAfter = remaining
			if decision.RetryAfter <= 0 {
				decision.RetryAfter = time.Second
			}
			metric.OpenClawInstanceCreateRejectionsTotal.WithLabelValues(decision.Reason).Inc()
			metric.OpenClawInstanceUserAbuseGuardEvalTotal.WithLabelValues("reject_active").Inc()
			metric.OpenClawInstanceChurnGuardRetryAfter.Set(decision.RetryAfter.Seconds())
			g.logger.Warn("create request rejected by active user abuse cooldown",
				zap.String("user_id", ctx.GetUserID()),
				zap.Int64("create_success_count", decision.CreateCount),
				zap.Int64("destroy_accepted_count", decision.DestroyCount),
				zap.Int("retry_after_seconds", int(math.Ceil(decision.RetryAfter.Seconds()))),
			)
			return decision, nil
		}
		if createCount >= int64(g.conf.UserAbuseCreateThreshold) && destroyCount >= int64(g.conf.UserAbuseDestroyThreshold) {
			cooldownWindow := time.Duration(g.conf.UserAbuseCooldownSeconds) * time.Second
			remaining, started, err := g.cooldowns.Activate(ctx, ctx.GetUserID(), now, cooldownWindow)
			if err != nil {
				g.logger.Warn("activate user abuse cooldown failed", zap.Error(err), zap.String("user_id", ctx.GetUserID()))
				metric.OpenClawInstanceUserAbuseGuardEvalTotal.WithLabelValues("fail_open").Inc()
				return decision, nil
			}
			decision.Allow = false
			if started {
				decision.Reason = "user_abuse_cooldown_started"
				metric.OpenClawInstanceUserAbuseCooldownsTotal.Inc()
				metric.OpenClawInstanceUserAbuseGuardEvalTotal.WithLabelValues("reject_started").Inc()
			} else {
				decision.Reason = "user_abuse_cooldown_active"
				metric.OpenClawInstanceUserAbuseGuardEvalTotal.WithLabelValues("reject_active").Inc()
			}
			decision.RetryAfter = remaining
			if decision.RetryAfter <= 0 {
				decision.RetryAfter = time.Duration(g.conf.UserAbuseCooldownSeconds) * time.Second
			}
			if decision.RetryAfter <= 0 {
				decision.RetryAfter = time.Second
			}
			metric.OpenClawInstanceCreateRejectionsTotal.WithLabelValues(decision.Reason).Inc()
			metric.OpenClawInstanceChurnGuardRetryAfter.Set(decision.RetryAfter.Seconds())
			g.logger.Warn("create request rejected by user abuse cooldown",
				zap.String("user_id", ctx.GetUserID()),
				zap.Int64("create_success_count", decision.CreateCount),
				zap.Int64("destroy_accepted_count", decision.DestroyCount),
				zap.String("reason", decision.Reason),
				zap.Int("retry_after_seconds", int(math.Ceil(decision.RetryAfter.Seconds()))),
			)
			return decision, nil
		}
		metric.OpenClawInstanceUserAbuseGuardEvalTotal.WithLabelValues("allow").Inc()
	}

	if !g.conf.IsChurnGuardEnabled() {
		decision.Reason = "user_abuse_below_threshold"
		metric.OpenClawInstanceChurnGuardEvalTotal.WithLabelValues("allow").Inc()
		return decision, nil
	}

	if createCount < int64(g.conf.CreateThreshold) || destroyCount < int64(g.conf.DestroyThreshold) {
		decision.Reason = "below_threshold"
		metric.OpenClawInstanceChurnGuardEvalTotal.WithLabelValues("allow").Inc()
		return decision, nil
	}

	snapshot, err := g.snapshots.Load(ctx)
	if err != nil {
		g.logger.Warn("load pool pressure snapshot failed", zap.Error(err))
		metric.OpenClawInstanceChurnGuardEvalTotal.WithLabelValues("fail_open").Inc()
		return decision, nil
	}
	if snapshot == nil || isSnapshotStale(snapshot, now, time.Duration(g.conf.PressureTTLSec)*time.Second) {
		g.logger.Warn("pool pressure snapshot missing or stale",
			zap.Bool("missing", snapshot == nil),
			zap.Time("now", now),
		)
		metric.OpenClawInstanceChurnGuardEvalTotal.WithLabelValues("fail_open").Inc()
		return decision, nil
	}
	decision.PressureState = snapshot.State
	if snapshot.State != poolPressureStateHot {
		decision.Reason = "global_pressure_cold"
		metric.OpenClawInstanceChurnGuardEvalTotal.WithLabelValues("allow").Inc()
		return decision, nil
	}

	createRetry, err := g.counter.RetryAfter(ctx, ctx.GetUserID(), churnEventCreateSuccess, g.conf.CreateThreshold, now, window)
	if err != nil {
		g.logger.Warn("compute create retry-after failed", zap.Error(err), zap.String("user_id", ctx.GetUserID()))
		metric.OpenClawInstanceChurnGuardEvalTotal.WithLabelValues("fail_open").Inc()
		return decision, nil
	}
	destroyRetry, err := g.counter.RetryAfter(ctx, ctx.GetUserID(), churnEventDestroyAccept, g.conf.DestroyThreshold, now, window)
	if err != nil {
		g.logger.Warn("compute destroy retry-after failed", zap.Error(err), zap.String("user_id", ctx.GetUserID()))
		metric.OpenClawInstanceChurnGuardEvalTotal.WithLabelValues("fail_open").Inc()
		return decision, nil
	}

	decision.Allow = false
	decision.Reason = "user_threshold_and_global_hot"
	// Reject requires both create and destroy counters to remain above threshold.
	// We can safely tell clients to retry when the first counter drops below threshold,
	// so the correct retry-after is the earlier of the two expiry times.
	decision.RetryAfter = minPositiveDuration(createRetry, destroyRetry)
	if decision.RetryAfter <= 0 {
		decision.RetryAfter = time.Second
	}

	metric.OpenClawInstanceCreateRejectionsTotal.WithLabelValues(decision.Reason).Inc()
	metric.OpenClawInstanceChurnGuardEvalTotal.WithLabelValues("reject").Inc()
	metric.OpenClawInstanceChurnGuardRetryAfter.Set(decision.RetryAfter.Seconds())

	g.logger.Warn("create request rejected by churn guard",
		zap.String("user_id", ctx.GetUserID()),
		zap.Int64("create_success_count", decision.CreateCount),
		zap.Int64("destroy_accepted_count", decision.DestroyCount),
		zap.String("pressure_state", decision.PressureState),
		zap.Strings("candidate_pools", decision.CandidatePools),
		zap.Int("retry_after_seconds", int(math.Ceil(decision.RetryAfter.Seconds()))),
	)

	return decision, nil
}

func (g *createChurnGuard) RecordCreateSuccess(ctx pctx.Context, instanceID string) {
	g.recordLifecycleEvent(ctx, churnEventCreateSuccess, instanceID)
}

func (g *createChurnGuard) RecordDestroyAccepted(ctx pctx.Context, instanceID string) {
	g.recordLifecycleEvent(ctx, churnEventDestroyAccept, instanceID)
}

func (g *createChurnGuard) recordLifecycleEvent(ctx pctx.Context, eventType, instanceID string) {
	metric.OpenClawInstanceUserChurnEventsTotal.WithLabelValues(eventType).Inc()
	if g == nil || g.conf == nil || (!g.conf.IsChurnGuardEnabled() && !g.conf.IsUserAbuseGuardEnabled()) || g.counter == nil {
		return
	}
	eventID := fmt.Sprintf("%s:%s:%d", ctx.GetRequestId(), instanceID, time.Now().UnixNano())
	window := time.Duration(g.conf.ChurnWindowSeconds) * time.Second
	if err := g.counter.RecordEvent(ctx, ctx.GetUserID(), eventType, eventID, time.Now(), window); err != nil {
		g.logger.Warn("record churn lifecycle event failed",
			zap.Error(err),
			zap.String("user_id", ctx.GetUserID()),
			zap.String("event_type", eventType),
			zap.String("instance_id", instanceID),
		)
	}
}

func RefreshPoolPressureSnapshot(ctx pctx.Context, adapter poolPressureFetcher) (*poolPressureSnapshot, error) {
	conf := currentInstanceAPIConfig()
	refresher := newPoolPressureRefresher(conf, adapter, ctx.Logger())
	return refresher.Refresh(ctx, nil)
}

func (r *poolPressureRefresher) Refresh(ctx pctx.Context, candidatePools []string) (*poolPressureSnapshot, error) {
	if r == nil || r.conf == nil || !r.conf.IsChurnGuardEnabled() {
		return nil, nil
	}
	if r.fetcher == nil || r.snapshots == nil {
		return nil, nil
	}

	now := time.Now().UTC()
	allPools, err := r.fetcher.ListPools(ctx)
	if err != nil {
		return nil, err
	}
	candidatePools = uniqueNonEmptyStrings(candidatePools)
	if len(candidatePools) == 0 {
		candidatePools = listPoolIDs(allPools, "", "")
	}
	if len(candidatePools) == 0 {
		return nil, nil
	}
	poolByID := make(map[string]psandbox.Pool, len(allPools))
	for _, pool := range allPools {
		poolByID[strings.TrimSpace(pool.ID)] = pool
	}

	snapshot := &poolPressureSnapshot{
		RefreshedAt: now,
		State:       poolPressureStateCold,
		Candidate:   append([]string(nil), candidatePools...),
		Pools:       make([]poolPressurePoolSnapshot, 0, len(candidatePools)),
	}

	var cleanTotal, runtimeTotal, inflightTotal int
	for _, poolID := range candidatePools {
		pool, ok := poolByID[poolID]
		if !ok {
			r.logger.Warn("candidate pool not found while refreshing pressure snapshot", zap.String("pool_id", poolID))
			continue
		}
		instances, err := r.fetcher.ListPoolInstances(ctx, poolID)
		if err != nil {
			r.logger.Warn("list pool instances failed while refreshing pressure snapshot",
				zap.String("pool_id", poolID),
				zap.Error(err),
			)
			continue
		}
		item := poolPressurePoolSnapshot{
			PoolID:          poolID,
			Status:          pool.Status,
			PauseReason:     pool.PauseReason,
			DesiredCapacity: pool.DesiredCapacity,
		}
		for _, inst := range instances {
			switch strings.ToUpper(strings.TrimSpace(inst.State)) {
			case "CLEAN":
				item.Clean++
			case "ALLOCATED":
				item.Allocated++
			case "CREATING":
				item.Creating++
			case "DRY":
				item.Dry++
			// sandbox may transiently report REINSTALLING during the same "not reusable yet"
			// phase as RESETTING, so churn pressure rolls both states into the resetting bucket.
			case "RESETTING", "REINSTALLING":
				item.Resetting++
			}
		}
		snapshot.Pools = append(snapshot.Pools, item)
		cleanTotal += item.Clean
		// Use actual running pool inventory as the denominator instead of configured desired_capacity.
		// Broken or paused pools may still advertise a large desired target, but they should not dilute
		// the clean ratio unless they currently contribute real pool instances.
		runtimeTotal += item.Clean + item.Allocated + item.Creating + item.Dry + item.Resetting
		inflightTotal += item.Creating + item.Dry + item.Resetting
	}

	if len(snapshot.Pools) == 0 {
		return nil, nil
	}

	cleanFloor := maxInt(r.conf.PressureMinClean, int(math.Ceil(float64(runtimeTotal)*r.conf.PressureCleanRatio)))
	if cleanTotal < cleanFloor || inflightTotal > cleanTotal {
		snapshot.State = poolPressureStateHot
	}

	prev, err := r.snapshots.Load(ctx)
	if err != nil && !errors.Is(err, redis.Nil) {
		r.logger.Warn("load previous pool pressure snapshot failed", zap.Error(err))
	}
	if snapshot.State == poolPressureStateHot && (prev == nil || prev.State != poolPressureStateHot) {
		metric.OpenClawInstancePoolPressureHotTransitionsTotal.Inc()
	}
	publishPoolPressureMetrics(snapshot)

	if err := r.snapshots.Save(ctx, snapshot, time.Duration(r.conf.PressureTTLSec)*time.Second); err != nil {
		return nil, err
	}
	return snapshot, nil
}

func publishPoolPressureMetrics(snapshot *poolPressureSnapshot) {
	if snapshot == nil {
		return
	}
	metric.OpenClawInstancePoolPressureState.WithLabelValues(poolPressureStateHot).Set(boolToFloat(snapshot.State == poolPressureStateHot))
	metric.OpenClawInstancePoolPressureState.WithLabelValues(poolPressureStateCold).Set(boolToFloat(snapshot.State != poolPressureStateHot))
	for _, pool := range snapshot.Pools {
		metric.OpenClawInstancePoolPressureClean.WithLabelValues(pool.PoolID).Set(float64(pool.Clean))
		metric.OpenClawInstancePoolPressureAllocated.WithLabelValues(pool.PoolID).Set(float64(pool.Allocated))
		metric.OpenClawInstancePoolPressureCreating.WithLabelValues(pool.PoolID).Set(float64(pool.Creating))
		metric.OpenClawInstancePoolPressureDry.WithLabelValues(pool.PoolID).Set(float64(pool.Dry))
		metric.OpenClawInstancePoolPressureResetting.WithLabelValues(pool.PoolID).Set(float64(pool.Resetting))
		metric.OpenClawInstancePoolPressureDesired.WithLabelValues(pool.PoolID).Set(float64(pool.DesiredCapacity))
	}
}

func orderCandidatePoolsForCreate(conf *config.InstanceAPIConfig, now time.Time, candidatePools []string, snapshot *poolPressureSnapshot) orderedCandidatePools {
	ordered := orderedCandidatePools{
		Pools:        uniqueNonEmptyStringsPreserveOrder(candidatePools),
		AttemptLimit: resolveCreatePoolAttemptLimit(conf, len(candidatePools)),
	}
	if len(ordered.Pools) == 0 {
		ordered.AttemptLimit = 0
		return ordered
	}
	if snapshot == nil || isSnapshotStale(snapshot, now, snapshotTTL(conf)) {
		return ordered
	}

	byID := make(map[string]poolPressurePoolSnapshot, len(snapshot.Pools))
	for _, pool := range snapshot.Pools {
		poolID := strings.TrimSpace(pool.PoolID)
		if poolID == "" {
			continue
		}
		byID[poolID] = pool
	}

	type rankedPool struct {
		poolID string
		score  int
		index  int
	}

	ranked := make([]rankedPool, 0, len(ordered.Pools))
	fallback := make([]string, 0, len(ordered.Pools))
	for idx, poolID := range ordered.Pools {
		pool, ok := byID[poolID]
		if !ok {
			fallback = append(fallback, poolID)
			continue
		}
		ranked = append(ranked, rankedPool{
			poolID: poolID,
			score:  poolCreatePreferenceScore(pool),
			index:  idx,
		})
	}
	if len(ranked) == 0 {
		return ordered
	}

	slices.SortFunc(ranked, func(a, b rankedPool) int {
		if diff := cmp.Compare(b.score, a.score); diff != 0 {
			return diff
		}
		return cmp.Compare(a.index, b.index)
	})

	result := make([]string, 0, len(ordered.Pools))
	for _, item := range ranked {
		result = append(result, item.poolID)
	}
	result = append(result, fallback...)
	ordered.Pools = result
	ordered.UsedSnapshot = true
	ordered.SnapshotRefreshedAt = snapshot.RefreshedAt
	return ordered
}

func poolCreatePreferenceScore(pool poolPressurePoolSnapshot) int {
	score := pool.Clean * 1000
	score -= pool.Allocated * 100
	score -= pool.Creating * 250
	score -= pool.Dry * 300
	score -= pool.Resetting * 350

	status := strings.ToUpper(strings.TrimSpace(pool.Status))
	switch status {
	case "RUNNING", "ACTIVE", "READY":
		score += 50
	case "PAUSED":
		score -= 200000
	case "BROKEN", "ERROR", "FAILED":
		score -= 300000
	case "DISABLED":
		score -= 250000
	}
	if strings.TrimSpace(pool.PauseReason) != "" {
		score -= 100000
	}
	return score
}

func resolveCreatePoolAttemptLimit(conf *config.InstanceAPIConfig, candidateCount int) int {
	if candidateCount <= 0 {
		return 0
	}
	if conf == nil || conf.CreatePoolMaxAttempts <= 0 || conf.CreatePoolMaxAttempts > candidateCount {
		return candidateCount
	}
	return conf.CreatePoolMaxAttempts
}

func snapshotTTL(conf *config.InstanceAPIConfig) time.Duration {
	if conf == nil || conf.PressureTTLSec <= 0 {
		return 0
	}
	return time.Duration(conf.PressureTTLSec) * time.Second
}

func RefreshUserAbuseCooldownMetrics(ctx pctx.Context) (int64, error) {
	conf := currentInstanceAPIConfig()
	if conf == nil || !conf.IsUserAbuseGuardEnabled() {
		metric.OpenClawInstanceUserAbuseActiveCooldowns.Set(0)
		return 0, nil
	}
	store := newRedisUserAbuseCooldownStore(resource.RedisMainClient)
	if store == nil {
		metric.OpenClawInstanceUserAbuseActiveCooldowns.Set(0)
		return 0, nil
	}
	count, err := store.ActiveCount(ctx, time.Now())
	if err != nil {
		return 0, err
	}
	metric.OpenClawInstanceUserAbuseActiveCooldowns.Set(float64(count))
	return count, nil
}

func (s *redisUserChurnCounter) RecordEvent(ctx context.Context, userID, eventType, eventID string, now time.Time, window time.Duration) error {
	if s == nil || s.client == nil || strings.TrimSpace(userID) == "" || strings.TrimSpace(eventType) == "" {
		return nil
	}
	key := s.key(userID, eventType)
	score := float64(now.UnixMilli())
	if strings.TrimSpace(eventID) == "" {
		eventID = strconv.FormatInt(now.UnixNano(), 10)
	}
	pipe := s.client.Pipeline()
	pipe.ZAdd(ctx, key, redis.Z{Score: score, Member: eventID})
	if window > 0 {
		cutoff := now.Add(-window).UnixMilli() - 1
		pipe.ZRemRangeByScore(ctx, key, "-inf", strconv.FormatInt(cutoff, 10))
		pipe.Expire(ctx, key, window+time.Minute)
	}
	_, err := pipe.Exec(ctx)
	return err
}

func (s *redisUserChurnCounter) Count(ctx context.Context, userID, eventType string, now time.Time, window time.Duration) (int64, error) {
	if s == nil || s.client == nil || strings.TrimSpace(userID) == "" || strings.TrimSpace(eventType) == "" {
		return 0, nil
	}
	key := s.key(userID, eventType)
	pipe := s.client.Pipeline()
	if window > 0 {
		cutoff := now.Add(-window).UnixMilli() - 1
		pipe.ZRemRangeByScore(ctx, key, "-inf", strconv.FormatInt(cutoff, 10))
	}
	countCmd := pipe.ZCard(ctx, key)
	_, err := pipe.Exec(ctx)
	if err != nil {
		return 0, err
	}
	return countCmd.Val(), nil
}

func (s *redisUserChurnCounter) RetryAfter(ctx context.Context, userID, eventType string, threshold int, now time.Time, window time.Duration) (time.Duration, error) {
	if threshold <= 0 {
		return 0, nil
	}
	count, err := s.Count(ctx, userID, eventType, now, window)
	if err != nil || count < int64(threshold) {
		return 0, err
	}
	criticalIndex := count - int64(threshold)
	events, err := s.client.ZRangeWithScores(ctx, s.key(userID, eventType), 0, criticalIndex).Result()
	if err != nil {
		return 0, err
	}
	if len(events) == 0 {
		return 0, nil
	}
	expiryAt := time.UnixMilli(int64(events[len(events)-1].Score)).Add(window)
	if !expiryAt.After(now) {
		return 0, nil
	}
	return expiryAt.Sub(now), nil
}

func (s *redisUserChurnCounter) key(userID, eventType string) string {
	return fmt.Sprintf("%s:user:%s:%s", s.prefix, userID, eventType)
}

func (s *redisUserAbuseCooldownStore) Activate(ctx context.Context, userID string, now time.Time, ttl time.Duration) (time.Duration, bool, error) {
	if s == nil || s.client == nil || strings.TrimSpace(userID) == "" || ttl <= 0 {
		return 0, false, nil
	}
	expiryAt := now.Add(ttl)
	expiryMillis := expiryAt.UnixMilli()
	started, err := s.client.SetNX(ctx, s.userKey(userID), strconv.FormatInt(expiryMillis, 10), ttl).Result()
	if err != nil {
		return 0, false, err
	}
	if started {
		pipe := s.client.Pipeline()
		pipe.ZAdd(ctx, s.activeIndex, redis.Z{Score: float64(expiryMillis), Member: userID})
		pipe.Expire(ctx, s.activeIndex, ttl+time.Hour)
		if _, err := pipe.Exec(ctx); err != nil {
			return 0, false, err
		}
		return ttl, true, nil
	}
	remaining, _, err := s.Remaining(ctx, userID, now)
	return remaining, false, err
}

func (s *redisUserAbuseCooldownStore) Remaining(ctx context.Context, userID string, now time.Time) (time.Duration, bool, error) {
	if s == nil || s.client == nil || strings.TrimSpace(userID) == "" {
		return 0, false, nil
	}
	raw, err := s.client.Get(ctx, s.userKey(userID)).Result()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return 0, false, nil
		}
		return 0, false, err
	}
	expiryMillis, parseErr := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if parseErr != nil {
		return 0, false, parseErr
	}
	expiryAt := time.UnixMilli(expiryMillis)
	if !expiryAt.After(now) {
		pipe := s.client.Pipeline()
		pipe.Del(ctx, s.userKey(userID))
		pipe.ZRem(ctx, s.activeIndex, userID)
		_, _ = pipe.Exec(ctx)
		return 0, false, nil
	}
	return expiryAt.Sub(now), true, nil
}

func (s *redisUserAbuseCooldownStore) ActiveCount(ctx context.Context, now time.Time) (int64, error) {
	if s == nil || s.client == nil {
		return 0, nil
	}
	pipe := s.client.Pipeline()
	pipe.ZRemRangeByScore(ctx, s.activeIndex, "-inf", strconv.FormatInt(now.UnixMilli()-1, 10))
	countCmd := pipe.ZCard(ctx, s.activeIndex)
	_, err := pipe.Exec(ctx)
	if err != nil {
		return 0, err
	}
	return countCmd.Val(), nil
}

func (s *redisUserAbuseCooldownStore) userKey(userID string) string {
	return fmt.Sprintf("%s:cooldown:user:%s", s.keyPrefix, userID)
}

func (s *redisPoolPressureSnapshotStore) Save(ctx context.Context, snapshot *poolPressureSnapshot, ttl time.Duration) error {
	if s == nil || s.client == nil || snapshot == nil {
		return nil
	}
	payload, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	return s.client.Set(ctx, s.key, payload, ttl).Err()
}

func (s *redisPoolPressureSnapshotStore) Load(ctx context.Context) (*poolPressureSnapshot, error) {
	if s == nil || s.client == nil {
		return nil, nil
	}
	raw, err := s.client.Get(ctx, s.key).Bytes()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, nil
		}
		return nil, err
	}
	var snapshot poolPressureSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return nil, err
	}
	return &snapshot, nil
}

func isSnapshotStale(snapshot *poolPressureSnapshot, now time.Time, ttl time.Duration) bool {
	if snapshot == nil {
		return true
	}
	if ttl <= 0 {
		return false
	}
	return snapshot.RefreshedAt.Add(ttl + poolPressureStaleFudge).Before(now)
}

func minPositiveDuration(values ...time.Duration) time.Duration {
	var best time.Duration
	for _, value := range values {
		if value <= 0 {
			continue
		}
		if best <= 0 || value < best {
			best = value
		}
	}
	return best
}

func uniqueNonEmptyStrings(values []string) []string {
	result := uniqueNonEmptyStringsPreserveOrder(values)
	slices.Sort(result)
	return result
}

func uniqueNonEmptyStringsPreserveOrder(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func boolToFloat(value bool) float64 {
	if value {
		return 1
	}
	return 0
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func (l *logic) evaluateCreateChurnGuard(ctx pctx.Context, skuID string) (churnGuardDecision, error) {
	if l == nil || l.churnGuard == nil {
		return churnGuardDecision{Allow: true}, nil
	}
	candidates, err := l.resolveCreateCandidatePools(ctx, skuID)
	if err != nil {
		return churnGuardDecision{}, err
	}
	return l.churnGuard.EvaluateCreate(ctx, candidates)
}

func (l *logic) recordCreateSuccessEvent(ctx pctx.Context, instanceID string) {
	if l == nil || l.churnGuard == nil {
		return
	}
	l.churnGuard.RecordCreateSuccess(ctx, instanceID)
}

func (l *logic) recordDestroyAcceptedEvent(ctx pctx.Context, instanceID string) {
	if l == nil || l.churnGuard == nil {
		return
	}
	l.churnGuard.RecordDestroyAccepted(ctx, instanceID)
}
