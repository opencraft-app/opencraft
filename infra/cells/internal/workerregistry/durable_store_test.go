package workerregistry

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDurableStorePublishesOnlyAfterImmutableObject(t *testing.T) {
	trace := []string{}
	var traceLock sync.Mutex
	metadata := newMemoryMetadataStore()
	metadata.beforePublish = func() {
		traceLock.Lock()
		defer traceLock.Unlock()
		trace = append(trace, "metadata")
	}
	objects := newMemoryObjectStore()
	objects.beforePut = func() {
		traceLock.Lock()
		defer traceLock.Unlock()
		trace = append(trace, "object")
	}
	store := mustDurableStore(t, metadata, objects)

	worker, created, err := store.PutWorker(context.Background(), "default", "hello", validRequest("export default {}"))
	if err != nil {
		t.Fatal(err)
	}
	if !created || len(worker.Versions) != 1 || worker.Versions[0].VersionID == "" {
		t.Fatalf("unexpected publish result: created=%v worker=%#v", created, worker)
	}
	if len(trace) != 2 || trace[0] != "object" || trace[1] != "metadata" {
		t.Fatalf("write order = %#v, want object then metadata", trace)
	}
}

func TestDurableStoreObjectFailureCannotPublishDeployment(t *testing.T) {
	metadata := newMemoryMetadataStore()
	objects := newMemoryObjectStore()
	objects.putError = errors.New("COS unavailable")
	store := mustDurableStore(t, metadata, objects)

	if _, _, err := store.PutWorker(context.Background(), "default", "hello", validRequest("export default {}")); err == nil {
		t.Fatal("upload unexpectedly succeeded")
	}
	if _, err := metadata.GetWorker(context.Background(), "default", "hello"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("failed object upload published deployment: %v", err)
	}
}

func TestDurableStoreDeploymentCompareAndSwap(t *testing.T) {
	metadata := newMemoryMetadataStore()
	store := mustDurableStore(t, metadata, newMemoryObjectStore())
	v1, _, err := store.UploadVersion(context.Background(), "default", "cas", validRequest("export default { fetch() { return new Response('v1') } }"))
	if err != nil {
		t.Fatal(err)
	}
	v2, _, err := store.UploadVersion(context.Background(), "default", "cas", validRequest("export default { fetch() { return new Response('v2') } }"))
	if err != nil {
		t.Fatal(err)
	}
	noActive := ""
	first, err := store.CreateDeployment(context.Background(), "default", "cas", CreateDeploymentRequest{
		Strategy: PercentageStrategy, Versions: []DeploymentVersion{{VersionID: v1.VersionID, Percentage: 100}}, ExpectedDeploymentID: &noActive,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateDeployment(context.Background(), "default", "cas", CreateDeploymentRequest{
		Strategy: PercentageStrategy, Versions: []DeploymentVersion{{VersionID: v2.VersionID, Percentage: 100}}, ExpectedDeploymentID: &noActive,
	}); !errors.Is(err, ErrDeploymentConflict) {
		t.Fatalf("stale durable deployment error = %v, want ErrDeploymentConflict", err)
	}
	expected := first.Deployment.ID
	if _, err := store.CreateDeployment(context.Background(), "default", "cas", CreateDeploymentRequest{
		Strategy: PercentageStrategy, Versions: []DeploymentVersion{{VersionID: v2.VersionID, Percentage: 100}}, ExpectedDeploymentID: &expected,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestDurableStoreRejectsGradualRolloutThatRebindsDurableObjectNamespace(t *testing.T) {
	store := mustDurableStore(t, newMemoryMetadataStore(), newMemoryObjectStore())
	firstRequest := validRequest("export class Counter {}; export default {}")
	firstRequest.DurableObjects = map[string]string{"COUNTER": "Counter"}
	first, _, err := store.UploadVersion(context.Background(), "default", "counter", firstRequest)
	if err != nil {
		t.Fatal(err)
	}
	secondRequest := validRequest("export class Other {}; export default {}")
	secondRequest.DurableObjects = map[string]string{"COUNTER": "Other"}
	second, _, err := store.UploadVersion(context.Background(), "default", "counter", secondRequest)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.CreateDeployment(context.Background(), "default", "counter", CreateDeploymentRequest{
		Strategy: PercentageStrategy,
		Versions: []DeploymentVersion{
			{VersionID: first.VersionID, Percentage: 50},
			{VersionID: second.VersionID, Percentage: 50},
		},
	})
	if !errors.Is(err, ErrIncompatibleRolloutBindings) {
		t.Fatalf("rollout error = %v, want ErrIncompatibleRolloutBindings", err)
	}
	if _, err := store.GetWorker(context.Background(), "default", "counter"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rejected rollout published an active Worker: %v", err)
	}
}

func TestDurableStoreConcurrentIdempotenceAndRetainedVersion(t *testing.T) {
	metadata := newMemoryMetadataStore()
	objects := newMemoryObjectStore()
	store := mustDurableStore(t, metadata, objects)
	request := validRequest("export default { fetch() { return new Response('ok') } }")

	var wait sync.WaitGroup
	errorsChannel := make(chan error, 32)
	createdChannel := make(chan bool, 32)
	for index := 0; index < 32; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, created, err := store.PutWorker(context.Background(), "default", "hello", request)
			createdChannel <- created
			errorsChannel <- err
		}()
	}
	wait.Wait()
	close(errorsChannel)
	close(createdChannel)
	for err := range errorsChannel {
		if err != nil {
			t.Fatal(err)
		}
	}
	createdCount := 0
	for created := range createdChannel {
		if created {
			createdCount++
		}
	}
	if createdCount != 1 {
		t.Fatalf("created count = %d, want 1", createdCount)
	}
	active, err := store.GetWorker(context.Background(), "default", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteWorker(context.Background(), "default", "hello"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetVersion(context.Background(), "default", "hello", active.Versions[0].VersionID); err != nil {
		t.Fatalf("delete removed pinned immutable version: %v", err)
	}
}

func TestDurableStorePublishesGradualDeploymentFromUploadedVersions(t *testing.T) {
	metadata := newMemoryMetadataStore()
	objects := newMemoryObjectStore()
	store := mustDurableStore(t, metadata, objects)
	v1, _, err := store.UploadVersion(context.Background(), "default", "gradual", validRequest("export default { fetch() { return new Response('v1') } }"))
	if err != nil {
		t.Fatal(err)
	}
	v2, _, err := store.UploadVersion(context.Background(), "default", "gradual", validRequest("export default { fetch() { return new Response('v2') } }"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := metadata.GetWorker(context.Background(), "default", "gradual"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("upload-only version published a deployment: %v", err)
	}
	worker, err := store.CreateDeployment(context.Background(), "default", "gradual", CreateDeploymentRequest{
		Strategy: PercentageStrategy,
		Versions: []DeploymentVersion{
			{VersionID: v1.VersionID, Percentage: 10},
			{VersionID: v2.VersionID, Percentage: 90},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(worker.Versions) != 2 || !reflect.DeepEqual(worker.Versions[0], v1) || !reflect.DeepEqual(worker.Versions[1], v2) {
		t.Fatalf("unexpected gradual deployment: %#v", worker)
	}
}

func TestDurableStoreDeleteRejectsNamespaceInventory(t *testing.T) {
	store := mustDurableStore(t, newMemoryMetadataStore(), newMemoryObjectStore())
	request := validRequest("export class Counter {}; export default {}")
	request.DurableObjects = map[string]string{"COUNTER": "Counter"}
	if _, _, err := store.PutWorker(context.Background(), "default", "durable", request); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteWorker(context.Background(), "default", "durable"); !errors.Is(err, ErrDurableObjectNamespaces) {
		t.Fatalf("delete error = %v, want ErrDurableObjectNamespaces", err)
	}
}

func TestDurableStoreObjectDeleteIsTerminalAndIdempotent(t *testing.T) {
	store := mustDurableStore(t, newMemoryMetadataStore(), newMemoryObjectStore())
	request := validRequest("export class Counter {}; export default {}")
	request.DurableObjects = map[string]string{"COUNTER": "Counter"}
	if _, _, err := store.PutWorker(context.Background(), "default", "counter", request); err != nil {
		t.Fatal(err)
	}
	objectID := strings.Repeat("b", 64)
	if _, err := store.ClaimObject(context.Background(), "default", "counter", "Counter", objectID, testObjectPlacement()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ActivateObject(context.Background(), "default", "counter", "Counter", objectID, "actor-2"); err != nil {
		t.Fatal(err)
	}
	observed, err := store.GetObject(context.Background(), "default", "counter", "Counter", objectID)
	if err != nil || observed.ActorID != "actor-2" || !reflect.DeepEqual(observed.Placement, testObjectPlacement()) {
		t.Fatalf("get object = %+v, err=%v", observed, err)
	}
	first, err := store.DeleteObject(context.Background(), "default", "counter", "Counter", objectID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.DeleteObject(context.Background(), "default", "counter", "Counter", objectID)
	if err != nil || !reflect.DeepEqual(first, second) {
		t.Fatalf("idempotent delete = %+v, err=%v; want %+v", second, err, first)
	}
	if _, err := store.ClaimObject(context.Background(), "default", "counter", "Counter", objectID, nil); !errors.Is(err, ErrObjectDeleted) {
		t.Fatalf("claim after delete = %v, want ErrObjectDeleted", err)
	}
}

func TestDurableStoreRejectsObjectMetadataMismatch(t *testing.T) {
	metadata := newMemoryMetadataStore()
	objects := newMemoryObjectStore()
	store := mustDurableStore(t, metadata, objects)
	worker, _, err := store.PutWorker(context.Background(), "default", "hello", validRequest("export default {}"))
	if err != nil {
		t.Fatal(err)
	}
	key := store.versionObjectKey("default", "hello", worker.Versions[0].VersionID)
	objects.mu.Lock()
	objects.values[key] = []byte(`{"tampered":true}`)
	objects.mu.Unlock()
	if _, err := store.GetVersion(context.Background(), "default", "hello", worker.Versions[0].VersionID); err == nil {
		t.Fatal("tampered immutable object was accepted")
	}
}

func mustDurableStore(t *testing.T, metadata MetadataStore, objects ImmutableObjectStore) *DurableStore {
	t.Helper()
	store, err := NewDurableStore(metadata, objects, "registry/v1")
	if err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC) }
	return store
}

type memoryMetadataStore struct {
	mu               sync.Mutex
	workers          map[string]Worker
	versions         map[string]VersionSummary
	deployments      map[string]Deployment
	objects          map[string]DurableObjectRecord
	deploymentCursor string
	beforePublish    func()
}

func newMemoryMetadataStore() *memoryMetadataStore {
	return &memoryMetadataStore{workers: map[string]Worker{}, versions: map[string]VersionSummary{}, deployments: map[string]Deployment{}, objects: map[string]DurableObjectRecord{}, deploymentCursor: InitialDeploymentCursor}
}

func (s *memoryMetadataStore) Check(context.Context) error { return nil }

func (s *memoryMetadataStore) Publish(_ context.Context, worker Worker, summary VersionSummary, retention int) (Worker, bool, error) {
	if s.beforePublish != nil {
		s.beforePublish()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := worker.Namespace + "\x00" + worker.Name + "\x00" + summary.VersionID
	existing, found := s.versions[key]
	if found && !sameVersionIdentity(existing, summary) {
		return Worker{}, false, ErrImmutableConflict
	}
	if !found {
		s.versions[key] = summary
	} else {
		for index := range worker.Versions {
			if worker.Versions[index].VersionID == existing.VersionID {
				worker.Versions[index] = existing
			}
		}
	}
	versions := s.listVersionSummariesLocked(worker.Namespace, worker.Name)
	if _, ok := versionIDSet(versions[:min(retention, len(versions))])[summary.VersionID]; !ok {
		return Worker{}, false, ErrVersionNotDeployable
	}
	s.workers[worker.Namespace+"\x00"+worker.Name] = worker
	s.deployments[worker.Namespace+"\x00"+worker.Name+"\x00"+worker.Deployment.ID] = worker.Deployment
	cursor, err := newDeploymentCursor()
	if err != nil {
		return Worker{}, false, err
	}
	s.deploymentCursor = cursor
	worker.DeploymentCursor = cursor
	return worker, !found, nil
}

func (s *memoryMetadataStore) PublishVersion(_ context.Context, namespace, worker string, summary VersionSummary) (VersionSummary, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := namespace + "\x00" + worker + "\x00" + summary.VersionID
	existing, found := s.versions[key]
	if found && !sameVersionIdentity(existing, summary) {
		return VersionSummary{}, false, ErrImmutableConflict
	}
	if found {
		return existing, false, nil
	}
	s.versions[key] = summary
	return summary, true, nil
}

func (s *memoryMetadataStore) PublishDeployment(_ context.Context, deployment Deployment, retention int, expected *string) (Worker, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, active := s.workers[deployment.Namespace+"\x00"+deployment.Worker]
	if expected != nil && ((!active && *expected != "") || (active && current.Deployment.ID != *expected)) {
		return Worker{}, ErrDeploymentConflict
	}
	versions := s.listVersionSummariesLocked(deployment.Namespace, deployment.Worker)
	deployable := versionIDSet(versions[:min(retention, len(versions))])
	summaries := make([]VersionSummary, 0, len(deployment.Versions))
	for _, target := range deployment.Versions {
		summary, found := s.versions[deployment.Namespace+"\x00"+deployment.Worker+"\x00"+target.VersionID]
		if !found {
			return Worker{}, ErrNotFound
		}
		if _, ok := deployable[target.VersionID]; !ok {
			return Worker{}, ErrVersionNotDeployable
		}
		summaries = append(summaries, summary)
	}
	worker := Worker{
		Schema: Schema, Namespace: deployment.Namespace, Name: deployment.Worker,
		Deployment: deployment, Versions: summaries,
	}
	s.workers[worker.Namespace+"\x00"+worker.Name] = worker
	s.deployments[worker.Namespace+"\x00"+worker.Name+"\x00"+deployment.ID] = deployment
	cursor, err := newDeploymentCursor()
	if err != nil {
		return Worker{}, err
	}
	s.deploymentCursor = cursor
	worker.DeploymentCursor = cursor
	return worker, nil
}

func (s *memoryMetadataStore) ListVersionSummaries(_ context.Context, namespace, worker string, page, perPage int) ([]VersionSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	page, perPage = normalizePagination(page, perPage)
	return paginate(s.listVersionSummariesLocked(namespace, worker), page, perPage), nil
}

func (s *memoryMetadataStore) listVersionSummariesLocked(namespace, worker string) []VersionSummary {
	prefix := namespace + "\x00" + worker + "\x00"
	result := []VersionSummary{}
	for key, summary := range s.versions {
		if len(key) >= len(prefix) && key[:len(prefix)] == prefix {
			result = append(result, summary)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAt.Equal(result[j].CreatedAt) {
			return result[i].VersionID > result[j].VersionID
		}
		return result[i].CreatedAt.After(result[j].CreatedAt)
	})
	return result
}

func (s *memoryMetadataStore) ListDeployments(_ context.Context, namespace, worker string, page, perPage int) ([]Deployment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	page, perPage = normalizePagination(page, perPage)
	prefix := namespace + "\x00" + worker + "\x00"
	result := []Deployment{}
	for key, deployment := range s.deployments {
		if len(key) >= len(prefix) && key[:len(prefix)] == prefix {
			result = append(result, deployment)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].DeployedAt.Equal(result[j].DeployedAt) {
			return result[i].ID > result[j].ID
		}
		return result[i].DeployedAt.After(result[j].DeployedAt)
	})
	return paginate(result, page, perPage), nil
}

func (s *memoryMetadataStore) GetDeployment(_ context.Context, namespace, worker, deploymentID string) (Deployment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	deployment, ok := s.deployments[namespace+"\x00"+worker+"\x00"+deploymentID]
	if !ok {
		return Deployment{}, ErrNotFound
	}
	return deployment, nil
}

func (s *memoryMetadataStore) DeleteDeployment(_ context.Context, namespace, worker, deploymentID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if active, ok := s.workers[namespace+"\x00"+worker]; ok && active.Deployment.ID == deploymentID {
		return ErrActiveDeployment
	}
	key := namespace + "\x00" + worker + "\x00" + deploymentID
	if _, ok := s.deployments[key]; !ok {
		return ErrNotFound
	}
	delete(s.deployments, key)
	return nil
}

func (s *memoryMetadataStore) GetWorker(_ context.Context, namespace, worker string) (Worker, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result, found := s.workers[namespace+"\x00"+worker]
	if !found {
		return Worker{}, ErrNotFound
	}
	result.DeploymentCursor = s.deploymentCursor
	return result, nil
}

func (s *memoryMetadataStore) WatchDeploymentCursor(ctx context.Context, _ string, after string) (string, error) {
	for {
		s.mu.Lock()
		cursor := s.deploymentCursor
		s.mu.Unlock()
		if cursor != after {
			return cursor, nil
		}
		timer := time.NewTimer(time.Millisecond)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return after, ctx.Err()
		case <-timer.C:
		}
	}
}

func (s *memoryMetadataStore) DeleteWorker(_ context.Context, namespace, worker string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := namespace + "\x00" + worker
	if _, found := s.workers[key]; !found {
		return ErrNotFound
	}
	if hasDurableObjectNamespaces(s.listVersionSummariesLocked(namespace, worker)) {
		return ErrDurableObjectNamespaces
	}
	delete(s.workers, key)
	cursor, err := newDeploymentCursor()
	if err != nil {
		return err
	}
	s.deploymentCursor = cursor
	return nil
}

func (s *memoryMetadataStore) ListWorkers(_ context.Context, namespace string) ([]Worker, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	workers := []Worker{}
	for _, worker := range s.workers {
		if worker.Namespace == namespace {
			worker.DeploymentCursor = s.deploymentCursor
			workers = append(workers, worker)
		}
	}
	return workers, nil
}

func (s *memoryMetadataStore) GetVersionSummary(_ context.Context, namespace, worker, versionID string) (VersionSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result, found := s.versions[namespace+"\x00"+worker+"\x00"+versionID]
	if !found {
		return VersionSummary{}, ErrNotFound
	}
	return result, nil
}

func (s *memoryMetadataStore) ClaimObject(_ context.Context, candidate DurableObjectRecord) (DurableObjectRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	worker, found := s.workers[candidate.Namespace+"\x00"+candidate.Worker]
	if !found {
		return DurableObjectRecord{}, ErrNotFound
	}
	if !workerExportsClass(worker, candidate.ClassName) {
		return DurableObjectRecord{}, ErrObjectClassNotFound
	}
	key := objectRecordKey(candidate.Namespace, candidate.Worker, candidate.ClassName, candidate.ObjectID)
	if existing, found := s.objects[key]; found {
		if existing.State == ObjectStateDeleted {
			return DurableObjectRecord{}, ErrObjectDeleted
		}
		return existing, nil
	}
	if err := validateObjectPlacement(candidate.Placement); err != nil {
		return DurableObjectRecord{}, err
	}
	s.objects[key] = candidate
	return candidate, nil
}

func (s *memoryMetadataStore) GetObject(_ context.Context, namespace, worker, className, objectID string) (DurableObjectRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.objects[objectRecordKey(namespace, worker, className, objectID)]
	if !ok {
		return DurableObjectRecord{}, ErrNotFound
	}
	return record, nil
}

func (s *memoryMetadataStore) ActivateObject(_ context.Context, namespace, worker, className, objectID, actorID string) (DurableObjectRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := objectRecordKey(namespace, worker, className, objectID)
	record, found := s.objects[key]
	if !found {
		return DurableObjectRecord{}, ErrNotFound
	}
	if record.State == ObjectStateDeleted {
		return DurableObjectRecord{}, ErrObjectDeleted
	}
	if record.ActorID != "" && record.ActorID != actorID {
		return DurableObjectRecord{}, ErrObjectConflict
	}
	record.ActorID = actorID
	s.objects[key] = record
	return record, nil
}

func (s *memoryMetadataStore) DeleteObject(_ context.Context, tombstone DurableObjectRecord) (DurableObjectRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := objectRecordKey(tombstone.Namespace, tombstone.Worker, tombstone.ClassName, tombstone.ObjectID)
	record, found := s.objects[key]
	if !found {
		if !summariesExportClass(s.listVersionSummariesLocked(tombstone.Namespace, tombstone.Worker), tombstone.ClassName) {
			return DurableObjectRecord{}, ErrObjectClassNotFound
		}
		s.objects[key] = tombstone
		return tombstone, nil
	}
	if record.State == ObjectStateDeleted {
		return record, nil
	}
	record.State = ObjectStateDeleted
	record.DeletedAt = tombstone.DeletedAt
	s.objects[key] = record
	return record, nil
}

func (s *memoryMetadataStore) GetCellPlacementCount(_ context.Context, cellName, cellUID string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var count int64
	for _, record := range s.objects {
		if record.State == ObjectStateActive && record.Placement != nil && record.Placement.CellName == cellName && record.Placement.CellUID == cellUID {
			count++
		}
	}
	return count, nil
}

func objectRecordKey(namespace, worker, className, objectID string) string {
	return namespace + "\x00" + worker + "\x00" + className + "\x00" + objectID
}

type memoryObjectStore struct {
	mu        sync.Mutex
	values    map[string][]byte
	putError  error
	beforePut func()
}

func newMemoryObjectStore() *memoryObjectStore {
	return &memoryObjectStore{values: map[string][]byte{}}
}

func (s *memoryObjectStore) Check(context.Context) error { return nil }

func (s *memoryObjectStore) PutImmutable(_ context.Context, key string, content []byte) (bool, error) {
	if s.beforePut != nil {
		s.beforePut()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.putError != nil {
		return false, s.putError
	}
	existing, found := s.values[key]
	if found {
		if !bytes.Equal(existing, content) {
			return false, ErrImmutableConflict
		}
		return false, nil
	}
	s.values[key] = append([]byte(nil), content...)
	return true, nil
}

func (s *memoryObjectStore) Get(_ context.Context, key string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, found := s.values[key]
	if !found {
		return nil, ErrNotFound
	}
	return append([]byte(nil), value...), nil
}
