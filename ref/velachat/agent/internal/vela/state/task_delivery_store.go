package state

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"

	atomicstate "velachat/agent/internal/state"
)

const (
	TaskDeliveryStoreFilename = "task-deliveries.json"
	taskDeliverySchema        = 1
	maxTaskDeliveryEntries    = 10_000
)

var (
	ErrInvalidTaskDelivery    = errors.New("Vela task delivery watermark 无效")
	ErrTaskRevisionRegression = errors.New("Vela task delivery revision 倒退")
	ErrTaskDeliveryCapacity   = errors.New("Vela task delivery watermark 已达到容量上限")
	ErrTaskDeliveryCorrupt    = errors.New("Vela task delivery 快照损坏")
)

type TaskDeliveryRecord struct {
	TaskID   string `json:"taskId"`
	Revision int64  `json:"revision"`
}

type FileTaskDeliveryStore struct {
	mu        sync.RWMutex
	store     *atomicstate.Store
	revisions map[string]int64
	capacity  int
}

type taskDeliverySnapshot struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Records       []TaskDeliveryRecord `json:"records"`
}

func OpenTaskDeliveryStore(root string) (*FileTaskDeliveryStore, error) {
	return openTaskDeliveryStore(root, maxTaskDeliveryEntries)
}

func openTaskDeliveryStore(root string, capacity int) (*FileTaskDeliveryStore, error) {
	if !filepath.IsAbs(root) || capacity < 1 || capacity > maxTaskDeliveryEntries {
		return nil, ErrInvalidTaskDelivery
	}
	value := &FileTaskDeliveryStore{
		store: atomicstate.New(filepath.Clean(root)), revisions: make(map[string]int64),
		capacity: capacity,
	}
	var snapshot taskDeliverySnapshot
	if err := value.store.Read(TaskDeliveryStoreFilename, &snapshot); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return value, nil
		}
		return nil, ErrTaskDeliveryCorrupt
	}
	if snapshot.SchemaVersion != taskDeliverySchema || len(snapshot.Records) > capacity {
		return nil, ErrTaskDeliveryCorrupt
	}
	for _, record := range snapshot.Records {
		if !validUUIDv7Value(record.TaskID) || record.Revision < 1 {
			return nil, ErrTaskDeliveryCorrupt
		}
		if _, duplicate := value.revisions[record.TaskID]; duplicate {
			return nil, ErrTaskDeliveryCorrupt
		}
		value.revisions[record.TaskID] = record.Revision
	}
	return value, nil
}

func (s *FileTaskDeliveryStore) DeliveredRevision(taskID string) (int64, bool) {
	if s == nil {
		return 0, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	revision, ok := s.revisions[taskID]
	return revision, ok
}

func (s *FileTaskDeliveryStore) RecordDelivered(taskID string, revision int64) error {
	if s == nil || !validUUIDv7Value(taskID) || revision < 1 {
		return ErrInvalidTaskDelivery
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, exists := s.revisions[taskID]
	if exists && revision == current {
		return nil
	}
	if exists && revision < current {
		return ErrTaskRevisionRegression
	}
	if !exists && len(s.revisions) >= s.capacity {
		return ErrTaskDeliveryCapacity
	}
	next := cloneTaskRevisions(s.revisions)
	next[taskID] = revision
	if err := s.persistLocked(next); err != nil {
		return err
	}
	s.revisions = next
	return nil
}

func (s *FileTaskDeliveryStore) PruneActive(active map[string]struct{}) error {
	if s == nil || active == nil {
		return ErrInvalidTaskDelivery
	}
	for taskID := range active {
		if !validUUIDv7Value(taskID) {
			return ErrInvalidTaskDelivery
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := make(map[string]int64, len(active))
	for taskID, revision := range s.revisions {
		if _, keep := active[taskID]; keep {
			next[taskID] = revision
		}
	}
	if len(next) == len(s.revisions) {
		return nil
	}
	if err := s.persistLocked(next); err != nil {
		return err
	}
	s.revisions = next
	return nil
}

func (s *FileTaskDeliveryStore) persistLocked(revisions map[string]int64) error {
	keys := make([]string, 0, len(revisions))
	for key := range revisions {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	records := make([]TaskDeliveryRecord, 0, len(keys))
	for _, key := range keys {
		records = append(records, TaskDeliveryRecord{TaskID: key, Revision: revisions[key]})
	}
	return s.store.Write(TaskDeliveryStoreFilename, taskDeliverySnapshot{
		SchemaVersion: taskDeliverySchema,
		Records:       records,
	})
}

func cloneTaskRevisions(source map[string]int64) map[string]int64 {
	result := make(map[string]int64, len(source)+1)
	for key, revision := range source {
		result[key] = revision
	}
	return result
}
