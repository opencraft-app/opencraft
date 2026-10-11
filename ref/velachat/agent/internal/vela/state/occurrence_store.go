package state

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	atomicstate "velachat/agent/internal/state"
)

const (
	OccurrenceStoreFilename = "reminder-occurrences.json"
	occurrenceStoreSchema   = 1
	maxOccurrenceEntries    = 10_000
)

var (
	ErrInvalidOccurrence    = errors.New("Vela reminder occurrence 无效")
	ErrOccurrenceConflict   = errors.New("Vela reminder occurrence 状态冲突")
	ErrOccurrenceTransition = errors.New("Vela reminder occurrence 状态转换无效")
	ErrOccurrenceCapacity   = errors.New("Vela reminder occurrence 已达到容量上限")
	ErrOccurrenceCorrupt    = errors.New("Vela reminder occurrence 快照损坏")
)

type OccurrenceState string

type OccurrenceInput struct {
	AgentID      string
	OccurrenceID string
	ReminderID   string
	ScheduledAt  time.Time
}

const (
	OccurrenceDue                 OccurrenceState = "due"
	OccurrenceExecuting           OccurrenceState = "executing"
	OccurrenceCompletedPendingAck OccurrenceState = "completed_pending_ack"
	OccurrenceNeedsAttention      OccurrenceState = "needs_attention"
)

type OccurrenceRecord struct {
	AgentID       string          `json:"agentId"`
	OccurrenceID  string          `json:"occurrenceId"`
	ReminderID    string          `json:"reminderId"`
	ScheduledAt   time.Time       `json:"scheduledAt"`
	State         OccurrenceState `json:"state"`
	RuntimeEpoch  string          `json:"runtimeEpoch,omitempty"`
	FailureCount  int             `json:"failureCount,omitempty"`
	NextAttemptAt time.Time       `json:"nextAttemptAt,omitempty"`
	UpdatedAt     time.Time       `json:"updatedAt"`
}

func (r OccurrenceRecord) Key() string { return r.OccurrenceID }

type FileOccurrenceStore struct {
	mu       sync.RWMutex
	store    *atomicstate.Store
	records  map[string]OccurrenceRecord
	capacity int
}

type occurrenceSnapshot struct {
	SchemaVersion int                `json:"schemaVersion"`
	Records       []OccurrenceRecord `json:"records"`
}

func OpenOccurrenceStore(root string) (*FileOccurrenceStore, error) {
	return openOccurrenceStore(root, maxOccurrenceEntries)
}

func openOccurrenceStore(root string, capacity int) (*FileOccurrenceStore, error) {
	if !filepath.IsAbs(root) || capacity < 1 || capacity > maxOccurrenceEntries {
		return nil, ErrInvalidOccurrence
	}
	value := &FileOccurrenceStore{
		store: atomicstate.New(filepath.Clean(root)), records: make(map[string]OccurrenceRecord),
		capacity: capacity,
	}
	var snapshot occurrenceSnapshot
	if err := value.store.Read(OccurrenceStoreFilename, &snapshot); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return value, nil
		}
		return nil, ErrOccurrenceCorrupt
	}
	if snapshot.SchemaVersion != occurrenceStoreSchema || len(snapshot.Records) > capacity {
		return nil, ErrOccurrenceCorrupt
	}
	for _, record := range snapshot.Records {
		if !validOccurrenceRecord(record) {
			return nil, ErrOccurrenceCorrupt
		}
		if _, duplicate := value.records[record.OccurrenceID]; duplicate {
			return nil, ErrOccurrenceCorrupt
		}
		value.records[record.OccurrenceID] = record
	}
	return value, nil
}

func (s *FileOccurrenceStore) Observe(input OccurrenceInput) (OccurrenceRecord, bool, error) {
	if s == nil || !validOccurrenceInput(input) {
		return OccurrenceRecord{}, false, ErrInvalidOccurrence
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.records[input.OccurrenceID]; ok {
		if existing.AgentID != input.AgentID || existing.ReminderID != input.ReminderID ||
			!existing.ScheduledAt.Equal(input.ScheduledAt.UTC()) {
			return OccurrenceRecord{}, false, ErrOccurrenceConflict
		}
		return existing, false, nil
	}
	if len(s.records) >= s.capacity {
		return OccurrenceRecord{}, false, ErrOccurrenceCapacity
	}
	now := time.Now().UTC()
	record := OccurrenceRecord{
		AgentID: input.AgentID, OccurrenceID: input.OccurrenceID, ReminderID: input.ReminderID,
		ScheduledAt: input.ScheduledAt.UTC(), State: OccurrenceDue, UpdatedAt: now,
	}
	if err := s.replaceLocked(record.OccurrenceID, record); err != nil {
		return OccurrenceRecord{}, false, err
	}
	return record, true, nil
}

func (s *FileOccurrenceStore) Get(occurrenceID string) (OccurrenceRecord, bool) {
	if s == nil {
		return OccurrenceRecord{}, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.records[occurrenceID]
	return record, ok
}

func (s *FileOccurrenceStore) Snapshot() []OccurrenceRecord {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return sortedOccurrenceRecords(s.records)
}

func (s *FileOccurrenceStore) Start(occurrenceID, runtimeEpoch string, now time.Time) (OccurrenceRecord, error) {
	return s.mutate(occurrenceID, func(record *OccurrenceRecord) error {
		runtimeEpoch = strings.TrimSpace(runtimeEpoch)
		if runtimeEpoch == "" || now.IsZero() ||
			(record.State != OccurrenceDue && record.State != OccurrenceNeedsAttention) ||
			(!record.NextAttemptAt.IsZero() && record.NextAttemptAt.After(now.UTC())) {
			return ErrOccurrenceTransition
		}
		record.State = OccurrenceExecuting
		record.RuntimeEpoch = runtimeEpoch
		record.NextAttemptAt = time.Time{}
		return nil
	})
}

func (s *FileOccurrenceStore) Complete(occurrenceID, runtimeEpoch string) (OccurrenceRecord, error) {
	return s.mutate(occurrenceID, func(record *OccurrenceRecord) error {
		if record.State != OccurrenceExecuting || record.RuntimeEpoch != strings.TrimSpace(runtimeEpoch) {
			return ErrOccurrenceConflict
		}
		record.State = OccurrenceCompletedPendingAck
		record.FailureCount = 0
		record.NextAttemptAt = time.Time{}
		return nil
	})
}

func (s *FileOccurrenceStore) Fail(occurrenceID, runtimeEpoch string, nextAttemptAt time.Time, needsAttention bool) (OccurrenceRecord, error) {
	return s.mutate(occurrenceID, func(record *OccurrenceRecord) error {
		if record.State != OccurrenceExecuting || record.RuntimeEpoch != strings.TrimSpace(runtimeEpoch) ||
			nextAttemptAt.IsZero() {
			return ErrOccurrenceConflict
		}
		record.FailureCount++
		record.NextAttemptAt = nextAttemptAt.UTC()
		if needsAttention || record.FailureCount >= 5 {
			record.State = OccurrenceNeedsAttention
		} else {
			record.State = OccurrenceDue
		}
		return nil
	})
}

func (s *FileOccurrenceStore) Acknowledge(occurrenceID string) (OccurrenceRecord, error) {
	if s == nil {
		return OccurrenceRecord{}, ErrInvalidOccurrence
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.records[occurrenceID]
	if !ok || record.State != OccurrenceCompletedPendingAck {
		return OccurrenceRecord{}, ErrOccurrenceConflict
	}
	records := cloneOccurrenceMap(s.records)
	delete(records, occurrenceID)
	if err := s.persistLocked(records); err != nil {
		return OccurrenceRecord{}, err
	}
	s.records = records
	return record, nil
}

func (s *FileOccurrenceStore) RecoverExecuting(newRuntimeEpoch string, now time.Time) (int, error) {
	newRuntimeEpoch = strings.TrimSpace(newRuntimeEpoch)
	if s == nil || newRuntimeEpoch == "" || now.IsZero() {
		return 0, ErrInvalidOccurrence
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	records := cloneOccurrenceMap(s.records)
	count := 0
	for key, record := range records {
		if record.State != OccurrenceExecuting || record.RuntimeEpoch == newRuntimeEpoch {
			continue
		}
		record.FailureCount++
		record.NextAttemptAt = now.UTC()
		if record.FailureCount >= 5 {
			record.State = OccurrenceNeedsAttention
		} else {
			record.State = OccurrenceDue
		}
		record.UpdatedAt = time.Now().UTC()
		records[key] = record
		count++
	}
	if count == 0 {
		return 0, nil
	}
	if err := s.persistLocked(records); err != nil {
		return 0, err
	}
	s.records = records
	return count, nil
}

func (s *FileOccurrenceStore) mutate(occurrenceID string, mutate func(*OccurrenceRecord) error) (OccurrenceRecord, error) {
	if s == nil || mutate == nil {
		return OccurrenceRecord{}, ErrInvalidOccurrence
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.records[occurrenceID]
	if !ok {
		return OccurrenceRecord{}, ErrInvalidOccurrence
	}
	if err := mutate(&record); err != nil {
		return OccurrenceRecord{}, err
	}
	record.UpdatedAt = time.Now().UTC()
	if !validOccurrenceRecord(record) {
		return OccurrenceRecord{}, ErrOccurrenceTransition
	}
	if err := s.replaceLocked(record.OccurrenceID, record); err != nil {
		return OccurrenceRecord{}, err
	}
	return record, nil
}

func (s *FileOccurrenceStore) replaceLocked(key string, record OccurrenceRecord) error {
	records := cloneOccurrenceMap(s.records)
	records[key] = record
	if err := s.persistLocked(records); err != nil {
		return err
	}
	s.records = records
	return nil
}

func (s *FileOccurrenceStore) persistLocked(records map[string]OccurrenceRecord) error {
	return s.store.Write(OccurrenceStoreFilename, occurrenceSnapshot{
		SchemaVersion: occurrenceStoreSchema,
		Records:       sortedOccurrenceRecords(records),
	})
}

func cloneOccurrenceMap(source map[string]OccurrenceRecord) map[string]OccurrenceRecord {
	result := make(map[string]OccurrenceRecord, len(source))
	for key, record := range source {
		result[key] = record
	}
	return result
}

func sortedOccurrenceRecords(records map[string]OccurrenceRecord) []OccurrenceRecord {
	keys := make([]string, 0, len(records))
	for key := range records {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]OccurrenceRecord, 0, len(keys))
	for _, key := range keys {
		result = append(result, records[key])
	}
	return result
}

func validOccurrenceRecord(record OccurrenceRecord) bool {
	if !validUUIDv7Value(record.AgentID) || !validUUIDv7Value(record.OccurrenceID) ||
		!validUUIDv7Value(record.ReminderID) || record.ScheduledAt.IsZero() ||
		record.UpdatedAt.IsZero() || record.FailureCount < 0 {
		return false
	}
	switch record.State {
	case OccurrenceDue:
		return true
	case OccurrenceNeedsAttention:
		return record.FailureCount >= 5 && !record.NextAttemptAt.IsZero()
	case OccurrenceExecuting:
		return strings.TrimSpace(record.RuntimeEpoch) != "" && record.NextAttemptAt.IsZero()
	case OccurrenceCompletedPendingAck:
		return strings.TrimSpace(record.RuntimeEpoch) != "" && record.FailureCount == 0 &&
			record.NextAttemptAt.IsZero()
	default:
		return false
	}
}

func validUUIDv7Value(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.Version() == 7 && parsed.String() == value
}

func validOccurrenceInput(input OccurrenceInput) bool {
	return validUUIDv7Value(input.AgentID) &&
		validUUIDv7Value(input.OccurrenceID) &&
		validUUIDv7Value(input.ReminderID) &&
		!input.ScheduledAt.IsZero()
}
