package setmanager

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/observability"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

type Config struct {
	Namespace                   string
	ControlURL                  string
	AdminToken                  string
	InternalToken               string
	Source                      string
	Fleet                       string
	RequestLimit                int
	NewSetReplicas              int
	WaitTimeout                 time.Duration
	UpgradeLeaseTTL             time.Duration
	ProbeTimeout                time.Duration
	ProbeInterval               time.Duration
	ProbeModel                  string
	RuntimeCleanerImage         string
	UpgradeEnabled              bool
	DecommissionEnabled         *bool
	RegressionHoldUpgradeStatus string
	RegressionUpgradeOwner      string
}

type ProvisionRequest struct {
	ID            string `json:"id"`
	SetID         string `json:"set_id"`
	Name          string `json:"name"`
	ShardRef      string `json:"shard_ref"`
	DatabaseName  string `json:"database_name"`
	RedisDB       string `json:"redis_db"`
	ReleaseRingID string `json:"release_ring_id,omitempty"`
	ReleaseID     string `json:"release_id,omitempty"`
	ReleaseImage  string `json:"release_image,omitempty"`
	Status        string `json:"status"`
}

type RuntimeCleanupPayload struct {
	CleanupID         string `json:"cleanup_id"`
	SetID             string `json:"set_id"`
	Attempt           int    `json:"attempt"`
	Source            string `json:"source"`
	Namespace         string `json:"namespace"`
	Fleet             string `json:"fleet"`
	ShardRef          string `json:"shard_ref"`
	DatabaseName      string `json:"database_name"`
	RedisDB           string `json:"redis_db"`
	LeaseFingerprint  string `json:"lease_fingerprint"`
	ClaimToken        string `json:"claim_token"`
	CleanupCapability string `json:"cleanup_capability"`
}

func ApplyCleanupToFleet(fleet *LLMFleet, payload RuntimeCleanupPayload) (bool, error) {
	if fleet == nil {
		return false, fmt.Errorf("fleet is required")
	}
	if len(fleet.Spec.Cleanups) > 0 {
		existing := fleet.Spec.Cleanups[0]
		if existing.CleanupID == payload.CleanupID && existing.Attempt == payload.Attempt {
			return false, nil
		}
		return false, fmt.Errorf("fleet already contains cleanup %s attempt %d", existing.CleanupID, existing.Attempt)
	}
	setIndex := -1
	var target LLMFleetSet
	for index, set := range fleet.Spec.Sets {
		if set.Name == payload.SetID {
			setIndex = index
			target = set
			break
		}
	}
	if setIndex >= 0 {
		if target.ShardRef != payload.ShardRef || target.DatabaseName != payload.DatabaseName || target.RedisDB != payload.RedisDB {
			return false, fmt.Errorf("cleanup runtime payload does not match fleet set %q", payload.SetID)
		}
	}
	var shard *LLMFleetShard
	for index := range fleet.Spec.Shards {
		if fleet.Spec.Shards[index].Name == payload.ShardRef {
			shard = &fleet.Spec.Shards[index]
			break
		}
	}
	if shard == nil || shard.RedisDBLimit <= 0 {
		return false, fmt.Errorf("shard %q has no redis db cleanup range", payload.ShardRef)
	}
	if setIndex >= 0 {
		fleet.Spec.Sets = append(fleet.Spec.Sets[:setIndex], fleet.Spec.Sets[setIndex+1:]...)
	}
	removeSetTrafficRuntimes(fleet, payload.SetID)
	fleet.Spec.Cleanups = []LLMFleetCleanup{{
		CleanupID: payload.CleanupID, JobName: runtimeCleanupJobName(payload.CleanupID, payload.Attempt),
		SetID: payload.SetID, Attempt: payload.Attempt,
		Source: payload.Source, Namespace: payload.Namespace, Fleet: payload.Fleet,
		ShardRef: payload.ShardRef, DatabaseName: payload.DatabaseName, RedisDB: payload.RedisDB,
		RedisDBStart: shard.RedisDBStart, RedisDBLimit: shard.RedisDBLimit,
		LeaseFingerprint: payload.LeaseFingerprint, ClaimToken: payload.ClaimToken,
		CleanupCapability: payload.CleanupCapability,
	}}
	return true, nil
}

func removeSetTrafficRuntimes(fleet *LLMFleet, setID string) bool {
	if fleet == nil || strings.TrimSpace(setID) == "" {
		return false
	}
	kept := fleet.Spec.TrafficRuntimes[:0]
	for _, runtime := range fleet.Spec.TrafficRuntimes {
		if runtime.SetID == setID {
			continue
		}
		kept = append(kept, runtime)
	}
	changed := len(kept) != len(fleet.Spec.TrafficRuntimes)
	fleet.Spec.TrafficRuntimes = kept
	return changed
}

func PruneOrphanTrafficRuntimes(fleet *LLMFleet) int {
	if fleet == nil || len(fleet.Spec.TrafficRuntimes) == 0 {
		return 0
	}
	setIDs := make(map[string]struct{}, len(fleet.Spec.Sets))
	for _, set := range fleet.Spec.Sets {
		setIDs[set.Name] = struct{}{}
	}
	kept := fleet.Spec.TrafficRuntimes[:0]
	for _, runtime := range fleet.Spec.TrafficRuntimes {
		if _, ok := setIDs[runtime.SetID]; !ok {
			continue
		}
		kept = append(kept, runtime)
	}
	removed := len(fleet.Spec.TrafficRuntimes) - len(kept)
	fleet.Spec.TrafficRuntimes = kept
	return removed
}

func LoadConfigFromEnv() Config {
	return Config{
		Namespace:                   envString("POD_NAMESPACE", readServiceAccountNamespace()),
		ControlURL:                  strings.TrimRight(envString("LLMGATEWAY_CONTROL_URL", "http://llmgateway-control"), "/"),
		AdminToken:                  os.Getenv("LLMGATEWAY_ADMIN_TOKEN"),
		InternalToken:               os.Getenv("LLMGATEWAY_INTERNAL_TOKEN"),
		Source:                      envString("LLMGATEWAY_SET_MANAGER_SOURCE", "prod"),
		Fleet:                       envString("LLMGATEWAY_SET_MANAGER_FLEET", "prod"),
		RequestLimit:                envInt("LLMGATEWAY_SET_MANAGER_REQUEST_LIMIT", 20),
		NewSetReplicas:              envInt("LLMGATEWAY_SET_MANAGER_NEW_SET_REPLICAS", 2),
		WaitTimeout:                 time.Duration(envInt("LLMGATEWAY_SET_MANAGER_WAIT_TIMEOUT_SECONDS", 300)) * time.Second,
		UpgradeLeaseTTL:             time.Duration(envInt("LLMGATEWAY_SET_UPGRADE_LEASE_SECONDS", 90)) * time.Second,
		ProbeTimeout:                time.Duration(envInt("LLMGATEWAY_SET_UPGRADE_PROBE_TIMEOUT_SECONDS", 180)) * time.Second,
		ProbeInterval:               time.Duration(envInt("LLMGATEWAY_SET_UPGRADE_PROBE_INTERVAL_SECONDS", 10)) * time.Second,
		ProbeModel:                  envString("LLMGATEWAY_SET_UPGRADE_PROBE_MODEL", "auto"),
		RuntimeCleanerImage:         strings.TrimSpace(os.Getenv("LLMGATEWAY_SET_MANAGER_RUNTIME_CLEANER_IMAGE")),
		UpgradeEnabled:              envBool("LLMGATEWAY_SET_MANAGER_UPGRADE_ENABLED", true),
		DecommissionEnabled:         boolPointer(envBool("LLMGATEWAY_SET_MANAGER_DECOMMISSION_ENABLED", true)),
		RegressionHoldUpgradeStatus: strings.TrimSpace(os.Getenv("LLMGATEWAY_REGRESSION_HOLD_UPGRADE_STATUS")),
		RegressionUpgradeOwner:      strings.TrimSpace(os.Getenv("LLMGATEWAY_REGRESSION_UPGRADE_OWNER")),
	}
}

func RunOnce(ctx context.Context, cfg Config, control ControlClient, kube KubeClient) (err error) {
	ctx, span := otel.Tracer(observability.ScopeSetLifecycle).Start(ctx, "llmgateway.set.reconcile",
		trace.WithAttributes(
			attribute.String("llmgateway.reconcile.source", cfg.Source),
			attribute.String("llmgateway.fleet.id", cfg.Fleet),
			attribute.String("k8s.namespace.name", cfg.Namespace),
		),
	)
	defer func() { observability.FinishSpan(span, err, "set_reconcile_failed", nil) }()
	if control.BaseURL == "" {
		control.BaseURL = cfg.ControlURL
	}
	if control.AdminToken == "" {
		control.AdminToken = cfg.AdminToken
	}
	if control.InternalToken == "" {
		control.InternalToken = cfg.InternalToken
	}
	if cfg.WaitTimeout <= 0 {
		cfg.WaitTimeout = 5 * time.Minute
	}
	return runLLMFleetOnce(ctx, cfg, control, kube)
}

func runLLMFleetOnce(ctx context.Context, cfg Config, control ControlClient, kube KubeClient) error {
	fleet, err := kube.GetLLMFleet(ctx, cfg.Namespace, cfg.Fleet)
	if err != nil {
		return fmt.Errorf("get llmfleet: %w", err)
	}
	if desired := strings.TrimSpace(cfg.RuntimeCleanerImage); desired != "" && fleet.Spec.RuntimeCleanerImage != desired {
		if err := kube.PatchLLMFleetRuntimeCleanerImage(ctx, cfg.Namespace, cfg.Fleet, fleet.Metadata.ResourceVersion, desired); err != nil {
			return fmt.Errorf("reconcile llmfleet runtime cleaner image: %w", err)
		}
		return nil
	}
	cfg.NewSetReplicas = EffectiveTrafficHAPolicy(fleet, cfg.NewSetReplicas).MinReplicas
	if removed := PruneOrphanTrafficRuntimes(&fleet); removed > 0 {
		if err := kube.PatchLLMFleetUpgradeRuntime(ctx, cfg.Namespace, cfg.Fleet, fleet.Metadata.ResourceVersion, fleet.Spec.Sets, fleet.Spec.TrafficRuntimes); err != nil {
			return fmt.Errorf("prune %d orphan llmfleet traffic runtimes: %w", removed, err)
		}
		return syncFleetFacts(ctx, cfg, control, fleet)
	}
	if changed := PinFleetRuntimeImages(&fleet); changed {
		if err := kube.PatchLLMFleetUpgradeRuntime(ctx, cfg.Namespace, cfg.Fleet, fleet.Metadata.ResourceVersion, fleet.Spec.Sets, fleet.Spec.TrafficRuntimes); err != nil {
			return fmt.Errorf("pin llmfleet runtime images: %w", err)
		}
		fleet, err = kube.WaitLLMFleetReady(ctx, cfg.Namespace, cfg.Fleet, cfg.WaitTimeout)
		if err != nil {
			return fmt.Errorf("wait pinned llmfleet runtimes ready: %w", err)
		}
	}
	if cfg.UpgradeEnabled {
		if updated, processed, err := reconcileFleetUpgrade(ctx, cfg, control, kube, fleet); err != nil {
			return err
		} else if processed {
			return syncFleetFacts(ctx, cfg, control, updated)
		}
	}
	decommissionChanged := false
	if cfg.DecommissionEnabled == nil || *cfg.DecommissionEnabled {
		var err error
		fleet, decommissionChanged, err = reconcileFleetDecommission(ctx, cfg, control, kube, fleet)
		if err != nil {
			return err
		}
	}
	if err := syncFleetFacts(ctx, cfg, control, fleet); err != nil {
		return err
	}
	if decommissionChanged {
		return nil
	}
	// Replica repair is steady-state work. Never let it race with an active
	// decommission cleanup or take priority over the upgrade state machine.
	if len(fleet.Spec.Cleanups) == 0 && EnsureManagedTrafficReplicaFloor(&fleet, cfg.NewSetReplicas) {
		if err := kube.PatchLLMFleetUpgradeRuntime(ctx, cfg.Namespace, cfg.Fleet, fleet.Metadata.ResourceVersion, fleet.Spec.Sets, fleet.Spec.TrafficRuntimes); err != nil {
			return fmt.Errorf("enforce llmfleet traffic replica floor: %w", err)
		}
		fleet, err = kube.WaitLLMFleetReady(ctx, cfg.Namespace, cfg.Fleet, cfg.WaitTimeout)
		if err != nil {
			return fmt.Errorf("wait llmfleet traffic replica floor ready: %w", err)
		}
		return syncFleetFacts(ctx, cfg, control, fleet)
	}
	if _, err := recoverErroredLLMFleetRequests(ctx, cfg, control, fleet); err != nil {
		return err
	}
	configured, err := control.ConfiguredRequests(ctx, cfg)
	if err != nil {
		return fmt.Errorf("list configured requests: %w", err)
	}
	fleet, err = scaleConfiguredLLMFleetRequests(ctx, cfg, control, kube, fleet, configured)
	if err != nil {
		return err
	}
	requests, err := control.PendingRequests(ctx, cfg)
	if err != nil {
		return fmt.Errorf("list pending requests: %w", err)
	}
	fleet, err = adoptLLMFleetRequests(ctx, cfg, control, kube, fleet, requests)
	if err != nil {
		return err
	}
	return syncFleetFacts(ctx, cfg, control, fleet)
}

func recoverErroredLLMFleetRequests(ctx context.Context, cfg Config, control ControlClient, fleet LLMFleet) (int, error) {
	requests, err := control.ErroredRequests(ctx, cfg)
	if err != nil {
		return 0, fmt.Errorf("list errored requests: %w", err)
	}
	recoverable := recoverableErroredProvisionRequests(fleet, requests)
	for index, request := range recoverable {
		if err := control.UpdateRequestStatus(ctx, request.ID, "configured", ""); err != nil {
			return index, fmt.Errorf("recover provision request %s: %w", request.ID, err)
		}
	}
	return len(recoverable), nil
}

func recoverableErroredProvisionRequests(fleet LLMFleet, requests []ProvisionRequest) []ProvisionRequest {
	if !llmFleetReady(fleet) {
		return nil
	}
	sets := make(map[string]LLMFleetSet, len(fleet.Spec.Sets))
	for _, set := range fleet.Spec.Sets {
		sets[set.Name] = set
	}
	runtimes := make(map[string][]LLMFleetTrafficRuntime, len(fleet.Spec.TrafficRuntimes))
	for _, runtime := range fleet.Spec.TrafficRuntimes {
		runtimes[runtime.SetID] = append(runtimes[runtime.SetID], runtime)
	}

	result := make([]ProvisionRequest, 0)
	for _, request := range requests {
		if request.Status != "error" || strings.TrimSpace(request.ID) == "" || strings.TrimSpace(request.SetID) == "" {
			continue
		}
		set, ok := sets[request.SetID]
		if !ok || set.ShardRef != request.ShardRef || set.DatabaseName != request.DatabaseName || set.RedisDB != request.RedisDB {
			continue
		}
		expectedImage := strings.TrimSpace(request.ReleaseImage)
		if expectedImage == "" {
			expectedImage = strings.TrimSpace(fleet.Spec.NewAPIImage)
		}
		if expectedImage == "" || strings.TrimSpace(set.AdminImage) != expectedImage {
			continue
		}
		runtimeReady := false
		for _, runtime := range runtimes[request.SetID] {
			if runtime.Generation > 0 && strings.TrimSpace(runtime.Image) == expectedImage {
				runtimeReady = true
				break
			}
		}
		if !runtimeReady {
			continue
		}
		result = append(result, request)
	}
	return result
}

func PinFleetRuntimeImages(fleet *LLMFleet) bool {
	if fleet == nil || strings.TrimSpace(fleet.Spec.NewAPIImage) == "" {
		return false
	}
	changed := false
	for index := range fleet.Spec.Sets {
		set := &fleet.Spec.Sets[index]
		if set.AdminImage == "" {
			set.AdminImage = fleet.Spec.NewAPIImage
			changed = true
		}
		if set.LegacyTrafficImage == "" {
			set.LegacyTrafficImage = fleet.Spec.NewAPIImage
			changed = true
		}
	}
	return changed
}

func scaleConfiguredLLMFleetRequests(ctx context.Context, cfg Config, control ControlClient, kube KubeClient, fleet LLMFleet, requests []ProvisionRequest) (LLMFleet, error) {
	sets, adopted, changed, err := ScaleConfiguredLLMFleetSets(fleet.Spec.Sets, requests, cfg)
	if err != nil {
		return fleet, persistProvisionRetryError(ctx, control, requests, err)
	}
	if len(adopted) == 0 {
		return fleet, nil
	}
	fleet.Spec.Sets = sets
	if ScaleConfiguredTrafficRuntimes(&fleet, adopted, cfg) {
		changed = true
	}
	if changed {
		if err := kube.PatchLLMFleetUpgradeRuntime(ctx, cfg.Namespace, cfg.Fleet, fleet.Metadata.ResourceVersion, fleet.Spec.Sets, fleet.Spec.TrafficRuntimes); err != nil {
			cause := fmt.Errorf("scale configured llmfleet sets: %w", err)
			return fleet, persistProvisionRetryError(ctx, control, adopted, cause)
		}
	}
	if changed || !llmFleetReady(fleet) {
		updated, err := kube.WaitLLMFleetReady(ctx, cfg.Namespace, cfg.Fleet, cfg.WaitTimeout)
		if err != nil {
			cause := fmt.Errorf("wait configured llmfleet sets ready: %w", err)
			return fleet, persistProvisionRetryError(ctx, control, adopted, cause)
		}
		fleet = updated
	}
	for _, request := range adopted {
		if err := control.UpdateRequestStatus(ctx, request.ID, "managed", ""); err != nil {
			return fleet, err
		}
	}
	return fleet, nil
}

func persistProvisionRetryError(ctx context.Context, control ControlClient, requests []ProvisionRequest, cause error) error {
	result := cause
	for _, request := range requests {
		if request.Status != "configured" {
			continue
		}
		if err := control.UpdateRequestStatus(ctx, request.ID, "configured", cause.Error()); err != nil {
			result = errors.Join(result, err)
		}
	}
	return result
}

func reconcileFleetDecommission(ctx context.Context, cfg Config, control ControlClient, kube KubeClient, fleet LLMFleet) (LLMFleet, bool, error) {
	if len(fleet.Spec.Cleanups) > 1 {
		return fleet, false, fmt.Errorf("fleet contains %d cleanups; at most one is supported", len(fleet.Spec.Cleanups))
	}
	if len(fleet.Spec.Cleanups) == 1 {
		cleanup := fleet.Spec.Cleanups[0]
		var status *LLMFleetCleanupStatus
		for index := range fleet.Status.Cleanups {
			candidate := &fleet.Status.Cleanups[index]
			if candidate.CleanupID == cleanup.CleanupID && candidate.Attempt == cleanup.Attempt {
				status = candidate
				break
			}
		}
		if status == nil || (status.Succeeded < 1 && status.Failed < 1) {
			return fleet, false, nil
		}
		if strings.TrimSpace(status.JobUID) == "" {
			return fleet, false, fmt.Errorf("cleanup %s finished without job uid evidence", cleanup.CleanupID)
		}
		if status.Succeeded < 1 && status.Failed > 0 {
			lastError := fmt.Sprintf("runtime cleanup job failed after Kubernetes retries (failed=%d)", status.Failed)
			if err := control.FailSetDecommission(ctx, cleanup, *status, lastError); err != nil {
				return fleet, false, fmt.Errorf("report failed set decommission %s: %w", cleanup.CleanupID, err)
			}
			if err := kube.PatchLLMFleetRuntime(ctx, cfg.Namespace, cfg.Fleet, fleet.Metadata.ResourceVersion, fleet.Spec.Sets, []LLMFleetCleanup{}); err != nil {
				return fleet, false, fmt.Errorf("remove failed fleet cleanup %s: %w", cleanup.CleanupID, err)
			}
			fleet.Spec.Cleanups = nil
			return fleet, true, nil
		}
		if err := control.FinalizeSetDecommission(ctx, cleanup, *status); err != nil {
			return fleet, false, fmt.Errorf("finalize set decommission %s: %w", cleanup.CleanupID, err)
		}
		if err := kube.PatchLLMFleetRuntime(ctx, cfg.Namespace, cfg.Fleet, fleet.Metadata.ResourceVersion, fleet.Spec.Sets, []LLMFleetCleanup{}); err != nil {
			return fleet, false, fmt.Errorf("remove fleet cleanup %s: %w", cleanup.CleanupID, err)
		}
		if err := control.AcknowledgeSetDecommission(ctx, cleanup.CleanupID, cleanup.Attempt); err != nil {
			return fleet, false, fmt.Errorf("acknowledge set decommission %s: %w", cleanup.CleanupID, err)
		}
		fleet.Spec.Cleanups = nil
		return fleet, true, nil
	}
	jobs, err := control.SetDecommissions(ctx, cfg.RequestLimit)
	if err != nil {
		return fleet, false, fmt.Errorf("list set decommissions: %w", err)
	}
	for _, job := range jobs {
		claimable := job.Status == "pending" || (job.Status == "removing_runtime" && !job.ClaimLeaseUntil.After(time.Now()))
		if !claimable {
			continue
		}
		owner := cfg.Source + "/" + cfg.Namespace + "/" + cfg.Fleet
		claim, err := control.ClaimSetDecommission(ctx, job.ID, owner, 900)
		if err != nil {
			var statusErr *controlHTTPError
			if errors.As(err, &statusErr) && statusErr.StatusCode == 409 {
				continue
			}
			return fleet, false, fmt.Errorf("claim set decommission %s: %w", job.ID, err)
		}
		if _, err := ApplyCleanupToFleet(&fleet, claim.Cleanup); err != nil {
			return fleet, false, err
		}
		if err := kube.PatchLLMFleetDecommission(ctx, cfg.Namespace, cfg.Fleet, fleet.Metadata.ResourceVersion, fleet.Spec.Sets, fleet.Spec.TrafficRuntimes, fleet.Spec.Cleanups); err != nil {
			return fleet, false, fmt.Errorf("patch llmfleet cleanup %s: %w", job.ID, err)
		}
		return fleet, true, nil
	}
	return fleet, false, nil
}

func adoptLLMFleetRequests(ctx context.Context, cfg Config, control ControlClient, kube KubeClient, fleet LLMFleet, requests []ProvisionRequest) (LLMFleet, error) {
	sets, adopted, changed, err := MergeLLMFleetSets(fleet.Spec.Sets, requests, cfg)
	if err != nil {
		for _, request := range requests {
			_ = control.UpdateRequestStatus(ctx, request.ID, "error", err.Error())
		}
		return fleet, err
	}
	fleet.Spec.Sets = sets
	initialRuntimeChanged, err := AddInitialTrafficRuntimes(&fleet, adopted)
	if err != nil {
		for _, request := range adopted {
			_ = control.UpdateRequestStatus(ctx, request.ID, "error", err.Error())
		}
		return fleet, err
	}
	runtimeChanged, err := ApplyFleetRuntimeConfig(&fleet)
	if err != nil {
		for _, request := range adopted {
			_ = control.UpdateRequestStatus(ctx, request.ID, "error", err.Error())
		}
		return fleet, err
	}
	changed = changed || runtimeChanged || initialRuntimeChanged
	if changed {
		if err := kube.PatchLLMFleetUpgradeRuntime(ctx, cfg.Namespace, cfg.Fleet, fleet.Metadata.ResourceVersion, fleet.Spec.Sets, fleet.Spec.TrafficRuntimes); err != nil {
			for _, request := range adopted {
				_ = control.UpdateRequestStatus(ctx, request.ID, "error", err.Error())
			}
			return fleet, fmt.Errorf("patch llmfleet sets: %w", err)
		}
		updated, err := kube.WaitLLMFleetReady(ctx, cfg.Namespace, cfg.Fleet, cfg.WaitTimeout)
		if err != nil {
			for _, request := range adopted {
				_ = control.UpdateRequestStatus(ctx, request.ID, "error", err.Error())
			}
			return fleet, fmt.Errorf("wait llmfleet ready: %w", err)
		}
		fleet = updated
	}
	for _, request := range adopted {
		if err := control.UpdateRequestStatus(ctx, request.ID, "created", ""); err != nil {
			return fleet, err
		}
	}
	return fleet, nil
}

func ResolveSetRuntimeConfig(fleet LLMFleet, shardRef string) (LLMFleetSetRuntimeConfig, error) {
	defaults := fleet.Spec.NewAPI
	admin := withDatabasePoolDefaults(defaults.DatabasePool.Admin)
	traffic := withDatabasePoolDefaults(defaults.DatabasePool.Traffic)
	concurrency := defaults.SubscriptionWriteConcurrency
	if concurrency <= 0 {
		concurrency = 8
	}

	var shard *LLMFleetShard
	for i := range fleet.Spec.Shards {
		if strings.TrimSpace(fleet.Spec.Shards[i].Name) == strings.TrimSpace(shardRef) {
			shard = &fleet.Spec.Shards[i]
			break
		}
	}
	if shard == nil {
		return LLMFleetSetRuntimeConfig{}, fmt.Errorf("shard %q not found in fleet", shardRef)
	}
	admin = mergeDatabasePool(admin, shard.DatabasePool.Admin)
	traffic = mergeDatabasePool(traffic, shard.DatabasePool.Traffic)
	if err := validateDatabasePool("admin", admin); err != nil {
		return LLMFleetSetRuntimeConfig{}, err
	}
	if err := validateDatabasePool("traffic", traffic); err != nil {
		return LLMFleetSetRuntimeConfig{}, err
	}
	if concurrency*2 > admin.MaxOpenConns {
		return LLMFleetSetRuntimeConfig{}, fmt.Errorf("subscription write concurrency %d requires admin max open connections of at least %d", concurrency, concurrency*2)
	}
	return LLMFleetSetRuntimeConfig{Admin: admin, Traffic: traffic, SubscriptionWriteConcurrency: concurrency}, nil
}

func ApplyFleetRuntimeConfig(fleet *LLMFleet) (bool, error) {
	if fleet == nil {
		return false, fmt.Errorf("fleet is required")
	}
	changed := false
	for i := range fleet.Spec.Sets {
		set := &fleet.Spec.Sets[i]
		config, err := ResolveSetRuntimeConfig(*fleet, set.ShardRef)
		if err != nil {
			return false, fmt.Errorf("resolve runtime config for set %s: %w", set.Name, err)
		}
		before := *set
		set.AdminSQLMaxOpenConns = config.Admin.MaxOpenConns
		set.AdminSQLMaxIdleConns = config.Admin.MaxIdleConns
		set.AdminSQLMaxLifetimeSeconds = config.Admin.MaxLifetimeSeconds
		set.TrafficSQLMaxOpenConns = config.Traffic.MaxOpenConns
		set.TrafficSQLMaxIdleConns = config.Traffic.MaxIdleConns
		set.TrafficSQLMaxLifetimeSeconds = config.Traffic.MaxLifetimeSeconds
		set.SubscriptionWriteConcurrency = config.SubscriptionWriteConcurrency
		if set.AdminImage == "" && fleet.Spec.NewAPIImage != "" {
			set.AdminImage = fleet.Spec.NewAPIImage
		}
		if set.LegacyTrafficImage == "" && fleet.Spec.NewAPIImage != "" {
			set.LegacyTrafficImage = fleet.Spec.NewAPIImage
		}
		changed = changed || before != *set
	}
	return changed, nil
}

func withDatabasePoolDefaults(pool LLMFleetDatabasePool) LLMFleetDatabasePool {
	if pool.MaxOpenConns <= 0 {
		pool.MaxOpenConns = 32
	}
	if pool.MaxIdleConns <= 0 {
		pool.MaxIdleConns = 2
	}
	if pool.MaxLifetimeSeconds <= 0 {
		pool.MaxLifetimeSeconds = 60
	}
	return pool
}

func mergeDatabasePool(base LLMFleetDatabasePool, override LLMFleetDatabasePool) LLMFleetDatabasePool {
	if override.MaxOpenConns > 0 {
		base.MaxOpenConns = override.MaxOpenConns
	}
	if override.MaxIdleConns > 0 {
		base.MaxIdleConns = override.MaxIdleConns
	}
	if override.MaxLifetimeSeconds > 0 {
		base.MaxLifetimeSeconds = override.MaxLifetimeSeconds
	}
	return base
}

func validateDatabasePool(role string, pool LLMFleetDatabasePool) error {
	if pool.MaxOpenConns <= 0 {
		return fmt.Errorf("%s max open connections must be greater than zero", role)
	}
	if pool.MaxIdleConns < 0 || pool.MaxIdleConns > pool.MaxOpenConns {
		return fmt.Errorf("%s max idle connections must be between zero and max open connections", role)
	}
	if pool.MaxLifetimeSeconds <= 0 {
		return fmt.Errorf("%s max lifetime seconds must be greater than zero", role)
	}
	return nil
}

func syncFleetFacts(ctx context.Context, cfg Config, control ControlClient, fleet LLMFleet) error {
	if err := syncFleetShards(ctx, control, fleet); err != nil {
		return err
	}
	policy := EffectiveTrafficHAPolicy(fleet, cfg.NewSetReplicas)
	observations := ObserveFleetRuntimeHA(fleet, policy, time.Now().UTC())
	facts := FactsFromLLMFleetWithHA(fleet, observations)
	if len(facts) == 0 {
		return nil
	}
	if err := control.RecordFacts(ctx, cfg, facts); err != nil {
		return err
	}
	if err := control.ReconcileFacts(ctx, cfg); err != nil {
		return err
	}
	return nil
}

func syncFleetShards(ctx context.Context, control ControlClient, fleet LLMFleet) error {
	for _, shard := range fleet.Spec.Shards {
		config, err := ResolveSetRuntimeConfig(fleet, shard.Name)
		if err != nil {
			return err
		}
		status := strings.TrimSpace(shard.Status)
		if status == "" {
			status = "active"
		}
		endpoint := strings.TrimSpace(shard.MySQLHost)
		if endpoint != "" && strings.TrimSpace(shard.MySQLPort) != "" {
			endpoint += ":" + strings.TrimSpace(shard.MySQLPort)
		}
		redisEndpoint := strings.TrimSpace(shard.RedisHost)
		if redisEndpoint != "" && strings.TrimSpace(shard.RedisPort) != "" {
			redisEndpoint += ":" + strings.TrimSpace(shard.RedisPort)
		}
		if err := control.UpsertShard(ctx, ShardProjection{
			ID:                           shard.Name,
			Name:                         shard.Name,
			Kind:                         "mysql",
			Endpoint:                     endpoint,
			RedisEndpoint:                redisEndpoint,
			SecretName:                   strings.TrimSpace(shard.SecretName),
			RedisDBStart:                 shard.RedisDBStart,
			RedisDBLimit:                 shard.RedisDBLimit,
			Status:                       status,
			MaxSets:                      shard.MaxSets,
			AdminSQLMaxOpenConns:         config.Admin.MaxOpenConns,
			AdminSQLMaxIdleConns:         config.Admin.MaxIdleConns,
			AdminSQLMaxLifetimeSeconds:   config.Admin.MaxLifetimeSeconds,
			TrafficSQLMaxOpenConns:       config.Traffic.MaxOpenConns,
			TrafficSQLMaxIdleConns:       config.Traffic.MaxIdleConns,
			TrafficSQLMaxLifetimeSeconds: config.Traffic.MaxLifetimeSeconds,
			SubscriptionWriteConcurrency: config.SubscriptionWriteConcurrency,
		}); err != nil {
			return fmt.Errorf("sync shard %s: %w", shard.Name, err)
		}
	}
	return nil
}

func MergeLLMFleetSets(existing []LLMFleetSet, requests []ProvisionRequest, cfg Config) ([]LLMFleetSet, []ProvisionRequest, bool, error) {
	sets := append([]LLMFleetSet(nil), existing...)
	known := map[string]bool{}
	for _, set := range sets {
		known[set.Name] = true
	}
	redisDBs := map[string]string{}
	for _, set := range sets {
		if err := reserveRedisDB(redisDBs, set.ShardRef, set.RedisDB, set.Name); err != nil {
			return nil, nil, false, err
		}
	}
	adopted := make([]ProvisionRequest, 0, len(requests))
	changed := false
	for _, request := range requests {
		if strings.TrimSpace(request.SetID) == "" {
			continue
		}
		if !known[request.SetID] {
			set := LLMFleetSetFromRequest(request, cfg)
			if err := reserveRedisDB(redisDBs, set.ShardRef, set.RedisDB, set.Name); err != nil {
				return nil, nil, false, err
			}
			sets = append(sets, set)
			known[request.SetID] = true
			changed = true
		}
		adopted = append(adopted, request)
	}
	return sets, adopted, changed, nil
}

func reserveRedisDB(used map[string]string, shardRef string, redisDB string, setID string) error {
	shardRef = strings.TrimSpace(shardRef)
	redisDB = strings.TrimSpace(redisDB)
	setID = strings.TrimSpace(setID)
	if shardRef == "" || redisDB == "" || setID == "" {
		return nil
	}
	key := shardRef + "\x00" + redisDB
	if existing, ok := used[key]; ok && existing != setID {
		return fmt.Errorf("redis db %s on shard %s is already used by set %s", redisDB, shardRef, existing)
	}
	used[key] = setID
	return nil
}

func LLMFleetSetFromRequest(req ProvisionRequest, cfg Config) LLMFleetSet {
	database := strings.TrimSpace(req.DatabaseName)
	if database == "" {
		database = "newapi_" + strings.ReplaceAll(req.SetID, "-", "_")
	}
	redisDB := strings.TrimSpace(req.RedisDB)
	if redisDB == "" {
		redisDB = "10"
	}
	legacyTrafficEnabled := false
	return LLMFleetSet{
		Name:                 req.SetID,
		ShardRef:             req.ShardRef,
		Replicas:             0,
		DatabaseName:         database,
		RedisDB:              redisDB,
		SessionSecret:        "llmgateway-" + cfg.Fleet + "-" + req.SetID + "-session-secret",
		LegacyTrafficEnabled: &legacyTrafficEnabled,
		AdminImage:           strings.TrimSpace(req.ReleaseImage),
		LegacyTrafficImage:   strings.TrimSpace(req.ReleaseImage),
	}
}

func AddInitialTrafficRuntimes(fleet *LLMFleet, requests []ProvisionRequest) (bool, error) {
	if fleet == nil {
		return false, fmt.Errorf("fleet is required")
	}
	changed := false
	for _, request := range requests {
		image := strings.TrimSpace(request.ReleaseImage)
		if image == "" {
			image = strings.TrimSpace(fleet.Spec.NewAPIImage)
		}
		if image == "" {
			return false, fmt.Errorf("newapiImage or provision release image is required for initial traffic runtime %s", request.SetID)
		}
		set, ok := llmFleetSetByName(fleet, request.SetID)
		if !ok || set.LegacyTrafficEnabled == nil || *set.LegacyTrafficEnabled {
			continue
		}
		found := false
		for _, runtime := range fleet.Spec.TrafficRuntimes {
			if runtime.SetID == request.SetID {
				found = true
				break
			}
		}
		if found {
			continue
		}
		fleet.Spec.TrafficRuntimes = append(fleet.Spec.TrafficRuntimes, LLMFleetTrafficRuntime{
			SetID: request.SetID, Generation: 1, Image: image, Replicas: set.Replicas,
		})
		changed = true
	}
	return changed, nil
}

func ScaleConfiguredLLMFleetSets(existing []LLMFleetSet, requests []ProvisionRequest, cfg Config) ([]LLMFleetSet, []ProvisionRequest, bool, error) {
	sets := append([]LLMFleetSet(nil), existing...)
	target := cfg.NewSetReplicas
	if target <= 0 {
		target = 1
	}
	adopted := make([]ProvisionRequest, 0, len(requests))
	changed := false
	for _, request := range requests {
		if strings.TrimSpace(request.SetID) == "" || request.Status != "configured" {
			continue
		}
		index := -1
		for i := range sets {
			if sets[i].Name == request.SetID {
				index = i
				break
			}
		}
		if index < 0 {
			return nil, nil, false, fmt.Errorf("configured set %q is missing from llmfleet", request.SetID)
		}
		if sets[index].Replicas < target {
			sets[index].Replicas = target
			changed = true
		}
		adopted = append(adopted, request)
	}
	return sets, adopted, changed, nil
}

func ScaleConfiguredTrafficRuntimes(fleet *LLMFleet, requests []ProvisionRequest, cfg Config) bool {
	if fleet == nil {
		return false
	}
	target := cfg.NewSetReplicas
	if target <= 0 {
		target = 1
	}
	wanted := make(map[string]struct{}, len(requests))
	for _, request := range requests {
		wanted[request.SetID] = struct{}{}
	}
	changed := false
	for index := range fleet.Spec.TrafficRuntimes {
		runtime := &fleet.Spec.TrafficRuntimes[index]
		if _, ok := wanted[runtime.SetID]; !ok || runtime.Replicas >= target {
			continue
		}
		runtime.Replicas = target
		changed = true
	}
	return changed
}

// EnsureManagedTrafficReplicaFloor applies the availability floor only after a
// versioned traffic runtime exists. Bootstrap Sets stay at zero until admission
// and initial configuration have completed.
func EnsureManagedTrafficReplicaFloor(fleet *LLMFleet, target int) bool {
	if fleet == nil {
		return false
	}
	if target <= 0 {
		return false
	}
	managed := make(map[string]struct{}, len(fleet.Spec.TrafficRuntimes))
	changed := false
	for index := range fleet.Spec.TrafficRuntimes {
		runtime := &fleet.Spec.TrafficRuntimes[index]
		if runtime.Generation <= 0 || strings.TrimSpace(runtime.SetID) == "" {
			continue
		}
		managed[runtime.SetID] = struct{}{}
		if runtime.Replicas < target {
			runtime.Replicas = target
			changed = true
		}
	}
	for index := range fleet.Spec.Sets {
		set := &fleet.Spec.Sets[index]
		if _, ok := managed[set.Name]; ok && set.Replicas < target {
			set.Replicas = target
			changed = true
		}
	}
	return changed
}

func FactsFromLLMFleet(fleet LLMFleet) []SetFact {
	return FactsFromLLMFleetWithHA(fleet, nil)
}

func FactsFromLLMFleetWithHA(fleet LLMFleet, observations map[string]SetRuntimeHAObservation) []SetFact {
	facts := make([]SetFact, 0, len(fleet.Spec.Sets))
	for _, set := range fleet.Spec.Sets {
		if strings.TrimSpace(set.Name) == "" {
			continue
		}
		trafficBaseURL := "http://" + fleet.Metadata.Name + "-" + set.Name + "-newapi-traffic:3000"
		var runtimeGeneration int64
		var runtimeImage string
		if set.LegacyTrafficEnabled != nil && !*set.LegacyTrafficEnabled {
			if runtime, ok := firstTrafficRuntimeForSet(fleet.Spec.TrafficRuntimes, set.Name); ok {
				runtimeGeneration = runtime.Generation
				runtimeImage = runtime.Image
				trafficBaseURL = fmt.Sprintf("http://%s-%s-g%d-newapi-traffic:3000", fleet.Metadata.Name, set.Name, runtime.Generation)
			}
		}
		fact := SetFact{
			SetID:                        set.Name,
			Name:                         firstNonEmpty(set.DisplayName, set.Name),
			BaseURL:                      "http://" + fleet.Metadata.Name + "-" + set.Name + "-newapi-admin:3000",
			TrafficBaseURL:               trafficBaseURL,
			RuntimeGeneration:            runtimeGeneration,
			RuntimeImage:                 runtimeImage,
			ShardRef:                     set.ShardRef,
			DatabaseName:                 set.DatabaseName,
			RedisDB:                      set.RedisDB,
			SQLMaxOpenConns:              set.AdminSQLMaxOpenConns,
			SQLMaxIdleConns:              set.AdminSQLMaxIdleConns,
			SQLMaxLifetimeSeconds:        set.AdminSQLMaxLifetimeSeconds,
			TrafficSQLMaxOpenConns:       set.TrafficSQLMaxOpenConns,
			TrafficSQLMaxIdleConns:       set.TrafficSQLMaxIdleConns,
			TrafficSQLMaxLifetimeSeconds: set.TrafficSQLMaxLifetimeSeconds,
			SubscriptionWriteConcurrency: set.SubscriptionWriteConcurrency,
		}
		if health, ok := observations[set.Name]; ok {
			fact.RuntimeHAStatus = health.Status
			fact.RuntimeHADesiredReplicas = health.DesiredReplicas
			fact.RuntimeHAReadyReplicas = health.ReadyReplicas
			fact.RuntimeHAPDBHealthy = health.PDBHealthy
			fact.RuntimeHATopologyKey = health.TopologyKey
			fact.RuntimeHAError = health.Error
			fact.RuntimeHACheckedAt = health.CheckedAt
		}
		facts = append(facts, fact)
	}
	return facts
}

func firstTrafficRuntimeForSet(runtimes []LLMFleetTrafficRuntime, setID string) (LLMFleetTrafficRuntime, bool) {
	var selected LLMFleetTrafficRuntime
	found := false
	for _, runtime := range runtimes {
		if runtime.SetID != setID || runtime.Generation <= 0 {
			continue
		}
		if !found || runtime.Generation < selected.Generation {
			selected = runtime
			found = true
		}
	}
	return selected, found
}

func envString(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			return parsed
		}
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		if parsed, err := strconv.ParseBool(value); err == nil {
			return parsed
		}
	}
	return fallback
}

func boolPointer(value bool) *bool { return &value }

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func readServiceAccountNamespace() string {
	raw, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace")
	if err != nil {
		return "llmgateway"
	}
	return strings.TrimSpace(string(raw))
}
