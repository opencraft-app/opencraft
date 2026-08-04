package state

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	atomicstate "github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/state"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
)

const (
	CursorStoreFilename = "message-cursors.json"
	cursorSchemaVersion = 2
	oldestCursorSchema  = 1
	maxCursorEntries    = 10_000
	maxCursorFileBytes  = 16 << 20
)

var (
	ErrInvalidCursor    = errors.New("Vela message cursor 无效")
	ErrCursorConflict   = errors.New("Vela message cursor CAS 冲突")
	ErrCursorRegression = errors.New("Vela message cursor 倒退")
	ErrCursorCorrupt    = errors.New("Vela message cursor 快照损坏")
	ErrCursorCapacity   = errors.New("Vela message cursor 已达到容量上限")
	ErrCursorInGap      = errors.New("Vela conversation 仍存在 history gap")
	ErrCursorNotInGap   = errors.New("Vela conversation 不在 history gap")
)

type BaselineReason string

const BaselineNewInstall BaselineReason = "new_install"

type GapCode string

const (
	GapHistoryExpired    GapCode = "history_expired"
	GapRecoveryStalled   GapCode = "recovery_stalled"
	GapQueueOverflow     GapCode = "queue_overflow"
	GapRuntimeFailed     GapCode = "runtime_failed"
	GapRuntimeTimeout    GapCode = "runtime_timeout"
	GapCursorWriteFailed GapCode = "cursor_write_failed"
)

type RebaseReason string

const RebaseOperatorLatest RebaseReason = "operator_latest"

type BaselineDiagnostic struct {
	Reason BaselineReason
	At     time.Time
}

type GapDiagnostic struct {
	Code       GapCode
	DetectedAt time.Time
}

type ConversationGap struct {
	Conversation    im.Conversation
	Version         uint64
	FirstUnconsumed *CursorBoundary
	Diagnostic      GapDiagnostic
}

type CursorBoundary struct {
	MessageID   string
	Sequence    int64
	TimestampMS int64
}

type RebaseDiagnostic struct {
	Reason RebaseReason
	At     time.Time
	From   CursorBoundary
	To     CursorBoundary
}

type MessageCursor struct {
	Conversation im.Conversation
	MessageID    string
	Sequence     int64
	TimestampMS  int64
	UpdatedAt    time.Time
	Baseline     *BaselineDiagnostic
	LastRebase   *RebaseDiagnostic
}

func NewMessageCursor(reference im.MessageRef, updatedAt time.Time) MessageCursor {
	return MessageCursor{
		Conversation: reference.Conversation(),
		MessageID:    reference.MessageID(),
		Sequence:     reference.Sequence(),
		TimestampMS:  reference.TimestampMS(),
		UpdatedAt:    updatedAt.UTC(),
	}
}

type CursorStore interface {
	Initialized() bool
	MarkInitialized() error
	Get(im.Conversation) (MessageCursor, bool)
	List() []MessageCursor
	ListGaps() []ConversationGap
	Advance(*MessageCursor, MessageCursor) error
	InitializeBaseline(MessageCursor, BaselineReason) error
	Gap(im.Conversation) (ConversationGap, bool)
	MarkGap(im.Conversation, *MessageCursor, *MessageCursor, GapDiagnostic) (ConversationGap, error)
	RecoverAdvance(*MessageCursor, uint64, MessageCursor) error
	RebaseGap(*MessageCursor, uint64, MessageCursor, RebaseReason) error
}

type FileCursorStore struct {
	mu          sync.RWMutex
	store       *atomicstate.Store
	cursors     map[string]MessageCursor
	gaps        map[string]ConversationGap
	initialized bool
}

type cursorSnapshot struct {
	SchemaVersion int            `json:"schemaVersion"`
	Initialized   bool           `json:"initialized"`
	Cursors       []cursorRecord `json:"cursors"`
	Gaps          []gapRecord    `json:"gaps,omitempty"`
}

type gapRecord struct {
	Kind            im.ConversationType `json:"kind"`
	PeerUserID      string              `json:"peerUserId,omitempty"`
	GroupID         string              `json:"groupId,omitempty"`
	TopicID         string              `json:"topicId,omitempty"`
	Version         uint64              `json:"version"`
	FirstUnconsumed *CursorBoundary     `json:"firstUnconsumed,omitempty"`
	Code            GapCode             `json:"code"`
	DetectedAt      time.Time           `json:"detectedAt"`
}

type cursorRecord struct {
	Kind        im.ConversationType `json:"kind"`
	PeerUserID  string              `json:"peerUserId,omitempty"`
	GroupID     string              `json:"groupId,omitempty"`
	TopicID     string              `json:"topicId,omitempty"`
	MessageID   string              `json:"messageId"`
	Sequence    int64               `json:"sequence"`
	TimestampMS int64               `json:"timestampMs"`
	UpdatedAt   time.Time           `json:"updatedAt"`
	Baseline    *BaselineDiagnostic `json:"baseline,omitempty"`
	LastRebase  *RebaseDiagnostic   `json:"lastRebase,omitempty"`
}

func OpenFileCursorStore(root string) (*FileCursorStore, error) {
	if !filepath.IsAbs(root) {
		return nil, ErrInvalidCursor
	}
	root = filepath.Clean(root)
	path := filepath.Join(root, CursorStoreFilename)
	if info, err := os.Stat(path); err == nil && info.Size() > maxCursorFileBytes {
		return nil, ErrCursorCorrupt
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	value := &FileCursorStore{
		store:   atomicstate.New(root),
		cursors: make(map[string]MessageCursor),
		gaps:    make(map[string]ConversationGap),
	}
	var snapshot cursorSnapshot
	if err := value.store.Read(CursorStoreFilename, &snapshot); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return value, nil
		}
		return nil, ErrCursorCorrupt
	}
	if snapshot.SchemaVersion < oldestCursorSchema || snapshot.SchemaVersion > cursorSchemaVersion ||
		len(snapshot.Cursors) > maxCursorEntries || len(snapshot.Gaps) > maxCursorEntries {
		return nil, ErrCursorCorrupt
	}
	for _, record := range snapshot.Cursors {
		cursor, err := cursorFromRecord(record)
		if err != nil {
			return nil, ErrCursorCorrupt
		}
		key := conversationCursorKey(cursor.Conversation)
		if _, duplicate := value.cursors[key]; duplicate {
			return nil, ErrCursorCorrupt
		}
		value.cursors[key] = cursor
	}
	for _, record := range snapshot.Gaps {
		gap, err := gapFromRecord(record)
		if err != nil {
			return nil, ErrCursorCorrupt
		}
		key := conversationCursorKey(gap.Conversation)
		if _, duplicate := value.gaps[key]; duplicate {
			return nil, ErrCursorCorrupt
		}
		value.gaps[key] = gap
	}
	value.initialized = snapshot.Initialized
	return value, nil
}

func (s *FileCursorStore) Get(conversation im.Conversation) (MessageCursor, bool) {
	if s == nil || !conversation.Valid() {
		return MessageCursor{}, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	cursor, ok := s.cursors[conversationCursorKey(conversation)]
	return cloneMessageCursor(cursor), ok
}

func (s *FileCursorStore) List() []MessageCursor {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	keys := make([]string, 0, len(s.cursors))
	for key := range s.cursors {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]MessageCursor, 0, len(keys))
	for _, key := range keys {
		result = append(result, cloneMessageCursor(s.cursors[key]))
	}
	return result
}

func (s *FileCursorStore) ListGaps() []ConversationGap {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	keys := make([]string, 0, len(s.gaps))
	for key := range s.gaps {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]ConversationGap, 0, len(keys))
	for _, key := range keys {
		result = append(result, cloneConversationGap(s.gaps[key]))
	}
	return result
}

func (s *FileCursorStore) Initialized() bool {
	if s == nil {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.initialized
}

func (s *FileCursorStore) MarkInitialized() error {
	if s == nil {
		return ErrInvalidCursor
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.initialized {
		return nil
	}
	if err := s.persistLocked(s.cursors, s.gaps, true); err != nil {
		return err
	}
	s.initialized = true
	return nil
}

func (s *FileCursorStore) Advance(expected *MessageCursor, next MessageCursor) error {
	if s == nil || !validMessageCursor(next) {
		return ErrInvalidCursor
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := conversationCursorKey(next.Conversation)
	current, exists := s.cursors[key]
	if _, inGap := s.gaps[key]; inGap {
		return ErrCursorInGap
	}
	if exists && sameCursorBoundary(current, next) {
		return nil
	}
	if !cursorExpectationMatches(current, exists, expected) {
		return ErrCursorConflict
	}
	if exists && cursorRegresses(current, next) {
		return ErrCursorRegression
	}
	if !exists && len(s.cursors) >= maxCursorEntries {
		return ErrCursorCapacity
	}
	next.Baseline = cloneBaseline(current.Baseline)
	next.LastRebase = cloneRebase(current.LastRebase)
	return s.replaceLocked(key, next)
}

func (s *FileCursorStore) InitializeBaseline(next MessageCursor, reason BaselineReason) error {
	if s == nil || !validMessageCursor(next) || reason != BaselineNewInstall {
		return ErrInvalidCursor
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := conversationCursorKey(next.Conversation)
	if _, inGap := s.gaps[key]; inGap {
		return ErrCursorInGap
	}
	if _, exists := s.cursors[key]; exists {
		return ErrCursorConflict
	}
	if len(s.cursors) >= maxCursorEntries {
		return ErrCursorCapacity
	}
	next.Baseline = &BaselineDiagnostic{Reason: reason, At: next.UpdatedAt}
	return s.replaceLocked(key, next)
}

func (s *FileCursorStore) Gap(conversation im.Conversation) (ConversationGap, bool) {
	if s == nil || !conversation.Valid() {
		return ConversationGap{}, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	gap, ok := s.gaps[conversationCursorKey(conversation)]
	return cloneConversationGap(gap), ok
}

func (s *FileCursorStore) MarkGap(
	conversation im.Conversation,
	expected *MessageCursor,
	firstUnconsumed *MessageCursor,
	diagnostic GapDiagnostic,
) (ConversationGap, error) {
	if s == nil || !conversation.Valid() || !validGapDiagnostic(diagnostic) ||
		expected != nil && !sameConversationCursor(conversation, expected.Conversation) ||
		firstUnconsumed != nil && (!validMessageCursor(*firstUnconsumed) ||
			!sameConversationCursor(conversation, firstUnconsumed.Conversation)) {
		return ConversationGap{}, ErrInvalidCursor
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := conversationCursorKey(conversation)
	current, exists := s.cursors[key]
	if !cursorExpectationMatches(current, exists, expected) {
		return ConversationGap{}, ErrCursorConflict
	}
	if existing, ok := s.gaps[key]; ok &&
		existing.Diagnostic.Code == diagnostic.Code &&
		existing.Diagnostic.DetectedAt.Equal(diagnostic.DetectedAt.UTC()) &&
		(firstUnconsumed == nil || existing.FirstUnconsumed != nil &&
			*existing.FirstUnconsumed == boundaryOf(*firstUnconsumed)) {
		return cloneConversationGap(existing), nil
	}
	version := uint64(1)
	var firstBoundary *CursorBoundary
	if existing, ok := s.gaps[key]; ok {
		version = existing.Version + 1
		firstBoundary = cloneCursorBoundary(existing.FirstUnconsumed)
	}
	if firstBoundary == nil && firstUnconsumed != nil {
		boundary := boundaryOf(*firstUnconsumed)
		firstBoundary = &boundary
	}
	gap := ConversationGap{
		Conversation: conversation, Version: version,
		FirstUnconsumed: firstBoundary,
		Diagnostic: GapDiagnostic{
			Code: diagnostic.Code, DetectedAt: diagnostic.DetectedAt.UTC(),
		},
	}
	gaps := cloneGapMap(s.gaps)
	gaps[key] = cloneConversationGap(gap)
	if err := s.persistLocked(s.cursors, gaps, s.initialized); err != nil {
		return ConversationGap{}, err
	}
	s.gaps = gaps
	return cloneConversationGap(gap), nil
}

func (s *FileCursorStore) RebaseGap(
	expected *MessageCursor,
	expectedGapVersion uint64,
	next MessageCursor,
	reason RebaseReason,
) error {
	if s == nil || !validMessageCursor(next) || expectedGapVersion == 0 ||
		reason != RebaseOperatorLatest ||
		expected != nil && !sameConversationCursor(expected.Conversation, next.Conversation) {
		return ErrInvalidCursor
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := conversationCursorKey(next.Conversation)
	current, exists := s.cursors[key]
	if !cursorExpectationMatches(current, exists, expected) {
		return ErrCursorConflict
	}
	gap, inGap := s.gaps[key]
	if !inGap {
		return ErrCursorNotInGap
	}
	if gap.Version != expectedGapVersion {
		return ErrCursorConflict
	}
	if exists && cursorRegresses(current, next) {
		return ErrCursorRegression
	}
	if !exists && len(s.cursors) >= maxCursorEntries {
		return ErrCursorCapacity
	}
	next.Baseline = cloneBaseline(current.Baseline)
	next.LastRebase = &RebaseDiagnostic{
		Reason: reason,
		At:     next.UpdatedAt,
		From:   boundaryOf(current),
		To:     boundaryOf(next),
	}
	cursors := cloneCursorMap(s.cursors)
	cursors[key] = cloneMessageCursor(next)
	gaps := cloneGapMap(s.gaps)
	delete(gaps, key)
	if err := s.persistLocked(cursors, gaps, s.initialized); err != nil {
		return err
	}
	s.cursors = cursors
	s.gaps = gaps
	return nil
}

// RecoverAdvance is the only non-operator path that may cross a persisted
// gap. The exact cursor and gap generation both participate in the CAS, so a
// stale recovery worker cannot clear a newer failure barrier.
func (s *FileCursorStore) RecoverAdvance(
	expected *MessageCursor,
	expectedGapVersion uint64,
	next MessageCursor,
) error {
	if s == nil || !validMessageCursor(next) || expectedGapVersion == 0 ||
		expected != nil && !sameConversationCursor(expected.Conversation, next.Conversation) {
		return ErrInvalidCursor
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := conversationCursorKey(next.Conversation)
	current, exists := s.cursors[key]
	if !cursorExpectationMatches(current, exists, expected) {
		return ErrCursorConflict
	}
	gap, inGap := s.gaps[key]
	if !inGap {
		return ErrCursorNotInGap
	}
	if gap.Version != expectedGapVersion {
		return ErrCursorConflict
	}
	if exists && cursorRegresses(current, next) {
		return ErrCursorRegression
	}
	if !exists && len(s.cursors) >= maxCursorEntries {
		return ErrCursorCapacity
	}
	next.Baseline = cloneBaseline(current.Baseline)
	next.LastRebase = cloneRebase(current.LastRebase)
	cursors := cloneCursorMap(s.cursors)
	cursors[key] = cloneMessageCursor(next)
	gaps := cloneGapMap(s.gaps)
	delete(gaps, key)
	if err := s.persistLocked(cursors, gaps, s.initialized); err != nil {
		return err
	}
	s.cursors = cursors
	s.gaps = gaps
	return nil
}

func (s *FileCursorStore) replaceLocked(key string, next MessageCursor) error {
	cursors := make(map[string]MessageCursor, len(s.cursors)+1)
	for existingKey, cursor := range s.cursors {
		cursors[existingKey] = cursor
	}
	cursors[key] = cloneMessageCursor(next)
	if err := s.persistLocked(cursors, s.gaps, s.initialized); err != nil {
		return err
	}
	s.cursors = cursors
	return nil
}

func (s *FileCursorStore) persistLocked(
	cursors map[string]MessageCursor,
	gaps map[string]ConversationGap,
	initialized bool,
) error {
	keys := make([]string, 0, len(cursors))
	for key := range cursors {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	records := make([]cursorRecord, 0, len(keys))
	for _, key := range keys {
		records = append(records, recordFromCursor(cursors[key]))
	}
	gapKeys := make([]string, 0, len(gaps))
	for key := range gaps {
		gapKeys = append(gapKeys, key)
	}
	sort.Strings(gapKeys)
	gapRecords := make([]gapRecord, 0, len(gapKeys))
	for _, key := range gapKeys {
		gapRecords = append(gapRecords, recordFromGap(gaps[key]))
	}
	return s.store.Write(CursorStoreFilename, cursorSnapshot{
		SchemaVersion: cursorSchemaVersion,
		Initialized:   initialized,
		Cursors:       records,
		Gaps:          gapRecords,
	})
}

func cursorExpectationMatches(current MessageCursor, exists bool, expected *MessageCursor) bool {
	if !exists {
		return expected == nil
	}
	return expected != nil && sameConversationCursor(current.Conversation, expected.Conversation) && sameCursorBoundary(current, *expected)
}

func cursorRegresses(current, next MessageCursor) bool {
	if next.TimestampMS < current.TimestampMS {
		return true
	}
	switch current.Conversation.Kind() {
	case im.ConversationGroup, im.ConversationTopic:
		return next.Sequence <= current.Sequence
	default:
		return false
	}
}

func validMessageCursor(cursor MessageCursor) bool {
	return cursor.Conversation.Valid() && strings.TrimSpace(cursor.MessageID) == cursor.MessageID &&
		cursor.MessageID != "" && cursor.Sequence >= 0 && cursor.TimestampMS > 0 &&
		!cursor.UpdatedAt.IsZero() && cursor.UpdatedAt.Location() == time.UTC
}

func validGapDiagnostic(value GapDiagnostic) bool {
	if value.DetectedAt.IsZero() {
		return false
	}
	switch value.Code {
	case GapHistoryExpired, GapRecoveryStalled, GapQueueOverflow,
		GapRuntimeFailed, GapRuntimeTimeout, GapCursorWriteFailed:
		return true
	default:
		return false
	}
}

func sameCursorBoundary(left, right MessageCursor) bool {
	return sameConversationCursor(left.Conversation, right.Conversation) &&
		left.MessageID == right.MessageID && left.Sequence == right.Sequence &&
		left.TimestampMS == right.TimestampMS
}

func sameConversationCursor(left, right im.Conversation) bool {
	return left.Kind() == right.Kind() && left.PeerUserID() == right.PeerUserID() &&
		left.GroupID() == right.GroupID() && left.TopicID() == right.TopicID()
}

func conversationCursorKey(conversation im.Conversation) string {
	return string(conversation.Kind()) + "\x00" + conversation.PeerUserID() + "\x00" +
		conversation.GroupID() + "\x00" + conversation.TopicID()
}

func cloneCursorMap(source map[string]MessageCursor) map[string]MessageCursor {
	result := make(map[string]MessageCursor, len(source)+1)
	for key, cursor := range source {
		result[key] = cloneMessageCursor(cursor)
	}
	return result
}

func cloneGapMap(source map[string]ConversationGap) map[string]ConversationGap {
	result := make(map[string]ConversationGap, len(source)+1)
	for key, gap := range source {
		result[key] = cloneConversationGap(gap)
	}
	return result
}

func cloneConversationGap(gap ConversationGap) ConversationGap {
	gap.FirstUnconsumed = cloneCursorBoundary(gap.FirstUnconsumed)
	return gap
}

func cloneCursorBoundary(value *CursorBoundary) *CursorBoundary {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func boundaryOf(cursor MessageCursor) CursorBoundary {
	return CursorBoundary{MessageID: cursor.MessageID, Sequence: cursor.Sequence, TimestampMS: cursor.TimestampMS}
}

func cloneMessageCursor(cursor MessageCursor) MessageCursor {
	cursor.Baseline = cloneBaseline(cursor.Baseline)
	cursor.LastRebase = cloneRebase(cursor.LastRebase)
	return cursor
}

func cloneBaseline(value *BaselineDiagnostic) *BaselineDiagnostic {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneRebase(value *RebaseDiagnostic) *RebaseDiagnostic {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func recordFromCursor(cursor MessageCursor) cursorRecord {
	return cursorRecord{
		Kind: cursor.Conversation.Kind(), PeerUserID: cursor.Conversation.PeerUserID(),
		GroupID: cursor.Conversation.GroupID(), TopicID: cursor.Conversation.TopicID(),
		MessageID: cursor.MessageID, Sequence: cursor.Sequence, TimestampMS: cursor.TimestampMS,
		UpdatedAt: cursor.UpdatedAt, Baseline: cloneBaseline(cursor.Baseline),
		LastRebase: cloneRebase(cursor.LastRebase),
	}
}

func recordFromGap(gap ConversationGap) gapRecord {
	return gapRecord{
		Kind: gap.Conversation.Kind(), PeerUserID: gap.Conversation.PeerUserID(),
		GroupID: gap.Conversation.GroupID(), TopicID: gap.Conversation.TopicID(),
		Version: gap.Version, FirstUnconsumed: cloneCursorBoundary(gap.FirstUnconsumed),
		Code:       gap.Diagnostic.Code,
		DetectedAt: gap.Diagnostic.DetectedAt,
	}
}

func gapFromRecord(record gapRecord) (ConversationGap, error) {
	conversation, err := conversationFromRoute(
		record.Kind, record.PeerUserID, record.GroupID, record.TopicID,
	)
	diagnostic := GapDiagnostic{Code: record.Code, DetectedAt: record.DetectedAt.UTC()}
	if err != nil || record.Version == 0 || !validGapDiagnostic(diagnostic) ||
		record.FirstUnconsumed != nil && !validCursorBoundary(*record.FirstUnconsumed) {
		return ConversationGap{}, ErrInvalidCursor
	}
	return ConversationGap{
		Conversation: conversation, Version: record.Version,
		FirstUnconsumed: cloneCursorBoundary(record.FirstUnconsumed), Diagnostic: diagnostic,
	}, nil
}

func validCursorBoundary(value CursorBoundary) bool {
	return strings.TrimSpace(value.MessageID) == value.MessageID && value.MessageID != "" &&
		value.Sequence >= 0 && value.TimestampMS > 0
}

func cursorFromRecord(record cursorRecord) (MessageCursor, error) {
	conversation, err := conversationFromRoute(
		record.Kind, record.PeerUserID, record.GroupID, record.TopicID,
	)
	if err != nil {
		return MessageCursor{}, err
	}
	cursor := MessageCursor{
		Conversation: conversation, MessageID: record.MessageID, Sequence: record.Sequence,
		TimestampMS: record.TimestampMS, UpdatedAt: record.UpdatedAt.UTC(),
		Baseline:   cloneBaseline(record.Baseline),
		LastRebase: cloneRebase(record.LastRebase),
	}
	if !validMessageCursor(cursor) {
		return MessageCursor{}, ErrInvalidCursor
	}
	return cursor, nil
}

func conversationFromRoute(
	kind im.ConversationType,
	peerUserID string,
	groupID string,
	topicID string,
) (im.Conversation, error) {
	switch kind {
	case im.ConversationC2C:
		if groupID != "" || topicID != "" {
			return im.Conversation{}, im.ErrInvalidConversation
		}
		return im.NewC2CConversation(peerUserID)
	case im.ConversationGroup:
		if peerUserID != "" || topicID != "" {
			return im.Conversation{}, im.ErrInvalidConversation
		}
		return im.NewGroupConversation(groupID)
	case im.ConversationTopic:
		if peerUserID != "" {
			return im.Conversation{}, im.ErrInvalidConversation
		}
		return im.NewTopicConversation(groupID, topicID)
	default:
		return im.Conversation{}, im.ErrInvalidConversation
	}
}
