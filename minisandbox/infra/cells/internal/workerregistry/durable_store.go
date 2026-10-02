package workerregistry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
	"sync"
	"time"
)

var ErrImmutableConflict = errors.New("immutable Worker version conflict")
var ErrIncompatibleRolloutBindings = errors.New("Worker rollout changes a Durable Object binding namespace")

// MetadataStore owns the small mutable control-plane records. Publish must be
// one serializable transaction: create/verify immutable version metadata and
// replace the active deployment pointer together.
type MetadataStore interface {
	Check(context.Context) error
	Publish(context.Context, Worker, VersionSummary, int) (Worker, bool, error)
	PublishVersion(context.Context, string, string, VersionSummary) (VersionSummary, bool, error)
	PublishDeployment(context.Context, Deployment, int, *string) (Worker, error)
	ListVersionSummaries(context.Context, string, string, int, int) ([]VersionSummary, error)
	ListDeployments(context.Context, string, string, int, int) ([]Deployment, error)
	GetDeployment(context.Context, string, string, string) (Deployment, error)
	DeleteDeployment(context.Context, string, string, string) error
	GetWorker(context.Context, string, string) (Worker, error)
	WatchDeploymentCursor(context.Context, string, string) (string, error)
	DeleteWorker(context.Context, string, string) error
	ListWorkers(context.Context, string) ([]Worker, error)
	GetVersionSummary(context.Context, string, string, string) (VersionSummary, error)
	GetObject(context.Context, string, string, string, string) (DurableObjectRecord, error)
	ClaimObject(context.Context, DurableObjectRecord) (DurableObjectRecord, error)
	ActivateObject(context.Context, string, string, string, string, string) (DurableObjectRecord, error)
	DeleteObject(context.Context, DurableObjectRecord) (DurableObjectRecord, error)
	GetCellPlacementCount(context.Context, string, string) (int64, error)
}

// ImmutableObjectStore contains the complete version JSON. PutImmutable must
// never overwrite a different value at an existing key.
type ImmutableObjectStore interface {
	Check(context.Context) error
	PutImmutable(context.Context, string, []byte) (bool, error)
	Get(context.Context, string) ([]byte, error)
}

// DurableStore implements the production ordering contract: write immutable
// code to the object store first, then atomically publish its FDB metadata and
// deployment pointer. A crash between the steps can only leave an unreferenced
// object, never an active deployment pointing at missing code.
type DurableStore struct {
	metadata     MetadataStore
	objects      ImmutableObjectStore
	objectPrefix string
	now          func() time.Time
	retention    int
	healthMu     sync.Mutex
	healthUntil  time.Time
	healthErr    error
}

func NewDurableStore(metadata MetadataStore, objects ImmutableObjectStore, objectPrefix string) (*DurableStore, error) {
	return NewDurableStoreWithRetention(metadata, objects, objectPrefix, DefaultVersionRetention)
}

func NewDurableStoreWithRetention(metadata MetadataStore, objects ImmutableObjectStore, objectPrefix string, retention int) (*DurableStore, error) {
	if metadata == nil || objects == nil {
		return nil, fmt.Errorf("Worker registry metadata and object stores are required")
	}
	if retention < 1 || retention > MaxVersionRetention {
		return nil, fmt.Errorf("Worker version retention must be between 1 and %d", MaxVersionRetention)
	}
	return &DurableStore{
		metadata:     metadata,
		objects:      objects,
		objectPrefix: strings.Trim(strings.TrimSpace(objectPrefix), "/"),
		now:          func() time.Time { return time.Now().UTC() },
		retention:    retention,
	}, nil
}

func (s *DurableStore) Check(ctx context.Context) error {
	s.healthMu.Lock()
	defer s.healthMu.Unlock()
	if s.now().Before(s.healthUntil) {
		return s.healthErr
	}
	var healthErr error
	if err := s.metadata.Check(ctx); err != nil {
		healthErr = fmt.Errorf("check Worker registry metadata: %w", err)
	} else if err := s.objects.Check(ctx); err != nil {
		healthErr = fmt.Errorf("check Worker registry object storage: %w", err)
	}
	ttl := 30 * time.Second
	if healthErr != nil {
		ttl = 5 * time.Second
	}
	s.healthErr = healthErr
	s.healthUntil = s.now().Add(ttl)
	return healthErr
}

func (s *DurableStore) PutWorker(ctx context.Context, namespace, worker string, request PutWorkerRequest) (Worker, bool, error) {
	version, encoded, err := s.prepareVersion(namespace, worker, request)
	if err != nil {
		return Worker{}, false, err
	}
	if _, err := s.objects.PutImmutable(ctx, s.versionObjectKey(namespace, worker, version.VersionID), encoded); err != nil {
		return Worker{}, false, fmt.Errorf("persist immutable Worker version: %w", err)
	}

	deployment, err := newDeployment(namespace, worker, CreateDeploymentRequest{
		Strategy:    PercentageStrategy,
		Versions:    []DeploymentVersion{{VersionID: version.VersionID, Percentage: 100}},
		Annotations: DeploymentAnnotations{TriggeredBy: "upload"},
	}, s.now())
	if err != nil {
		return Worker{}, false, err
	}
	result := makeWorker(namespace, worker, deployment, []WorkerVersion{version})
	persisted, created, err := s.metadata.Publish(ctx, result, summarizeVersion(version), s.retention)
	if err != nil {
		return Worker{}, false, fmt.Errorf("publish Worker deployment: %w", err)
	}
	// Publish returns the exact transaction value instead of reading the active
	// pointer again. A concurrent deployment may legitimately overtake this one
	// immediately after commit, but must not change this request's response.
	return persisted, created, nil
}

func (s *DurableStore) UploadVersion(ctx context.Context, namespace, worker string, request PutWorkerRequest) (VersionSummary, bool, error) {
	version, encoded, err := s.prepareVersion(namespace, worker, request)
	if err != nil {
		return VersionSummary{}, false, err
	}
	if _, err := s.objects.PutImmutable(ctx, s.versionObjectKey(namespace, worker, version.VersionID), encoded); err != nil {
		return VersionSummary{}, false, fmt.Errorf("persist immutable Worker version: %w", err)
	}
	persisted, created, err := s.metadata.PublishVersion(ctx, namespace, worker, summarizeVersion(version))
	if err != nil {
		return VersionSummary{}, false, fmt.Errorf("publish Worker version metadata: %w", err)
	}
	return persisted, created, nil
}

func (s *DurableStore) CreateDeployment(ctx context.Context, namespace, worker string, request CreateDeploymentRequest) (Worker, error) {
	deployment, err := newDeployment(namespace, worker, request, s.now())
	if err != nil {
		return Worker{}, err
	}
	versions := make([]WorkerVersion, 0, len(deployment.Versions))
	for _, target := range deployment.Versions {
		version, err := s.GetVersion(ctx, namespace, worker, target.VersionID)
		if err != nil {
			return Worker{}, err
		}
		versions = append(versions, version)
	}
	if err := validateRolloutBindingCompatibility(versions); err != nil {
		return Worker{}, err
	}
	persisted, err := s.metadata.PublishDeployment(ctx, deployment, s.retention, request.ExpectedDeploymentID)
	if err != nil {
		return Worker{}, fmt.Errorf("publish Worker deployment: %w", err)
	}
	return persisted, nil
}

func (s *DurableStore) ListVersions(ctx context.Context, namespace, worker string, page, perPage int) (VersionList, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return VersionList{}, err
	}
	page, perPage = normalizePagination(page, perPage)
	summaries, err := s.metadata.ListVersionSummaries(ctx, namespace, worker, page, perPage)
	if err != nil {
		return VersionList{}, err
	}
	active := map[string]struct{}{}
	workerRecord, err := s.metadata.GetWorker(ctx, namespace, worker)
	if err == nil {
		for _, target := range workerRecord.Deployment.Versions {
			active[target.VersionID] = struct{}{}
		}
	} else if !errors.Is(err, ErrNotFound) {
		return VersionList{}, err
	}
	records := buildVersionRecords(summaries, active, s.retention, (page-1)*perPage)
	return VersionList{
		Versions:  records,
		Page:      page,
		PerPage:   perPage,
		Retention: s.retention,
		GCMode:    "report_only",
	}, nil
}

func (s *DurableStore) ListDeployments(ctx context.Context, namespace, worker string, page, perPage int) (DeploymentList, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return DeploymentList{}, err
	}
	page, perPage = normalizePagination(page, perPage)
	deployments, err := s.metadata.ListDeployments(ctx, namespace, worker, page, perPage)
	if err != nil {
		return DeploymentList{}, err
	}
	recent, err := s.metadata.ListVersionSummaries(ctx, namespace, worker, 1, s.retention)
	if err != nil {
		return DeploymentList{}, err
	}
	deployable := versionIDSet(recent)
	activeID := ""
	workerRecord, err := s.metadata.GetWorker(ctx, namespace, worker)
	if err == nil {
		activeID = workerRecord.Deployment.ID
	} else if !errors.Is(err, ErrNotFound) {
		return DeploymentList{}, err
	}
	records := buildDeploymentRecords(deployments, activeID, deployable)
	return DeploymentList{Deployments: records, Page: page, PerPage: perPage}, nil
}

func (s *DurableStore) GetDeployment(ctx context.Context, namespace, worker, deploymentID string) (DeploymentRecord, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return DeploymentRecord{}, err
	}
	if !validDeploymentID(deploymentID) {
		return DeploymentRecord{}, fmt.Errorf("invalid Worker deployment ID")
	}
	deployment, err := s.metadata.GetDeployment(ctx, namespace, worker, deploymentID)
	if err != nil {
		return DeploymentRecord{}, err
	}
	recent, err := s.metadata.ListVersionSummaries(ctx, namespace, worker, 1, s.retention)
	if err != nil {
		return DeploymentRecord{}, err
	}
	activeID := ""
	workerRecord, err := s.metadata.GetWorker(ctx, namespace, worker)
	if err == nil {
		activeID = workerRecord.Deployment.ID
	} else if !errors.Is(err, ErrNotFound) {
		return DeploymentRecord{}, err
	}
	return buildDeploymentRecords([]Deployment{deployment}, activeID, versionIDSet(recent))[0], nil
}

func (s *DurableStore) DeleteDeployment(ctx context.Context, namespace, worker, deploymentID string) error {
	if err := validateIdentity(namespace, worker); err != nil {
		return err
	}
	if !validDeploymentID(deploymentID) {
		return fmt.Errorf("invalid Worker deployment ID")
	}
	return s.metadata.DeleteDeployment(ctx, namespace, worker, deploymentID)
}

func (s *DurableStore) prepareVersion(namespace, worker string, request PutWorkerRequest) (WorkerVersion, []byte, error) {
	content, _, digest, versionID, err := prepareVersion(namespace, worker, request)
	if err != nil {
		return WorkerVersion{}, nil, err
	}
	version := WorkerVersion{
		VersionID: versionID,
		Digest:    "sha256:" + digest,
		CreatedAt: s.now(),
		Content:   content,
	}
	encoded, err := json.Marshal(content)
	if err != nil {
		return WorkerVersion{}, nil, fmt.Errorf("encode Worker version: %w", err)
	}
	return version, encoded, nil
}

func (s *DurableStore) GetWorker(ctx context.Context, namespace, worker string) (Worker, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return Worker{}, err
	}
	return s.metadata.GetWorker(ctx, namespace, worker)
}

func (s *DurableStore) WatchDeploymentCursor(ctx context.Context, namespace, after string) (string, error) {
	if !namePattern.MatchString(namespace) {
		return "", fmt.Errorf("namespace must match %s", namePattern.String())
	}
	if !validDeploymentCursor(after) {
		return "", fmt.Errorf("invalid Worker deployment cursor")
	}
	return s.metadata.WatchDeploymentCursor(ctx, namespace, after)
}

func (s *DurableStore) DeleteWorker(ctx context.Context, namespace, worker string) error {
	if err := validateIdentity(namespace, worker); err != nil {
		return err
	}
	return s.metadata.DeleteWorker(ctx, namespace, worker)
}

func (s *DurableStore) ListWorkers(ctx context.Context, namespace string) ([]Worker, error) {
	if !namePattern.MatchString(namespace) {
		return nil, fmt.Errorf("namespace must match %s", namePattern.String())
	}
	workers, err := s.metadata.ListWorkers(ctx, namespace)
	if err != nil {
		return nil, err
	}
	sort.Slice(workers, func(i, j int) bool { return workers[i].Name < workers[j].Name })
	return workers, nil
}

func (s *DurableStore) GetVersion(ctx context.Context, namespace, worker, versionID string) (WorkerVersion, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return WorkerVersion{}, err
	}
	if !validVersionID(versionID) {
		return WorkerVersion{}, fmt.Errorf("invalid Worker version ID")
	}
	summary, err := s.metadata.GetVersionSummary(ctx, namespace, worker, versionID)
	if err != nil {
		return WorkerVersion{}, err
	}
	encoded, err := s.objects.Get(ctx, s.versionObjectKey(namespace, worker, versionID))
	if err != nil {
		return WorkerVersion{}, fmt.Errorf("read immutable Worker version: %w", err)
	}
	var content VersionContent
	if err := decodeStrict(encoded, &content); err != nil {
		return WorkerVersion{}, fmt.Errorf("decode immutable Worker version: %w", err)
	}
	version := WorkerVersion{
		VersionID: summary.VersionID,
		Digest:    summary.Digest,
		CreatedAt: summary.CreatedAt,
		Content:   content,
	}
	if err := verifyWorkerVersion(namespace, worker, versionID, version); err != nil {
		return WorkerVersion{}, err
	}
	if got := summarizeVersion(version); !got.CreatedAt.Equal(summary.CreatedAt) || !sameVersionIdentity(got, summary) {
		return WorkerVersion{}, fmt.Errorf("Worker version metadata does not match immutable object")
	}
	return version, nil
}

func (s *DurableStore) ClaimObject(ctx context.Context, namespace, worker, className, objectID string, placement *ObjectPlacement) (DurableObjectRecord, error) {
	if err := validateObjectIdentity(namespace, worker, className, objectID); err != nil {
		return DurableObjectRecord{}, err
	}
	return s.metadata.ClaimObject(ctx, newObjectRecord(namespace, worker, className, objectID, placement, s.now()))
}

func (s *DurableStore) GetObject(ctx context.Context, namespace, worker, className, objectID string) (DurableObjectRecord, error) {
	if err := validateObjectIdentity(namespace, worker, className, objectID); err != nil {
		return DurableObjectRecord{}, err
	}
	return s.metadata.GetObject(ctx, namespace, worker, className, objectID)
}

func (s *DurableStore) ActivateObject(ctx context.Context, namespace, worker, className, objectID, actorID string) (DurableObjectRecord, error) {
	if err := validateObjectIdentity(namespace, worker, className, objectID); err != nil {
		return DurableObjectRecord{}, err
	}
	if err := validateActorID(actorID); err != nil {
		return DurableObjectRecord{}, err
	}
	return s.metadata.ActivateObject(ctx, namespace, worker, className, objectID, actorID)
}

func (s *DurableStore) DeleteObject(ctx context.Context, namespace, worker, className, objectID string) (DurableObjectRecord, error) {
	if err := validateObjectIdentity(namespace, worker, className, objectID); err != nil {
		return DurableObjectRecord{}, err
	}
	record := newObjectRecord(namespace, worker, className, objectID, nil, s.now())
	deletedAt := s.now()
	record.State = ObjectStateDeleted
	record.DeletedAt = &deletedAt
	return s.metadata.DeleteObject(ctx, record)
}

func (s *DurableStore) GetCellPlacementCount(ctx context.Context, cellName, cellUID string) (int64, error) {
	if err := validateCellIdentity(cellName, cellUID); err != nil {
		return 0, err
	}
	return s.metadata.GetCellPlacementCount(ctx, cellName, cellUID)
}

func (s *DurableStore) versionObjectKey(namespace, worker, versionID string) string {
	return path.Join(s.objectPrefix, "namespaces", namespace, "workers", worker, "versions", versionID+".json")
}
