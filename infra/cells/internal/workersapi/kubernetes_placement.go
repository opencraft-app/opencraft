package workersapi

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

var (
	shardPoolResource = schema.GroupVersionResource{Group: "fleet.actor.dev", Version: "v1alpha1", Resource: "shardpools"}
	rivetCellResource = schema.GroupVersionResource{Group: "fleet.actor.dev", Version: "v1alpha1", Resource: "rivetcells"}
)

const cellRouteLabel = "fleet.actor.dev/cell-route"

type placementCandidate struct {
	CellName   string `json:"cellName"`
	CellUID    string `json:"cellUID"`
	Datacenter string `json:"datacenter"`
}

type placementSnapshot struct {
	PoolName        string               `json:"poolName"`
	PoolUID         string               `json:"poolUID"`
	ResourceVersion string               `json:"resourceVersion"`
	Generation      int64                `json:"generation"`
	ExpiresAt       time.Time            `json:"expiresAt"`
	Candidates      []placementCandidate `json:"candidates"`
	Digest          string               `json:"-"`
}

// KubernetesPlacementResolver intersects the controller-owned admission
// candidate set with immutable identity route records. Release evidence is
// carried by immutable receipts, while this long-lived route survives a Cell
// requalification without replacing its UID. It also
// rechecks each Cell's report deadline so stale status fails closed even when
// no Kubernetes event wakes the Fleet controller at the exact expiry time.
type KubernetesPlacementResolver struct {
	dynamicClient   dynamic.Interface
	kubeClient      kubernetes.Interface
	namespace       string
	poolName        string
	routeNamespace  string
	maxReportAge    time.Duration
	refreshInterval time.Duration
	refreshTimeout  time.Duration
	now             func() time.Time

	mu             sync.Mutex
	cached         *placementSnapshot
	refreshedAt    time.Time
	refreshing     bool
	refreshDone    chan struct{}
	lastRefreshErr error
}

func NewKubernetesPlacementResolver(
	dynamicClient dynamic.Interface,
	kubeClient kubernetes.Interface,
	namespace, poolName, routeNamespace string,
	maxReportAge, refreshInterval time.Duration,
) (*KubernetesPlacementResolver, error) {
	if dynamicClient == nil || kubeClient == nil {
		return nil, fmt.Errorf("Kubernetes placement clients are required")
	}
	if namespace == "" || poolName == "" || routeNamespace == "" {
		return nil, fmt.Errorf("placement namespace, Pool, and route namespace are required")
	}
	if maxReportAge < 5*time.Second || refreshInterval <= 0 || refreshInterval > maxReportAge {
		return nil, fmt.Errorf("placement freshness configuration is invalid")
	}
	refreshTimeout := 2 * refreshInterval
	if refreshTimeout < 5*time.Second {
		refreshTimeout = 5 * time.Second
	}
	if refreshTimeout > maxReportAge {
		refreshTimeout = maxReportAge
	}
	return &KubernetesPlacementResolver{
		dynamicClient: dynamicClient, kubeClient: kubeClient, namespace: namespace,
		poolName: poolName, routeNamespace: routeNamespace, maxReportAge: maxReportAge,
		refreshInterval: refreshInterval, refreshTimeout: refreshTimeout,
		now: func() time.Time { return time.Now().UTC() },
	}, nil
}

func (resolver *KubernetesPlacementResolver) Check(ctx context.Context) error {
	_, err := resolver.snapshot(ctx)
	return err
}

func (resolver *KubernetesPlacementResolver) Resolve(ctx context.Context, key string) (registryPlacement, error) {
	snapshot, err := resolver.snapshot(ctx)
	if err != nil {
		return registryPlacement{}, err
	}
	if len(snapshot.Candidates) == 0 {
		return registryPlacement{}, ErrNoAdmissionCapacity
	}
	selected := snapshot.Candidates[0]
	selectedScore := rendezvousScore(key, selected.CellUID)
	for _, candidate := range snapshot.Candidates[1:] {
		if score := rendezvousScore(key, candidate.CellUID); score > selectedScore {
			selected, selectedScore = candidate, score
		}
	}
	return registryPlacement{
		PoolName: snapshot.PoolName, PoolUID: snapshot.PoolUID,
		SnapshotResourceVersion: snapshot.ResourceVersion, SnapshotDigest: snapshot.Digest,
		CellName: selected.CellName, CellUID: selected.CellUID, Datacenter: selected.Datacenter,
		DecidedAt: resolver.now(),
	}, nil
}

// AdmissionCandidates projects the currently leased placement snapshot into
// exact serving identities. Consumers must still intersect these identities
// with the independently published CellServingRoute inventory and their local
// capabilities. In particular, a serving route alone never makes a Cell an
// eligible stateless dispatch target.
func (resolver *KubernetesPlacementResolver) AdmissionCandidates(ctx context.Context) ([]registryPlacement, error) {
	snapshot, err := resolver.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	if len(snapshot.Candidates) == 0 {
		return nil, ErrNoAdmissionCapacity
	}
	now := resolver.now()
	result := make([]registryPlacement, 0, len(snapshot.Candidates))
	for _, candidate := range snapshot.Candidates {
		result = append(result, registryPlacement{
			PoolName: snapshot.PoolName, PoolUID: snapshot.PoolUID,
			SnapshotResourceVersion: snapshot.ResourceVersion, SnapshotDigest: snapshot.Digest,
			CellName: candidate.CellName, CellUID: candidate.CellUID, Datacenter: candidate.Datacenter,
			DecidedAt: now,
		})
	}
	return result, nil
}

func rendezvousScore(key, cellUID string) uint64 {
	digest := sha256.Sum256([]byte(key + "\x00" + cellUID))
	return binary.BigEndian.Uint64(digest[:8])
}

func (resolver *KubernetesPlacementResolver) snapshot(ctx context.Context) (*placementSnapshot, error) {
	for {
		now := resolver.now()
		resolver.mu.Lock()
		cached := resolver.cached
		leaseValid := cached != nil && now.Before(cached.ExpiresAt)
		if leaseValid && now.Sub(resolver.refreshedAt) < resolver.refreshInterval {
			resolver.mu.Unlock()
			return cached, nil
		}
		if !resolver.refreshing {
			if !leaseValid && resolver.lastRefreshErr != nil && now.Sub(resolver.refreshedAt) < resolver.refreshInterval {
				err := resolver.lastRefreshErr
				resolver.mu.Unlock()
				return nil, err
			}
			resolver.startRefreshLocked(now)
		}
		if leaseValid {
			// ExpiresAt is the controller-issued admission lease. Serving it while
			// a single background refresh is in progress keeps Kubernetes API tail
			// latency out of Object creation without extending that lease.
			resolver.mu.Unlock()
			return cached, nil
		}
		done := resolver.refreshDone
		resolver.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-done:
		}
	}
}

func (resolver *KubernetesPlacementResolver) startRefreshLocked(now time.Time) {
	resolver.refreshing = true
	resolver.refreshDone = make(chan struct{})
	done := resolver.refreshDone
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), resolver.refreshTimeout)
		defer cancel()
		snapshot, err := resolver.loadSnapshot(ctx, now)

		resolver.mu.Lock()
		resolver.refreshedAt = now
		resolver.lastRefreshErr = err
		if err == nil {
			resolver.cached = snapshot
		}
		resolver.refreshing = false
		close(done)
		resolver.mu.Unlock()
	}()
}

func (resolver *KubernetesPlacementResolver) loadSnapshot(ctx context.Context, now time.Time) (*placementSnapshot, error) {
	pool, err := resolver.dynamicClient.Resource(shardPoolResource).Namespace(resolver.namespace).Get(ctx, resolver.poolName, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("read ShardPool: %w", err)
	}
	poolUID := string(pool.GetUID())
	if poolUID == "" || pool.GetResourceVersion() == "" || pool.GetGeneration() <= 0 {
		return nil, fmt.Errorf("ShardPool identity is incomplete")
	}
	observedGeneration, found, err := unstructured.NestedInt64(pool.Object, "status", "observedGeneration")
	if err != nil || !found || observedGeneration != pool.GetGeneration() {
		return nil, fmt.Errorf("ShardPool status has not observed its current generation")
	}
	open, found, err := unstructured.NestedBool(pool.Object, "status", "admissionOpen")
	if err != nil || !found || !open {
		return nil, ErrNoAdmissionCapacity
	}
	names, found, err := unstructured.NestedStringSlice(pool.Object, "status", "admissionCandidates")
	if err != nil || !found || len(names) == 0 {
		return nil, ErrNoAdmissionCapacity
	}
	sort.Strings(names)
	if len(names) > 1000 {
		return nil, fmt.Errorf("ShardPool candidate set exceeds its bound")
	}
	snapshot := &placementSnapshot{
		PoolName: pool.GetName(), PoolUID: poolUID, ResourceVersion: pool.GetResourceVersion(),
		Generation: pool.GetGeneration(), ExpiresAt: now.Add(resolver.maxReportAge),
		Candidates: make([]placementCandidate, 0, len(names)),
	}
	for index, name := range names {
		if index > 0 && name == names[index-1] {
			return nil, fmt.Errorf("ShardPool candidate set contains a duplicate Cell")
		}
		cell, err := resolver.dynamicClient.Resource(rivetCellResource).Namespace(resolver.namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, fmt.Errorf("read candidate RivetCell %s: %w", name, err)
		}
		candidate, expiry, err := resolver.validateCell(ctx, pool, cell, now)
		if err != nil {
			return nil, err
		}
		if expiry.Before(snapshot.ExpiresAt) {
			snapshot.ExpiresAt = expiry
		}
		snapshot.Candidates = append(snapshot.Candidates, candidate)
	}
	if !now.Before(snapshot.ExpiresAt) {
		return nil, ErrNoAdmissionCapacity
	}
	unsigned, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(unsigned)
	snapshot.Digest = "sha256:" + hex.EncodeToString(digest[:])
	return snapshot, nil
}

func (resolver *KubernetesPlacementResolver) validateCell(
	ctx context.Context, pool, cell *unstructured.Unstructured, now time.Time,
) (placementCandidate, time.Time, error) {
	name := cell.GetName()
	if name == "" || cell.GetGeneration() <= 0 {
		return placementCandidate{}, time.Time{}, fmt.Errorf("candidate RivetCell identity is incomplete")
	}
	if nestedString(cell.Object, "metadata", "labels", "fleet.actor.dev/pool") != pool.GetName() {
		return placementCandidate{}, time.Time{}, fmt.Errorf("candidate RivetCell %s belongs to another Pool", name)
	}
	if nestedString(cell.Object, "spec", "desiredState") != "Ready" ||
		nestedString(cell.Object, "status", "phase") != "Ready" ||
		nestedString(cell.Object, "status", "capacityRisk") != "Normal" ||
		!nestedBool(cell.Object, "status", "readyForPlacement") {
		return placementCandidate{}, time.Time{}, fmt.Errorf("candidate RivetCell %s is not placement-ready", name)
	}
	observed := nestedInt64(cell.Object, "status", "observedGeneration")
	if observed != cell.GetGeneration() {
		return placementCandidate{}, time.Time{}, fmt.Errorf("candidate RivetCell %s status is stale", name)
	}
	reportAt, err := time.Parse(time.RFC3339, nestedString(cell.Object, "status", "reportObservedAt"))
	if err != nil || reportAt.After(now.Add(5*time.Second)) {
		return placementCandidate{}, time.Time{}, fmt.Errorf("candidate RivetCell %s report time is invalid", name)
	}
	expiry := reportAt.Add(resolver.maxReportAge)
	if !now.Before(expiry) {
		return placementCandidate{}, time.Time{}, fmt.Errorf("candidate RivetCell %s report expired", name)
	}
	spokeUID := nestedString(cell.Object, "status", "spokeCellRef", "uid")
	if spokeUID == "" {
		return placementCandidate{}, time.Time{}, fmt.Errorf("candidate RivetCell %s has no spoke UID", name)
	}
	route, err := resolver.kubeClient.CoreV1().ConfigMaps(resolver.routeNamespace).Get(ctx, "actor-cell-route-"+name, metav1.GetOptions{})
	if err != nil {
		return placementCandidate{}, time.Time{}, fmt.Errorf("read candidate route %s: %w", name, err)
	}
	if route.Immutable == nil || !*route.Immutable || route.Labels[cellRouteLabel] != "true" ||
		route.Data["pool-name"] != pool.GetName() || route.Data["pool-uid"] != string(pool.GetUID()) ||
		route.Data["cell-name"] != name || route.Data["cell-uid"] != spokeUID ||
		!namePattern.MatchString(route.Data["datacenter"]) {
		return placementCandidate{}, time.Time{}, fmt.Errorf("candidate RivetCell %s route identity is invalid", name)
	}
	return placementCandidate{CellName: name, CellUID: spokeUID, Datacenter: route.Data["datacenter"]}, expiry, nil
}

func nestedString(value map[string]any, fields ...string) string {
	result, _, _ := unstructured.NestedString(value, fields...)
	return result
}

func nestedBool(value map[string]any, fields ...string) bool {
	result, _, _ := unstructured.NestedBool(value, fields...)
	return result
}

func nestedInt64(value map[string]any, fields ...string) int64 {
	result, _, _ := unstructured.NestedInt64(value, fields...)
	return result
}
