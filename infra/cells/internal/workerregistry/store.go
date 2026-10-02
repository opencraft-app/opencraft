package workerregistry

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	MaxModules            = 64
	MaxModuleBytes        = 1 << 20
	MaxTotalModuleBytes   = 2 << 20
	MaxCompatibilityFlags = 32
	MaxBindings           = 64
	MaxExports            = 64
)

var (
	ErrNotFound                = errors.New("worker not found")
	ErrActiveDeployment        = errors.New("active deployment cannot be deleted")
	ErrDeploymentConflict      = errors.New("active Worker deployment changed")
	ErrVersionNotDeployable    = errors.New("worker version is outside the deployable retention window")
	ErrDurableObjectNamespaces = errors.New("worker has durable object namespaces")
	ErrObjectClassNotFound     = errors.New("durable object class not found")
	ErrObjectDeleted           = errors.New("durable object was deleted")
	ErrObjectConflict          = errors.New("durable object actor identity conflict")
	ErrPlacementRequired       = errors.New("durable object placement is required")
	namePattern                = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
	flagPattern                = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	bindingPattern             = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)
	classPattern               = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]{0,127}$`)
	objectPattern              = regexp.MustCompile(`^[0-9a-f]{64}$`)
	digestPattern              = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

type Store struct {
	root        string
	now         func() time.Time
	retention   int
	locks       sync.Map
	placementMu sync.RWMutex
}

func NewStore(root string) (*Store, error) {
	return NewStoreWithRetention(root, DefaultVersionRetention)
}

func NewStoreWithRetention(root string, retention int) (*Store, error) {
	if strings.TrimSpace(root) == "" {
		return nil, fmt.Errorf("worker registry data directory is required")
	}
	if retention < 1 || retention > MaxVersionRetention {
		return nil, fmt.Errorf("Worker version retention must be between 1 and %d", MaxVersionRetention)
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve worker registry data directory: %w", err)
	}
	absolute = filepath.Join(absolute, "v5")
	if err := os.MkdirAll(filepath.Join(absolute, "namespaces"), 0o750); err != nil {
		return nil, fmt.Errorf("create worker registry data directory: %w", err)
	}
	store := &Store{root: absolute, now: func() time.Time { return time.Now().UTC() }, retention: retention}
	if err := store.Check(context.Background()); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *Store) Check(_ context.Context) error {
	info, err := os.Stat(filepath.Join(s.root, "namespaces"))
	if err != nil {
		return fmt.Errorf("stat worker registry data directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("worker registry namespaces path is not a directory")
	}
	return nil
}

func (s *Store) PutWorker(_ context.Context, namespace, worker string, request PutWorkerRequest) (Worker, bool, error) {
	content, canonical, digest, versionID, err := prepareVersion(namespace, worker, request)
	if err != nil {
		return Worker{}, false, err
	}
	lock := s.workerLock(namespace, worker)
	lock.Lock()
	defer lock.Unlock()
	version, created, err := s.putVersionLocked(namespace, worker, content, canonical, digest, versionID)
	if err != nil {
		return Worker{}, false, err
	}
	if err := s.requireDeployableVersionsLocked(namespace, worker, []DeploymentVersion{{VersionID: versionID, Percentage: 100}}); err != nil {
		return Worker{}, false, err
	}
	deployment, err := newDeployment(namespace, worker, CreateDeploymentRequest{
		Strategy:    PercentageStrategy,
		Versions:    []DeploymentVersion{{VersionID: versionID, Percentage: 100}},
		Annotations: DeploymentAnnotations{TriggeredBy: "upload"},
	}, s.now())
	if err != nil {
		return Worker{}, false, err
	}
	cursor, err := s.writeDeploymentLocked(namespace, worker, deployment)
	if err != nil {
		return Worker{}, false, err
	}
	result := makeWorker(namespace, worker, deployment, []WorkerVersion{version})
	result.DeploymentCursor = cursor
	return result, created, nil
}

func (s *Store) UploadVersion(_ context.Context, namespace, worker string, request PutWorkerRequest) (VersionSummary, bool, error) {
	content, canonical, digest, versionID, err := prepareVersion(namespace, worker, request)
	if err != nil {
		return VersionSummary{}, false, err
	}
	lock := s.workerLock(namespace, worker)
	lock.Lock()
	defer lock.Unlock()
	version, created, err := s.putVersionLocked(namespace, worker, content, canonical, digest, versionID)
	if err != nil {
		return VersionSummary{}, false, err
	}
	return summarizeVersion(version), created, nil
}

func (s *Store) CreateDeployment(_ context.Context, namespace, worker string, request CreateDeploymentRequest) (Worker, error) {
	deployment, err := newDeployment(namespace, worker, request, s.now())
	if err != nil {
		return Worker{}, err
	}
	lock := s.workerLock(namespace, worker)
	lock.Lock()
	defer lock.Unlock()
	if err := s.requireExpectedDeploymentLocked(namespace, worker, request.ExpectedDeploymentID); err != nil {
		return Worker{}, err
	}
	if err := s.requireDeployableVersionsLocked(namespace, worker, deployment.Versions); err != nil {
		return Worker{}, err
	}
	versions, err := s.readDeploymentVersionsLocked(namespace, worker, deployment)
	if err != nil {
		return Worker{}, err
	}
	if err := validateRolloutBindingCompatibility(versions); err != nil {
		return Worker{}, err
	}
	cursor, err := s.writeDeploymentLocked(namespace, worker, deployment)
	if err != nil {
		return Worker{}, err
	}
	result := makeWorker(namespace, worker, deployment, versions)
	result.DeploymentCursor = cursor
	return result, nil
}

// validateRolloutBindingCompatibility prevents one binding name from changing
// the logical Durable Object namespace across versions in the same gradual
// rollout. A binding may be added or removed with its version, but a request
// must never interpret the same env binding as two different persistent
// object spaces depending on the percentage bucket it selected.
func validateRolloutBindingCompatibility(versions []WorkerVersion) error {
	seen := make(map[string]struct {
		className    string
		namespaceKey string
		storage      string
	})
	for _, version := range versions {
		for name, binding := range version.Content.Bindings {
			export, ok := version.Content.Exports[binding.ClassName]
			if !ok {
				return fmt.Errorf("%w: binding %s has no export", ErrIncompatibleRolloutBindings, name)
			}
			identity := struct {
				className    string
				namespaceKey string
				storage      string
			}{
				className: binding.ClassName,
				namespaceKey: durableObjectNamespaceKey(
					version.Content.Namespace, version.Content.Worker, binding.ClassName,
				),
				storage: export.Storage,
			}
			if previous, exists := seen[name]; exists && previous != identity {
				return fmt.Errorf("%w: binding %s", ErrIncompatibleRolloutBindings, name)
			}
			seen[name] = identity
		}
	}
	return nil
}

func (s *Store) requireExpectedDeploymentLocked(namespace, worker string, expected *string) error {
	if expected == nil {
		return nil
	}
	active, err := s.activeDeploymentLocked(namespace, worker)
	if errors.Is(err, ErrNotFound) {
		if *expected == "" {
			return nil
		}
		return ErrDeploymentConflict
	}
	if err != nil {
		return err
	}
	if active.ID != *expected {
		return ErrDeploymentConflict
	}
	return nil
}

func (s *Store) putVersionLocked(namespace, worker string, content VersionContent, canonical []byte, digest, versionID string) (WorkerVersion, bool, error) {

	workerDirectory := s.workerDirectory(namespace, worker)
	versionsDirectory := filepath.Join(workerDirectory, "versions")
	if err := os.MkdirAll(versionsDirectory, 0o750); err != nil {
		return WorkerVersion{}, false, fmt.Errorf("create Worker version directory: %w", err)
	}
	versionPath := filepath.Join(versionsDirectory, versionID+".json")
	createdAt := s.now()
	version := WorkerVersion{
		VersionID: versionID,
		Digest:    "sha256:" + digest,
		CreatedAt: createdAt,
		Content:   content,
	}
	encodedVersion, err := json.Marshal(version)
	if err != nil {
		return WorkerVersion{}, false, fmt.Errorf("encode Worker version: %w", err)
	}
	created, err := writeImmutable(versionPath, encodedVersion)
	if err != nil {
		return WorkerVersion{}, false, err
	}
	if !created {
		persisted, err := s.readVersion(namespace, worker, versionID)
		if err != nil {
			return WorkerVersion{}, false, err
		}
		version = persisted
		persistedCanonical, err := json.Marshal(persisted.Content)
		if err != nil || !bytes.Equal(persistedCanonical, canonical) {
			return WorkerVersion{}, false, fmt.Errorf("immutable Worker version content does not match its digest")
		}
	}
	return version, created, nil
}

func (s *Store) writeDeploymentLocked(namespace, worker string, deployment Deployment) (string, error) {
	encodedDeployment, err := json.Marshal(deployment)
	if err != nil {
		return "", fmt.Errorf("encode Worker deployment: %w", err)
	}
	cursor, err := newDeploymentCursor()
	if err != nil {
		return "", err
	}
	directory := s.workerDirectory(namespace, worker)
	historyDirectory := filepath.Join(directory, "deployments")
	if err := os.MkdirAll(historyDirectory, 0o750); err != nil {
		return "", fmt.Errorf("create Worker deployment history directory: %w", err)
	}
	if _, err := writeImmutable(filepath.Join(historyDirectory, deployment.ID+".json"), encodedDeployment); err != nil {
		return "", err
	}
	if err := writeAtomic(filepath.Join(directory, "deployment.json"), encodedDeployment); err != nil {
		return "", err
	}
	if err := writeAtomic(s.deploymentCursorPath(namespace), []byte(cursor)); err != nil {
		return "", fmt.Errorf("publish Worker deployment cursor: %w", err)
	}
	return cursor, nil
}

func (s *Store) ListVersions(_ context.Context, namespace, worker string, page, perPage int) (VersionList, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return VersionList{}, err
	}
	page, perPage = normalizePagination(page, perPage)
	lock := s.workerLock(namespace, worker)
	lock.Lock()
	defer lock.Unlock()

	summaries, err := s.listVersionSummariesLocked(namespace, worker)
	if err != nil {
		return VersionList{}, err
	}
	active, err := s.activeVersionIDsLocked(namespace, worker)
	if err != nil {
		return VersionList{}, err
	}
	records := buildVersionRecords(summaries, active, s.retention, 0)
	return VersionList{
		Versions:  paginate(records, page, perPage),
		Page:      page,
		PerPage:   perPage,
		Retention: s.retention,
		GCMode:    "report_only",
	}, nil
}

func (s *Store) ListDeployments(_ context.Context, namespace, worker string, page, perPage int) (DeploymentList, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return DeploymentList{}, err
	}
	page, perPage = normalizePagination(page, perPage)
	lock := s.workerLock(namespace, worker)
	lock.Lock()
	defer lock.Unlock()
	deployments, err := s.listDeploymentsLocked(namespace, worker)
	if err != nil {
		return DeploymentList{}, err
	}
	recent, err := s.recentVersionIDsLocked(namespace, worker)
	if err != nil {
		return DeploymentList{}, err
	}
	activeID, err := s.activeDeploymentIDLocked(namespace, worker)
	if err != nil {
		return DeploymentList{}, err
	}
	records := buildDeploymentRecords(deployments, activeID, recent)
	return DeploymentList{Deployments: paginate(records, page, perPage), Page: page, PerPage: perPage}, nil
}

func (s *Store) GetDeployment(_ context.Context, namespace, worker, deploymentID string) (DeploymentRecord, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return DeploymentRecord{}, err
	}
	if !validDeploymentID(deploymentID) {
		return DeploymentRecord{}, fmt.Errorf("invalid Worker deployment ID")
	}
	lock := s.workerLock(namespace, worker)
	lock.Lock()
	defer lock.Unlock()
	deployment, err := s.readDeploymentLocked(namespace, worker, deploymentID)
	if err != nil {
		return DeploymentRecord{}, err
	}
	recent, err := s.recentVersionIDsLocked(namespace, worker)
	if err != nil {
		return DeploymentRecord{}, err
	}
	activeID, err := s.activeDeploymentIDLocked(namespace, worker)
	if err != nil {
		return DeploymentRecord{}, err
	}
	return buildDeploymentRecords([]Deployment{deployment}, activeID, recent)[0], nil
}

func (s *Store) DeleteDeployment(_ context.Context, namespace, worker, deploymentID string) error {
	if err := validateIdentity(namespace, worker); err != nil {
		return err
	}
	if !validDeploymentID(deploymentID) {
		return fmt.Errorf("invalid Worker deployment ID")
	}
	lock := s.workerLock(namespace, worker)
	lock.Lock()
	defer lock.Unlock()
	activeID, err := s.activeDeploymentIDLocked(namespace, worker)
	if err != nil {
		return err
	}
	if activeID == deploymentID {
		return ErrActiveDeployment
	}
	path := filepath.Join(s.workerDirectory(namespace, worker), "deployments", deploymentID+".json")
	if err := os.Remove(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrNotFound
		}
		return fmt.Errorf("delete Worker deployment history: %w", err)
	}
	return syncDirectory(filepath.Dir(path))
}

func (s *Store) GetWorker(_ context.Context, namespace, worker string) (Worker, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return Worker{}, err
	}
	lock := s.workerLock(namespace, worker)
	lock.Lock()
	defer lock.Unlock()
	return s.getWorkerLocked(namespace, worker)
}

func (s *Store) WatchDeploymentCursor(ctx context.Context, namespace, after string) (string, error) {
	if !namePattern.MatchString(namespace) {
		return "", fmt.Errorf("namespace must match %s", namePattern.String())
	}
	if !validDeploymentCursor(after) {
		return "", fmt.Errorf("invalid Worker deployment cursor")
	}
	for {
		cursor, err := s.readDeploymentCursor(namespace)
		if err != nil {
			return "", err
		}
		if cursor != after {
			return cursor, nil
		}
		timer := time.NewTimer(50 * time.Millisecond)
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

func (s *Store) ClaimObject(_ context.Context, namespace, worker, className, objectID string, placement *ObjectPlacement) (DurableObjectRecord, error) {
	if err := validateObjectIdentity(namespace, worker, className, objectID); err != nil {
		return DurableObjectRecord{}, err
	}
	s.placementMu.Lock()
	defer s.placementMu.Unlock()
	lock := s.workerLock(namespace, worker)
	lock.Lock()
	defer lock.Unlock()
	active, err := s.getWorkerLocked(namespace, worker)
	if err != nil {
		return DurableObjectRecord{}, err
	}
	if !workerExportsClass(active, className) {
		return DurableObjectRecord{}, ErrObjectClassNotFound
	}
	record, err := s.readObjectLocked(namespace, worker, className, objectID)
	if err == nil {
		if record.State == ObjectStateDeleted {
			return DurableObjectRecord{}, ErrObjectDeleted
		}
		return record, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return DurableObjectRecord{}, err
	}
	if err := validateObjectPlacement(placement); err != nil {
		return DurableObjectRecord{}, ErrPlacementRequired
	}
	record = newObjectRecord(namespace, worker, className, objectID, placement, s.now())
	if err := s.writeObjectLocked(record); err != nil {
		return DurableObjectRecord{}, err
	}
	return record, nil
}

func (s *Store) GetObject(_ context.Context, namespace, worker, className, objectID string) (DurableObjectRecord, error) {
	if err := validateObjectIdentity(namespace, worker, className, objectID); err != nil {
		return DurableObjectRecord{}, err
	}
	lock := s.workerLock(namespace, worker)
	lock.Lock()
	defer lock.Unlock()
	return s.readObjectLocked(namespace, worker, className, objectID)
}

func (s *Store) ActivateObject(_ context.Context, namespace, worker, className, objectID, actorID string) (DurableObjectRecord, error) {
	if err := validateObjectIdentity(namespace, worker, className, objectID); err != nil {
		return DurableObjectRecord{}, err
	}
	if err := validateActorID(actorID); err != nil {
		return DurableObjectRecord{}, err
	}
	lock := s.workerLock(namespace, worker)
	lock.Lock()
	defer lock.Unlock()
	record, err := s.readObjectLocked(namespace, worker, className, objectID)
	if err != nil {
		return DurableObjectRecord{}, err
	}
	if record.State == ObjectStateDeleted {
		return DurableObjectRecord{}, ErrObjectDeleted
	}
	if record.ActorID != "" && record.ActorID != actorID {
		return DurableObjectRecord{}, ErrObjectConflict
	}
	if record.ActorID == actorID {
		return record, nil
	}
	record.ActorID = actorID
	if err := s.writeObjectLocked(record); err != nil {
		return DurableObjectRecord{}, err
	}
	return record, nil
}

func (s *Store) DeleteObject(_ context.Context, namespace, worker, className, objectID string) (DurableObjectRecord, error) {
	if err := validateObjectIdentity(namespace, worker, className, objectID); err != nil {
		return DurableObjectRecord{}, err
	}
	s.placementMu.Lock()
	defer s.placementMu.Unlock()
	lock := s.workerLock(namespace, worker)
	lock.Lock()
	defer lock.Unlock()
	record, err := s.readObjectLocked(namespace, worker, className, objectID)
	if errors.Is(err, ErrNotFound) {
		summaries, listErr := s.listVersionSummariesLocked(namespace, worker)
		if listErr != nil {
			return DurableObjectRecord{}, listErr
		}
		if !summariesExportClass(summaries, className) {
			return DurableObjectRecord{}, ErrObjectClassNotFound
		}
		record = newObjectRecord(namespace, worker, className, objectID, nil, s.now())
	} else if err != nil {
		return DurableObjectRecord{}, err
	}
	if record.State == ObjectStateDeleted {
		return record, nil
	}
	deletedAt := s.now()
	record.State = ObjectStateDeleted
	record.DeletedAt = &deletedAt
	if err := s.writeObjectLocked(record); err != nil {
		return DurableObjectRecord{}, err
	}
	return record, nil
}

func (s *Store) GetCellPlacementCount(ctx context.Context, cellName, cellUID string) (int64, error) {
	if err := validateCellIdentity(cellName, cellUID); err != nil {
		return 0, err
	}
	s.placementMu.RLock()
	defer s.placementMu.RUnlock()
	var count int64
	objectsMarker := string(filepath.Separator) + "objects" + string(filepath.Separator)
	err := filepath.Walk(s.root, func(current string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if info.IsDir() || filepath.Ext(current) != ".json" || !strings.Contains(current, objectsMarker) {
			return nil
		}
		encoded, err := os.ReadFile(current)
		if err != nil {
			return fmt.Errorf("read Durable Object record for placement count: %w", err)
		}
		var record DurableObjectRecord
		if err := decodeStrict(encoded, &record); err != nil {
			return fmt.Errorf("decode Durable Object record for placement count: %w", err)
		}
		if err := validateObjectRecord(record); err != nil {
			return fmt.Errorf("invalid Durable Object record for placement count: %w", err)
		}
		if record.State == ObjectStateActive && record.Placement != nil && record.Placement.CellName == cellName && record.Placement.CellUID == cellUID {
			if count == math.MaxInt64 {
				return fmt.Errorf("Cell placement counter overflow")
			}
			count++
		}
		return nil
	})
	return count, err
}

// DeleteWorker removes only the active deployment pointer. Immutable versions
// remain addressable so pinned and already-running actors can still cold-load.
func (s *Store) DeleteWorker(_ context.Context, namespace, worker string) error {
	if err := validateIdentity(namespace, worker); err != nil {
		return err
	}
	lock := s.workerLock(namespace, worker)
	lock.Lock()
	defer lock.Unlock()
	summaries, err := s.listVersionSummariesLocked(namespace, worker)
	if err != nil {
		return err
	}
	if hasDurableObjectNamespaces(summaries) {
		return ErrDurableObjectNamespaces
	}
	directory := s.workerDirectory(namespace, worker)
	if err := os.Remove(filepath.Join(directory, "deployment.json")); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrNotFound
		}
		return fmt.Errorf("delete Worker deployment: %w", err)
	}
	if err := syncDirectory(directory); err != nil {
		return err
	}
	cursor, err := newDeploymentCursor()
	if err != nil {
		return err
	}
	if err := writeAtomic(s.deploymentCursorPath(namespace), []byte(cursor)); err != nil {
		return fmt.Errorf("publish Worker deployment cursor: %w", err)
	}
	return nil
}

func (s *Store) ListWorkers(ctx context.Context, namespace string) ([]Worker, error) {
	if !namePattern.MatchString(namespace) {
		return nil, fmt.Errorf("namespace must match %s", namePattern.String())
	}
	entries, err := os.ReadDir(filepath.Join(s.root, "namespaces", namespace, "workers"))
	if errors.Is(err, os.ErrNotExist) {
		return []Worker{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("list Workers: %w", err)
	}
	workers := make([]Worker, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !namePattern.MatchString(entry.Name()) {
			return nil, fmt.Errorf("worker registry contains an invalid Worker directory %q", entry.Name())
		}
		worker, err := s.GetWorker(ctx, namespace, entry.Name())
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		workers = append(workers, worker)
	}
	sort.Slice(workers, func(i, j int) bool { return workers[i].Name < workers[j].Name })
	return workers, nil
}

func (s *Store) GetVersion(_ context.Context, namespace, worker, versionID string) (WorkerVersion, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return WorkerVersion{}, err
	}
	if !validVersionID(versionID) {
		return WorkerVersion{}, fmt.Errorf("invalid Worker version ID")
	}
	lock := s.workerLock(namespace, worker)
	lock.Lock()
	defer lock.Unlock()
	return s.readVersion(namespace, worker, versionID)
}

func (s *Store) getWorkerLocked(namespace, worker string) (Worker, error) {
	encoded, err := os.ReadFile(filepath.Join(s.workerDirectory(namespace, worker), "deployment.json"))
	if errors.Is(err, os.ErrNotExist) {
		return Worker{}, ErrNotFound
	}
	if err != nil {
		return Worker{}, fmt.Errorf("read Worker deployment: %w", err)
	}
	var deployment Deployment
	if err := decodeStrict(encoded, &deployment); err != nil {
		return Worker{}, fmt.Errorf("decode Worker deployment: %w", err)
	}
	if err := validateDeployment(deployment); err != nil || deployment.Namespace != namespace || deployment.Worker != worker {
		return Worker{}, fmt.Errorf("Worker deployment identity is invalid")
	}
	versions, err := s.readDeploymentVersionsLocked(namespace, worker, deployment)
	if err != nil {
		return Worker{}, err
	}
	result := makeWorker(namespace, worker, deployment, versions)
	cursor, err := s.readDeploymentCursor(namespace)
	if err != nil {
		return Worker{}, err
	}
	result.DeploymentCursor = cursor
	return result, nil
}

func (s *Store) requireDeployableVersionsLocked(namespace, worker string, targets []DeploymentVersion) error {
	recent, err := s.recentVersionIDsLocked(namespace, worker)
	if err != nil {
		return err
	}
	for _, target := range targets {
		if _, err := s.readVersion(namespace, worker, target.VersionID); err != nil {
			return err
		}
		if _, ok := recent[target.VersionID]; !ok {
			return ErrVersionNotDeployable
		}
	}
	return nil
}

func (s *Store) recentVersionIDsLocked(namespace, worker string) (map[string]struct{}, error) {
	summaries, err := s.listVersionSummariesLocked(namespace, worker)
	if err != nil {
		return nil, err
	}
	result := make(map[string]struct{}, min(len(summaries), s.retention))
	for index, summary := range summaries {
		if index >= s.retention {
			break
		}
		result[summary.VersionID] = struct{}{}
	}
	return result, nil
}

func (s *Store) listVersionSummariesLocked(namespace, worker string) ([]VersionSummary, error) {
	directory := filepath.Join(s.workerDirectory(namespace, worker), "versions")
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return []VersionSummary{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("list Worker versions: %w", err)
	}
	summaries := make([]VersionSummary, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		versionID := strings.TrimSuffix(entry.Name(), ".json")
		if !validVersionID(versionID) {
			return nil, fmt.Errorf("Worker version directory contains invalid entry %q", entry.Name())
		}
		version, err := s.readVersion(namespace, worker, versionID)
		if err != nil {
			return nil, err
		}
		summaries = append(summaries, summarizeVersion(version))
	}
	sort.Slice(summaries, func(i, j int) bool {
		if summaries[i].CreatedAt.Equal(summaries[j].CreatedAt) {
			return summaries[i].VersionID > summaries[j].VersionID
		}
		return summaries[i].CreatedAt.After(summaries[j].CreatedAt)
	})
	return summaries, nil
}

func (s *Store) listDeploymentsLocked(namespace, worker string) ([]Deployment, error) {
	directory := filepath.Join(s.workerDirectory(namespace, worker), "deployments")
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return []Deployment{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("list Worker deployments: %w", err)
	}
	deployments := make([]Deployment, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		deploymentID := strings.TrimSuffix(entry.Name(), ".json")
		deployment, err := s.readDeploymentLocked(namespace, worker, deploymentID)
		if err != nil {
			return nil, err
		}
		deployments = append(deployments, deployment)
	}
	sort.Slice(deployments, func(i, j int) bool {
		if deployments[i].DeployedAt.Equal(deployments[j].DeployedAt) {
			return deployments[i].ID > deployments[j].ID
		}
		return deployments[i].DeployedAt.After(deployments[j].DeployedAt)
	})
	return deployments, nil
}

func (s *Store) readDeploymentLocked(namespace, worker, deploymentID string) (Deployment, error) {
	if !validDeploymentID(deploymentID) {
		return Deployment{}, fmt.Errorf("invalid Worker deployment ID")
	}
	encoded, err := os.ReadFile(filepath.Join(s.workerDirectory(namespace, worker), "deployments", deploymentID+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return Deployment{}, ErrNotFound
	}
	if err != nil {
		return Deployment{}, fmt.Errorf("read Worker deployment history: %w", err)
	}
	var deployment Deployment
	if err := decodeStrict(encoded, &deployment); err != nil {
		return Deployment{}, fmt.Errorf("decode Worker deployment history: %w", err)
	}
	if err := validateDeployment(deployment); err != nil || deployment.Namespace != namespace || deployment.Worker != worker || deployment.ID != deploymentID {
		return Deployment{}, fmt.Errorf("Worker deployment history identity is invalid")
	}
	return deployment, nil
}

func (s *Store) activeDeploymentLocked(namespace, worker string) (Deployment, error) {
	encoded, err := os.ReadFile(filepath.Join(s.workerDirectory(namespace, worker), "deployment.json"))
	if errors.Is(err, os.ErrNotExist) {
		return Deployment{}, ErrNotFound
	}
	if err != nil {
		return Deployment{}, fmt.Errorf("read active Worker deployment: %w", err)
	}
	var deployment Deployment
	if err := decodeStrict(encoded, &deployment); err != nil {
		return Deployment{}, fmt.Errorf("decode active Worker deployment: %w", err)
	}
	if err := validateDeployment(deployment); err != nil || deployment.Namespace != namespace || deployment.Worker != worker {
		return Deployment{}, fmt.Errorf("active Worker deployment identity is invalid")
	}
	return deployment, nil
}

func (s *Store) activeDeploymentIDLocked(namespace, worker string) (string, error) {
	deployment, err := s.activeDeploymentLocked(namespace, worker)
	if errors.Is(err, ErrNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return deployment.ID, nil
}

func (s *Store) activeVersionIDsLocked(namespace, worker string) (map[string]struct{}, error) {
	deployment, err := s.activeDeploymentLocked(namespace, worker)
	if errors.Is(err, ErrNotFound) {
		return map[string]struct{}{}, nil
	}
	if err != nil {
		return nil, err
	}
	result := make(map[string]struct{}, len(deployment.Versions))
	for _, target := range deployment.Versions {
		result[target.VersionID] = struct{}{}
	}
	return result, nil
}

func (s *Store) readDeploymentVersionsLocked(namespace, worker string, deployment Deployment) ([]WorkerVersion, error) {
	versions := make([]WorkerVersion, 0, len(deployment.Versions))
	for _, target := range deployment.Versions {
		version, err := s.readVersion(namespace, worker, target.VersionID)
		if err != nil {
			return nil, err
		}
		versions = append(versions, version)
	}
	return versions, nil
}

func (s *Store) readVersion(namespace, worker, versionID string) (WorkerVersion, error) {
	encoded, err := os.ReadFile(filepath.Join(s.workerDirectory(namespace, worker), "versions", versionID+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return WorkerVersion{}, ErrNotFound
	}
	if err != nil {
		return WorkerVersion{}, fmt.Errorf("read Worker version: %w", err)
	}
	var version WorkerVersion
	if err := decodeStrict(encoded, &version); err != nil {
		return WorkerVersion{}, fmt.Errorf("decode Worker version: %w", err)
	}
	if err := verifyWorkerVersion(namespace, worker, versionID, version); err != nil {
		return WorkerVersion{}, err
	}
	return version, nil
}

func verifyWorkerVersion(namespace, worker, versionID string, version WorkerVersion) error {
	if version.VersionID != versionID || version.Content.Schema != Schema ||
		version.Content.Namespace != namespace || version.Content.Worker != worker || version.CreatedAt.IsZero() {
		return fmt.Errorf("Worker version identity is invalid")
	}
	if err := validateVersionConfiguration(version.Content.Bindings, version.Content.Exports); err != nil {
		return fmt.Errorf("Worker version configuration is invalid: %w", err)
	}
	canonical, err := json.Marshal(version.Content)
	if err != nil {
		return fmt.Errorf("encode Worker version content: %w", err)
	}
	digest := sha256.Sum256(canonical)
	wantDigest := hex.EncodeToString(digest[:])
	if version.VersionID != "v_"+wantDigest || version.Digest != "sha256:"+wantDigest {
		return fmt.Errorf("Worker version digest verification failed")
	}
	return nil
}

func prepareVersion(namespace, worker string, request PutWorkerRequest) (VersionContent, []byte, string, string, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return VersionContent{}, nil, "", "", err
	}
	if _, err := time.Parse("2006-01-02", request.CompatibilityDate); err != nil {
		return VersionContent{}, nil, "", "", fmt.Errorf("compatibility_date must use YYYY-MM-DD")
	}
	if len(request.Modules) == 0 || len(request.Modules) > MaxModules {
		return VersionContent{}, nil, "", "", fmt.Errorf("modules must contain between 1 and %d entries", MaxModules)
	}
	if !validModuleName(request.MainModule) {
		return VersionContent{}, nil, "", "", fmt.Errorf("main_module is invalid")
	}
	if _, ok := request.Modules[request.MainModule]; !ok {
		return VersionContent{}, nil, "", "", fmt.Errorf("main_module must name an uploaded module")
	}
	totalBytes := 0
	modules := make(map[string]string, len(request.Modules))
	for moduleName, source := range request.Modules {
		if !validModuleName(moduleName) {
			return VersionContent{}, nil, "", "", fmt.Errorf("module name %q is invalid", moduleName)
		}
		if !utf8.ValidString(source) {
			return VersionContent{}, nil, "", "", fmt.Errorf("module %q is not valid UTF-8", moduleName)
		}
		if len(source) == 0 || len(source) > MaxModuleBytes {
			return VersionContent{}, nil, "", "", fmt.Errorf("module %q must contain 1..%d bytes", moduleName, MaxModuleBytes)
		}
		totalBytes += len(source)
		if totalBytes > MaxTotalModuleBytes {
			return VersionContent{}, nil, "", "", fmt.Errorf("module content exceeds %d bytes", MaxTotalModuleBytes)
		}
		modules[moduleName] = source
	}
	if len(request.CompatibilityFlags) > MaxCompatibilityFlags {
		return VersionContent{}, nil, "", "", fmt.Errorf("too many compatibility_flags")
	}
	flags := append([]string(nil), request.CompatibilityFlags...)
	sort.Strings(flags)
	for index, flag := range flags {
		if !flagPattern.MatchString(flag) {
			return VersionContent{}, nil, "", "", fmt.Errorf("compatibility flag %q is invalid", flag)
		}
		if index > 0 && flags[index-1] == flag {
			return VersionContent{}, nil, "", "", fmt.Errorf("compatibility flag %q is duplicated", flag)
		}
	}
	if len(request.DurableObjects) > MaxBindings {
		return VersionContent{}, nil, "", "", fmt.Errorf("durable_objects must contain at most %d bindings", MaxBindings)
	}
	bindings := make(map[string]VersionBinding, len(request.DurableObjects))
	exports := make(map[string]VersionExport)
	for bindingName, className := range request.DurableObjects {
		if !bindingPattern.MatchString(bindingName) {
			return VersionContent{}, nil, "", "", fmt.Errorf("Durable Object binding %q is invalid", bindingName)
		}
		if !classPattern.MatchString(className) {
			return VersionContent{}, nil, "", "", fmt.Errorf("Durable Object class %q is invalid", className)
		}
		bindings[bindingName] = VersionBinding{Type: BindingTypeDurableObject, ClassName: className}
		exports[className] = VersionExport{Type: ExportTypeDurableObject, Storage: DurableObjectSQLite}
	}
	if len(exports) > MaxExports {
		return VersionContent{}, nil, "", "", fmt.Errorf("Worker exports must contain at most %d entries", MaxExports)
	}
	content := VersionContent{
		Schema:             Schema,
		Namespace:          namespace,
		Worker:             worker,
		MainModule:         request.MainModule,
		Modules:            modules,
		CompatibilityDate:  request.CompatibilityDate,
		CompatibilityFlags: flags,
		Bindings:           bindings,
		Exports:            exports,
	}
	canonical, err := json.Marshal(content)
	if err != nil {
		return VersionContent{}, nil, "", "", fmt.Errorf("encode canonical Worker version: %w", err)
	}
	digestBytes := sha256.Sum256(canonical)
	digest := hex.EncodeToString(digestBytes[:])
	return content, canonical, digest, "v_" + digest, nil
}

func hasDurableObjectNamespaces(summaries []VersionSummary) bool {
	for _, summary := range summaries {
		if len(summary.DurableObjectNamespaces) > 0 {
			return true
		}
	}
	return false
}

func durableObjectNamespaces(content VersionContent) []DurableObjectNamespace {
	result := make([]DurableObjectNamespace, 0, len(content.Exports))
	for className, export := range content.Exports {
		result = append(result, DurableObjectNamespace{
			NamespaceKey: durableObjectNamespaceKey(content.Namespace, content.Worker, className),
			ClassName:    className,
			Storage:      export.Storage,
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ClassName < result[j].ClassName })
	return result
}

func durableObjectNamespaceKey(namespace, worker, className string) string {
	digest := sha256.Sum256([]byte(namespace + "\x00" + worker + "\x00" + className))
	return "do_" + hex.EncodeToString(digest[:])
}

func newObjectRecord(namespace, worker, className, objectID string, placement *ObjectPlacement, createdAt time.Time) DurableObjectRecord {
	return DurableObjectRecord{
		Schema:     ObjectSchema,
		Namespace:  namespace,
		Worker:     worker,
		ClassName:  className,
		ObjectID:   objectID,
		Placement:  placement,
		State:      ObjectStateActive,
		Generation: 1,
		CreatedAt:  createdAt,
	}
}

func validBoundedIdentity(value string) bool {
	return value != "" && len(value) <= 128 && utf8.ValidString(value) && !strings.ContainsAny(value, "\x00\r\n")
}

func validateObjectPlacement(placement *ObjectPlacement) error {
	if placement == nil {
		return ErrPlacementRequired
	}
	if !namePattern.MatchString(placement.PoolName) || !validBoundedIdentity(placement.PoolUID) ||
		!validBoundedIdentity(placement.SnapshotResourceVersion) ||
		!digestPattern.MatchString(placement.SnapshotDigest) ||
		!namePattern.MatchString(placement.CellName) || !validBoundedIdentity(placement.CellUID) ||
		!namePattern.MatchString(placement.Datacenter) || placement.DecidedAt.IsZero() {
		return fmt.Errorf("invalid Durable Object placement")
	}
	return nil
}

func validateObjectIdentity(namespace, worker, className, objectID string) error {
	if err := validateIdentity(namespace, worker); err != nil {
		return err
	}
	if !classPattern.MatchString(className) || !objectPattern.MatchString(objectID) {
		return fmt.Errorf("invalid Durable Object identity")
	}
	return nil
}

func validateActorID(actorID string) error {
	if actorID == "" || len(actorID) > 256 || !utf8.ValidString(actorID) || strings.ContainsAny(actorID, "\x00\r\n") {
		return fmt.Errorf("invalid Actor ID")
	}
	return nil
}

func validateObjectRecord(record DurableObjectRecord) error {
	if record.Schema != ObjectSchema {
		return fmt.Errorf("invalid Durable Object record schema")
	}
	if err := validateObjectIdentity(record.Namespace, record.Worker, record.ClassName, record.ObjectID); err != nil {
		return fmt.Errorf("invalid Durable Object record identity: %w", err)
	}
	if record.Generation != 1 {
		return fmt.Errorf("invalid Durable Object record generation")
	}
	if record.CreatedAt.IsZero() {
		return fmt.Errorf("invalid Durable Object record creation time")
	}
	if record.Placement != nil {
		if err := validateObjectPlacement(record.Placement); err != nil {
			return err
		}
	} else if record.State == ObjectStateActive {
		return ErrPlacementRequired
	}
	if record.ActorID != "" {
		if err := validateActorID(record.ActorID); err != nil {
			return fmt.Errorf("invalid Durable Object record Actor ID: %w", err)
		}
	}
	switch record.State {
	case ObjectStateActive:
		if record.DeletedAt != nil {
			return fmt.Errorf("active Durable Object record has a deletion time")
		}
	case ObjectStateDeleted:
		if record.DeletedAt == nil || record.DeletedAt.IsZero() {
			return fmt.Errorf("deleted Durable Object record has no deletion time")
		}
	default:
		return fmt.Errorf("invalid Durable Object record state")
	}
	return nil
}

func workerExportsClass(worker Worker, className string) bool {
	return summariesExportClass(worker.Versions, className)
}

func summariesExportClass(versions []VersionSummary, className string) bool {
	for _, version := range versions {
		for _, item := range version.DurableObjectNamespaces {
			if item.ClassName == className && item.Storage == DurableObjectSQLite {
				return true
			}
		}
	}
	return false
}

func sameObjectIdentity(left, right DurableObjectRecord) bool {
	return left.Schema == right.Schema && left.Namespace == right.Namespace && left.Worker == right.Worker && left.ClassName == right.ClassName && left.ObjectID == right.ObjectID && left.Generation == right.Generation
}

func validateVersionConfiguration(bindings map[string]VersionBinding, exports map[string]VersionExport) error {
	if len(bindings) > MaxBindings || len(exports) > MaxExports {
		return fmt.Errorf("Worker binding or export count exceeds its limit")
	}
	referenced := make(map[string]struct{}, len(exports))
	for name, binding := range bindings {
		if !bindingPattern.MatchString(name) || binding.Type != BindingTypeDurableObject || !classPattern.MatchString(binding.ClassName) {
			return fmt.Errorf("invalid Durable Object binding %q", name)
		}
		export, ok := exports[binding.ClassName]
		if !ok || export.Type != ExportTypeDurableObject || export.Storage != DurableObjectSQLite {
			return fmt.Errorf("Durable Object binding %q references an invalid export", name)
		}
		referenced[binding.ClassName] = struct{}{}
	}
	for className, export := range exports {
		if !classPattern.MatchString(className) || export.Type != ExportTypeDurableObject || export.Storage != DurableObjectSQLite {
			return fmt.Errorf("invalid Durable Object export %q", className)
		}
		if _, ok := referenced[className]; !ok {
			return fmt.Errorf("Durable Object export %q has no binding", className)
		}
	}
	return nil
}

func validateIdentity(namespace, worker string) error {
	if !namePattern.MatchString(namespace) {
		return fmt.Errorf("namespace must match %s", namePattern.String())
	}
	if !namePattern.MatchString(worker) {
		return fmt.Errorf("Worker name must match %s", namePattern.String())
	}
	return nil
}

func validModuleName(name string) bool {
	if name == "" || len(name) > 256 || !utf8.ValidString(name) ||
		strings.ContainsRune(name, '\\') || strings.ContainsRune(name, '\x00') ||
		strings.HasPrefix(name, "/") || path.Clean(name) != name {
		return false
	}
	for _, segment := range strings.Split(name, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func validVersionID(versionID string) bool {
	if len(versionID) != 66 || !strings.HasPrefix(versionID, "v_") {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(versionID, "v_"))
	return err == nil
}

func (s *Store) workerDirectory(namespace, worker string) string {
	return filepath.Join(s.root, "namespaces", namespace, "workers", worker)
}

func (s *Store) deploymentCursorPath(namespace string) string {
	return filepath.Join(s.root, "namespaces", namespace, "deployment-cursor")
}

func (s *Store) readDeploymentCursor(namespace string) (string, error) {
	encoded, err := os.ReadFile(s.deploymentCursorPath(namespace))
	if errors.Is(err, os.ErrNotExist) {
		return InitialDeploymentCursor, nil
	}
	if err != nil {
		return "", fmt.Errorf("read Worker deployment cursor: %w", err)
	}
	cursor := string(encoded)
	if !validDeploymentCursor(cursor) {
		return "", fmt.Errorf("Worker deployment cursor is invalid")
	}
	return cursor, nil
}

func (s *Store) objectPath(namespace, worker, className, objectID string) string {
	return filepath.Join(s.workerDirectory(namespace, worker), "objects", className, objectID+".json")
}

func (s *Store) readObjectLocked(namespace, worker, className, objectID string) (DurableObjectRecord, error) {
	encoded, err := os.ReadFile(s.objectPath(namespace, worker, className, objectID))
	if errors.Is(err, os.ErrNotExist) {
		return DurableObjectRecord{}, ErrNotFound
	}
	if err != nil {
		return DurableObjectRecord{}, fmt.Errorf("read Durable Object record: %w", err)
	}
	var record DurableObjectRecord
	if err := decodeStrict(encoded, &record); err != nil {
		return DurableObjectRecord{}, fmt.Errorf("decode Durable Object record: %w", err)
	}
	if err := validateObjectRecord(record); err != nil || record.Namespace != namespace || record.Worker != worker || record.ClassName != className || record.ObjectID != objectID {
		return DurableObjectRecord{}, fmt.Errorf("invalid persisted Durable Object record")
	}
	return record, nil
}

func (s *Store) writeObjectLocked(record DurableObjectRecord) error {
	if err := validateObjectRecord(record); err != nil {
		return err
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encode Durable Object record: %w", err)
	}
	path := s.objectPath(record.Namespace, record.Worker, record.ClassName, record.ObjectID)
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return fmt.Errorf("create Durable Object directory: %w", err)
	}
	return writeAtomic(path, encoded)
}

func (s *Store) workerLock(namespace, worker string) *sync.Mutex {
	value, _ := s.locks.LoadOrStore(namespace+"\x00"+worker, &sync.Mutex{})
	return value.(*sync.Mutex)
}

func makeWorker(namespace, worker string, deployment Deployment, versions []WorkerVersion) Worker {
	summaries := make([]VersionSummary, 0, len(versions))
	for _, version := range versions {
		summaries = append(summaries, summarizeVersion(version))
	}
	return Worker{
		Schema:     Schema,
		Namespace:  namespace,
		Name:       worker,
		Deployment: deployment,
		Versions:   summaries,
	}
}

func newDeployment(namespace, worker string, request CreateDeploymentRequest, deployedAt time.Time) (Deployment, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return Deployment{}, err
	}
	if err := validateDeploymentRequest(request); err != nil {
		return Deployment{}, err
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return Deployment{}, fmt.Errorf("generate Worker deployment ID: %w", err)
	}
	return Deployment{
		ID:          "d_" + hex.EncodeToString(random),
		Schema:      Schema,
		Namespace:   namespace,
		Worker:      worker,
		Strategy:    PercentageStrategy,
		Versions:    append([]DeploymentVersion(nil), request.Versions...),
		DeployedAt:  deployedAt,
		Source:      "api",
		Annotations: request.Annotations,
	}, nil
}

func validateDeploymentRequest(request CreateDeploymentRequest) error {
	if request.Strategy != PercentageStrategy {
		return fmt.Errorf("strategy must be %q", PercentageStrategy)
	}
	if len(request.Versions) < 1 || len(request.Versions) > 2 {
		return fmt.Errorf("deployment must contain one or two versions")
	}
	if !utf8.ValidString(request.Annotations.Message) || len(request.Annotations.Message) > MaxDeploymentMessageBytes {
		return fmt.Errorf("workers/message must be valid UTF-8 and at most %d bytes", MaxDeploymentMessageBytes)
	}
	if request.Annotations.TriggeredBy != "" && !flagPattern.MatchString(request.Annotations.TriggeredBy) {
		return fmt.Errorf("workers/triggered_by is invalid")
	}
	if request.ExpectedDeploymentID != nil && *request.ExpectedDeploymentID != "" && !validDeploymentID(*request.ExpectedDeploymentID) {
		return fmt.Errorf("expected_deployment_id is invalid")
	}
	totalBasisPoints := 0
	seen := make(map[string]struct{}, len(request.Versions))
	for _, target := range request.Versions {
		if !validVersionID(target.VersionID) {
			return fmt.Errorf("deployment contains an invalid Worker version ID")
		}
		if _, exists := seen[target.VersionID]; exists {
			return fmt.Errorf("deployment contains a duplicate Worker version ID")
		}
		seen[target.VersionID] = struct{}{}
		scaled := target.Percentage * 100
		basisPoints := int(math.Round(scaled))
		if math.IsNaN(target.Percentage) || math.IsInf(target.Percentage, 0) || basisPoints < 1 || basisPoints > 10_000 || math.Abs(scaled-float64(basisPoints)) > 1e-9 {
			return fmt.Errorf("deployment percentages must use 0.01%% precision and be between 0.01 and 100")
		}
		totalBasisPoints += basisPoints
	}
	if totalBasisPoints != 10_000 {
		return fmt.Errorf("deployment percentages must sum to 100")
	}
	return nil
}

func validateDeployment(deployment Deployment) error {
	if deployment.Schema != Schema || !validDeploymentID(deployment.ID) || deployment.DeployedAt.IsZero() || deployment.Source != "api" {
		return fmt.Errorf("invalid Worker deployment identity")
	}
	return validateDeploymentRequest(CreateDeploymentRequest{
		Strategy:    deployment.Strategy,
		Versions:    deployment.Versions,
		Annotations: deployment.Annotations,
	})
}

func validDeploymentID(deploymentID string) bool {
	if len(deploymentID) != 34 || !strings.HasPrefix(deploymentID, "d_") {
		return false
	}
	_, err := hex.DecodeString(deploymentID[2:])
	return err == nil
}

func writeImmutable(destination string, content []byte) (bool, error) {
	directory := filepath.Dir(destination)
	temporary, err := os.CreateTemp(directory, ".version-*")
	if err != nil {
		return false, fmt.Errorf("create temporary Worker version: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o640); err != nil {
		temporary.Close()
		return false, fmt.Errorf("set Worker version permissions: %w", err)
	}
	if _, err := temporary.Write(content); err != nil {
		temporary.Close()
		return false, fmt.Errorf("write Worker version: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return false, fmt.Errorf("sync Worker version: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return false, fmt.Errorf("close Worker version: %w", err)
	}
	if err := os.Link(temporaryName, destination); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return false, fmt.Errorf("publish immutable Worker version: %w", err)
		}
		// The caller reads the existing file and verifies its content-addressed
		// digest before updating the deployment pointer.
		return false, nil
	}
	if err := syncDirectory(directory); err != nil {
		return false, err
	}
	return true, nil
}

func writeAtomic(destination string, content []byte) error {
	directory := filepath.Dir(destination)
	temporary, err := os.CreateTemp(directory, ".deployment-*")
	if err != nil {
		return fmt.Errorf("create temporary Worker deployment: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o640); err != nil {
		temporary.Close()
		return fmt.Errorf("set Worker deployment permissions: %w", err)
	}
	if _, err := temporary.Write(content); err != nil {
		temporary.Close()
		return fmt.Errorf("write Worker deployment: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync Worker deployment: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close Worker deployment: %w", err)
	}
	if err := os.Rename(temporaryName, destination); err != nil {
		return fmt.Errorf("publish Worker deployment: %w", err)
	}
	return syncDirectory(directory)
}

func syncDirectory(directory string) error {
	handle, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("open Worker registry directory for sync: %w", err)
	}
	defer handle.Close()
	if err := handle.Sync(); err != nil {
		return fmt.Errorf("sync Worker registry directory: %w", err)
	}
	return nil
}

func decodeStrict(encoded []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("unexpected trailing JSON value")
		}
		return fmt.Errorf("unexpected trailing data: %w", err)
	}
	return nil
}
