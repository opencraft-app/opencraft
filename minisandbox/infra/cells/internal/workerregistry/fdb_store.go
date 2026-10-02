//go:build fdb

package workerregistry

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/apple/foundationdb/bindings/go/src/fdb"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
)

const fdbAPIVersion = 730

type FDBMetadataConfig struct {
	ClusterFile        string
	ConnectionString   string
	KeyPrefix          string
	TransactionTimeout time.Duration
}

type FDBMetadataStore struct {
	database  fdb.Database
	root      tuple.Tuple
	timeoutMS int64
}

func NewFDBMetadataStore(config FDBMetadataConfig) (*FDBMetadataStore, error) {
	if config.ClusterFile != "" && config.ConnectionString != "" {
		return nil, fmt.Errorf("configure either FDB cluster file or connection string, not both")
	}
	fdb.MustAPIVersion(fdbAPIVersion)
	var (
		database fdb.Database
		err      error
	)
	if config.ConnectionString != "" {
		database, err = fdb.OpenWithConnectionString(config.ConnectionString)
	} else {
		database, err = fdb.OpenDatabase(config.ClusterFile)
	}
	if err != nil {
		return nil, fmt.Errorf("open FoundationDB: %w", err)
	}
	if config.TransactionTimeout <= 0 {
		config.TransactionTimeout = 5 * time.Second
	}
	return &FDBMetadataStore{
		database:  database,
		root:      tuple.Tuple{"rivet-worker-registry", int64(5), config.KeyPrefix},
		timeoutMS: config.TransactionTimeout.Milliseconds(),
	}, nil
}

func (s *FDBMetadataStore) Check(ctx context.Context) error {
	return s.read(ctx, func(transaction fdb.ReadTransaction) error {
		_, err := transaction.Get(s.key("health")).Get()
		return err
	})
}

func (s *FDBMetadataStore) Publish(ctx context.Context, worker Worker, summary VersionSummary, retention int) (Worker, bool, error) {
	if err := validatePersistedWorker(worker); err != nil {
		return Worker{}, false, err
	}
	if retention < 1 || retention > MaxVersionRetention {
		return Worker{}, false, fmt.Errorf("Worker version retention must be between 1 and %d", MaxVersionRetention)
	}
	cursor, err := newDeploymentCursor()
	if err != nil {
		return Worker{}, false, err
	}
	created := false
	err = s.write(ctx, func(transaction fdb.Transaction) error {
		created = false
		versionKey := s.versionKey(worker.Namespace, worker.Name, summary.VersionID)
		existing, err := transaction.Get(versionKey).Get()
		if err != nil {
			return err
		}
		if existing == nil {
			created = true
			encodedSummary, err := json.Marshal(summary)
			if err != nil {
				return err
			}
			transaction.Set(versionKey, encodedSummary)
			transaction.Set(s.versionOrderKey(worker.Namespace, worker.Name, summary.CreatedAt, summary.VersionID), encodedSummary)
		} else {
			var persisted VersionSummary
			if err := decodeStrict(existing, &persisted); err != nil {
				return err
			}
			if !sameVersionIdentity(persisted, summary) {
				return ErrImmutableConflict
			}
			summary = persisted
			for index := range worker.Versions {
				if worker.Versions[index].VersionID == persisted.VersionID {
					worker.Versions[index] = persisted
				}
			}
		}
		if err := s.writeDurableObjectNamespaceInventory(transaction, worker.Namespace, worker.Name, summary); err != nil {
			return err
		}
		deployable, err := s.readRecentVersionIDs(transaction, worker.Namespace, worker.Name, retention)
		if err != nil {
			return err
		}
		if _, ok := deployable[summary.VersionID]; !ok {
			return ErrVersionNotDeployable
		}
		encodedWorker, err := json.Marshal(worker)
		if err != nil {
			return err
		}
		if err := s.writeDeploymentHistory(transaction, worker.Deployment); err != nil {
			return err
		}
		transaction.Set(s.deploymentKey(worker.Namespace, worker.Name), encodedWorker)
		transaction.Set(s.deploymentCursorKey(worker.Namespace), []byte(cursor))
		return nil
	})
	if err != nil {
		return Worker{}, false, err
	}
	worker.DeploymentCursor = cursor
	return worker, created, nil
}

func (s *FDBMetadataStore) PublishVersion(ctx context.Context, namespace, worker string, summary VersionSummary) (VersionSummary, bool, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return VersionSummary{}, false, err
	}
	if err := validateVersionSummary(summary); err != nil {
		return VersionSummary{}, false, err
	}
	created := false
	err := s.write(ctx, func(transaction fdb.Transaction) error {
		created = false
		key := s.versionKey(namespace, worker, summary.VersionID)
		existing, err := transaction.Get(key).Get()
		if err != nil {
			return err
		}
		if existing == nil {
			created = true
			encoded, err := json.Marshal(summary)
			if err != nil {
				return err
			}
			transaction.Set(key, encoded)
			transaction.Set(s.versionOrderKey(namespace, worker, summary.CreatedAt, summary.VersionID), encoded)
			return s.writeDurableObjectNamespaceInventory(transaction, namespace, worker, summary)
		}
		var persisted VersionSummary
		if err := decodeStrict(existing, &persisted); err != nil {
			return err
		}
		if !sameVersionIdentity(persisted, summary) {
			return ErrImmutableConflict
		}
		summary = persisted
		return s.writeDurableObjectNamespaceInventory(transaction, namespace, worker, summary)
	})
	return summary, created, err
}

func (s *FDBMetadataStore) PublishDeployment(ctx context.Context, deployment Deployment, retention int, expected *string) (Worker, error) {
	if err := validateDeployment(deployment); err != nil {
		return Worker{}, err
	}
	if err := validateIdentity(deployment.Namespace, deployment.Worker); err != nil {
		return Worker{}, err
	}
	if retention < 1 || retention > MaxVersionRetention {
		return Worker{}, fmt.Errorf("Worker version retention must be between 1 and %d", MaxVersionRetention)
	}
	cursor, err := newDeploymentCursor()
	if err != nil {
		return Worker{}, err
	}
	var worker Worker
	err = s.write(ctx, func(transaction fdb.Transaction) error {
		if expected != nil {
			active, err := transaction.Get(s.deploymentKey(deployment.Namespace, deployment.Worker)).Get()
			if err != nil {
				return err
			}
			if active == nil {
				if *expected != "" {
					return ErrDeploymentConflict
				}
			} else {
				var current Worker
				if err := decodeStrict(active, &current); err != nil {
					return err
				}
				if err := validatePersistedWorker(current); err != nil {
					return err
				}
				if current.Deployment.ID != *expected {
					return ErrDeploymentConflict
				}
			}
		}
		deployable, err := s.readRecentVersionIDs(transaction, deployment.Namespace, deployment.Worker, retention)
		if err != nil {
			return err
		}
		summaries := make([]VersionSummary, 0, len(deployment.Versions))
		for _, target := range deployment.Versions {
			encoded, err := transaction.Get(s.versionKey(deployment.Namespace, deployment.Worker, target.VersionID)).Get()
			if err != nil {
				return err
			}
			if encoded == nil {
				return ErrNotFound
			}
			var summary VersionSummary
			if err := decodeStrict(encoded, &summary); err != nil {
				return err
			}
			if err := validateVersionSummary(summary); err != nil || summary.VersionID != target.VersionID {
				return fmt.Errorf("invalid Worker version summary in FDB")
			}
			if _, ok := deployable[target.VersionID]; !ok {
				return ErrVersionNotDeployable
			}
			summaries = append(summaries, summary)
		}
		worker = Worker{
			Schema:     Schema,
			Namespace:  deployment.Namespace,
			Name:       deployment.Worker,
			Deployment: deployment,
			Versions:   summaries,
		}
		encoded, err := json.Marshal(worker)
		if err != nil {
			return err
		}
		if err := s.writeDeploymentHistory(transaction, deployment); err != nil {
			return err
		}
		transaction.Set(s.deploymentKey(worker.Namespace, worker.Name), encoded)
		transaction.Set(s.deploymentCursorKey(worker.Namespace), []byte(cursor))
		return nil
	})
	if err == nil {
		worker.DeploymentCursor = cursor
	}
	return worker, err
}

func (s *FDBMetadataStore) GetWorker(ctx context.Context, namespace, worker string) (Worker, error) {
	var result Worker
	err := s.read(ctx, func(transaction fdb.ReadTransaction) error {
		workerFuture := transaction.Get(s.deploymentKey(namespace, worker))
		cursorFuture := transaction.Get(s.deploymentCursorKey(namespace))
		encoded, err := workerFuture.Get()
		if err != nil {
			return err
		}
		if encoded == nil {
			return ErrNotFound
		}
		result = Worker{}
		if err := decodeStrict(encoded, &result); err != nil {
			return err
		}
		if err := validatePersistedWorker(result); err != nil {
			return err
		}
		encodedCursor, err := cursorFuture.Get()
		if err != nil {
			return err
		}
		result.DeploymentCursor, err = decodeDeploymentCursor(encodedCursor)
		return err
	})
	return result, err
}

func (s *FDBMetadataStore) WatchDeploymentCursor(ctx context.Context, namespace, after string) (string, error) {
	if !namePattern.MatchString(namespace) {
		return "", fmt.Errorf("namespace must match %s", namePattern.String())
	}
	if !validDeploymentCursor(after) {
		return "", fmt.Errorf("invalid Worker deployment cursor")
	}
	key := s.deploymentCursorKey(namespace)
	for {
		if err := ctx.Err(); err != nil {
			return after, err
		}
		var cursor string
		var watch fdb.FutureNil
		_, err := s.database.Transact(func(transaction fdb.Transaction) (interface{}, error) {
			// A transaction timeout also bounds watches created by that
			// transaction. Keep it beyond the Registry's 25-second heartbeat;
			// ordinary metadata transactions retain the shorter configured
			// timeout through s.read/s.write.
			watchTimeoutMS := max(s.timeoutMS, (30 * time.Second).Milliseconds())
			if err := transaction.Options().SetTimeout(watchTimeoutMS); err != nil {
				return nil, err
			}
			encoded, err := transaction.Get(key).Get()
			if err != nil {
				return nil, err
			}
			cursor, err = decodeDeploymentCursor(encoded)
			if err != nil || cursor != after {
				return nil, err
			}
			watch = transaction.Watch(key)
			return nil, nil
		})
		if err != nil {
			return "", err
		}
		if cursor != after {
			return cursor, nil
		}
		ready := make(chan error, 1)
		go func() { ready <- watch.Get() }()
		select {
		case <-ctx.Done():
			watch.Cancel()
			<-ready
			return after, ctx.Err()
		case err := <-ready:
			if err != nil {
				return "", err
			}
		}
	}
}

func (s *FDBMetadataStore) ClaimObject(ctx context.Context, candidate DurableObjectRecord) (DurableObjectRecord, error) {
	if err := validateObjectIdentity(candidate.Namespace, candidate.Worker, candidate.ClassName, candidate.ObjectID); err != nil ||
		candidate.Schema != ObjectSchema || candidate.Generation != 1 || candidate.CreatedAt.IsZero() ||
		candidate.State != ObjectStateActive || candidate.ActorID != "" {
		return DurableObjectRecord{}, fmt.Errorf("invalid Durable Object claim")
	}
	result := candidate
	err := s.write(ctx, func(transaction fdb.Transaction) error {
		workerFuture := transaction.Get(s.deploymentKey(candidate.Namespace, candidate.Worker))
		key := s.objectKey(candidate.Namespace, candidate.Worker, candidate.ClassName, candidate.ObjectID)
		objectFuture := transaction.Get(key)
		encodedWorker, err := workerFuture.Get()
		if err != nil {
			return err
		}
		if encodedWorker == nil {
			return ErrNotFound
		}
		var worker Worker
		if err := decodeStrict(encodedWorker, &worker); err != nil {
			return err
		}
		if err := validatePersistedWorker(worker); err != nil {
			return err
		}
		if !workerExportsClass(worker, candidate.ClassName) {
			return ErrObjectClassNotFound
		}
		existing, err := objectFuture.Get()
		if err != nil {
			return err
		}
		if existing == nil {
			if err := validateObjectPlacement(candidate.Placement); err != nil {
				return ErrPlacementRequired
			}
			encoded, err := json.Marshal(candidate)
			if err != nil {
				return err
			}
			transaction.Set(key, encoded)
			transaction.Add(s.placementCountKey(candidate.Placement.CellName, candidate.Placement.CellUID, placementCountShard(candidate.Namespace, candidate.Worker, candidate.ClassName, candidate.ObjectID)), encodePlacementCountDelta(1))
			result = candidate
			return nil
		}
		result = DurableObjectRecord{}
		if err := decodeStrict(existing, &result); err != nil {
			return err
		}
		if err := validateObjectRecord(result); err != nil {
			return fmt.Errorf("invalid Durable Object record in FDB: %w", err)
		}
		if !sameObjectIdentity(result, candidate) {
			return fmt.Errorf("Durable Object record identity mismatch in FDB")
		}
		if result.State == ObjectStateDeleted {
			return ErrObjectDeleted
		}
		return nil
	})
	return result, err
}

func (s *FDBMetadataStore) GetObject(ctx context.Context, namespace, worker, className, objectID string) (DurableObjectRecord, error) {
	if err := validateObjectIdentity(namespace, worker, className, objectID); err != nil {
		return DurableObjectRecord{}, err
	}
	var result DurableObjectRecord
	err := s.read(ctx, func(transaction fdb.ReadTransaction) error {
		encoded, err := transaction.Get(s.objectKey(namespace, worker, className, objectID)).Get()
		if err != nil {
			return err
		}
		if encoded == nil {
			return ErrNotFound
		}
		if err := decodeStrict(encoded, &result); err != nil {
			return err
		}
		return validateObjectRecord(result)
	})
	return result, err
}

func (s *FDBMetadataStore) ActivateObject(ctx context.Context, namespace, worker, className, objectID, actorID string) (DurableObjectRecord, error) {
	if err := validateObjectIdentity(namespace, worker, className, objectID); err != nil {
		return DurableObjectRecord{}, err
	}
	if err := validateActorID(actorID); err != nil {
		return DurableObjectRecord{}, err
	}
	var result DurableObjectRecord
	err := s.write(ctx, func(transaction fdb.Transaction) error {
		key := s.objectKey(namespace, worker, className, objectID)
		encoded, err := transaction.Get(key).Get()
		if err != nil {
			return err
		}
		if encoded == nil {
			return ErrNotFound
		}
		result = DurableObjectRecord{}
		if err := decodeStrict(encoded, &result); err != nil {
			return err
		}
		if err := validateObjectRecord(result); err != nil {
			return fmt.Errorf("invalid Durable Object record in FDB: %w", err)
		}
		if result.Namespace != namespace || result.Worker != worker || result.ClassName != className || result.ObjectID != objectID {
			return fmt.Errorf("Durable Object record identity mismatch in FDB")
		}
		if result.State == ObjectStateDeleted {
			return ErrObjectDeleted
		}
		if result.ActorID != "" && result.ActorID != actorID {
			return ErrObjectConflict
		}
		if result.ActorID == actorID {
			return nil
		}
		result.ActorID = actorID
		updated, err := json.Marshal(result)
		if err != nil {
			return err
		}
		transaction.Set(key, updated)
		return nil
	})
	return result, err
}

func (s *FDBMetadataStore) DeleteObject(ctx context.Context, tombstone DurableObjectRecord) (DurableObjectRecord, error) {
	if err := validateObjectRecord(tombstone); err != nil || tombstone.State != ObjectStateDeleted {
		return DurableObjectRecord{}, fmt.Errorf("invalid Durable Object tombstone")
	}
	result := tombstone
	err := s.write(ctx, func(transaction fdb.Transaction) error {
		key := s.objectKey(tombstone.Namespace, tombstone.Worker, tombstone.ClassName, tombstone.ObjectID)
		existing, err := transaction.Get(key).Get()
		if err != nil {
			return err
		}
		if existing == nil {
			namespaceKey := durableObjectNamespaceKey(tombstone.Namespace, tombstone.Worker, tombstone.ClassName)
			inventory, err := transaction.Get(s.durableObjectNamespaceKey(tombstone.Namespace, tombstone.Worker, namespaceKey)).Get()
			if err != nil {
				return err
			}
			if inventory == nil {
				return ErrObjectClassNotFound
			}
			encoded, err := json.Marshal(tombstone)
			if err != nil {
				return err
			}
			transaction.Set(key, encoded)
			result = tombstone
			return nil
		}
		result = DurableObjectRecord{}
		if err := decodeStrict(existing, &result); err != nil {
			return err
		}
		if err := validateObjectRecord(result); err != nil {
			return fmt.Errorf("invalid Durable Object record in FDB: %w", err)
		}
		if !sameObjectIdentity(result, tombstone) {
			return fmt.Errorf("Durable Object record identity mismatch in FDB")
		}
		if result.State == ObjectStateDeleted {
			return nil
		}
		if err := validateObjectPlacement(result.Placement); err != nil {
			return fmt.Errorf("active Durable Object has invalid placement: %w", err)
		}
		counterKey := s.placementCountKey(result.Placement.CellName, result.Placement.CellUID, placementCountShard(result.Namespace, result.Worker, result.ClassName, result.ObjectID))
		encodedCount, err := transaction.Get(counterKey).Get()
		if err != nil {
			return err
		}
		count, err := decodePlacementCount(encodedCount)
		if err != nil {
			return fmt.Errorf("read Cell placement counter: %w", err)
		}
		if count == 0 {
			return fmt.Errorf("Cell placement counter underflow")
		}
		result.State = ObjectStateDeleted
		result.DeletedAt = tombstone.DeletedAt
		updated, err := json.Marshal(result)
		if err != nil {
			return err
		}
		transaction.Set(key, updated)
		transaction.Set(counterKey, encodePlacementCountDelta(count-1))
		return nil
	})
	return result, err
}

func (s *FDBMetadataStore) GetCellPlacementCount(ctx context.Context, cellName, cellUID string) (int64, error) {
	if err := validateCellIdentity(cellName, cellUID); err != nil {
		return 0, err
	}
	var total int64
	err := s.read(ctx, func(transaction fdb.ReadTransaction) error {
		futures := make([]fdb.FutureByteSlice, CellPlacementCountShards)
		for shard := range futures {
			futures[shard] = transaction.Get(s.placementCountKey(cellName, cellUID, shard))
		}
		total = 0
		for _, future := range futures {
			encoded, err := future.Get()
			if err != nil {
				return err
			}
			if encoded == nil {
				continue
			}
			value, err := decodePlacementCount(encoded)
			if err != nil {
				return err
			}
			total, err = addPlacementCounts(total, value)
			if err != nil {
				return err
			}
		}
		return nil
	})
	return total, err
}

func (s *FDBMetadataStore) DeleteWorker(ctx context.Context, namespace, worker string) error {
	cursor, err := newDeploymentCursor()
	if err != nil {
		return err
	}
	return s.write(ctx, func(transaction fdb.Transaction) error {
		key := s.deploymentKey(namespace, worker)
		existing, err := transaction.Get(key).Get()
		if err != nil {
			return err
		}
		if existing == nil {
			return ErrNotFound
		}
		inventoryRange, err := fdb.PrefixRange(s.durableObjectNamespacePrefix(namespace, worker))
		if err != nil {
			return err
		}
		inventory, err := transaction.GetRange(inventoryRange, fdb.RangeOptions{Limit: 1}).GetSliceWithError()
		if err != nil {
			return err
		}
		if len(inventory) != 0 {
			return ErrDurableObjectNamespaces
		}
		transaction.Clear(key)
		transaction.Set(s.deploymentCursorKey(namespace), []byte(cursor))
		return nil
	})
}

func (s *FDBMetadataStore) ListWorkers(ctx context.Context, namespace string) ([]Worker, error) {
	workers := []Worker{}
	err := s.read(ctx, func(transaction fdb.ReadTransaction) error {
		cursorFuture := transaction.Get(s.deploymentCursorKey(namespace))
		keyRange, err := fdb.PrefixRange(s.deploymentPrefix(namespace))
		if err != nil {
			return err
		}
		pairs, err := transaction.GetRange(keyRange, fdb.RangeOptions{}).GetSliceWithError()
		if err != nil {
			return err
		}
		encodedCursor, err := cursorFuture.Get()
		if err != nil {
			return err
		}
		cursor, err := decodeDeploymentCursor(encodedCursor)
		if err != nil {
			return err
		}
		workers = make([]Worker, 0, len(pairs))
		for _, pair := range pairs {
			var worker Worker
			if err := decodeStrict(pair.Value, &worker); err != nil {
				return err
			}
			if err := validatePersistedWorker(worker); err != nil || worker.Namespace != namespace {
				return fmt.Errorf("invalid Worker deployment in FDB namespace index")
			}
			worker.DeploymentCursor = cursor
			workers = append(workers, worker)
		}
		return nil
	})
	return workers, err
}

func (s *FDBMetadataStore) GetVersionSummary(ctx context.Context, namespace, worker, versionID string) (VersionSummary, error) {
	var summary VersionSummary
	err := s.read(ctx, func(transaction fdb.ReadTransaction) error {
		encoded, err := transaction.Get(s.versionKey(namespace, worker, versionID)).Get()
		if err != nil {
			return err
		}
		if encoded == nil {
			return ErrNotFound
		}
		if err := decodeStrict(encoded, &summary); err != nil {
			return err
		}
		if err := validateVersionSummary(summary); err != nil || summary.VersionID != versionID {
			return fmt.Errorf("invalid Worker version summary in FDB")
		}
		return nil
	})
	return summary, err
}

func (s *FDBMetadataStore) ListVersionSummaries(ctx context.Context, namespace, worker string, page, perPage int) ([]VersionSummary, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return nil, err
	}
	page, perPage = normalizePagination(page, perPage)
	var summaries []VersionSummary
	err := s.read(ctx, func(transaction fdb.ReadTransaction) error {
		keyRange, err := fdb.PrefixRange(s.versionOrderPrefix(namespace, worker))
		if err != nil {
			return err
		}
		pairs, err := transaction.GetRange(keyRange, fdb.RangeOptions{Limit: page * perPage, Reverse: true}).GetSliceWithError()
		if err != nil {
			return err
		}
		summaries = make([]VersionSummary, 0, len(pairs))
		for _, pair := range pairs {
			var summary VersionSummary
			if err := decodeStrict(pair.Value, &summary); err != nil {
				return err
			}
			if err := validateVersionSummary(summary); err != nil {
				return err
			}
			summaries = append(summaries, summary)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return paginate(summaries, page, perPage), nil
}

func (s *FDBMetadataStore) ListDeployments(ctx context.Context, namespace, worker string, page, perPage int) ([]Deployment, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return nil, err
	}
	page, perPage = normalizePagination(page, perPage)
	var deployments []Deployment
	err := s.read(ctx, func(transaction fdb.ReadTransaction) error {
		keyRange, err := fdb.PrefixRange(s.deploymentOrderPrefix(namespace, worker))
		if err != nil {
			return err
		}
		pairs, err := transaction.GetRange(keyRange, fdb.RangeOptions{Limit: page * perPage, Reverse: true}).GetSliceWithError()
		if err != nil {
			return err
		}
		deployments = make([]Deployment, 0, len(pairs))
		for _, pair := range pairs {
			var deployment Deployment
			if err := decodeStrict(pair.Value, &deployment); err != nil {
				return err
			}
			if err := validateDeployment(deployment); err != nil || deployment.Namespace != namespace || deployment.Worker != worker {
				return fmt.Errorf("invalid Worker deployment history in FDB")
			}
			deployments = append(deployments, deployment)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return paginate(deployments, page, perPage), nil
}

func (s *FDBMetadataStore) GetDeployment(ctx context.Context, namespace, worker, deploymentID string) (Deployment, error) {
	if err := validateIdentity(namespace, worker); err != nil {
		return Deployment{}, err
	}
	if !validDeploymentID(deploymentID) {
		return Deployment{}, fmt.Errorf("invalid Worker deployment ID")
	}
	var deployment Deployment
	err := s.read(ctx, func(transaction fdb.ReadTransaction) error {
		encoded, err := transaction.Get(s.deploymentHistoryKey(namespace, worker, deploymentID)).Get()
		if err != nil {
			return err
		}
		if encoded == nil {
			return ErrNotFound
		}
		if err := decodeStrict(encoded, &deployment); err != nil {
			return err
		}
		if err := validateDeployment(deployment); err != nil || deployment.Namespace != namespace || deployment.Worker != worker || deployment.ID != deploymentID {
			return fmt.Errorf("invalid Worker deployment history in FDB")
		}
		return nil
	})
	return deployment, err
}

func (s *FDBMetadataStore) DeleteDeployment(ctx context.Context, namespace, worker, deploymentID string) error {
	if err := validateIdentity(namespace, worker); err != nil {
		return err
	}
	if !validDeploymentID(deploymentID) {
		return fmt.Errorf("invalid Worker deployment ID")
	}
	return s.write(ctx, func(transaction fdb.Transaction) error {
		active, err := transaction.Get(s.deploymentKey(namespace, worker)).Get()
		if err != nil {
			return err
		}
		if active != nil {
			var current Worker
			if err := decodeStrict(active, &current); err != nil {
				return err
			}
			if err := validatePersistedWorker(current); err != nil {
				return err
			}
			if current.Deployment.ID == deploymentID {
				return ErrActiveDeployment
			}
		}
		historyKey := s.deploymentHistoryKey(namespace, worker, deploymentID)
		encoded, err := transaction.Get(historyKey).Get()
		if err != nil {
			return err
		}
		if encoded == nil {
			return ErrNotFound
		}
		var deployment Deployment
		if err := decodeStrict(encoded, &deployment); err != nil {
			return err
		}
		if err := validateDeployment(deployment); err != nil || deployment.ID != deploymentID || deployment.Namespace != namespace || deployment.Worker != worker {
			return fmt.Errorf("invalid Worker deployment history in FDB")
		}
		transaction.Clear(historyKey)
		transaction.Clear(s.deploymentOrderKey(namespace, worker, deployment.DeployedAt, deployment.ID))
		return nil
	})
}

func (s *FDBMetadataStore) readRecentVersionIDs(transaction fdb.ReadTransaction, namespace, worker string, retention int) (map[string]struct{}, error) {
	keyRange, err := fdb.PrefixRange(s.versionOrderPrefix(namespace, worker))
	if err != nil {
		return nil, err
	}
	pairs, err := transaction.GetRange(keyRange, fdb.RangeOptions{Limit: retention, Reverse: true}).GetSliceWithError()
	if err != nil {
		return nil, err
	}
	result := make(map[string]struct{}, len(pairs))
	for _, pair := range pairs {
		var summary VersionSummary
		if err := decodeStrict(pair.Value, &summary); err != nil {
			return nil, err
		}
		if err := validateVersionSummary(summary); err != nil {
			return nil, err
		}
		result[summary.VersionID] = struct{}{}
	}
	return result, nil
}

func (s *FDBMetadataStore) writeDeploymentHistory(transaction fdb.Transaction, deployment Deployment) error {
	encoded, err := json.Marshal(deployment)
	if err != nil {
		return err
	}
	key := s.deploymentHistoryKey(deployment.Namespace, deployment.Worker, deployment.ID)
	existing, err := transaction.Get(key).Get()
	if err != nil {
		return err
	}
	if existing != nil && !bytes.Equal(existing, encoded) {
		return ErrImmutableConflict
	}
	transaction.Set(key, encoded)
	transaction.Set(s.deploymentOrderKey(deployment.Namespace, deployment.Worker, deployment.DeployedAt, deployment.ID), encoded)
	return nil
}

func (s *FDBMetadataStore) writeDurableObjectNamespaceInventory(transaction fdb.Transaction, namespace, worker string, summary VersionSummary) error {
	for _, item := range summary.DurableObjectNamespaces {
		if item.NamespaceKey != durableObjectNamespaceKey(namespace, worker, item.ClassName) {
			return fmt.Errorf("Durable Object namespace inventory identity is invalid")
		}
		encoded, err := json.Marshal(item)
		if err != nil {
			return err
		}
		key := s.durableObjectNamespaceKey(namespace, worker, item.NamespaceKey)
		existing, err := transaction.Get(key).Get()
		if err != nil {
			return err
		}
		if existing != nil && !bytes.Equal(existing, encoded) {
			return ErrImmutableConflict
		}
		transaction.Set(key, encoded)
	}
	return nil
}

func (s *FDBMetadataStore) read(ctx context.Context, operation func(fdb.ReadTransaction) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err := s.database.ReadTransact(func(transaction fdb.ReadTransaction) (interface{}, error) {
		if err := transaction.Options().SetTimeout(s.timeoutMS); err != nil {
			return nil, err
		}
		return nil, operation(transaction)
	})
	if err != nil {
		return err
	}
	return ctx.Err()
}

func (s *FDBMetadataStore) write(ctx context.Context, operation func(fdb.Transaction) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err := s.database.Transact(func(transaction fdb.Transaction) (interface{}, error) {
		if err := transaction.Options().SetTimeout(s.timeoutMS); err != nil {
			return nil, err
		}
		return nil, operation(transaction)
	})
	if err != nil {
		return err
	}
	return ctx.Err()
}

func (s *FDBMetadataStore) key(parts ...tuple.TupleElement) fdb.Key {
	return fdb.Key(append(tuple.Tuple(s.root).Pack(), tuple.Tuple(parts).Pack()...))
}

func (s *FDBMetadataStore) deploymentKey(namespace, worker string) fdb.Key {
	return s.key("deployment", namespace, worker)
}

func (s *FDBMetadataStore) deploymentCursorKey(namespace string) fdb.Key {
	return s.key("deployment-cursor", namespace)
}

func (s *FDBMetadataStore) deploymentPrefix(namespace string) []byte {
	return s.key("deployment", namespace)
}

func (s *FDBMetadataStore) versionKey(namespace, worker, versionID string) fdb.Key {
	return s.key("version", namespace, worker, versionID)
}

func (s *FDBMetadataStore) durableObjectNamespacePrefix(namespace, worker string) []byte {
	return s.key("durable-object-namespace", namespace, worker)
}

func (s *FDBMetadataStore) durableObjectNamespaceKey(namespace, worker, namespaceKey string) fdb.Key {
	return s.key("durable-object-namespace", namespace, worker, namespaceKey)
}

func (s *FDBMetadataStore) objectKey(namespace, worker, className, objectID string) fdb.Key {
	return s.key("durable-object", namespace, worker, className, objectID)
}

func (s *FDBMetadataStore) placementCountKey(cellName, cellUID string, shard int) fdb.Key {
	return s.key("cell-placement-count", cellName, cellUID, int64(shard))
}

func (s *FDBMetadataStore) versionOrderPrefix(namespace, worker string) []byte {
	return s.key("version-order", namespace, worker)
}

func (s *FDBMetadataStore) versionOrderKey(namespace, worker string, createdAt time.Time, versionID string) fdb.Key {
	return s.key("version-order", namespace, worker, createdAt.UnixNano(), versionID)
}

func (s *FDBMetadataStore) deploymentHistoryKey(namespace, worker, deploymentID string) fdb.Key {
	return s.key("deployment-history", namespace, worker, deploymentID)
}

func (s *FDBMetadataStore) deploymentOrderPrefix(namespace, worker string) []byte {
	return s.key("deployment-order", namespace, worker)
}

func (s *FDBMetadataStore) deploymentOrderKey(namespace, worker string, deployedAt time.Time, deploymentID string) fdb.Key {
	return s.key("deployment-order", namespace, worker, deployedAt.UnixNano(), deploymentID)
}

func validatePersistedWorker(worker Worker) error {
	if err := validateIdentity(worker.Namespace, worker.Name); err != nil {
		return err
	}
	if worker.Schema != Schema || worker.Deployment.Namespace != worker.Namespace ||
		worker.Deployment.Worker != worker.Name || validateDeployment(worker.Deployment) != nil ||
		len(worker.Versions) != len(worker.Deployment.Versions) {
		return fmt.Errorf("invalid persisted Worker deployment")
	}
	for index, summary := range worker.Versions {
		if validateVersionSummary(summary) != nil || summary.VersionID != worker.Deployment.Versions[index].VersionID {
			return fmt.Errorf("invalid persisted Worker deployment")
		}
	}
	return nil
}

func validateVersionSummary(summary VersionSummary) error {
	if !validVersionID(summary.VersionID) || summary.Digest != "sha256:"+summary.VersionID[2:] ||
		summary.CreatedAt.IsZero() || summary.MainModule == "" || summary.ModuleCount < 1 || summary.CompatibilityDate == "" ||
		len(summary.DurableObjectNamespaces) > MaxExports {
		return fmt.Errorf("invalid Worker version summary")
	}
	previous := ""
	for _, item := range summary.DurableObjectNamespaces {
		if len(item.NamespaceKey) != 67 || !strings.HasPrefix(item.NamespaceKey, "do_") || !classPattern.MatchString(item.ClassName) || item.Storage != DurableObjectSQLite || item.ClassName <= previous {
			return fmt.Errorf("invalid Worker version namespace inventory")
		}
		if _, err := hex.DecodeString(item.NamespaceKey[3:]); err != nil {
			return fmt.Errorf("invalid Worker version namespace inventory")
		}
		previous = item.ClassName
	}
	return nil
}
