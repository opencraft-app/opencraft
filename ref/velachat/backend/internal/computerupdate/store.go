package computerupdate

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/gofrs/flock"
	"github.com/google/uuid"
)

const (
	storeFileName       = "channels.json"
	storeLockName       = ".writer.lock"
	maximumStoreBytes   = 4 << 20
	maximumAuditEntries = 1000
)

var (
	ErrStoreInUse       = errors.New("Computer Update store 已被其他进程占用")
	ErrUnsafeStore      = errors.New("Computer Update store 权限或路径不安全")
	ErrCorruptStore     = errors.New("Computer Update store 内容损坏")
	ErrRevisionConflict = errors.New("Computer Release Channel revision 冲突")
)

type ChannelCommit struct {
	Channel             string
	ExpectedSequence    int64
	Version             string
	CatalogSHA256       []byte
	IssuedAt            time.Time
	Signed              map[string]SignedDescriptor
	AuditID             string
	OperatorFingerprint []byte
}

type ChannelView struct {
	Channel          string           `json:"channel"`
	Target           string           `json:"target"`
	Sequence         int64            `json:"sequence"`
	ExpectedVersion  string           `json:"expectedVersion"`
	CatalogSHA256    string           `json:"catalogSHA256"`
	DescriptorSHA256 string           `json:"descriptorSHA256"`
	IssuedAt         time.Time        `json:"issuedAt"`
	KeyID            string           `json:"keyId"`
	Signed           SignedDescriptor `json:"signed"`
}

type AuditEntry struct {
	ID                  string    `json:"id"`
	OperatorFingerprint string    `json:"operatorFingerprint"`
	Channel             string    `json:"channel"`
	FromSequence        int64     `json:"fromSequence"`
	ToSequence          int64     `json:"toSequence"`
	Version             string    `json:"version"`
	CreatedAt           time.Time `json:"createdAt"`
}

type StoreSnapshot struct {
	Channels map[string]map[string]ChannelView
	Audit    []AuditEntry
}

type storeDocument struct {
	SchemaVersion int                               `json:"schemaVersion"`
	Channels      map[string]map[string]ChannelView `json:"channels"`
	Audit         []AuditEntry                      `json:"audit"`
}

type Store struct {
	root string
	lock *flock.Flock

	mu     sync.RWMutex
	state  storeDocument
	closed bool
}

func OpenStore(ctx context.Context, root string) (*Store, error) {
	if ctx == nil || !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return nil, ErrUnsafeStore
	}
	if err := ensurePrivateStoreRoot(root); err != nil {
		return nil, err
	}
	lockPath := filepath.Join(root, storeLockName)
	fileLock := flock.New(lockPath, flock.SetPermissions(0o600))
	lockContext, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	locked, err := fileLock.TryLockContext(lockContext, 10*time.Millisecond)
	if err != nil || !locked {
		_ = fileLock.Close()
		return nil, ErrStoreInUse
	}
	if err := os.Chmod(lockPath, 0o600); err != nil {
		_ = fileLock.Unlock()
		_ = fileLock.Close()
		return nil, ErrUnsafeStore
	}
	state, err := loadStore(root)
	if err != nil {
		_ = fileLock.Unlock()
		_ = fileLock.Close()
		return nil, err
	}
	return &Store{root: root, lock: fileLock, state: state}, nil
}

func (store *Store) Close() error {
	if store == nil {
		return nil
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.closed {
		return nil
	}
	store.closed = true
	unlockErr := store.lock.Unlock()
	closeErr := store.lock.Close()
	if unlockErr != nil {
		return unlockErr
	}
	return closeErr
}

func (store *Store) Snapshot() (StoreSnapshot, error) {
	if store == nil {
		return StoreSnapshot{}, ErrCorruptStore
	}
	store.mu.RLock()
	defer store.mu.RUnlock()
	if store.closed {
		return StoreSnapshot{}, ErrCorruptStore
	}
	return snapshotFromDocument(store.state), nil
}

func (store *Store) Commit(commit ChannelCommit) ([]ChannelView, error) {
	if store == nil {
		return nil, ErrCorruptStore
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.closed {
		return nil, ErrCorruptStore
	}
	current := store.state.Channels[commit.Channel]
	currentSequence := int64(0)
	for _, value := range current {
		if currentSequence == 0 {
			currentSequence = value.Sequence
		} else if currentSequence != value.Sequence {
			return nil, ErrCorruptStore
		}
	}
	if commit.ExpectedSequence != currentSequence {
		return nil, ErrRevisionConflict
	}
	views, err := validateCommit(commit, currentSequence+1)
	if err != nil {
		return nil, err
	}
	next := cloneDocument(store.state)
	next.Channels[commit.Channel] = make(map[string]ChannelView, len(views))
	for _, value := range views {
		next.Channels[commit.Channel][value.Target] = value
	}
	next.Audit = append(next.Audit, AuditEntry{
		ID:                  commit.AuditID,
		OperatorFingerprint: hex.EncodeToString(commit.OperatorFingerprint),
		Channel:             commit.Channel, FromSequence: currentSequence,
		ToSequence: currentSequence + 1, Version: commit.Version,
		CreatedAt: commit.IssuedAt.UTC(),
	})
	if len(next.Audit) > maximumAuditEntries {
		next.Audit = append([]AuditEntry(nil), next.Audit[len(next.Audit)-maximumAuditEntries:]...)
	}
	if err := writeStore(store.root, next); err != nil {
		return nil, err
	}
	store.state = next
	return append([]ChannelView(nil), views...), nil
}

func validateCommit(commit ChannelCommit, sequence int64) ([]ChannelView, error) {
	if (commit.Channel != "stable" && commit.Channel != "canary") ||
		commit.ExpectedSequence < 0 || sequence < 1 ||
		!versionPattern.MatchString(commit.Version) ||
		len(commit.CatalogSHA256) != sha256.Size ||
		commit.IssuedAt.IsZero() || len(commit.OperatorFingerprint) != sha256.Size ||
		len(commit.Signed) != 2 {
		return nil, ErrInvalidDescriptor
	}
	parsedAuditID, err := uuid.Parse(commit.AuditID)
	if err != nil || parsedAuditID.Version() != 7 {
		return nil, ErrInvalidDescriptor
	}
	views := make([]ChannelView, 0, 2)
	for _, target := range []string{"darwin-arm64", "linux-amd64"} {
		signed, ok := commit.Signed[target]
		if !ok {
			return nil, ErrInvalidDescriptor
		}
		descriptor, payload, err := decodeStoredDescriptor(signed)
		if err != nil || descriptor.Channel != commit.Channel ||
			descriptor.Target != target || descriptor.Sequence != sequence ||
			descriptor.ExpectedVersion != commit.Version ||
			!bytes.Equal(descriptor.CatalogSHA256, commit.CatalogSHA256) ||
			!descriptor.IssuedAt.Equal(commit.IssuedAt.UTC()) {
			return nil, ErrInvalidDescriptor
		}
		digest := sha256.Sum256(payload)
		views = append(views, ChannelView{
			Channel: commit.Channel, Target: target, Sequence: sequence,
			ExpectedVersion:  commit.Version,
			CatalogSHA256:    hex.EncodeToString(commit.CatalogSHA256),
			DescriptorSHA256: hex.EncodeToString(digest[:]),
			IssuedAt:         commit.IssuedAt.UTC(), KeyID: signed.Signature.KeyID,
			Signed: signed,
		})
	}
	return views, nil
}

func decodeStoredDescriptor(signed SignedDescriptor) (ChannelDescriptor, []byte, error) {
	if signed.SchemaVersion != 1 || signed.Signature.Algorithm != "ed25519" ||
		!keyIDPattern.MatchString(signed.Signature.KeyID) {
		return ChannelDescriptor{}, nil, ErrInvalidDescriptor
	}
	if signature, err := base64.RawURLEncoding.DecodeString(signed.Signature.Value); err != nil ||
		len(signature) != ed25519.SignatureSize {
		return ChannelDescriptor{}, nil, ErrInvalidDescriptor
	}
	payload, err := base64.RawURLEncoding.DecodeString(signed.Payload)
	if err != nil || len(payload) == 0 || len(payload) > 3*1024 {
		return ChannelDescriptor{}, nil, ErrInvalidDescriptor
	}
	var document descriptorDocument
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil || requireJSONEOF(decoder) != nil {
		return ChannelDescriptor{}, nil, ErrInvalidDescriptor
	}
	canonical, err := json.Marshal(document)
	if err != nil || !bytes.Equal(canonical, payload) {
		return ChannelDescriptor{}, nil, ErrInvalidDescriptor
	}
	descriptor, err := descriptorFromDocument(document)
	return descriptor, payload, err
}

func ensurePrivateStoreRoot(root string) error {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return ErrUnsafeStore
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		info.Mode().Perm()&0o077 != 0 {
		return ErrUnsafeStore
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Geteuid() {
		return ErrUnsafeStore
	}
	return nil
}

func loadStore(root string) (storeDocument, error) {
	initial := storeDocument{
		SchemaVersion: 1,
		Channels:      map[string]map[string]ChannelView{},
		Audit:         []AuditEntry{},
	}
	path := filepath.Join(root, storeFileName)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return initial, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o177 != 0 ||
		info.Size() <= 0 || info.Size() > maximumStoreBytes {
		return storeDocument{}, ErrCorruptStore
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return storeDocument{}, ErrCorruptStore
	}
	var value storeDocument
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil || requireJSONEOF(decoder) != nil ||
		validateDocument(value) != nil {
		return storeDocument{}, ErrCorruptStore
	}
	return value, nil
}

func validateDocument(value storeDocument) error {
	if value.SchemaVersion != 1 || value.Channels == nil || value.Audit == nil ||
		len(value.Channels) > 2 || len(value.Audit) > maximumAuditEntries {
		return ErrCorruptStore
	}
	for channel, targets := range value.Channels {
		if (channel != "stable" && channel != "canary") || len(targets) != 2 {
			return ErrCorruptStore
		}
		sequence := int64(0)
		for target, view := range targets {
			if (target != "darwin-arm64" && target != "linux-amd64") ||
				view.Channel != channel || view.Target != target || view.Sequence < 1 ||
				!versionPattern.MatchString(view.ExpectedVersion) ||
				len(view.CatalogSHA256) != 64 || len(view.DescriptorSHA256) != 64 ||
				view.IssuedAt.IsZero() || !keyIDPattern.MatchString(view.KeyID) {
				return ErrCorruptStore
			}
			if sequence == 0 {
				sequence = view.Sequence
			} else if sequence != view.Sequence {
				return ErrCorruptStore
			}
			if descriptor, payload, err := decodeStoredDescriptor(view.Signed); err != nil ||
				descriptor.Channel != channel || descriptor.Target != target ||
				descriptor.Sequence != view.Sequence ||
				descriptor.ExpectedVersion != view.ExpectedVersion ||
				hex.EncodeToString(descriptor.CatalogSHA256) != view.CatalogSHA256 ||
				hex.EncodeToString(sha256Sum(payload)) != view.DescriptorSHA256 {
				return ErrCorruptStore
			}
		}
	}
	return nil
}

func writeStore(root string, value storeDocument) error {
	encoded, err := json.Marshal(value)
	if err != nil || int64(len(encoded)) > maximumStoreBytes {
		return ErrCorruptStore
	}
	path := filepath.Join(root, storeFileName)
	temporary, err := os.CreateTemp(root, ".channels-*.tmp")
	if err != nil {
		return ErrCorruptStore
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err == nil {
		_, err = temporary.Write(encoded)
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil || os.Rename(temporaryPath, path) != nil {
		return ErrCorruptStore
	}
	directory, err := os.Open(root)
	if err != nil {
		return ErrCorruptStore
	}
	syncErr := directory.Sync()
	closeErr := directory.Close()
	if syncErr != nil {
		return ErrCorruptStore
	}
	if closeErr != nil {
		return ErrCorruptStore
	}
	return nil
}

func cloneDocument(value storeDocument) storeDocument {
	result := storeDocument{
		SchemaVersion: value.SchemaVersion,
		Channels:      make(map[string]map[string]ChannelView, len(value.Channels)),
		Audit:         append([]AuditEntry(nil), value.Audit...),
	}
	for channel, targets := range value.Channels {
		result.Channels[channel] = make(map[string]ChannelView, len(targets))
		for target, view := range targets {
			result.Channels[channel][target] = cloneView(view)
		}
	}
	return result
}

func snapshotFromDocument(value storeDocument) StoreSnapshot {
	cloned := cloneDocument(value)
	return StoreSnapshot{Channels: cloned.Channels, Audit: cloned.Audit}
}

func cloneView(value ChannelView) ChannelView {
	return value
}

func sha256Sum(value []byte) []byte {
	digest := sha256.Sum256(value)
	return digest[:]
}
