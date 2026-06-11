package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/logging"
	"cvm-mock-e2b/internal/observability"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/runtimecfg"
	"cvm-mock-e2b/internal/service"
	"cvm-mock-e2b/internal/store"
	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel/attribute"
)

// Worker timing defaults are centralized here for easier tuning.
var (
	defaultRefillInterval      = 2 * time.Second
	defaultWaterlineInterval   = 1 * time.Minute
	defaultResetInterval       = 300 * time.Millisecond
	defaultCleanupInterval     = 15 * time.Second
	defaultBindingSyncInterval = 5 * time.Second
	defaultBundleSyncInterval  = 15 * time.Second
	defaultSKURolloutInterval  = 5 * time.Second
	defaultOrphanSGTTL         = 100 * time.Second
	defaultCreateVerifyRetries = 3
	defaultCreateVerifyBackoff = 5 * time.Second
	defaultCreateVerifyMaxWait = 20 * time.Second
	defaultCreatingStaleAfter  = 15 * time.Minute
	defaultResettingStaleAfter = 10 * time.Minute
	defaultResetObserveTimeout = 20 * time.Second
)

var (
	availableStates     = []core.InstanceState{core.StateClean}
	inflightStates      = []core.InstanceState{core.StateCreating, core.StateResetting, core.StateDeleting, core.StatePausing}
	creatingStaleAfter  = defaultCreatingStaleAfter
	resettingStaleAfter = defaultResettingStaleAfter
	// pausingStaleAfter bounds how long an instance may sit in PAUSING before
	// being failed (the cvm StopInstances path is bounded by ~3min sync polling
	// inside api-gin handler, so 10min is a generous safety net for stuck rows).
	pausingStaleAfter = 10 * time.Minute
	// reinstallVerifyDelay prevents marking CLEAN immediately after a reinstall request returns.
	// Tests may override this to avoid slow sleeps.
	reinstallVerifyDelay   = 30 * time.Second
	resetObserveTimeout    = defaultResetObserveTimeout
	createVerifyRetries    = defaultCreateVerifyRetries
	createVerifyBackoff    = defaultCreateVerifyBackoff
	createVerifyMaxWait    = defaultCreateVerifyMaxWait
	refillFailureThreshold = 5
	skuRolloutTimeout      = 10 * time.Minute
	refillSkippedStateMu   sync.Mutex
	refillSkippedState     = map[string]string{}
)

type inflightStaleRule struct {
	State      core.InstanceState
	StaleAfter time.Duration
	Target     core.InstanceState
	Name       string
}

type createBatchResult struct {
	created           []core.Instance
	createFailures    int
	firstCreateCode   string
	firstCreateDetail string
	terminalFailure   bool
}

type refillCreatedInstanceSummary struct {
	InstanceID string             `json:"instance_id"`
	CloudID    string             `json:"cloud_id,omitempty"`
	Address    string             `json:"address,omitempty"`
	State      core.InstanceState `json:"state"`
}

const refillCreatedSampleLimit = 5

type skuRolloutError struct {
	skuID  string
	poolID string
	stage  string
	err    error
}

func (e *skuRolloutError) Error() string {
	return e.err.Error()
}

func (e *skuRolloutError) Unwrap() error {
	return e.err
}

func newSKURolloutError(skuID string, poolID string, stage string, err error) error {
	if err == nil {
		return nil
	}
	return &skuRolloutError{
		skuID:  skuID,
		poolID: poolID,
		stage:  stage,
		err:    err,
	}
}

func emitSKURolloutBlockedIfChanged(ctx context.Context, previousState core.SKURolloutState, previousReason string, previousCursor string, sku core.SKU, poolID string, explanation string, attrs ...attribute.KeyValue) {
	if !shouldEmitSKURolloutStateEvent(previousState, previousReason, previousCursor, sku.RolloutState, sku.LastRolloutError, sku.RolloutCursorPoolID) {
		return
	}
	base := []attribute.KeyValue{
		attribute.String("sku_id", sku.ID),
		attribute.String("pool_id", poolID),
		attribute.String("reason", sku.LastRolloutError),
	}
	observability.EmitEvent(ctx, "sandbox.sku_rollout.blocked", explanation, append(base, attrs...)...)
}

func shouldEmitRefillSkipped(pool core.Pool) bool {
	refillSkippedStateMu.Lock()
	defer refillSkippedStateMu.Unlock()
	reason := strings.TrimSpace(pool.PauseReason)
	prev, ok := refillSkippedState[pool.ID]
	if ok && prev == reason {
		return false
	}
	refillSkippedState[pool.ID] = reason
	return true
}

func clearRefillSkipped(poolID string) {
	refillSkippedStateMu.Lock()
	defer refillSkippedStateMu.Unlock()
	delete(refillSkippedState, strings.TrimSpace(poolID))
}

func refillCreatedSummaries(instances []core.Instance) ([]refillCreatedInstanceSummary, bool) {
	limit := len(instances)
	truncated := false
	if limit > refillCreatedSampleLimit {
		limit = refillCreatedSampleLimit
		truncated = true
	}
	items := make([]refillCreatedInstanceSummary, 0, limit)
	for _, inst := range instances[:limit] {
		items = append(items, refillCreatedInstanceSummary{
			InstanceID: inst.ID,
			CloudID:    inst.CloudID,
			Address:    inst.Address,
			State:      inst.State,
		})
	}
	return items, truncated
}

func emitWorkerEvent(ctx context.Context, name string, explanation string, attrs ...attribute.KeyValue) {
	observability.EmitEvent(ctx, name, explanation, attrs...)
}

func fatalWorkerf(format string, args ...any) {
	_, _ = fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

func main() {
	cleanup, err := logging.Init("worker")
	if err != nil {
		fatalWorkerf("init logging: %v", err)
	}
	defer cleanup()
	shutdownTracing, err := observability.InitStdoutTracing("sandbox-worker")
	if err != nil {
		fatalWorkerf("init stdout tracing: %v", err)
	}
	defer func() {
		if err := shutdownTracing(context.Background()); err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "shutdown stdout tracing: %v\n", err)
		}
	}()

	refillPool := flag.String("refill-pool", "", "pool id to refill (optional)")
	refillCount := flag.Int("refill-count", 0, "instances per sweep; 0 use desired_capacity; <0 disable refill loop")
	refillConcurrency := flag.Int("refill-concurrency", 5, "max concurrent creates per pool")
	refillInterval := flag.Duration("refill-interval", defaultRefillInterval, "interval between refill sweeps; 0 to run once")
	waterlineInterval := flag.Duration("waterline-interval", defaultWaterlineInterval, "interval for CLEAN waterline/health check; 0 to disable")
	waterlineSample := flag.Int("waterline-sample", 3, "number of CLEAN instances to sample per pool for health check")

	resetPool := flag.String("reset-pool", "", "pool id to reset (optional, default all pools)")
	resetInterval := flag.Duration("reset-interval", defaultResetInterval, "poll interval for reset loop; 0 to run once")
	resetConcurrency := flag.Int("reset-concurrency", 10, "max concurrent reinstalls per sweep")
	shardTotal := flag.Int("shard-total", 0, "worker shard total; 0 to disable sharding filter")
	shardIndex := flag.Int("shard-index", 0, "worker shard index in [0, shard-total)")
	imageOverride := flag.String("image", "", "override image id for reset (default pool base_image)")
	cleanupPool := flag.String("cleanup-pool", "", "pool id to cleanup FAILED (optional, default all pools)")
	cleanupInterval := flag.Duration("cleanup-interval", defaultCleanupInterval, "interval for FAILED cleanup; 0 to run once")
	bindingSyncInterval := flag.Duration("binding-sync-interval", defaultBindingSyncInterval, "interval for template binding admission reconciliation; 0 to disable")
	bundleSyncInterval := flag.Duration("bundle-sync-interval", defaultBundleSyncInterval, "interval for warm capacity bundle reconciliation; 0 to disable")
	skuRolloutInterval := flag.Duration("sku-rollout-interval", defaultSKURolloutInterval, "interval for serialized SKU rollout reconciliation; 0 to disable")
	flag.Parse()

	if *shardTotal > 0 && (*shardIndex < 0 || *shardIndex >= *shardTotal) {
		emitWorkerEvent(context.Background(), "sandbox.worker.config_invalid", "worker 的 shard 配置非法，启动被拒绝。", attribute.Int("shard_total", *shardTotal), attribute.Int("shard_index", *shardIndex))
		fatalWorkerf("invalid shard config: shard-total=%d shard-index=%d", *shardTotal, *shardIndex)
	}

	var backend store.Store
	if dsn := runtimecfg.MySQLDSNFromEnv(); dsn != "" {
		mysqlStore, err := store.NewMySQLStore(dsn)
		if err != nil {
			emitWorkerEvent(context.Background(), "sandbox.worker.store_init_failed", "worker 初始化 MySQL 存储失败，进程无法启动。", attribute.String("backend", "mysql"), attribute.String("error", err.Error()))
			fatalWorkerf("init mysql store: %v", err)
		}
		backend = mysqlStore
		emitWorkerEvent(context.Background(), "sandbox.worker.store_selected", "worker 已选择 MySQL 作为后端存储。", attribute.String("backend", "mysql"))
	} else {
		backend = store.NewMemoryStore()
		emitWorkerEvent(context.Background(), "sandbox.worker.store_selected", "worker 未发现 MySQL DSN，已退回使用内存存储。", attribute.String("backend", "memory"))
	}

	svc := service.NewService(backend)
	cp, err := provider.ResolveFromEnv()
	if err != nil {
		emitWorkerEvent(context.Background(), "sandbox.worker.provider_init_failed", "worker 初始化云 provider 失败，进程无法启动。", attribute.String("error", err.Error()))
		fatalWorkerf("init provider: %v", err)
	}
	workerMetrics := observability.NewWorkerMetrics(prometheus.NewRegistry())

	baseCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, os.Kill)
	defer stop()
	startWorkerMetricsServer(baseCtx, getenv("WORKER_METRICS_ADDR", ":8080"), workerMetrics)
	shardEnabled := *shardTotal > 0
	shardCtx := baseCtx
	if shardEnabled {
		shardCtx = store.WithShard(baseCtx, *shardTotal, *shardIndex)
		emitWorkerEvent(baseCtx, "sandbox.worker.shard_enabled", "worker 已启用 shard 模式，只负责当前分片的库存和重置任务。", attribute.Int("shard_total", *shardTotal), attribute.Int("shard_index", *shardIndex))
	}

	var wg sync.WaitGroup
	// desired_capacity is interpreted as total pool target inventory.
	// When sharding is enabled, each worker manages only its shard's share of that total.
	if *refillCount >= 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			runRefillLoop(shardCtx, svc, cp, workerMetrics, *refillPool, *refillCount, *refillInterval, *refillConcurrency)
		}()
	} else {
		emitWorkerEvent(baseCtx, "sandbox.worker.loop_disabled", "refill loop 已被显式关闭，因为 refill-count 小于 0。", attribute.String("loop", "refill"))
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		runResetLoop(shardCtx, svc, cp, *resetPool, *imageOverride, *resetInterval, *resetConcurrency)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runCleanupLoop(shardCtx, svc, cp, *cleanupPool, *cleanupInterval)
	}()

	if *bindingSyncInterval > 0 && (!shardEnabled || *shardIndex == 0) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			runBindingSyncLoop(baseCtx, svc, *bindingSyncInterval)
		}()
	} else if *bindingSyncInterval <= 0 {
		emitWorkerEvent(baseCtx, "sandbox.worker.loop_disabled", "binding sync loop 已被显式关闭，因为 interval 小于等于 0。", attribute.String("loop", "binding_sync"))
	} else {
		emitWorkerEvent(baseCtx, "sandbox.worker.loop_skipped", "当前 worker 不是 leader shard，因此跳过 binding sync loop。", attribute.String("loop", "binding_sync"), attribute.Int("shard_index", *shardIndex), attribute.Int("shard_total", *shardTotal))
	}

	if *bundleSyncInterval > 0 && (!shardEnabled || *shardIndex == 0) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			runCapacityBundleLoop(baseCtx, svc, cp, *bundleSyncInterval)
		}()
	} else if *bundleSyncInterval <= 0 {
		emitWorkerEvent(baseCtx, "sandbox.worker.loop_disabled", "capacity bundle loop 已被显式关闭，因为 interval 小于等于 0。", attribute.String("loop", "capacity_bundle"))
	} else {
		emitWorkerEvent(baseCtx, "sandbox.worker.loop_skipped", "当前 worker 不是 leader shard，因此跳过 capacity bundle loop。", attribute.String("loop", "capacity_bundle"), attribute.Int("shard_index", *shardIndex), attribute.Int("shard_total", *shardTotal))
	}

	if *skuRolloutInterval > 0 && (!shardEnabled || *shardIndex == 0) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			runSKURolloutLoop(baseCtx, svc, *skuRolloutInterval)
		}()
	} else if *skuRolloutInterval <= 0 {
		emitWorkerEvent(baseCtx, "sandbox.worker.loop_disabled", "sku rollout loop 已被显式关闭，因为 interval 小于等于 0。", attribute.String("loop", "sku_rollout"))
	} else {
		emitWorkerEvent(baseCtx, "sandbox.worker.loop_skipped", "当前 worker 不是 leader shard，因此跳过 sku rollout loop。", attribute.String("loop", "sku_rollout"), attribute.Int("shard_index", *shardIndex), attribute.Int("shard_total", *shardTotal))
	}

	if *waterlineInterval > 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			runWaterlineLoop(shardCtx, svc, cp, workerMetrics, *waterlineInterval, *waterlineSample)
		}()
	} else {
		emitWorkerEvent(baseCtx, "sandbox.worker.loop_disabled", "waterline loop 已被显式关闭，因为 interval 小于等于 0。", attribute.String("loop", "waterline"))
	}

	wg.Wait()
}

func runRefillLoop(ctx context.Context, svc *service.Service, cp provider.CloudProvider, metrics *observability.WorkerMetrics, poolID string, count int, interval time.Duration, concurrency int) {
	target := poolID
	if target == "" {
		target = "ALL"
	}
	emitWorkerEvent(ctx, "sandbox.worker.loop_started", "refill loop 已启动，worker 会按周期检查目标 pool 是否需要补货。", attribute.String("loop", "refill"), attribute.String("pool_id", target), attribute.String("interval", interval.String()), attribute.Int("count", count))
	runOnce := interval <= 0
	for {
		if err := doRefill(ctx, svc, cp, metrics, poolID, count, concurrency); err != nil {
			emitWorkerEvent(ctx, "sandbox.worker.loop_failed", "refill loop 执行失败，本轮补货扫描未完成。", attribute.String("loop", "refill"), attribute.String("error", err.Error()))
		}
		if runOnce {
			return
		}
		select {
		case <-time.After(interval):
		case <-ctx.Done():
			emitWorkerEvent(ctx, "sandbox.worker.loop_stopped", "refill loop 已停止。", attribute.String("loop", "refill"), attribute.String("reason", ctx.Err().Error()))
			return
		}
	}
}

func runBindingSyncLoop(ctx context.Context, svc *service.Service, interval time.Duration) {
	emitWorkerEvent(ctx, "sandbox.worker.loop_started", "binding sync loop 已启动，worker 会周期性同步模板绑定的 admission 状态。", attribute.String("loop", "binding_sync"), attribute.String("interval", interval.String()))
	runOnce := interval <= 0
	for {
		updated, err := svc.ReconcileTemplateBindingAdmissions(ctx)
		if err != nil {
			emitWorkerEvent(ctx, "sandbox.worker.loop_failed", "binding sync loop 执行失败，本轮 admission 同步没有完成。", attribute.String("loop", "binding_sync"), attribute.String("error", err.Error()))
		} else if updated > 0 {
			emitWorkerEvent(ctx, "sandbox.binding_sync.updated", "本轮 binding sync 已更新模板类的 admission 状态。", attribute.Int("updated_template_classes", updated))
		}
		if runOnce {
			return
		}
		select {
		case <-time.After(interval):
		case <-ctx.Done():
			emitWorkerEvent(ctx, "sandbox.worker.loop_stopped", "binding sync loop 已停止。", attribute.String("loop", "binding_sync"), attribute.String("reason", ctx.Err().Error()))
			return
		}
	}
}

func runCapacityBundleLoop(ctx context.Context, svc *service.Service, cp provider.CloudProvider, interval time.Duration) {
	_, ok := cp.(provider.CapacityBundleProvisioner)
	if !ok {
		emitWorkerEvent(ctx, "sandbox.worker.loop_disabled", "capacity bundle loop 已关闭，因为当前 provider 不支持 CapacityBundleProvisioner。", attribute.String("loop", "capacity_bundle"))
		return
	}
	janitor, janitorOK := cp.(provider.SecurityGroupShardJanitor)
	emitWorkerEvent(ctx, "sandbox.worker.loop_started", "capacity bundle loop 已启动，worker 会周期性预热 bundle 并派生 pool。", attribute.String("loop", "capacity_bundle"), attribute.String("interval", interval.String()))
	runOnce := interval <= 0
	for {
		createdBundles, err := svc.EnsureWarmCapacityBundles(ctx, cp)
		if err != nil {
			emitWorkerEvent(ctx, "sandbox.worker.loop_failed", "capacity bundle loop 在预热 bundle 阶段失败。", attribute.String("loop", "capacity_bundle"), attribute.String("stage", "ensure_warm_capacity_bundles"), attribute.String("error", err.Error()))
		} else {
			createdPools, err := svc.EnsurePoolsFromWarmCapacityBundles(ctx)
			if err != nil {
				emitWorkerEvent(ctx, "sandbox.worker.loop_failed", "capacity bundle loop 在 bundle 派生 pool 阶段失败。", attribute.String("loop", "capacity_bundle"), attribute.String("stage", "ensure_pools_from_warm_capacity_bundles"), attribute.String("error", err.Error()))
			} else if createdBundles > 0 || createdPools > 0 {
				emitWorkerEvent(ctx, "sandbox.capacity_bundle.sync_completed", "本轮 capacity bundle loop 完成了 bundle 预热和 pool 派生。", attribute.Int("created_bundles", createdBundles), attribute.Int("created_pools", createdPools))
			}
		}
		if janitorOK {
			deletedOrphans, err := reconcileOrphanSecurityGroupShards(ctx, svc, janitor, defaultOrphanSGTTL, "")
			if err != nil {
				emitWorkerEvent(ctx, "sandbox.worker.loop_failed", "capacity bundle loop 在 orphan SG 收敛阶段失败。", attribute.String("loop", "capacity_bundle"), attribute.String("stage", "reconcile_orphan_sg_shards"), attribute.String("error", err.Error()))
			} else if deletedOrphans > 0 {
				emitWorkerEvent(ctx, "sandbox.sg_shard.orphan_cleanup_completed", "本轮 capacity bundle loop 已清理超过 TTL 且没有任何 DB 引用的 orphan SG shard。", attribute.Int("deleted_security_groups", deletedOrphans))
			}
		}
		if runOnce {
			return
		}
		select {
		case <-time.After(interval):
		case <-ctx.Done():
			emitWorkerEvent(ctx, "sandbox.worker.loop_stopped", "capacity bundle loop 已停止。", attribute.String("loop", "capacity_bundle"), attribute.String("reason", ctx.Err().Error()))
			return
		}
	}
}

func reconcileOrphanSecurityGroupShards(ctx context.Context, svc *service.Service, janitor provider.SecurityGroupShardJanitor, ttl time.Duration, region string) (int, error) {
	if janitor == nil {
		return 0, nil
	}
	if ttl <= 0 {
		ttl = defaultOrphanSGTTL
	}
	referenced, err := referencedSecurityGroupIDs(ctx, svc)
	if err != nil {
		return 0, err
	}
	shards, err := janitor.ListManagedPendingSecurityGroupShards(ctx, region)
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	deleted := 0
	for _, shard := range shards {
		if shard.CreatedAt.IsZero() || now.Sub(shard.CreatedAt) < ttl {
			continue
		}
		if _, ok := referenced[shard.ID]; ok {
			continue
		}
		if err := janitor.DeleteSecurityGroup(ctx, shard.Region, shard.ID); err != nil {
			emitWorkerEvent(ctx, "sandbox.sg_shard.orphan_delete_failed", "worker 发现了一个超过 TTL 且没有任何 DB 引用的 orphan SG shard，但删除腾讯云安全组失败。", attribute.String("security_group_id", shard.ID), attribute.String("region", shard.Region), attribute.String("description", shard.Description), attribute.String("error", err.Error()))
			continue
		}
		deleted++
		emitWorkerEvent(ctx, "sandbox.sg_shard.orphan_deleted", "worker 已删除一个超过 TTL 且没有任何 DB 引用的 orphan SG shard。", attribute.String("security_group_id", shard.ID), attribute.String("region", shard.Region), attribute.String("description", shard.Description), attribute.String("age", now.Sub(shard.CreatedAt).String()))
	}
	return deleted, nil
}

func referencedSecurityGroupIDs(ctx context.Context, svc *service.Service) (map[string]struct{}, error) {
	referenced := map[string]struct{}{}
	bundles, err := svc.ListCapacityBundles(ctx)
	if err != nil {
		return nil, err
	}
	for _, bundle := range bundles {
		for _, sgID := range bundle.SecurityGroupIDs {
			if trimmed := strings.TrimSpace(sgID); trimmed != "" {
				referenced[trimmed] = struct{}{}
			}
		}
	}
	pools, err := svc.ListPools(ctx)
	if err != nil {
		return nil, err
	}
	for _, pool := range pools {
		for _, sgID := range pool.SecurityGroups {
			if trimmed := strings.TrimSpace(sgID); trimmed != "" {
				referenced[trimmed] = struct{}{}
			}
		}
	}
	return referenced, nil
}

func runSKURolloutLoop(ctx context.Context, svc *service.Service, interval time.Duration) {
	emitWorkerEvent(ctx, "sandbox.worker.loop_started", "sku rollout loop 已启动，worker 会周期性推进 SKU 串行 rollout。", attribute.String("loop", "sku_rollout"), attribute.String("interval", interval.String()))
	runOnce := interval <= 0
	for {
		if advanced, err := advanceSKURollouts(ctx, svc); err != nil {
			attrs := []attribute.KeyValue{
				attribute.String("error", err.Error()),
			}
			var rolloutErr *skuRolloutError
			if errors.As(err, &rolloutErr) {
				attrs = append(attrs,
					attribute.String("sku_id", rolloutErr.skuID),
					attribute.String("pool_id", rolloutErr.poolID),
					attribute.String("stage", rolloutErr.stage),
				)
			}
			observability.EmitEvent(ctx, "sandbox.sku_rollout.failed", "SKU 串行 rollout 控制循环执行失败，本轮未能完成推进；事件里会带出出错的 SKU、pool 和阶段，便于快速定位失败点。", attrs...)
		} else if advanced > 0 {
			emitWorkerEvent(ctx, "sandbox.sku_rollout.advanced", "本轮 sku rollout loop 已成功推进一个或多个 SKU。", attribute.Int("advanced_sku_count", advanced))
		}
		if runOnce {
			return
		}
		select {
		case <-time.After(interval):
		case <-ctx.Done():
			emitWorkerEvent(ctx, "sandbox.worker.loop_stopped", "sku rollout loop 已停止。", attribute.String("loop", "sku_rollout"), attribute.String("reason", ctx.Err().Error()))
			return
		}
	}
}

func advanceSKURollouts(ctx context.Context, svc *service.Service) (int, error) {
	skus, err := svc.ListSKUs(ctx)
	if err != nil {
		return 0, err
	}
	advanced := 0
	for _, sku := range skus {
		changed, err := advanceSingleSKURollout(ctx, svc, sku)
		if err != nil {
			return advanced, err
		}
		if changed {
			advanced++
		}
	}
	return advanced, nil
}

func advanceSingleSKURollout(ctx context.Context, svc *service.Service, sku core.SKU) (bool, error) {
	desired := strings.TrimSpace(sku.DesiredImageID)
	stable := strings.TrimSpace(sku.StableImageID)
	previousState := sku.RolloutState
	previousReason := strings.TrimSpace(sku.LastRolloutError)
	previousCursor := strings.TrimSpace(sku.RolloutCursorPoolID)
	pools, err := svc.ListPoolsForSKU(ctx, sku.ID)
	if err != nil {
		return false, newSKURolloutError(sku.ID, "", "list_pools_for_sku", err)
	}
	if desired == "" {
		return false, nil
	}
	if len(pools) == 0 {
		if sku.StableImageID == desired && sku.RolloutState == core.SKURolloutStateStable {
			return false, nil
		}
		sku.StableImageID = desired
		sku.RolloutState = core.SKURolloutStateStable
		sku.RolloutCursorPoolID = ""
		sku.TotalPoolCount = 0
		sku.ConvergedPoolCount = 0
		sku.PoolsPendingRollout = 0
		_, err := svc.UpsertSKU(ctx, sku)
		if err == nil {
			observability.EmitEvent(ctx, "sandbox.sku_rollout.converged", "该 SKU 当前没有运行中的 pool，控制器已将 stable_image_id 直接收敛到目标镜像，并清空 rollout 游标。", attribute.String("sku_id", sku.ID), attribute.String("desired_image_id", desired))
		}
		if err != nil {
			return false, newSKURolloutError(sku.ID, "", "persist_empty_pool_converged", err)
		}
		return true, nil
	}

	pending := make([]core.Pool, 0, len(pools))
	converged := 0
	for _, pool := range pools {
		if pool.BaseImage == desired {
			converged++
			continue
		}
		pending = append(pending, pool)
	}
	sku.TotalPoolCount = len(pools)
	sku.ConvergedPoolCount = converged
	sku.PoolsPendingRollout = len(pending)

	if len(pending) == 0 {
		if stable == desired && sku.RolloutState == core.SKURolloutStateStable && sku.RolloutCursorPoolID == "" {
			return false, nil
		}
		sku.StableImageID = desired
		sku.RolloutState = core.SKURolloutStateStable
		sku.RolloutCursorPoolID = ""
		_, err := svc.UpsertSKU(ctx, sku)
		if err == nil {
			observability.EmitEvent(ctx, "sandbox.sku_rollout.converged", "该 SKU 下所有 pool 都已收敛到目标镜像，rollout 完成并回到 stable 状态。", attribute.String("sku_id", sku.ID), attribute.String("desired_image_id", desired), attribute.Int("total_pool_count", len(pools)))
		}
		if err != nil {
			return false, newSKURolloutError(sku.ID, "", "persist_converged", err)
		}
		return true, nil
	}

	sku.RolloutState = core.SKURolloutStateRolling
	eligiblePending := make([]core.Pool, 0, len(pending))
	for _, pool := range pending {
		if service.PoolEligibleForRollout(pool) {
			eligiblePending = append(eligiblePending, pool)
		}
	}
	if sku.RolloutCursorPoolID == "" {
		if len(eligiblePending) == 0 {
			sku.RolloutState = core.SKURolloutStateBlocked
			sku.LastRolloutError = "no eligible pools for rollout"
			_, err := svc.UpsertSKU(ctx, sku)
			if err == nil {
				emitSKURolloutBlockedIfChanged(ctx, previousState, previousReason, previousCursor, sku, "", "该 SKU 虽然仍有待升级 pool，但当前没有任何符合条件的 pool 可以开始 rollout，因此被标记为 blocked。", attribute.Int("pending_pool_count", len(pending)))
			}
			if err != nil {
				return false, newSKURolloutError(sku.ID, "", "persist_blocked_no_eligible_pool", err)
			}
			return true, nil
		}
		startedAt := time.Now().UTC()
		_, _, err := svc.BeginSKUPoolRollout(ctx, sku.ID, eligiblePending[0].ID, desired, startedAt)
		if err == nil {
			observability.EmitEvent(ctx, "sandbox.sku_rollout.target_selected", "控制器已经为该 SKU 选定本轮 rollout 目标 pool，并开始将这个 pool 切到目标镜像。", attribute.String("sku_id", sku.ID), attribute.String("pool_id", eligiblePending[0].ID), attribute.String("desired_image_id", desired))
		}
		if err != nil {
			return false, newSKURolloutError(sku.ID, eligiblePending[0].ID, "begin_rollout_from_pending", err)
		}
		return true, nil
	}

	var cursorPool *core.Pool
	for i := range pools {
		if pools[i].ID == sku.RolloutCursorPoolID {
			cursorPool = &pools[i]
			break
		}
	}
	if cursorPool == nil {
		sku.RolloutCursorPoolID = ""
		sku.RolloutState = core.SKURolloutStateBlocked
		sku.LastRolloutError = "rollout cursor pool missing"
		_, err := svc.UpsertSKU(ctx, sku)
		if err == nil {
			emitSKURolloutBlockedIfChanged(ctx, previousState, previousReason, previousCursor, sku, "", "rollout 当前指向的游标 pool 已不存在，控制器无法继续推进本轮升级，因此将该 SKU 标记为 blocked。")
		}
		if err != nil {
			return false, newSKURolloutError(sku.ID, "", "persist_blocked_missing_cursor", err)
		}
		return true, nil
	}
	if !service.PoolEligibleForRollout(*cursorPool) {
		sku.RolloutState = core.SKURolloutStateBlocked
		sku.LastRolloutError = "rollout cursor pool not eligible"
		_, err := svc.UpsertSKU(ctx, sku)
		if err == nil {
			emitSKURolloutBlockedIfChanged(ctx, previousState, previousReason, previousCursor, sku, cursorPool.ID, "rollout 当前游标 pool 已不再满足可升级条件，例如被暂停或排水，因此该 SKU 的 rollout 被阻塞。")
		}
		if err != nil {
			return false, newSKURolloutError(sku.ID, cursorPool.ID, "persist_blocked_ineligible_cursor", err)
		}
		return true, nil
	}
	if cursorPool.BaseImage != desired {
		startedAt := time.Now().UTC()
		_, _, err := svc.BeginSKUPoolRollout(ctx, sku.ID, cursorPool.ID, desired, startedAt)
		if err == nil {
			observability.EmitEvent(ctx, "sandbox.sku_rollout.target_selected", "rollout 游标 pool 还未真正切到目标镜像，控制器本轮再次触发该 pool 的镜像切换。", attribute.String("sku_id", sku.ID), attribute.String("pool_id", cursorPool.ID), attribute.String("desired_image_id", desired))
		}
		if err != nil {
			return false, newSKURolloutError(sku.ID, cursorPool.ID, "begin_rollout_from_cursor", err)
		}
		return true, nil
	}
	if !svc.PoolRolloutReady(ctx, *cursorPool) {
		if sku.LastRolloutStartedAt != nil && time.Since(*sku.LastRolloutStartedAt) > skuRolloutTimeout {
			sku.RolloutState = core.SKURolloutStateBlocked
			sku.LastRolloutError = "rollout cursor timeout"
			_, err := svc.UpsertSKU(ctx, sku)
			if err == nil {
				emitSKURolloutBlockedIfChanged(ctx, previousState, previousReason, previousCursor, sku, cursorPool.ID, "rollout 游标 pool 在规定时间内没有恢复到健康可服务状态，控制器因此停止推进并标记 blocked。")
			}
			if err != nil {
				return false, newSKURolloutError(sku.ID, cursorPool.ID, "persist_blocked_cursor_timeout", err)
			}
			return true, nil
		}
		_, err := svc.UpsertSKU(ctx, sku)
		if err != nil {
			return false, newSKURolloutError(sku.ID, cursorPool.ID, "persist_waiting_for_recovery", err)
		}
		return true, nil
	}

	for _, pool := range eligiblePending {
		if pool.ID == cursorPool.ID {
			continue
		}
		sku.RolloutCursorPoolID = pool.ID
		sku.LastRolloutError = ""
		_, err := svc.UpsertSKU(ctx, sku)
		if err == nil {
			observability.EmitEvent(ctx, "sandbox.sku_rollout.cursor_advanced", "当前 rollout 目标 pool 已恢复健康，控制器将游标推进到下一个待升级 pool。", attribute.String("sku_id", sku.ID), attribute.String("completed_pool_id", cursorPool.ID), attribute.String("next_pool_id", pool.ID), attribute.String("desired_image_id", desired))
		}
		if err != nil {
			return false, newSKURolloutError(sku.ID, pool.ID, "persist_cursor_advanced", err)
		}
		return true, nil
	}

	sku.StableImageID = desired
	sku.RolloutState = core.SKURolloutStateStable
	sku.RolloutCursorPoolID = ""
	_, err = svc.UpsertSKU(ctx, sku)
	if err == nil {
		observability.EmitEvent(ctx, "sandbox.sku_rollout.converged", "该 SKU 的最后一个待升级 pool 已恢复正常，控制器已将 stable_image_id 推进到目标镜像，表示 rollout 全部完成。", attribute.String("sku_id", sku.ID), attribute.String("desired_image_id", desired), attribute.Int("total_pool_count", len(pools)))
	}
	if err != nil {
		return false, newSKURolloutError(sku.ID, "", "persist_converged_final", err)
	}
	return true, nil
}

func shouldEmitSKURolloutStateEvent(previousState core.SKURolloutState, previousReason string, previousCursor string, nextState core.SKURolloutState, nextReason string, nextCursor string) bool {
	return previousState != nextState ||
		strings.TrimSpace(previousReason) != strings.TrimSpace(nextReason) ||
		strings.TrimSpace(previousCursor) != strings.TrimSpace(nextCursor)
}

func doRefill(ctx context.Context, svc *service.Service, cp provider.CloudProvider, metrics *observability.WorkerMetrics, poolID string, count int, concurrency int) error {
	shardTotal, shardIndex, shardOK := store.ShardFromContext(ctx)
	pools := []core.Pool{}
	if poolID != "" {
		pool, err := svc.GetPool(ctx, poolID)
		if err != nil {
			return err
		}
		pools = append(pools, pool)
	} else {
		all, err := svc.ListPools(ctx)
		if err != nil {
			return err
		}
		pools = append(pools, all...)
	}
	for _, pool := range pools {
		if pool.Status == core.PoolStatusPaused {
			if shouldEmitRefillSkipped(pool) {
				observability.EmitEvent(ctx, "sandbox.refill.skipped", "当前 pool 处于暂停状态，因此 worker 跳过了这次补货，不会为它继续创建新实例。", attribute.String("pool_id", pool.ID), attribute.String("reason", pool.PauseReason))
			}
			continue
		}
		clearRefillSkipped(pool.ID)
		refillCount := count
		if refillCount <= 0 {
			desiredTotal := pool.DesiredCap
			desired := desiredCapacityTargetForShard(desiredTotal, shardTotal, shardIndex)

			// desired_capacity targets CLEAN inventory. Treat everything that's "not ALLOCATED" as present
			// capacity-in-progress to avoid over-creating when cleanup/reinstall/verify is lagging.
			// We intentionally do NOT count ALLOCATED as inventory since it's checked out by clients.
			clean := countInventory(ctx, svc, pool.ID, core.StateClean)
			inflight := countInventory(ctx, svc, pool.ID,
				core.StateCreating,
				core.StateDry,
				core.StateResetting,
				core.StateReinstalling, // legacy persisted state
				core.StateDeleting,
				core.StateFailed,
			)

			if clean > desired {
				excess := clean - desired
				if shardOK {
					emitWorkerEvent(ctx, "sandbox.capacity_shrink.triggered", "当前 CLEAN 库存高于目标水位，worker 将开始回收多余实例。", attribute.String("pool_id", pool.ID), attribute.Int("shard_total", shardTotal), attribute.Int("shard_index", shardIndex), attribute.Int("desired_total_capacity", desiredTotal), attribute.Int("shard_target_capacity", desired), attribute.Int("clean_inventory", clean), attribute.Int("excess_count", excess))
				} else {
					emitWorkerEvent(ctx, "sandbox.capacity_shrink.triggered", "当前 CLEAN 库存高于目标水位，worker 将开始回收多余实例。", attribute.String("pool_id", pool.ID), attribute.Int("shard_target_capacity", desired), attribute.Int("clean_inventory", clean), attribute.Int("excess_count", excess))
				}
				if err := shrinkClean(ctx, svc, cp, pool.ID, excess, concurrency); err != nil {
					return err
				}
				continue
			}

			refillCount = desired - (clean + inflight)
			if refillCount <= 0 {
				continue
			}
			observability.EmitEvent(ctx, "sandbox.refill.triggered", "当前 pool 的可用库存低于目标水位，worker 因此触发了一次补货决策；事件里会带出库存缺口和本次计划补货数量。",
				attribute.String("pool_id", pool.ID),
				attribute.String("template_class_id", pool.TemplateClassID),
				attribute.String("sku_id", pool.SKUID),
				attribute.Int("desired_total_capacity", desiredTotal),
				attribute.Int("shard_target_capacity", desired),
				attribute.Int("clean_inventory", clean),
				attribute.Int("inflight_inventory", inflight),
				attribute.Int("refill_count", refillCount),
				attribute.Int("shard_total", shardTotal),
				attribute.Int("shard_index", shardIndex),
			)
		}
		result, err := createBatch(ctx, svc, cp, metrics, pool, refillCount, concurrency)
		if err != nil {
			observability.EmitEvent(ctx, "sandbox.refill.batch_setup_failed", "本轮补货在进入逐实例创建之前就失败了，通常表示占位实例或批次初始化阶段出错，而不是单个实例创建失败。", attribute.String("pool_id", pool.ID), attribute.String("template_class_id", pool.TemplateClassID), attribute.String("sku_id", pool.SKUID), attribute.String("stage", "insert_creating"), attribute.String("error", err.Error()))
			return err
		}
		if len(result.created) > 0 {
			if metrics != nil {
				metrics.ObserveRefillCreated(pool.ID, len(result.created))
			}
			if _, err := svc.ResetPoolRefillFailures(ctx, pool.ID); err != nil {
				return err
			}
			createdSample, truncated := refillCreatedSummaries(result.created)
			observability.EmitEvent(ctx, "sandbox.refill.created", "本轮补货已经成功创建实例并补回到目标 pool；事件里会给出补货数量，以及新建实例的摘要信息。",
				attribute.String("pool_id", pool.ID),
				attribute.String("template_class_id", pool.TemplateClassID),
				attribute.String("sku_id", pool.SKUID),
				attribute.Int("created_count", len(result.created)),
				attribute.Int("created_instances_total_count", len(result.created)),
				attribute.Bool("created_instances_truncated", truncated),
				observability.AttrJSON("created_instances_sample", createdSample),
			)
			continue
		}
		if result.terminalFailure {
			if metrics != nil {
				for i := 0; i < result.createFailures; i++ {
					metrics.ObserveRefillFailure(pool.ID, result.firstCreateCode, true)
				}
				metrics.ObservePoolPaused(pool.ID, "terminal")
			}
			recovery, err := svc.ReconcileSGShardRecovery(ctx, cp, pool, result.firstCreateCode)
			if err != nil {
				emitWorkerEvent(ctx, "sandbox.sg_shard.auto_provision_failed", "worker 识别到安全组分片触顶后尝试自动扩新的 SG shard，但这次扩张失败。", attribute.String("pool_id", pool.ID), attribute.String("template_class_id", pool.TemplateClassID), attribute.String("sku_id", pool.SKUID), attribute.String("trigger_error_code", result.firstCreateCode), attribute.String("error", err.Error()))
			} else if recovery.Triggered {
				emitWorkerEvent(ctx, "sandbox.sg_shard.auto_provisioned", "worker 识别到安全组分片已触顶，已自动 provision 新的 SG shard bundle，并派生出新的 pool 接流量。", attribute.String("template_class_id", pool.TemplateClassID), attribute.String("sku_id", pool.SKUID), attribute.String("source_pool_id", pool.ID), attribute.String("bundle_id", recovery.Bundle.ID), attribute.StringSlice("bundle_security_group_ids", recovery.Bundle.SecurityGroupIDs), attribute.String("new_pool_id", recovery.NewPool.ID), attribute.Bool("pool_created", recovery.PoolCreated), attribute.String("trigger_error_code", result.firstCreateCode))
			} else if service.IsSecurityGroupShardLimitCode(result.firstCreateCode) {
				emitWorkerEvent(ctx, "sandbox.sg_shard.auto_provision_skipped", "同一个 source pool 的 SG shard recovery 已经在进行中，本轮 worker 不会重复扩张。", attribute.String("source_pool_id", pool.ID), attribute.String("trigger_error_code", result.firstCreateCode))
			}
			reason := "terminal create error"
			if result.firstCreateCode != "" {
				reason = "terminal create error: " + result.firstCreateCode
			}
			if _, err := svc.PausePool(ctx, pool.ID, reason, result.firstCreateCode, result.firstCreateDetail); err != nil {
				return err
			}
			observability.EmitEvent(ctx, "sandbox.refill.pool_paused", "补货失败被判定为终局性错误，控制器已自动暂停该 pool，避免后续流量或补货继续打到有问题的池子。", attribute.String("pool_id", pool.ID), attribute.String("template_class_id", pool.TemplateClassID), attribute.String("sku_id", pool.SKUID), attribute.String("error_code", result.firstCreateCode), attribute.String("pause_reason", reason))
			continue
		}
		if result.createFailures > 0 {
			if metrics != nil {
				for i := 0; i < result.createFailures; i++ {
					metrics.ObserveRefillFailure(pool.ID, result.firstCreateCode, false)
				}
			}
			updated, paused, err := svc.RecordPoolRefillFailure(ctx, pool.ID, result.firstCreateCode, result.firstCreateDetail, refillFailureThreshold)
			if err != nil {
				return err
			}
			if paused {
				if metrics != nil {
					metrics.ObservePoolPaused(updated.ID, "threshold")
				}
				observability.EmitEvent(ctx, "sandbox.refill.pool_paused", "该 pool 在连续多次补货失败后触发了阈值熔断，控制器已自动暂停它，等待人工排查或后续恢复。", attribute.String("pool_id", updated.ID), attribute.String("template_class_id", updated.TemplateClassID), attribute.String("sku_id", updated.SKUID), attribute.String("error_code", updated.LastRefillErrorCode), attribute.String("pause_reason", updated.PauseReason))
			}
		}
	}
	return nil
}

func desiredCapacityTargetForShard(desiredTotal, shardTotal, shardIndex int) int {
	if desiredTotal <= 0 {
		return 0
	}
	if shardTotal <= 0 || shardIndex < 0 || shardIndex >= shardTotal {
		return desiredTotal
	}
	base := desiredTotal / shardTotal
	remainder := desiredTotal % shardTotal
	target := base
	if shardIndex < remainder {
		target++
	}
	return target
}

func shrinkClean(ctx context.Context, svc *service.Service, cp provider.CloudProvider, poolID string, excess int, concurrency int) error {
	if excess <= 0 {
		return nil
	}
	insts, err := svc.ListInstancesByStates(ctx, poolID, []core.InstanceState{core.StateClean}, excess)
	if err != nil {
		return err
	}
	if len(insts) == 0 {
		return nil
	}
	if concurrency <= 0 {
		concurrency = 1
	}

	sem := make(chan struct{}, concurrency)
	var removed int32
	var wg sync.WaitGroup
	for _, inst := range insts {
		sem <- struct{}{}
		wg.Add(1)
		go func(inst core.Instance) {
			defer wg.Done()
			defer func() { <-sem }()

			if _, err := svc.AdvanceState(ctx, inst.ID, core.StateDeleting); err != nil {
				emitWorkerEvent(ctx, "sandbox.capacity_shrink.instance_mark_failed", "worker 尝试把多余的 CLEAN 实例标记为删除中失败，本次缩容不会继续处理这个实例。", attribute.String("pool_id", poolID), attribute.String("instance_id", inst.ID), attribute.String("error", err.Error()))
				return
			}
			if inst.CloudID != "" {
				if err := cp.TerminateInstance(ctx, inst.CloudID); err != nil {
					emitWorkerEvent(ctx, "sandbox.capacity_shrink.instance_terminate_failed", "worker 在缩容过程中终止云实例失败，该实例会保留在 DELETING 等待后续重试。", attribute.String("pool_id", poolID), attribute.String("instance_id", inst.ID), attribute.String("cloud_id", inst.CloudID), attribute.String("error", err.Error()))
					// Keep in DELETING for retry by cleanup loop.
					return
				}
			}
			if _, err := svc.AdvanceState(ctx, inst.ID, core.StateDeleted); err != nil {
				emitWorkerEvent(ctx, "sandbox.capacity_shrink.instance_finalize_failed", "worker 在缩容过程中未能把实例推进到 DELETED 状态。", attribute.String("pool_id", poolID), attribute.String("instance_id", inst.ID), attribute.String("error", err.Error()))
				return
			}
			if err := svc.DeleteInstance(ctx, inst.ID); err != nil {
				emitWorkerEvent(ctx, "sandbox.capacity_shrink.instance_record_delete_failed", "worker 已完成实例删除，但清理本地实例记录失败。", attribute.String("pool_id", poolID), attribute.String("instance_id", inst.ID), attribute.String("error", err.Error()))
				return
			}
			atomic.AddInt32(&removed, 1)
		}(inst)
	}
	wg.Wait()
	if removed > 0 {
		emitWorkerEvent(ctx, "sandbox.capacity_shrink.completed", "worker 已完成本轮多余 CLEAN 实例回收。", attribute.String("pool_id", poolID), attribute.Int("requested_removal_count", excess), attribute.Int("removed_count", int(removed)))
	}
	if int(removed) < excess {
		emitWorkerEvent(ctx, "sandbox.capacity_shrink.partial", "worker 本轮计划缩容的实例数量未完全回收，仍有部分实例留待后续处理。", attribute.String("pool_id", poolID), attribute.Int("requested_removal_count", excess), attribute.Int("removed_count", int(removed)))
	}
	return nil
}

func createBatch(ctx context.Context, svc *service.Service, cp provider.CloudProvider, metrics *observability.WorkerMetrics, pool core.Pool, refillCount int, concurrency int) (createBatchResult, error) {
	result := createBatchResult{}
	if concurrency <= 0 {
		concurrency = 1
	}
	placeholders, err := svc.InsertCreating(ctx, pool.ID, refillCount)
	if err != nil {
		return result, err
	}
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	var mu sync.Mutex

	for i := 0; i < len(placeholders); i++ {
		sem <- struct{}{}
		wg.Add(1)
		go func(inst core.Instance) {
			defer wg.Done()
			defer func() { <-sem }()
			cid, addr, err := cp.CreateInstance(ctx, pool)
			if err != nil {
				code, terminal := provider.ClassifyCreateError(err)
				mu.Lock()
				result.createFailures++
				if result.firstCreateCode == "" {
					result.firstCreateCode = code
					result.firstCreateDetail = err.Error()
				}
				if terminal {
					result.terminalFailure = true
				}
				mu.Unlock()
				emitWorkerEvent(ctx, "sandbox.refill.instance_create_failed", "worker 在补货过程中创建云实例失败，这个占位实例将被标记为失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("error_code", code), attribute.Bool("terminal_failure", terminal), attribute.String("error", err.Error()))
				if cid != "" || addr != "" {
					if _, ferr := svc.FinalizeCreating(ctx, inst.ID, core.StateFailed, addr, cid); ferr != nil {
						emitWorkerEvent(ctx, "sandbox.refill.instance_finalize_failed", "worker 创建失败后尝试把占位实例标记为 FAILED，但状态落库失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("error", ferr.Error()))
						_ = markFailedFallback(ctx, svc, inst.ID)
					}
				} else {
					if _, ferr := svc.FinalizeCreating(ctx, inst.ID, core.StateFailed, "", ""); ferr != nil {
						emitWorkerEvent(ctx, "sandbox.refill.instance_finalize_failed", "worker 创建失败后尝试把占位实例标记为 FAILED，但状态落库失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("error", ferr.Error()))
						_ = markFailedFallback(ctx, svc, inst.ID)
					}
				}
				return
			}
			if err := verifyCreatedInstance(ctx, cp, pool.ID, inst.ID, addr); err != nil {
				if metrics != nil {
					metrics.ObserveVerifyFailure(pool.ID, "create")
				}
				emitWorkerEvent(ctx, "sandbox.refill.instance_verify_failed", "worker 在补货后校验新实例可用性失败，该实例将被标记为 FAILED 并尝试回收云侧资源。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("address", addr), attribute.String("error", err.Error()))
				if _, ferr := svc.FinalizeCreating(ctx, inst.ID, core.StateFailed, addr, cid); ferr != nil {
					emitWorkerEvent(ctx, "sandbox.refill.instance_finalize_failed", "worker 在校验失败后尝试把占位实例标记为 FAILED，但状态落库失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("error", ferr.Error()))
					_ = markFailedFallback(ctx, svc, inst.ID)
				}
				if cid != "" {
					_ = cp.TerminateInstance(ctx, cid)
				}
				return
			}
			if _, ferr := svc.FinalizeCreating(ctx, inst.ID, core.StateClean, addr, cid); ferr != nil {
				emitWorkerEvent(ctx, "sandbox.refill.instance_finalize_failed", "worker 已成功创建并校验实例，但推进到 CLEAN 状态失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("error", ferr.Error()))
				if cid != "" {
					_ = cp.TerminateInstance(ctx, cid)
				}
				_ = markFailedFallback(ctx, svc, inst.ID)
				return
			}
		}(placeholders[i])
	}
	wg.Wait()
	// Collect finalized instances from store to reflect latest state.
	created := make([]core.Instance, 0, len(placeholders))
	for _, ph := range placeholders {
		inst, err := svc.GetInstance(ctx, ph.ID)
		if err != nil {
			continue
		}
		if inst.State == core.StateClean {
			created = append(created, inst)
		}
	}
	result.created = created
	return result, nil
}

func verifyCreatedInstance(ctx context.Context, cp provider.CloudProvider, poolID, instanceID, addr string) error {
	if createVerifyRetries <= 1 {
		return cp.VerifyInstance(ctx, addr)
	}

	var lastErr error
	for attempt := 1; attempt <= createVerifyRetries; attempt++ {
		lastErr = cp.VerifyInstance(ctx, addr)
		if lastErr == nil {
			if attempt > 1 {
				emitWorkerEvent(ctx, "sandbox.refill.instance_verify_recovered", "worker 对新实例的健康校验在重试后恢复成功，本次补货可以继续推进。", attribute.String("pool_id", poolID), attribute.String("instance_id", instanceID), attribute.String("address", addr), attribute.Int("attempt", attempt), attribute.Int("max_attempts", createVerifyRetries))
			}
			return nil
		}
		if attempt == createVerifyRetries {
			break
		}

		wait := nextCreateVerifyBackoff(attempt)
		emitWorkerEvent(ctx, "sandbox.refill.instance_verify_retry", "worker 对新实例的健康校验失败，准备按退避策略重试。", attribute.String("pool_id", poolID), attribute.String("instance_id", instanceID), attribute.String("address", addr), attribute.Int("attempt", attempt), attribute.Int("max_attempts", createVerifyRetries), attribute.String("wait", wait.String()), attribute.String("error", lastErr.Error()))
		if wait <= 0 {
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
	return lastErr
}

func nextCreateVerifyBackoff(attempt int) time.Duration {
	if createVerifyBackoff <= 0 {
		return 0
	}
	wait := createVerifyBackoff
	for i := 1; i < attempt; i++ {
		wait *= 2
		if createVerifyMaxWait > 0 && wait >= createVerifyMaxWait {
			return createVerifyMaxWait
		}
	}
	return wait
}

// markFailedFallback best-effort marks a creating instance as FAILED if finalize failed.
func markFailedFallback(ctx context.Context, svc *service.Service, id string) error {
	if _, err := svc.FinalizeCreating(ctx, id, core.StateFailed, "", ""); err == nil {
		return nil
	}
	_, err := svc.AdvanceState(ctx, id, core.StateFailed)
	return err
}

func countInventory(ctx context.Context, svc *service.Service, poolID string, states ...core.InstanceState) int {
	insts, err := svc.ListInstancesByStates(ctx, poolID, states, 0)
	if err != nil {
		return 0
	}
	return len(insts)
}

func runResetLoop(ctx context.Context, svc *service.Service, cp provider.CloudProvider, poolFilter, imageOverride string, interval time.Duration, concurrency int) {
	emitWorkerEvent(ctx, "sandbox.worker.loop_started", "reset loop 已启动，worker 会处理 DRY 和 RESETTING 实例的重装与恢复。", attribute.String("loop", "reset"), attribute.String("interval", interval.String()), attribute.Int("concurrency", concurrency))
	runOnce := interval <= 0
	rs := newResetScheduler(concurrency)
	for {
		pools, err := svc.ListPools(ctx)
		if err != nil {
			emitWorkerEvent(ctx, "sandbox.worker.loop_failed", "reset loop 读取 pools 失败，本轮重置扫描未完成。", attribute.String("loop", "reset"), attribute.String("stage", "list_pools"), attribute.String("error", err.Error()))
		} else {
			for _, pool := range pools {
				if poolFilter != "" && pool.ID != poolFilter {
					continue
				}
				// Schedule work without blocking the loop on long-running reinstall/verify calls.
				// Otherwise a single sweep can take 30s+ and DRY will appear to "sit" in DB.
				schedulePoolResetWork(ctx, svc, cp, pool, imageOverride, rs)
			}
		}
		if runOnce {
			// For one-shot mode, wait for scheduled work to finish before exiting.
			rs.Wait()
			return
		}
		select {
		case <-time.After(interval):
		case <-ctx.Done():
			emitWorkerEvent(ctx, "sandbox.worker.loop_stopped", "reset loop 已停止。", attribute.String("loop", "reset"), attribute.String("reason", ctx.Err().Error()))
			rs.Wait()
			return
		}
	}
}

// resetScheduler bounds concurrent cloud calls across sweeps without blocking the reset loop.
type resetScheduler struct {
	sem chan struct{}
	wg  sync.WaitGroup
}

func newResetScheduler(concurrency int) *resetScheduler {
	if concurrency <= 0 {
		concurrency = 1
	}
	return &resetScheduler{sem: make(chan struct{}, concurrency)}
}

func (s *resetScheduler) TryGo(fn func()) bool {
	select {
	case s.sem <- struct{}{}:
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer func() { <-s.sem }()
			fn()
		}()
		return true
	default:
		return false
	}
}

func (s *resetScheduler) Wait() {
	s.wg.Wait()
}

// schedulePoolResetWork schedules DRY->RESETTING and RESETTING->CLEAN verification work for one pool.
// It does not block; concurrency is globally bounded by resetScheduler.
func schedulePoolResetWork(ctx context.Context, svc *service.Service, cp provider.CloudProvider, pool core.Pool, imageOverride string, rs *resetScheduler) {
	insts, err := svc.ListInstancesByStates(ctx, pool.ID, []core.InstanceState{core.StateDry}, 0)
	if err != nil {
		emitWorkerEvent(ctx, "sandbox.reset.scan_failed", "worker 读取 pool 的 DRY 实例失败，本轮无法启动这些实例的重装。", attribute.String("pool_id", pool.ID), attribute.String("state", string(core.StateDry)), attribute.String("error", err.Error()))
		return
	}
	// Reinstalling instances may be left behind if verification is flaky/transient. Keep verifying them until
	// they become healthy (or stale scan marks them FAILED).
	resetting, err := svc.ListInstancesByStates(ctx, pool.ID, []core.InstanceState{core.StateResetting, core.StateReinstalling}, 0)
	if err != nil {
		emitWorkerEvent(ctx, "sandbox.reset.scan_failed", "worker 读取 pool 的 RESETTING/Reinstalling 实例失败，本轮无法继续恢复这些实例。", attribute.String("pool_id", pool.ID), attribute.String("state", "RESETTING"), attribute.String("error", err.Error()))
		return
	}
	image := pool.BaseImage
	if imageOverride != "" {
		image = imageOverride
	}

	// Prefer consuming DRY first so they don't "sit" in DB. Each scheduled reinstall will advance
	// DRY -> RESETTING immediately once it has a concurrency slot.
	for _, inst := range insts {
		inst := inst
		if !rs.TryGo(func() {
			if _, err := svc.AdvanceState(ctx, inst.ID, core.StateResetting); err != nil {
				emitWorkerEvent(ctx, "sandbox.reset.instance_mark_failed", "worker 尝试把 DRY 实例推进到 RESETTING 失败，本轮不会继续处理这个实例。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("error", err.Error()))
				return
			}
			emitWorkerEvent(ctx, "sandbox.reset.instance_started", "worker 已选中一个 DRY 实例并开始重装流程。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("cloud_id", inst.CloudID))

			// Best-effort: stop envd from serving old /health during reset; do not fail the reset if this errors.
			if err := provider.BestEffortHupEnvd(ctx, cp, inst.Address); err != nil {
				emitWorkerEvent(ctx, "sandbox.reset.envd_hup_failed", "worker 在重装前尝试通知 envd 关闭旧健康探针失败，但这不会阻止后续重装。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("address", inst.Address), attribute.String("error", err.Error()))
			}
			if err := cp.ReinstallInstance(ctx, inst.CloudID, image); err != nil {
				emitWorkerEvent(ctx, "sandbox.reset.instance_reinstall_failed", "worker 调用云侧重装实例失败，该实例会被标记为 FAILED。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("cloud_id", inst.CloudID), attribute.String("image_id", image), attribute.String("error", err.Error()))
				if _, ferr := svc.AdvanceState(ctx, inst.ID, core.StateFailed); ferr != nil {
					emitWorkerEvent(ctx, "sandbox.reset.instance_mark_failed", "worker 在重装失败后尝试将实例标记为 FAILED，但状态落库失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("cloud_id", inst.CloudID), attribute.String("error", ferr.Error()))
				}
				return
			}
			// Best-effort: observe that reset has started via DescribeInstance instead of probing /health down.
			// This is only a gate to avoid "immediate CLEAN" in cases where VerifyInstance would succeed on the old system.
			_ = observeResetStarted(ctx, cp, inst.CloudID, resetObserveTimeout)
			select {
			case <-time.After(reinstallVerifyDelay):
			case <-ctx.Done():
				return
			}
			if err := cp.VerifyInstance(ctx, inst.Address); err != nil {
				emitWorkerEvent(ctx, "sandbox.reset.instance_verify_failed", "实例重装后健康校验仍未通过，worker 会保留它在 RESETTING，等待后续 sweep 重试。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("address", inst.Address), attribute.String("error", err.Error()))
				// Keep in RESETTING and retry in subsequent sweeps; stale scan will mark FAILED eventually.
				return
			}
			if _, err := svc.AdvanceState(ctx, inst.ID, core.StateClean); err != nil {
				emitWorkerEvent(ctx, "sandbox.reset.instance_mark_failed", "实例重装和校验都成功了，但推进到 CLEAN 状态失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("error", err.Error()))
				return
			}
			emitWorkerEvent(ctx, "sandbox.reset.instance_completed", "worker 已完成实例重装并将其恢复到 CLEAN 状态。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("cloud_id", inst.CloudID))
		}) {
			break
		}
	}

	// Then verify RESETTING -> CLEAN for anything already in-flight.
	for _, inst := range resetting {
		inst := inst
		if !rs.TryGo(func() {
			// Enforce a minimum "settling" window after entering RESETTING before we ever mark CLEAN.
			// This avoids delivering an instance where VerifyInstance still hits the old system (and returns OK)
			// while reinstall is still pending or hasn't taken effect yet.
			if reinstallVerifyDelay > 0 && time.Since(inst.UpdatedAt) < reinstallVerifyDelay {
				return
			}
			if inst.Address == "" {
				// Nothing we can probe; stale scan will clean this up.
				emitWorkerEvent(ctx, "sandbox.reset.instance_probe_missing", "RESETTING 实例缺少地址，worker 本轮无法执行健康校验。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("cloud_id", inst.CloudID))
				return
			}
			if err := cp.VerifyInstance(ctx, inst.Address); err != nil {
				// Transient verify failures (e.g. ingressproxy timeouts) should not destroy the instance.
				emitWorkerEvent(ctx, "sandbox.reset.instance_verify_failed", "RESETTING 实例的健康校验仍未通过，worker 本轮继续等待。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("address", inst.Address), attribute.String("error", err.Error()))
				return
			}
			if _, err := svc.AdvanceState(ctx, inst.ID, core.StateClean); err != nil {
				emitWorkerEvent(ctx, "sandbox.reset.instance_mark_failed", "RESETTING 实例校验通过后，推进到 CLEAN 状态失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("error", err.Error()))
				return
			}
			emitWorkerEvent(ctx, "sandbox.reset.instance_completed", "worker 已将 RESETTING 实例恢复到 CLEAN 状态。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("cloud_id", inst.CloudID))
		}) {
			break
		}
	}
}

// processPool is a synchronous variant used by unit tests.
func processPool(ctx context.Context, svc *service.Service, cp provider.CloudProvider, pool core.Pool, imageOverride string, concurrency int) {
	rs := newResetScheduler(concurrency)
	schedulePoolResetWork(ctx, svc, cp, pool, imageOverride, rs)
	rs.Wait()
}

func observeResetStarted(ctx context.Context, cp provider.CloudProvider, cloudID string, timeout time.Duration) error {
	if cloudID == "" {
		return nil
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	start := time.Now()
	deadline := start.Add(timeout)
	interval := 2 * time.Second

	// We consider any non-RUNNING state as "reset in progress" (best-effort).
	for attempt := 1; ; attempt++ {
		st, err := cp.DescribeInstance(ctx, cloudID)
		if err == nil && st != "" && st != "RUNNING" {
			emitWorkerEvent(ctx, "sandbox.reset.observe_started", "worker 已通过 DescribeInstance 观察到实例开始进入非 RUNNING 状态，说明重装流程已经真正启动。", attribute.String("cloud_id", cloudID), attribute.String("state", st), attribute.String("elapsed", time.Since(start).String()))
			return nil
		}
		if time.Now().After(deadline) {
			if err != nil {
				emitWorkerEvent(ctx, "sandbox.reset.observe_timeout", "worker 在等待实例进入重装中的可观察状态时超时，并记录了最后一次云侧错误。", attribute.String("cloud_id", cloudID), attribute.String("elapsed", time.Since(start).String()), attribute.String("error", err.Error()))
				return err
			}
			emitWorkerEvent(ctx, "sandbox.reset.observe_timeout", "worker 在等待实例进入重装中的可观察状态时超时，但最后一次 DescribeInstance 没有返回明确错误。", attribute.String("cloud_id", cloudID), attribute.String("elapsed", time.Since(start).String()), attribute.String("last_state", st))
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
}

func runCleanupLoop(ctx context.Context, svc *service.Service, cp provider.CloudProvider, poolFilter string, interval time.Duration) {
	emitWorkerEvent(ctx, "sandbox.worker.loop_started", "cleanup loop 已启动，worker 会回收 FAILED 和 DELETING 实例并清理陈旧状态。", attribute.String("loop", "cleanup"), attribute.String("interval", interval.String()))
	runOnce := interval <= 0
	for {
		pools, err := svc.ListPools(ctx)
		if err != nil {
			emitWorkerEvent(ctx, "sandbox.worker.loop_failed", "cleanup loop 读取 pools 失败，本轮清理扫描未完成。", attribute.String("loop", "cleanup"), attribute.String("stage", "list_pools"), attribute.String("error", err.Error()))
		} else {
			for _, pool := range pools {
				if poolFilter != "" && pool.ID != poolFilter {
					continue

				}
				// Stale scan for long-running in-flight states (easy to extend with new ING states).
				cleanupStaleInflightStates(ctx, svc, pool, []inflightStaleRule{
					{State: core.StateCreating, StaleAfter: creatingStaleAfter, Target: core.StateFailed, Name: "creating"},
					{State: core.StateResetting, StaleAfter: resettingStaleAfter, Target: core.StateFailed, Name: "resetting"},
					// Backward compatibility for old rows persisted as REINSTALLING.
					{State: core.StateReinstalling, StaleAfter: resettingStaleAfter, Target: core.StateFailed, Name: "reinstalling(legacy)"},
					// Pausing rows that never reached PAUSED (Q26-D 修订版 + Q32=b).
					{State: core.StatePausing, StaleAfter: pausingStaleAfter, Target: core.StateFailed, Name: "pausing"},
				})

				cleanupFailed(ctx, svc, cp, pool)
				cleanupDeleting(ctx, svc, cp, pool)
			}
		}
		if runOnce {
			return
		}
		select {
		case <-time.After(interval):
		case <-ctx.Done():
			emitWorkerEvent(ctx, "sandbox.worker.loop_stopped", "cleanup loop 已停止。", attribute.String("loop", "cleanup"), attribute.String("reason", ctx.Err().Error()))
			return
		}
	}
}

func cleanupFailed(ctx context.Context, svc *service.Service, cp provider.CloudProvider, pool core.Pool) {
	insts, err := svc.ListInstancesByStates(ctx, pool.ID, []core.InstanceState{core.StateFailed}, 0)
	if err != nil {
		emitWorkerEvent(ctx, "sandbox.cleanup.scan_failed", "worker 读取 FAILED 实例失败，本轮无法继续清理这些实例。", attribute.String("pool_id", pool.ID), attribute.String("state", string(core.StateFailed)), attribute.String("error", err.Error()))
		return
	}
	for _, inst := range insts {
		emitWorkerEvent(ctx, "sandbox.cleanup.failed_instance_started", "worker 开始清理一个 FAILED 实例。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("cloud_id", inst.CloudID))
		if inst.CloudID != "" {
			if err := cp.TerminateInstance(ctx, inst.CloudID); err != nil {
				emitWorkerEvent(ctx, "sandbox.cleanup.instance_terminate_failed", "worker 清理 FAILED 实例时终止云侧实例失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("cloud_id", inst.CloudID), attribute.String("error", err.Error()))
				continue
			}
		}
		if _, err := svc.AdvanceState(ctx, inst.ID, core.StateDeleted); err != nil {
			emitWorkerEvent(ctx, "sandbox.cleanup.instance_mark_failed", "worker 清理 FAILED 实例时推进到 DELETED 状态失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("error", err.Error()))
			continue
		}
		if err := svc.DeleteInstance(ctx, inst.ID); err != nil {
			emitWorkerEvent(ctx, "sandbox.cleanup.instance_record_delete_failed", "worker 已完成 FAILED 实例清理，但删除本地实例记录失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("error", err.Error()))
		}
	}
}

func cleanupStaleInflightStates(ctx context.Context, svc *service.Service, pool core.Pool, rules []inflightStaleRule) {
	for _, rule := range rules {
		insts, err := svc.ListInstancesByStates(ctx, pool.ID, []core.InstanceState{rule.State}, 0)
		if err != nil {
			emitWorkerEvent(ctx, "sandbox.cleanup.scan_failed", "worker 读取陈旧实例状态失败，本轮无法执行 stale scan。", attribute.String("pool_id", pool.ID), attribute.String("state", strings.ToUpper(string(rule.State))), attribute.String("error", err.Error()))
			continue
		}
		for _, inst := range insts {
			if rule.StaleAfter > 0 && time.Since(inst.UpdatedAt) < rule.StaleAfter {
				continue
			}
			if _, err := svc.AdvanceState(ctx, inst.ID, rule.Target); err != nil {
				emitWorkerEvent(ctx, "sandbox.cleanup.stale_mark_failed", "worker 发现实例状态陈旧，但推进到目标状态失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("stale_name", rule.Name), attribute.String("target_state", string(rule.Target)), attribute.String("error", err.Error()))
			} else {
				emitWorkerEvent(ctx, "sandbox.cleanup.stale_marked", "worker 已将陈旧实例推进到目标状态，避免它长期卡在中间态。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("stale_name", rule.Name), attribute.String("target_state", string(rule.Target)))
			}
		}
	}
}

func cleanupDeleting(ctx context.Context, svc *service.Service, cp provider.CloudProvider, pool core.Pool) {
	insts, err := svc.ListInstancesByStates(ctx, pool.ID, []core.InstanceState{core.StateDeleting}, 0)
	if err != nil {
		emitWorkerEvent(ctx, "sandbox.cleanup.scan_failed", "worker 读取 DELETING 实例失败，本轮无法继续删除重试。", attribute.String("pool_id", pool.ID), attribute.String("state", string(core.StateDeleting)), attribute.String("error", err.Error()))
		return
	}
	for _, inst := range insts {
		emitWorkerEvent(ctx, "sandbox.cleanup.deleting_retry_started", "worker 正在重试删除一个仍处于 DELETING 的实例。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("cloud_id", inst.CloudID))
		if inst.CloudID != "" {
			if err := cp.TerminateInstance(ctx, inst.CloudID); err != nil {
				emitWorkerEvent(ctx, "sandbox.cleanup.instance_terminate_failed", "worker 重试删除 DELETING 实例时终止云侧实例失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("cloud_id", inst.CloudID), attribute.String("error", err.Error()))
				continue
			}
		}
		if _, err := svc.AdvanceState(ctx, inst.ID, core.StateDeleted); err != nil {
			if err != core.ErrInstanceNotFound {
				emitWorkerEvent(ctx, "sandbox.cleanup.instance_mark_failed", "worker 重试删除 DELETING 实例时推进到 DELETED 失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("error", err.Error()))
			}
			continue
		}
		if err := svc.DeleteInstance(ctx, inst.ID); err != nil {
			emitWorkerEvent(ctx, "sandbox.cleanup.instance_record_delete_failed", "worker 已完成 DELETING 实例清理，但删除本地实例记录失败。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("error", err.Error()))
		}
	}
}

func runWaterlineLoop(ctx context.Context, svc *service.Service, cp provider.CloudProvider, metrics *observability.WorkerMetrics, interval time.Duration, sample int) {
	if sample < 0 {
		sample = 0
	}
	emitWorkerEvent(ctx, "sandbox.worker.loop_started", "waterline loop 已启动，worker 会周期性检查 CLEAN 水位和抽样健康状态。", attribute.String("loop", "waterline"), attribute.String("interval", interval.String()), attribute.Int("sample", sample))
	runOnce := interval <= 0
	for {
		pools, err := svc.ListPools(ctx)
		if err != nil {
			emitWorkerEvent(ctx, "sandbox.worker.loop_failed", "waterline loop 读取 pools 失败，本轮水位检查未完成。", attribute.String("loop", "waterline"), attribute.String("stage", "list_pools"), attribute.String("error", err.Error()))
		} else {
			for _, pool := range pools {
				checkWaterline(ctx, svc, cp, metrics, pool, sample)
			}
		}
		if runOnce {
			return
		}
		select {
		case <-time.After(interval):
		case <-ctx.Done():
			emitWorkerEvent(ctx, "sandbox.worker.loop_stopped", "waterline loop 已停止。", attribute.String("loop", "waterline"), attribute.String("reason", ctx.Err().Error()))
			return
		}
	}
}

func checkWaterline(ctx context.Context, svc *service.Service, cp provider.CloudProvider, metrics *observability.WorkerMetrics, pool core.Pool, sample int) {
	if pool.Status == core.PoolStatusPaused {
		return
	}
	shardTotal, shardIndex, shardOK := store.ShardFromContext(ctx)
	trackedStates := []core.InstanceState{
		core.StateClean, core.StateCreating, core.StateDeleting,
		core.StateDry, core.StateFailed, core.StateResetting, core.StateReinstalling,
		core.StatePausing, core.StatePaused,
	}
	insts, err := svc.ListInstancesByStates(ctx, pool.ID, trackedStates, 0)
	if err != nil {
		emitWorkerEvent(ctx, "sandbox.waterline.scan_failed", "worker 读取 pool 的库存状态失败，本轮无法完成水位检查。", attribute.String("pool_id", pool.ID), attribute.String("error", err.Error()))
		return
	}
	counts := make(map[core.InstanceState]int)
	clean := make([]core.Instance, 0)
	for _, inst := range insts {
		counts[inst.State]++
		if inst.State == core.StateClean {
			clean = append(clean, inst)
		}
	}
	if metrics != nil {
		for _, state := range trackedStates {
			metrics.SetInventory(pool.ID, string(state), counts[state])
		}
	}
	desired := desiredCapacityTargetForShard(pool.DesiredCap, shardTotal, shardIndex)
	if desired > 0 {
		if counts[core.StateClean] < desired {
			if shardOK {
				emitWorkerEvent(ctx, "sandbox.waterline.warning", "当前 pool 的 CLEAN 水位低于目标值，worker 发出库存预警。", attribute.String("pool_id", pool.ID), attribute.Int("shard_total", shardTotal), attribute.Int("shard_index", shardIndex), attribute.Int("clean_inventory", counts[core.StateClean]), attribute.Int("desired_total_capacity", pool.DesiredCap), attribute.Int("shard_target_capacity", desired), attribute.Int("creating_count", counts[core.StateCreating]), attribute.Int("resetting_count", counts[core.StateResetting]+counts[core.StateReinstalling]), attribute.Int("deleting_count", counts[core.StateDeleting]), attribute.Int("dry_count", counts[core.StateDry]), attribute.Int("failed_count", counts[core.StateFailed]))
			} else {
				emitWorkerEvent(ctx, "sandbox.waterline.warning", "当前 pool 的 CLEAN 水位低于目标值，worker 发出库存预警。", attribute.String("pool_id", pool.ID), attribute.Int("clean_inventory", counts[core.StateClean]), attribute.Int("shard_target_capacity", desired), attribute.Int("creating_count", counts[core.StateCreating]), attribute.Int("resetting_count", counts[core.StateResetting]+counts[core.StateReinstalling]), attribute.Int("deleting_count", counts[core.StateDeleting]), attribute.Int("dry_count", counts[core.StateDry]), attribute.Int("failed_count", counts[core.StateFailed]))
			}
		}
	}
	if sample == 0 || len(clean) == 0 {
		return
	}
	if sample > len(clean) {
		sample = len(clean)
	}
	rand.Shuffle(len(clean), func(i, j int) { clean[i], clean[j] = clean[j], clean[i] })
	check := clean[:sample]
	for _, inst := range check {
		if err := cp.VerifyInstance(ctx, inst.Address); err != nil {
			if metrics != nil {
				metrics.ObserveVerifyFailure(pool.ID, "waterline")
			}
			// Waterline checks are best-effort. A single probe failure (especially via ingressproxy) is not enough
			// to declare the instance broken; avoid destructive actions here to keep inventory stable.
			emitWorkerEvent(ctx, "sandbox.waterline.verify_failed", "waterline 抽样健康检查失败，但 worker 不会立刻对这个实例做破坏性处理。", attribute.String("pool_id", pool.ID), attribute.String("instance_id", inst.ID), attribute.String("address", inst.Address), attribute.String("error", err.Error()))
		}
	}
}

func startWorkerMetricsServer(ctx context.Context, addr string, metrics *observability.WorkerMetrics) {
	if strings.TrimSpace(addr) == "" || metrics == nil {
		return
	}
	mux := http.NewServeMux()
	mux.Handle("/metrics", metrics.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	srv := &http.Server{Addr: addr, Handler: mux}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	go func() {
		emitWorkerEvent(ctx, "sandbox.worker.metrics_server_started", "worker metrics HTTP 服务已启动。", attribute.String("addr", addr))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			emitWorkerEvent(ctx, "sandbox.worker.metrics_server_failed", "worker metrics HTTP 服务异常退出。", attribute.String("addr", addr), attribute.String("error", err.Error()))
		}
	}()
}

func getenv(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}
