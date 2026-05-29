//go:build vfs
// +build vfs

package litestream

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	_ "unsafe"

	lru "github.com/hashicorp/golang-lru/v2"
	"github.com/psanford/sqlite3vfs"
	"github.com/superfly/ltx"
)

const (
	DefaultPollInterval = 1 * time.Second
	DefaultCacheSize    = 10 * 1024 * 1024 // 10MB
	DefaultPageSize     = 4096             // SQLite default page size

	pageFetchRetryAttempts = 6
	pageFetchRetryDelay    = 15 * time.Millisecond
)

// ErrConflict is returned when the remote replica has newer transactions than expected.
var ErrConflict = errors.New("remote has newer transactions than expected")

var errPageNotFound = errors.New("page not found")

var (
	//go:linkname sqlite3vfsFileMap github.com/psanford/sqlite3vfs.fileMap
	sqlite3vfsFileMap map[uint64]sqlite3vfs.File

	//go:linkname sqlite3vfsFileMux github.com/psanford/sqlite3vfs.fileMux
	sqlite3vfsFileMux sync.Mutex

	vfsConnectionMap sync.Map // map[uintptr]uint64
)

// VFS implements the SQLite VFS interface for Litestream.
// It is intended to be used for read replicas that read directly from S3.
// When WriteEnabled is true, also supports writes with periodic sync.
type VFS struct {
	client ReplicaClient
	logger *slog.Logger

	// PollInterval is the interval at which to poll the replica client for new
	// LTX files. The index will be fetched for the new files automatically.
	PollInterval time.Duration

	// CacheSize is the maximum size of the page cache in bytes.
	CacheSize int

	// WriteEnabled activates write support for the VFS.
	WriteEnabled bool

	// WriteSyncInterval is how often to sync dirty pages to remote storage.
	// If zero, defaults to DefaultSyncInterval (1 second).
	WriteSyncInterval time.Duration

	// WriteBufferPath is the path for local write buffer persistence.
	// If empty, uses a temp file.
	WriteBufferPath string

	// HydrationEnabled activates background hydration of the database to a local file.
	// When enabled, the VFS will restore the database in the background and serve
	// reads from the local file once complete, eliminating remote fetch latency.
	HydrationEnabled bool

	// HydrationPath is the file path for local hydration file.
	// If empty and HydrationEnabled is true, a temp file will be used.
	HydrationPath string

	// CompactionEnabled activates background compaction for the VFS.
	// Requires WriteEnabled to be true.
	CompactionEnabled bool

	// CompactionLevels defines the compaction intervals for each level.
	// If nil, uses default compaction levels.
	CompactionLevels CompactionLevels

	// SnapshotInterval is how often to create full database snapshots.
	// Set to 0 to disable automatic snapshots.
	SnapshotInterval time.Duration

	// SnapshotRetention is how long to keep old snapshots.
	// Set to 0 to keep all snapshots.
	SnapshotRetention time.Duration

	// L0Retention is how long to keep L0 files after compaction into L1.
	// Set to 0 to delete immediately after compaction.
	L0Retention time.Duration

	writeMu        sync.Mutex
	writeFile      *VFSFile // current RESERVED lock holder (nil if none)
	lastSyncedTXID ltx.TXID // highest TXID synced by any local connection
	writeSeq       uint64   // atomic counter for unique buffer paths
	openFiles      sync.Map // *VFSFile -> struct{}

	tempDirOnce sync.Once
	tempDir     string
	tempDirErr  error
	tempFiles   sync.Map // canonical name -> absolute path
	tempNames   sync.Map // canonical name -> struct{}{}
}

// MaintenanceOptions controls a one-shot compaction/snapshot pass.
type MaintenanceOptions struct {
	Snapshot                 bool
	CompactLevel             int
	EnforceSnapshotRetention bool
	SnapshotRetention        time.Duration
	EnforceL0Retention       bool
	L0Retention              time.Duration
}

// MaintenanceStats summarizes a one-shot compaction/snapshot pass.
type MaintenanceStats struct {
	OpenFiles                int
	SnapshotCreated          bool
	SnapshotSkipped          bool
	SnapshotSkipReason       string
	SnapshotMinTXID          uint64
	SnapshotMaxTXID          uint64
	SnapshotSize             int64
	Compacted                bool
	CompactionSkipped        bool
	CompactionSkipReason     string
	CompactionLevel          int
	CompactionMinTXID        uint64
	CompactionMaxTXID        uint64
	CompactionSize           int64
	SnapshotRetentionMinTXID uint64
	L0RetentionEnforced      bool
}

func NewVFS(client ReplicaClient, logger *slog.Logger) *VFS {
	return &VFS{
		client:       client,
		logger:       logger.With("vfs", "true"),
		PollInterval: DefaultPollInterval,
		CacheSize:    DefaultCacheSize,
	}
}

func (vfs *VFS) Open(name string, flags sqlite3vfs.OpenFlag) (sqlite3vfs.File, sqlite3vfs.OpenFlag, error) {
	slog.Debug("opening file", "name", name, "flags", flags)

	switch {
	case flags&sqlite3vfs.OpenMainDB != 0:
		return vfs.openMainDB(name, flags)
	case vfs.requiresTempFile(flags):
		return vfs.openTempFile(name, flags)
	default:
		return nil, flags, sqlite3vfs.CantOpenError
	}
}

func (vfs *VFS) openMainDB(name string, flags sqlite3vfs.OpenFlag) (sqlite3vfs.File, sqlite3vfs.OpenFlag, error) {
	f := NewVFSFile(vfs.client, name, vfs.logger.With("name", name))
	f.PollInterval = vfs.PollInterval
	f.CacheSize = vfs.CacheSize
	f.vfs = vfs // Store reference to parent VFS for config access

	// Initialize write support if enabled
	if vfs.WriteEnabled {
		f.writeEnabled = true
		f.dirty = make(map[uint32]int64)
		f.syncInterval = vfs.WriteSyncInterval
		if f.syncInterval == 0 {
			f.syncInterval = DefaultSyncInterval
		}

		writeSeq := atomic.AddUint64(&vfs.writeSeq, 1)
		if vfs.WriteBufferPath != "" {
			if writeSeq == 1 {
				f.bufferPath = vfs.WriteBufferPath
			} else {
				f.bufferPath = vfs.WriteBufferPath + "." + strconv.FormatUint(writeSeq, 10)
			}
		} else {
			dir, err := vfs.ensureTempDir()
			if err != nil {
				return nil, 0, fmt.Errorf("create temp dir for write buffer: %w", err)
			}
			f.bufferPath = filepath.Join(dir, "write-buffer-"+strconv.FormatUint(writeSeq, 10))
		}

		// Initialize compaction if enabled
		if vfs.CompactionEnabled {
			f.compactor = NewCompactor(vfs.client, f.logger)
			// VFS has no local files, so leave LocalFileOpener/LocalFileDeleter nil
		}
	}

	// Initialize hydration support if enabled
	if vfs.HydrationEnabled {
		if vfs.HydrationPath != "" {
			f.hydrationPath = vfs.HydrationPath
			f.hydrationPersistent = true
		} else {
			// Use a temp file if no path specified
			dir, err := vfs.ensureTempDir()
			if err != nil {
				return nil, 0, fmt.Errorf("create temp dir for hydration: %w", err)
			}
			f.hydrationPath = filepath.Join(dir, "hydration.db")
		}
	}

	if err := f.Open(); err != nil {
		return nil, 0, err
	}
	vfs.openFiles.Store(f, struct{}{})

	if vfs.WriteEnabled {
		vfs.writeMu.Lock()
		if f.expectedTXID > vfs.lastSyncedTXID {
			vfs.lastSyncedTXID = f.expectedTXID
		}
		vfs.writeMu.Unlock()
	}

	// When SQLite requests read-write access, always report ReadWrite in the
	// output flags so that cold enable via PRAGMA litestream_write_enabled
	// works. SQLite permanently marks databases as read-only based on the
	// output flags from xOpen (pager.c:readOnly, btree.c:BTS_READ_ONLY),
	// which would prevent write transactions even after enabling writes at
	// runtime. Read-only enforcement happens at the VFS layer (WriteAt,
	// Truncate, Lock) when writeEnabled is false.
	//
	// If the caller explicitly requested read-only, we respect that intent.
	if flags&sqlite3vfs.OpenReadOnly == 0 {
		flags &^= sqlite3vfs.OpenReadOnly
		flags |= sqlite3vfs.OpenReadWrite
	}

	return f, flags, nil
}

// SyncWrites actively flushes dirty writable-VFS connections to the replica.
// Durability barriers use this so they do not wait for WriteSyncInterval.
func (vfs *VFS) SyncWrites(ctx context.Context) error {
	var errs []error
	vfs.openFiles.Range(func(key, _ any) bool {
		select {
		case <-ctx.Done():
			errs = append(errs, ctx.Err())
			return false
		default:
		}
		f, ok := key.(*VFSFile)
		if !ok || f == nil {
			return true
		}
		if err := f.Sync(0); err != nil {
			errs = append(errs, err)
		}
		return true
	})
	return errors.Join(errs...)
}

func (vfs *VFS) Delete(name string, dirSync bool) error {
	slog.Debug("deleting file", "name", name, "dirSync", dirSync)
	err := vfs.deleteTempFile(name)
	if err == nil {
		return nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if errors.Is(err, errTempFileNotFound) {
		return fmt.Errorf("cannot delete vfs file")
	}
	return err
}

func (vfs *VFS) Access(name string, flag sqlite3vfs.AccessFlag) (bool, error) {
	slog.Debug("accessing file", "name", name, "flag", flag)

	if strings.HasSuffix(name, "-wal") {
		return vfs.accessWAL(name, flag)
	}
	if vfs.isTempFileName(name) {
		return vfs.accessTempFile(name, flag)
	}
	return false, nil
}

func (vfs *VFS) accessWAL(name string, flag sqlite3vfs.AccessFlag) (bool, error) {
	return false, nil
}

func (vfs *VFS) FullPathname(name string) string {
	slog.Debug("full pathname", "name", name)
	return name
}

func (vfs *VFS) requiresTempFile(flags sqlite3vfs.OpenFlag) bool {
	const tempMask = sqlite3vfs.OpenTempDB |
		sqlite3vfs.OpenTempJournal |
		sqlite3vfs.OpenSubJournal |
		sqlite3vfs.OpenSuperJournal |
		sqlite3vfs.OpenTransientDB |
		sqlite3vfs.OpenMainJournal
	if flags&tempMask != 0 {
		return true
	}
	return flags&sqlite3vfs.OpenDeleteOnClose != 0
}

func (vfs *VFS) ensureTempDir() (string, error) {
	vfs.tempDirOnce.Do(func() {
		dir, err := os.MkdirTemp("", "litestream-vfs-*")
		if err != nil {
			vfs.tempDirErr = fmt.Errorf("create temp dir: %w", err)
			return
		}
		vfs.tempDir = dir
	})
	return vfs.tempDir, vfs.tempDirErr
}

func (vfs *VFS) canonicalTempName(name string) string {
	if name == "" {
		return ""
	}
	name = filepath.Clean(name)
	if name == "." || name == string(filepath.Separator) {
		return ""
	}
	return name
}

func tempFilenameFromCanonical(canonical string) (string, error) {
	base := filepath.Base(canonical)
	if base == "." || base == string(filepath.Separator) {
		return "", fmt.Errorf("invalid temp file name: %q", canonical)
	}

	h := fnv.New64a()
	if _, err := h.Write([]byte(canonical)); err != nil {
		return "", fmt.Errorf("hash temp name: %w", err)
	}
	return fmt.Sprintf("%s-%016x", base, h.Sum64()), nil
}

func (vfs *VFS) openTempFile(name string, flags sqlite3vfs.OpenFlag) (sqlite3vfs.File, sqlite3vfs.OpenFlag, error) {
	dir, err := vfs.ensureTempDir()
	if err != nil {
		return nil, flags, err
	}
	deleteOnClose := flags&sqlite3vfs.OpenDeleteOnClose != 0 || name == ""
	var f *os.File
	var onClose func()
	if name == "" {
		f, err = os.CreateTemp(dir, "temp-*")
		if err != nil {
			return nil, flags, sqlite3vfs.CantOpenError
		}
	} else {
		canonical := vfs.canonicalTempName(name)
		if canonical == "" {
			return nil, flags, sqlite3vfs.CantOpenError
		}
		fname, err := tempFilenameFromCanonical(canonical)
		if err != nil {
			return nil, flags, sqlite3vfs.CantOpenError
		}
		path := filepath.Join(dir, fname)
		flag := openFlagToOSFlag(flags)
		if flag == 0 {
			flag = os.O_RDWR
		}
		f, err = os.OpenFile(path, flag|os.O_CREATE, 0o600)
		if err != nil {
			return nil, flags, sqlite3vfs.CantOpenError
		}
		onClose = vfs.trackTempFile(canonical, path)
	}

	return newLocalTempFile(f, deleteOnClose, onClose), flags, nil
}

func (vfs *VFS) deleteTempFile(name string) error {
	path, ok := vfs.loadTempFilePath(name)
	if !ok {
		if vfs.wasTempFileName(name) {
			vfs.unregisterTempFile(name)
			return os.ErrNotExist
		}
		return errTempFileNotFound
	}
	if err := os.Remove(path); err != nil {
		if !os.IsNotExist(err) {
			return err
		}
	}
	vfs.unregisterTempFile(name)
	return nil
}

func (vfs *VFS) isTempFileName(name string) bool {
	_, ok := vfs.loadTempFilePath(name)
	return ok
}

func (vfs *VFS) wasTempFileName(name string) bool {
	canonical := vfs.canonicalTempName(name)
	if canonical == "" {
		return false
	}
	_, ok := vfs.tempNames.Load(canonical)
	return ok
}

func (vfs *VFS) unregisterTempFile(name string) {
	canonical := vfs.canonicalTempName(name)
	if canonical == "" {
		return
	}
	vfs.tempFiles.Delete(canonical)
}

func (vfs *VFS) accessTempFile(name string, flag sqlite3vfs.AccessFlag) (bool, error) {
	path, ok := vfs.loadTempFilePath(name)
	if !ok {
		return false, nil
	}
	_, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func (vfs *VFS) trackTempFile(canonical, path string) func() {
	if canonical == "" {
		return func() {}
	}
	vfs.tempFiles.Store(canonical, path)
	vfs.tempNames.Store(canonical, struct{}{})
	return func() { vfs.tempFiles.Delete(canonical) }
}

func (vfs *VFS) loadTempFilePath(name string) (string, bool) {
	canonical := vfs.canonicalTempName(name)
	if canonical == "" {
		return "", false
	}
	if path, ok := vfs.tempFiles.Load(canonical); ok {
		return path.(string), true
	}
	return "", false
}

func openFlagToOSFlag(flag sqlite3vfs.OpenFlag) int {
	var v int
	if flag&sqlite3vfs.OpenReadWrite != 0 {
		v |= os.O_RDWR
	} else if flag&sqlite3vfs.OpenReadOnly != 0 {
		v |= os.O_RDONLY
	}
	if flag&sqlite3vfs.OpenCreate != 0 {
		v |= os.O_CREATE
	}
	if flag&sqlite3vfs.OpenExclusive != 0 {
		v |= os.O_EXCL
	}
	return v
}

var errTempFileNotFound = fmt.Errorf("temp file not tracked")

// localTempFile fulfills sqlite3vfs.File solely for SQLite temp & transient files.
// These files stay on the local filesystem and optionally delete themselves
// when SQLite closes them (DeleteOnClose flag).
type localTempFile struct {
	f             *os.File
	deleteOnClose bool
	lockType      atomic.Int32
	onClose       func()
}

func newLocalTempFile(f *os.File, deleteOnClose bool, onClose func()) *localTempFile {
	return &localTempFile{f: f, deleteOnClose: deleteOnClose, onClose: onClose}
}

func (tf *localTempFile) Close() error {
	err := tf.f.Close()
	if tf.deleteOnClose {
		if removeErr := os.Remove(tf.f.Name()); removeErr != nil && !os.IsNotExist(removeErr) && err == nil {
			err = removeErr
		}
	}
	if tf.onClose != nil {
		tf.onClose()
	}
	return err
}

func (tf *localTempFile) ReadAt(p []byte, off int64) (n int, err error) {
	return tf.f.ReadAt(p, off)
}

func (tf *localTempFile) WriteAt(b []byte, off int64) (n int, err error) {
	return tf.f.WriteAt(b, off)
}

func (tf *localTempFile) Truncate(size int64) error {
	return tf.f.Truncate(size)
}

func (tf *localTempFile) Sync(flag sqlite3vfs.SyncType) error {
	return tf.f.Sync()
}

func (tf *localTempFile) FileSize() (int64, error) {
	info, err := tf.f.Stat()
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

func (tf *localTempFile) Lock(elock sqlite3vfs.LockType) error {
	if elock == sqlite3vfs.LockNone {
		return nil
	}
	tf.lockType.Store(int32(elock))
	return nil
}

func (tf *localTempFile) Unlock(elock sqlite3vfs.LockType) error {
	tf.lockType.Store(int32(elock))
	return nil
}

func (tf *localTempFile) CheckReservedLock() (bool, error) {
	return sqlite3vfs.LockType(tf.lockType.Load()) >= sqlite3vfs.LockReserved, nil
}

func (tf *localTempFile) SectorSize() int64 {
	return 0
}

func (tf *localTempFile) DeviceCharacteristics() sqlite3vfs.DeviceCharacteristic {
	return 0
}

// VFSFile implements the SQLite VFS file interface.
type localViewState struct {
	pos            ltx.Pos  // Last TXID visible in the live local view
	maxTXID1       ltx.TXID // Last level-1 TXID merged into the local view
	index          map[uint32]ltx.PageIndexElem
	commit         uint32
	baseCommit     uint32 // Highest commit whose remote-backed clean pages remain valid for local reads
	pending        map[uint32]ltx.PageIndexElem
	pendingReplace bool
}

type remoteViewState struct {
	remotePos      ltx.Pos  // Last TXID in the remote recoverable view
	remoteMaxTXID1 ltx.TXID // Last level-1 TXID in the remote recoverable view
	remoteIndex    map[uint32]ltx.PageIndexElem
	remoteCommit   uint32
}

type writeState struct {
	dirty         map[uint32]int64 // Dirty pages: pgno -> offset in buffer file
	pendingTXID   ltx.TXID         // Next TXID to use for sync
	expectedTXID  ltx.TXID         // Expected remote TXID (for conflict detection)
	bufferFile    *os.File         // Temp file for durability
	bufferPath    string           // Path to buffer file
	bufferNextOff int64            // Next write offset in buffer file
	syncTicker    *time.Ticker     // Ticker for periodic sync
	syncInterval  time.Duration    // Interval for periodic sync
	syncStop      chan struct{}    // Signal to stop sync loop
	inTransaction bool             // True during active write transaction
	disabling     bool             // True when write disable is in progress
}

type remoteUpdateKind int

const (
	remoteUpdateFromRebuild remoteUpdateKind = iota
	remoteUpdateFromSync
	remoteUpdateFromPoll
	remoteUpdateFromCompaction
)

type VFSFile struct {
	mu     sync.Mutex
	client ReplicaClient
	name   string

	localViewState
	remoteViewState
	cache           *lru.Cache[uint32, []byte] // LRU cache for page data
	targetTime      *time.Time                 // Target view time; nil means latest
	latestLTXTime   time.Time                  // Timestamp of most recent LTX file
	lastPollSuccess time.Time                  // Time of last successful poll
	lockType        sqlite3vfs.LockType        // Current lock state
	pageSize        uint32

	// Write support fields (only used when writeEnabled is true)
	writeEnabled bool // Whether write support is enabled
	writeState
	cond *sync.Cond // Signals transaction state changes

	hydrator            *Hydrator // Background hydration (nil if disabled)
	hydrationPath       string    // Path for hydration file (set during Open)
	hydrationPersistent bool      // True when using user-specified persistent path

	wg     sync.WaitGroup
	ctx    context.Context
	cancel context.CancelFunc

	logger *slog.Logger

	PollInterval time.Duration
	CacheSize    int

	// Compaction support (only used when VFS.CompactionEnabled is true)
	vfs              *VFS       // Reference back to parent VFS for config
	compactor        *Compactor // Shared compaction logic
	compactionWg     sync.WaitGroup
	compactionCtx    context.Context
	compactionCancel context.CancelFunc
}

func clonePageIndexMap(src map[uint32]ltx.PageIndexElem) map[uint32]ltx.PageIndexElem {
	dst := make(map[uint32]ltx.PageIndexElem, len(src))
	for pgno, elem := range src {
		dst[pgno] = elem
	}
	return dst
}

func (f *VFSFile) replaceAllViewsLocked(index map[uint32]ltx.PageIndexElem, commit uint32, pos ltx.Pos, maxTXID1 ltx.TXID) {
	f.index = clonePageIndexMap(index)
	f.remoteIndex = clonePageIndexMap(index)
	f.pending = make(map[uint32]ltx.PageIndexElem)
	f.pendingReplace = false
	f.pos = pos
	f.remotePos = pos
	f.maxTXID1 = maxTXID1
	f.remoteMaxTXID1 = maxTXID1
	f.commit = commit
	f.remoteCommit = commit
	f.baseCommit = commit
}

func (f *VFSFile) applyRemoteSyncLocked(txid ltx.TXID, commit uint32, idx map[uint32]ltx.PageIndexElem) {
	f.expectedTXID = txid
	f.pendingTXID = txid + 1
	f.pos = ltx.Pos{TXID: txid}
	f.remotePos = f.pos
	f.remoteCommit = commit
	f.baseCommit = commit
	for pgno := range f.index {
		if pgno > commit {
			delete(f.index, pgno)
		}
	}
	for pgno, elem := range idx {
		f.remoteIndex[pgno] = elem
		f.index[pgno] = elem
	}
}

func (f *VFSFile) shouldReplaceRemoteViewLocked(kind remoteUpdateKind, info *ltx.FileInfo, hdr ltx.Header) bool {
	switch kind {
	case remoteUpdateFromRebuild:
		return true
	case remoteUpdateFromCompaction:
		// Compaction files rewrite page locations for older TX ranges, but they
		// are not a complete replacement of the latest remote recoverable view.
		return info != nil && info.Level == SnapshotLevel && hdr.Commit < f.remoteCommit
	case remoteUpdateFromPoll:
		return hdr.Commit < f.remoteCommit
	default:
		return false
	}
}

func (f *VFSFile) applyRemoteIndexLocked(kind remoteUpdateKind, info *ltx.FileInfo, idx map[uint32]ltx.PageIndexElem, commit uint32, pos ltx.Pos, maxTXID1 ltx.TXID) {
	if f.remoteIndex == nil {
		f.remoteIndex = make(map[uint32]ltx.PageIndexElem)
	}
	if f.shouldReplaceRemoteViewLocked(kind, info, ltx.Header{Commit: commit}) {
		f.remoteIndex = make(map[uint32]ltx.PageIndexElem)
		if f.cache != nil {
			f.cache.Purge()
		}
	}
	for pgno, elem := range idx {
		f.remoteIndex[pgno] = elem
	}
	if commit > 0 {
		f.remoteCommit = commit
	}
	if pos.TXID > f.remotePos.TXID {
		f.remotePos = pos
	}
	if maxTXID1 > f.remoteMaxTXID1 {
		f.remoteMaxTXID1 = maxTXID1
	}
}

func (f *VFSFile) applyCompactionToLocalCleanPagesLocked(idx map[uint32]ltx.PageIndexElem) {
	if !f.writeEnabled {
		return
	}
	for pgno, elem := range idx {
		if pgno > f.baseCommit {
			continue
		}
		if _, dirty := f.dirty[pgno]; dirty {
			continue
		}
		f.index[pgno] = elem
	}
}

func (f *VFSFile) applyPollResultLocked(writeEnabled bool, replaceIndex bool, combined map[uint32]ltx.PageIndexElem, newCommit uint32, maxTXID0, maxTXID1 ltx.TXID) {
	invalidateN := 0
	target := f.index
	targetIsMain := true
	if writeEnabled {
		if f.remoteIndex == nil {
			f.remoteIndex = make(map[uint32]ltx.PageIndexElem)
		}
		target = f.remoteIndex
		targetIsMain = false
		f.pendingReplace = false
	} else if f.lockType >= sqlite3vfs.LockShared {
		target = f.pending
		targetIsMain = false
	} else {
		f.pendingReplace = false
	}
	if replaceIndex {
		if writeEnabled {
			f.remoteIndex = make(map[uint32]ltx.PageIndexElem)
			target = f.remoteIndex
			targetIsMain = false
			f.pendingReplace = false
		} else if f.lockType < sqlite3vfs.LockShared {
			f.index = make(map[uint32]ltx.PageIndexElem)
			target = f.index
			targetIsMain = true
			f.pendingReplace = false
		} else {
			f.pending = make(map[uint32]ltx.PageIndexElem)
			target = f.pending
			targetIsMain = false
			f.pendingReplace = true
		}
	}
	for k, v := range combined {
		target[k] = v
		if targetIsMain {
			f.cache.Remove(k)
			invalidateN++
		}
	}
	if invalidateN > 0 {
		f.logger.Debug("cache invalidated pages due to new ltx files", "count", invalidateN)
	}

	if writeEnabled {
		if replaceIndex {
			f.remoteCommit = newCommit
		} else if len(combined) > 0 && newCommit > f.remoteCommit {
			f.remoteCommit = newCommit
		}
		if maxTXID0 > maxTXID1 {
			f.remotePos.TXID = maxTXID0
		} else {
			f.remotePos.TXID = maxTXID1
		}
		f.remoteMaxTXID1 = maxTXID1
		f.logger.Debug("remote txid updated", "txid", f.remotePos.TXID.String(), "maxTXID1", f.remoteMaxTXID1.String())
		return
	}

	if replaceIndex {
		f.commit = newCommit
	} else if len(combined) > 0 && newCommit > f.commit {
		f.commit = newCommit
	}
	if maxTXID0 > maxTXID1 {
		f.pos.TXID = maxTXID0
	} else {
		f.pos.TXID = maxTXID1
	}
	f.maxTXID1 = maxTXID1
	f.logger.Debug("txid updated", "txid", f.pos.TXID.String(), "maxTXID1", f.maxTXID1.String())
}

func (f *VFSFile) remoteSnapshotState() (pageSize uint32, commit uint32, pos ltx.Pos, pages map[uint32]ltx.PageIndexElem) {
	f.mu.Lock()
	defer f.mu.Unlock()

	pageSize = f.pageSize
	commit = f.remoteCommit
	pos = f.remotePos
	pages = make(map[uint32]ltx.PageIndexElem, len(f.remoteIndex))
	for pgno, elem := range f.remoteIndex {
		if pgno <= commit {
			pages[pgno] = elem
		}
	}
	return
}

func (f *VFSFile) applyRemoteFileInfo(ctx context.Context, info *ltx.FileInfo) error {
	idx, err := FetchPageIndex(ctx, f.client, info)
	if err != nil {
		return fmt.Errorf("fetch page index: %w", err)
	}
	hdr, err := FetchLTXHeader(ctx, f.client, info)
	if err != nil {
		return fmt.Errorf("fetch header: %w", err)
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	f.mergeRemoteFileInfoLocked(info, idx, hdr)
	return nil
}

func (f *VFSFile) mergeRemoteFileInfoLocked(info *ltx.FileInfo, idx map[uint32]ltx.PageIndexElem, hdr ltx.Header) {
	maxTXID1 := f.remoteMaxTXID1
	if info.Level == 1 && info.MaxTXID > maxTXID1 {
		maxTXID1 = info.MaxTXID
	}
	f.applyRemoteIndexLocked(remoteUpdateFromCompaction, info, idx, hdr.Commit, ltx.Pos{TXID: info.MaxTXID}, maxTXID1)
	f.applyCompactionToLocalCleanPagesLocked(idx)
}

type syncLTXResult struct {
	index map[uint32]ltx.PageIndexElem
	err   error
}

type countingWriter struct {
	w io.Writer
	n int64
}

func (w *countingWriter) Write(p []byte) (int, error) {
	n, err := w.w.Write(p)
	w.n += int64(n)
	return n, err
}

// Hydrator handles background hydration of the database to a local file.
type Hydrator struct {
	path       string         // Full path to hydration file
	persistent bool           // True when file should survive across restarts
	file       *os.File       // Local database file
	complete   atomic.Bool    // True when restore completes
	txid       ltx.TXID       // TXID the hydrated file is at
	mu         sync.Mutex     // Protects hydration file writes
	err        error          // Stores fatal hydration error
	compactor  *ltx.Compactor // Tracks compaction progress during restore
	pageSize   uint32         // Page size of the database
	client     ReplicaClient
	logger     *slog.Logger
}

// NewHydrator creates a new Hydrator instance.
func NewHydrator(path string, persistent bool, pageSize uint32, client ReplicaClient, logger *slog.Logger) *Hydrator {
	return &Hydrator{
		path:       path,
		persistent: persistent,
		pageSize:   pageSize,
		client:     client,
		logger:     logger,
	}
}

// Init opens or creates the hydration file.
func (h *Hydrator) Init() error {
	if err := os.MkdirAll(filepath.Dir(h.path), 0755); err != nil {
		return fmt.Errorf("create hydration directory: %w", err)
	}

	if h.persistent {
		if txid, err := h.loadMeta(); err == nil {
			if _, statErr := os.Stat(h.path); statErr == nil {
				file, err := os.OpenFile(h.path, os.O_RDWR, 0600)
				if err != nil {
					return fmt.Errorf("open persistent hydration file: %w", err)
				}
				h.file = file
				h.txid = txid
				return nil
			}
		}
		if err := os.Remove(h.metaPath()); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove stale hydration meta: %w", err)
		}
	}

	file, err := os.OpenFile(h.path, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("create hydration file: %w", err)
	}
	h.file = file
	return nil
}

// Complete returns true if hydration has completed.
func (h *Hydrator) Complete() bool {
	return h.complete.Load()
}

// SetComplete marks hydration as complete.
func (h *Hydrator) SetComplete() {
	h.complete.Store(true)
}

// Disable temporarily disables hydrated reads (used during time travel).
func (h *Hydrator) Disable() {
	h.complete.Store(false)
}

// TXID returns the current hydration TXID.
func (h *Hydrator) TXID() ltx.TXID {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.txid
}

// SetTXID sets the hydration TXID.
func (h *Hydrator) SetTXID(txid ltx.TXID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.txid = txid
}

// Err returns any fatal hydration error.
func (h *Hydrator) Err() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.err
}

// SetErr sets a fatal hydration error.
func (h *Hydrator) SetErr(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.err = err
}

// Status returns the current compaction progress during restore.
func (h *Hydrator) Status() ltx.CompactorStatus {
	if h.compactor == nil {
		return ltx.CompactorStatus{}
	}
	return h.compactor.Status()
}

// Restore restores the database from LTX files to the hydration file.
func (h *Hydrator) Restore(ctx context.Context, infos []*ltx.FileInfo) error {
	// Open all LTX files as readers
	rdrs := make([]io.Reader, 0, len(infos))
	defer func() {
		for _, rd := range rdrs {
			if closer, ok := rd.(io.Closer); ok {
				_ = closer.Close()
			}
		}
	}()

	for _, info := range infos {
		h.logger.Debug("opening ltx file for hydration", "level", info.Level, "min", info.MinTXID, "max", info.MaxTXID)
		rc, err := h.client.OpenLTXFile(ctx, info.Level, info.MinTXID, info.MaxTXID, 0, 0)
		if err != nil {
			return fmt.Errorf("open ltx file: %w", err)
		}
		rdrs = append(rdrs, rc)
	}

	if len(rdrs) == 0 {
		return fmt.Errorf("no ltx files for hydration")
	}

	// Compact and decode using io.Pipe pattern
	pr, pw := io.Pipe()
	c, err := ltx.NewCompactor(pw, rdrs)
	if err != nil {
		return fmt.Errorf("new ltx compactor: %w", err)
	}
	c.HeaderFlags = ltx.HeaderFlagNoChecksum
	h.compactor = c

	go func() {
		_ = pw.CloseWithError(c.Compact(ctx))
	}()

	h.mu.Lock()
	defer h.mu.Unlock()

	dec := ltx.NewDecoder(pr)
	if err := dec.DecodeDatabaseTo(h.file); err != nil {
		return fmt.Errorf("decode database: %w", err)
	}

	h.txid = infos[len(infos)-1].MaxTXID
	return nil
}

// CatchUp applies updates from LTX files between fromTXID and toTXID.
func (h *Hydrator) CatchUp(ctx context.Context, fromTXID, toTXID ltx.TXID) error {
	h.logger.Debug("catching up hydration", "from", fromTXID, "to", toTXID)

	// Fetch LTX files from fromTXID+1 to toTXID
	itr, err := h.client.LTXFiles(ctx, 0, fromTXID+1, false)
	if err != nil {
		return fmt.Errorf("list ltx files for catch-up: %w", err)
	}
	defer itr.Close()

	for itr.Next() {
		info := itr.Item()
		if info.MaxTXID > toTXID {
			break
		}

		if err := h.ApplyLTX(ctx, info); err != nil {
			return fmt.Errorf("apply ltx to hydrated file: %w", err)
		}

		h.mu.Lock()
		h.txid = info.MaxTXID
		h.mu.Unlock()
	}

	return nil
}

// ApplyLTX fetches an entire LTX file and applies its pages to the hydration file.
func (h *Hydrator) ApplyLTX(ctx context.Context, info *ltx.FileInfo) error {
	h.logger.Debug("applying ltx to hydration file", "level", info.Level, "min", info.MinTXID, "max", info.MaxTXID)

	// Fetch entire LTX file
	rc, err := h.client.OpenLTXFile(ctx, info.Level, info.MinTXID, info.MaxTXID, 0, 0)
	if err != nil {
		return fmt.Errorf("open ltx file: %w", err)
	}
	defer rc.Close()

	dec := ltx.NewDecoder(rc)
	if err := dec.DecodeHeader(); err != nil {
		return fmt.Errorf("decode header: %w", err)
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	// Apply each page to the hydration file
	for {
		var phdr ltx.PageHeader
		data := make([]byte, h.pageSize)
		if err := dec.DecodePage(&phdr, data); err == io.EOF {
			break
		} else if err != nil {
			return fmt.Errorf("decode page: %w", err)
		}

		off := int64(phdr.Pgno-1) * int64(h.pageSize)
		if _, err := h.file.WriteAt(data, off); err != nil {
			return fmt.Errorf("write page %d: %w", phdr.Pgno, err)
		}
	}

	return nil
}

// ReadAt reads data from the hydrated local file.
func (h *Hydrator) ReadAt(p []byte, off int64) (int, error) {
	h.mu.Lock()
	n, err := h.file.ReadAt(p, off)
	h.mu.Unlock()

	if err != nil && err != io.EOF {
		return n, fmt.Errorf("read hydrated file: %w", err)
	}

	// Update the first page to pretend like we are in journal mode
	if off == 0 && len(p) >= 28 {
		p[18], p[19] = 0x01, 0x01
		_, _ = rand.Read(p[24:28])
	}

	return n, nil
}

// ApplyUpdates fetches updated pages and writes them to the hydration file.
func (h *Hydrator) ApplyUpdates(ctx context.Context, updates map[uint32]ltx.PageIndexElem) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	for pgno, elem := range updates {
		_, data, err := FetchPage(ctx, h.client, elem.Level, elem.MinTXID, elem.MaxTXID, elem.Offset, elem.Size)
		if err != nil {
			return fmt.Errorf("fetch updated page %d: %w", pgno, err)
		}

		off := int64(pgno-1) * int64(h.pageSize)
		if _, err := h.file.WriteAt(data, off); err != nil {
			return fmt.Errorf("write updated page %d: %w", pgno, err)
		}
	}

	return nil
}

// WritePage writes a single page to the hydration file.
func (h *Hydrator) WritePage(pgno uint32, data []byte) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	off := int64(pgno-1) * int64(h.pageSize)
	if _, err := h.file.WriteAt(data, off); err != nil {
		return fmt.Errorf("write page %d to hydrated file: %w", pgno, err)
	}
	return nil
}

// Truncate truncates the hydration file to the specified size.
func (h *Hydrator) Truncate(size int64) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.file.Truncate(size)
}

// Close closes the hydration file. For persistent hydrators, the file and a
// companion .meta file are preserved so hydration can resume on the next open.
func (h *Hydrator) Close() error {
	if h.file == nil {
		return nil
	}

	if h.persistent && h.txid > 0 {
		if err := h.file.Sync(); err != nil {
			h.logger.Warn("failed to sync hydration file", "error", err)
		}
		if err := h.saveMeta(); err != nil {
			h.logger.Warn("failed to save hydration meta", "error", err)
		}
		return h.file.Close()
	}

	if err := h.file.Close(); err != nil {
		return err
	}

	if err := os.Remove(h.path); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Remove(h.metaPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (h *Hydrator) metaPath() string {
	return h.path + ".meta"
}

func (h *Hydrator) loadMeta() (ltx.TXID, error) {
	data, err := os.ReadFile(h.metaPath())
	if err != nil {
		return 0, err
	}
	v, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse hydration meta: %w", err)
	}
	return ltx.TXID(v), nil
}

func (h *Hydrator) saveMeta() error {
	h.mu.Lock()
	txid := h.txid
	h.mu.Unlock()

	dir := filepath.Dir(h.metaPath())
	tmp, err := os.CreateTemp(dir, ".hydration-meta-*")
	if err != nil {
		return fmt.Errorf("create temp meta file: %w", err)
	}
	tmpPath := tmp.Name()

	if _, err := fmt.Fprintf(tmp, "%d\n", txid); err != nil {
		if closeErr := tmp.Close(); closeErr != nil {
			h.logger.Warn("failed to close temp meta file during cleanup", "error", closeErr)
		}
		if removeErr := os.Remove(tmpPath); removeErr != nil {
			h.logger.Warn("failed to remove temp meta file during cleanup", "error", removeErr)
		}
		return fmt.Errorf("write hydration meta: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		if closeErr := tmp.Close(); closeErr != nil {
			h.logger.Warn("failed to close temp meta file during cleanup", "error", closeErr)
		}
		if removeErr := os.Remove(tmpPath); removeErr != nil {
			h.logger.Warn("failed to remove temp meta file during cleanup", "error", removeErr)
		}
		return fmt.Errorf("sync temp meta file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		if removeErr := os.Remove(tmpPath); removeErr != nil {
			h.logger.Warn("failed to remove temp meta file during cleanup", "error", removeErr)
		}
		return fmt.Errorf("close temp meta file: %w", err)
	}
	if err := os.Rename(tmpPath, h.metaPath()); err != nil {
		if removeErr := os.Remove(tmpPath); removeErr != nil {
			h.logger.Warn("failed to remove temp meta file during cleanup", "error", removeErr)
		}
		return fmt.Errorf("rename hydration meta: %w", err)
	}
	if err := syncDir(filepath.Dir(h.metaPath())); err != nil {
		return fmt.Errorf("sync hydration meta directory: %w", err)
	}
	return nil
}

func syncDir(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func readSQLiteHeader(path string) (pageSize uint32, commit uint32, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	hdr := make([]byte, 100)
	if _, err := io.ReadFull(f, hdr); err != nil {
		return 0, 0, err
	}
	if string(hdr[:16]) != "SQLite format 3\x00" {
		return 0, 0, fmt.Errorf("invalid sqlite header")
	}
	pageSize = uint32(hdr[16])<<8 | uint32(hdr[17])
	if pageSize == 1 {
		pageSize = 65536
	}
	if !isSupportedPageSize(pageSize) {
		return 0, 0, fmt.Errorf("unsupported page size: %d", pageSize)
	}
	info, err := f.Stat()
	if err != nil {
		return 0, 0, err
	}
	if info.Size() == 0 {
		return 0, 0, fmt.Errorf("empty sqlite file")
	}
	commit = uint32(hdr[28])<<24 | uint32(hdr[29])<<16 | uint32(hdr[30])<<8 | uint32(hdr[31])
	if commit == 0 {
		commit = uint32(info.Size() / int64(pageSize))
	}
	return pageSize, commit, nil
}

func NewVFSFile(client ReplicaClient, name string, logger *slog.Logger) *VFSFile {
	f := &VFSFile{
		client: client,
		name:   name,
		localViewState: localViewState{
			index:   make(map[uint32]ltx.PageIndexElem),
			pending: make(map[uint32]ltx.PageIndexElem),
		},
		logger:       logger,
		PollInterval: DefaultPollInterval,
		CacheSize:    DefaultCacheSize,
	}
	f.ctx, f.cancel = context.WithCancel(context.Background())
	f.cond = sync.NewCond(&f.mu)
	return f
}

// Pos returns the current position of the file.
func (f *VFSFile) Pos() ltx.Pos {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pos
}

// MaxTXID1 returns the last TXID read from level 1.
func (f *VFSFile) MaxTXID1() ltx.TXID {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.maxTXID1
}

// LockType returns the current lock type of the file.
func (f *VFSFile) LockType() sqlite3vfs.LockType {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lockType
}

// TargetTime returns the current target time for the VFS file (nil for latest).
func (f *VFSFile) TargetTime() *time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.targetTime == nil {
		return nil
	}
	t := *f.targetTime
	return &t
}

// LatestLTXTime returns the timestamp of the most recent LTX file.
func (f *VFSFile) LatestLTXTime() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.latestLTXTime
}

// LastPollSuccess returns the time of the last successful poll.
func (f *VFSFile) LastPollSuccess() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastPollSuccess
}

func (f *VFSFile) hasTargetTime() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.targetTime != nil
}

func (f *VFSFile) Open() error {
	f.logger.Debug("opening file")
	openStart := time.Now()

	// Try to get restore plan. For write-enabled VFS, we can create a new database
	// if no LTX files exist yet.
	restorePlanStart := time.Now()
	infos, err := f.waitForRestorePlan()
	restorePlanElapsed := time.Since(restorePlanStart)
	if err != nil {
		// If write mode is enabled and no files exist, we can create a new database
		if f.writeEnabled && errors.Is(err, ErrTxNotAvailable) {
			f.logger.Info("no existing database found, creating new database")
			return f.openNewDatabase()
		}
		return err
	}
	var snapshotCount, l0Count, l1Count, highLevelCount int
	for _, info := range infos {
		switch info.Level {
		case SnapshotLevel:
			snapshotCount++
		case 0:
			l0Count++
		case 1:
			l1Count++
		default:
			highLevelCount++
		}
	}

	pageSizeStart := time.Now()
	pageSize, err := detectPageSizeFromInfos(f.ctx, f.client, infos)
	pageSizeElapsed := time.Since(pageSizeStart)
	if err != nil {
		f.logger.Error("cannot detect page size", "error", err)
		return fmt.Errorf("detect page size: %w", err)
	}
	f.pageSize = pageSize

	// Initialize page cache. Convert byte size to number of pages.
	cacheEntries := f.CacheSize / int(pageSize)
	if cacheEntries < 1 {
		cacheEntries = 1
	}
	cache, err := lru.New[uint32, []byte](cacheEntries)
	if err != nil {
		return fmt.Errorf("create page cache: %w", err)
	}
	f.cache = cache

	// Determine the current position based off the latest LTX file.
	var pos ltx.Pos
	if len(infos) > 0 {
		pos = ltx.Pos{TXID: infos[len(infos)-1].MaxTXID}
	}

	if f.writeEnabled && f.hydrationPath != "" {
		if ready, err := f.tryOpenFromPersistentHydration(pos, infos); err != nil {
			f.logger.Warn("persistent hydration fast path unavailable, falling back to remote rebuild", "error", err)
		} else if ready {
			// Continuously monitor the replica client for new LTX files in read-only mode.
			if f.writeEnabled && f.syncInterval > 0 {
				f.syncTicker = time.NewTicker(f.syncInterval)
				f.syncStop = make(chan struct{})
				stopCh := f.syncStop
				tickerCh := f.syncTicker.C
				f.wg.Add(1)
				go func() { defer f.wg.Done(); f.syncLoop(stopCh, tickerCh) }()
			}
			f.wg.Add(1)
			go func() {
				defer f.wg.Done()
				if err := f.rebuildRemoteViewAsync(f.ctx, infos); err != nil {
					f.logger.Error("remote view rebuild failed after hydration fast path", "error", err)
					return
				}
				if f.compactor != nil && f.vfs != nil {
					f.startCompactionMonitors()
				}
			}()
			if f.writeEnabled {
				f.logger.Info("vfs open timings",
					"restorePlan", restorePlanElapsed,
					"pageSize", time.Duration(0),
					"buildIndex", time.Duration(0),
					"hydrationInit", time.Since(openStart)-restorePlanElapsed,
					"total", time.Since(openStart),
					"restoreInfos", len(infos),
					"snapshots", snapshotCount,
					"l0", l0Count,
					"l1", l1Count,
					"higherLevels", highLevelCount,
					"fastPath", "persistent-hydration",
				)
			}
			return nil
		}
	}
	f.pos = pos

	// Initialize write support TXID tracking
	if f.writeEnabled {
		f.expectedTXID = pos.TXID
		f.pendingTXID = pos.TXID + 1
		f.logger.Debug("write support enabled", "expectedTXID", f.expectedTXID, "pendingTXID", f.pendingTXID)

		// Initialize write buffer file for durability (discards any existing buffer)
		if err := f.initWriteBuffer(); err != nil {
			return fmt.Errorf("initialize write buffer: %w", err)
		}
	}

	// Build the page index so we can lookup individual pages.
	buildIndexStart := time.Now()
	if err := f.buildIndex(f.ctx, infos); err != nil {
		f.logger.Error("cannot build index", "error", err)
		return fmt.Errorf("cannot build index: %w", err)
	}
	buildIndexElapsed := time.Since(buildIndexStart)

	// Start background hydration if enabled
	hydrationInitStart := time.Now()
	if f.hydrationPath != "" {
		if err := f.initHydration(infos); err != nil {
			f.logger.Warn("hydration initialization failed, continuing without hydration", "error", err)
			f.hydrationPath = ""
		}
	}
	hydrationInitElapsed := time.Since(hydrationInitStart)
	if f.writeEnabled {
		f.logger.Info("vfs open timings",
			"restorePlan", restorePlanElapsed,
			"pageSize", pageSizeElapsed,
			"buildIndex", buildIndexElapsed,
			"hydrationInit", hydrationInitElapsed,
			"total", time.Since(openStart),
			"restoreInfos", len(infos),
			"snapshots", snapshotCount,
			"l0", l0Count,
			"l1", l1Count,
			"higherLevels", highLevelCount,
		)
	}

	// Continuously monitor the replica client for new LTX files in read-only mode.
	// In write mode, the local writer maintains remote state explicitly via sync &
	// maintenance events so background polling cannot clobber the live writable view.
	if !f.writeEnabled {
		f.wg.Add(1)
		go func() { defer f.wg.Done(); f.monitorReplicaClient(f.ctx) }()
	}

	// Start periodic sync goroutine if write support is enabled
	if f.writeEnabled && f.syncInterval > 0 {
		f.syncTicker = time.NewTicker(f.syncInterval)
		f.syncStop = make(chan struct{})
		stopCh := f.syncStop
		tickerCh := f.syncTicker.C
		f.wg.Add(1)
		go func() { defer f.wg.Done(); f.syncLoop(stopCh, tickerCh) }()
	}

	// Start compaction monitors if enabled
	if f.compactor != nil && f.vfs != nil {
		f.startCompactionMonitors()
	}

	return nil
}

// openNewDatabase initializes the VFSFile for a brand new database with no existing data.
// This is called when write mode is enabled and no LTX files exist yet.
func (f *VFSFile) openNewDatabase() error {
	f.logger.Debug("initializing new database")

	// Use default page size for new databases
	f.pageSize = DefaultPageSize

	// Initialize page cache
	cacheEntries := f.CacheSize / int(f.pageSize)
	if cacheEntries < 1 {
		cacheEntries = 1
	}
	cache, err := lru.New[uint32, []byte](cacheEntries)
	if err != nil {
		return fmt.Errorf("create page cache: %w", err)
	}
	f.cache = cache

	// Initialize empty index - no pages exist yet
	f.index = make(map[uint32]ltx.PageIndexElem)
	f.remoteIndex = make(map[uint32]ltx.PageIndexElem)
	f.pending = make(map[uint32]ltx.PageIndexElem)
	f.pos = ltx.Pos{TXID: 0}
	f.remotePos = ltx.Pos{TXID: 0}
	f.commit = 0
	f.remoteCommit = 0
	f.baseCommit = 0
	f.remoteMaxTXID1 = 0

	// Initialize write support for new database
	f.expectedTXID = 0
	f.pendingTXID = 1
	f.logger.Debug("write support enabled for new database", "expectedTXID", f.expectedTXID, "pendingTXID", f.pendingTXID)

	// Initialize write buffer file for durability
	if err := f.initWriteBuffer(); err != nil {
		f.logger.Warn("failed to initialize write buffer", "error", err)
	}

	// New databases in write mode maintain their own remote state via sync.

	// Start periodic sync goroutine
	if f.syncInterval > 0 {
		f.syncTicker = time.NewTicker(f.syncInterval)
		f.syncStop = make(chan struct{})
		stopCh := f.syncStop
		tickerCh := f.syncTicker.C
		f.wg.Add(1)
		go func() { defer f.wg.Done(); f.syncLoop(stopCh, tickerCh) }()
	}

	// Start compaction monitors if enabled
	if f.compactor != nil && f.vfs != nil {
		f.startCompactionMonitors()
	}

	return nil
}

// SetTargetTime rebuilds the page index to view the database at a specific time.
func (f *VFSFile) SetTargetTime(ctx context.Context, timestamp time.Time) error {
	if timestamp.IsZero() {
		return fmt.Errorf("target time required")
	}

	infos, err := CalcRestorePlan(ctx, f.client, 0, timestamp, f.logger)
	if err != nil {
		return fmt.Errorf("cannot calc restore plan: %w", err)
	} else if len(infos) == 0 {
		return fmt.Errorf("no backup files available")
	}

	// Disable hydrated reads during time travel - hydrated file is at latest state
	if f.hydrator != nil && f.hydrator.Complete() {
		f.hydrator.Disable()
		f.logger.Debug("hydration disabled for time travel", "target", timestamp)
	}

	return f.rebuildIndex(ctx, infos, &timestamp)
}

// ResetTime rebuilds the page index to the latest available state.
func (f *VFSFile) ResetTime(ctx context.Context) error {
	infos, err := CalcRestorePlan(ctx, f.client, 0, time.Time{}, f.logger)
	if err != nil {
		return fmt.Errorf("cannot calc restore plan: %w", err)
	} else if len(infos) == 0 {
		return fmt.Errorf("no backup files available")
	}

	return f.rebuildIndex(ctx, infos, nil)
}

// rebuildIndex constructs a fresh page index and swaps it into the VFSFile.
func (f *VFSFile) rebuildIndex(ctx context.Context, infos []*ltx.FileInfo, target *time.Time) error {
	index, commit, err := f.buildIndexMap(ctx, infos)
	if err != nil {
		return err
	}

	var pos ltx.Pos
	if len(infos) > 0 {
		pos = ltx.Pos{TXID: infos[len(infos)-1].MaxTXID}
	}

	maxTXID1 := maxLevelTXID(infos, 1)

	f.mu.Lock()
	defer f.mu.Unlock()
	f.replaceAllViewsLocked(index, commit, pos, maxTXID1)
	if len(infos) > 0 {
		f.latestLTXTime = infos[len(infos)-1].CreatedAt
	}
	if f.cache != nil {
		f.cache.Purge()
	}
	if target == nil {
		f.targetTime = nil
	} else {
		t := *target
		f.targetTime = &t
	}

	return nil
}

func maxLevelTXID(infos []*ltx.FileInfo, level int) ltx.TXID {
	var maxTXID ltx.TXID
	for _, info := range infos {
		if info.Level == level && info.MaxTXID > maxTXID {
			maxTXID = info.MaxTXID
		}
	}
	return maxTXID
}

// buildIndexMap constructs a lookup of pgno to LTX file offsets.
func (f *VFSFile) buildIndexMap(ctx context.Context, infos []*ltx.FileInfo) (map[uint32]ltx.PageIndexElem, uint32, error) {
	index := make(map[uint32]ltx.PageIndexElem)
	var commit uint32
	for _, info := range infos {
		f.logger.Debug("opening page index", "level", info.Level, "min", info.MinTXID, "max", info.MaxTXID)

		// Read page index.
		idx, err := FetchPageIndex(ctx, f.client, info)
		if err != nil {
			return nil, 0, fmt.Errorf("fetch page index: %w", err)
		}

		// Replace pages in overall index with new pages.
		for k, v := range idx {
			f.logger.Debug("adding page index", "page", k, "elem", v)
			index[k] = v
		}
		hdr, err := FetchLTXHeader(ctx, f.client, info)
		if err != nil {
			return nil, 0, fmt.Errorf("fetch header: %w", err)
		}
		commit = hdr.Commit
	}

	return index, commit, nil
}

// buildIndex constructs a lookup of pgno to LTX file offsets (legacy wrapper).
func (f *VFSFile) buildIndex(ctx context.Context, infos []*ltx.FileInfo) error {
	return f.rebuildIndex(ctx, infos, nil)
}

func (f *VFSFile) tryOpenFromPersistentHydration(pos ltx.Pos, infos []*ltx.FileInfo) (bool, error) {
	pageSize, commit, err := readSQLiteHeader(f.hydrationPath)
	if err != nil {
		return false, err
	}

	cacheEntries := f.CacheSize / int(pageSize)
	if cacheEntries < 1 {
		cacheEntries = 1
	}
	cache, err := lru.New[uint32, []byte](cacheEntries)
	if err != nil {
		return false, fmt.Errorf("create page cache: %w", err)
	}
	f.cache = cache
	f.pageSize = pageSize

	f.hydrator = NewHydrator(f.hydrationPath, f.hydrationPersistent, pageSize, f.client, f.logger)
	if err := f.hydrator.Init(); err != nil {
		return false, fmt.Errorf("init hydrator: %w", err)
	}
	hydrationTXID := f.hydrator.TXID()
	if hydrationTXID == 0 || hydrationTXID > pos.TXID {
		_ = f.hydrator.Close()
		f.hydrator = nil
		return false, fmt.Errorf("hydration txid mismatch: hydration=%s current=%s", hydrationTXID, pos.TXID)
	}
	if hydrationTXID < pos.TXID {
		f.logger.Info("persistent hydration catch-up",
			"from", hydrationTXID.String(),
			"to", pos.TXID.String(),
		)
		if err := f.hydrator.CatchUp(f.ctx, hydrationTXID, pos.TXID); err != nil {
			_ = f.hydrator.Close()
			f.hydrator = nil
			return false, fmt.Errorf("hydration catch-up: %w", err)
		}
		f.hydrator.SetTXID(pos.TXID)
		pageSize, commit, err = readSQLiteHeader(f.hydrationPath)
		if err != nil {
			_ = f.hydrator.Close()
			f.hydrator = nil
			return false, fmt.Errorf("reload hydration header after catch-up: %w", err)
		}
		f.pageSize = pageSize
	}
	f.logger.Info("persistent hydration fast path candidate",
		"path", f.hydrationPath,
		"pageSize", pageSize,
		"commit", commit,
		"hydrationTXID", hydrationTXID.String(),
		"currentTXID", pos.TXID.String(),
	)

	maxTXID1 := maxLevelTXID(infos, 1)

	f.mu.Lock()
	f.pos = pos
	f.remotePos = pos
	f.maxTXID1 = maxTXID1
	f.remoteMaxTXID1 = maxTXID1
	f.commit = commit
	f.remoteCommit = commit
	f.baseCommit = commit
	f.expectedTXID = pos.TXID
	f.pendingTXID = pos.TXID + 1
	f.index = make(map[uint32]ltx.PageIndexElem)
	f.remoteIndex = make(map[uint32]ltx.PageIndexElem)
	f.pending = make(map[uint32]ltx.PageIndexElem)
	f.pendingReplace = false
	if len(infos) > 0 {
		f.latestLTXTime = infos[len(infos)-1].CreatedAt
	}
	f.mu.Unlock()

	if err := f.initWriteBuffer(); err != nil {
		_ = f.hydrator.Close()
		f.hydrator = nil
		return false, fmt.Errorf("initialize write buffer: %w", err)
	}

	f.hydrator.SetComplete()
	return true, nil
}

func (f *VFSFile) rebuildRemoteViewAsync(ctx context.Context, infos []*ltx.FileInfo) error {
	index, commit, err := f.buildIndexMap(ctx, infos)
	if err != nil {
		return err
	}
	var pos ltx.Pos
	if len(infos) > 0 {
		pos = ltx.Pos{TXID: infos[len(infos)-1].MaxTXID}
	}
	maxTXID1 := maxLevelTXID(infos, 1)

	f.mu.Lock()
	f.remoteIndex = clonePageIndexMap(index)
	f.remoteCommit = commit
	f.remotePos = pos
	f.remoteMaxTXID1 = maxTXID1
	f.mu.Unlock()
	return nil
}

// initHydration starts the background hydration process.
func (f *VFSFile) initHydration(infos []*ltx.FileInfo) error {
	f.hydrator = NewHydrator(f.hydrationPath, f.hydrationPersistent, f.pageSize, f.client, f.logger)
	if err := f.hydrator.Init(); err != nil {
		return err
	}

	// Start background restore
	f.wg.Add(1)
	go f.runHydration(infos)

	return nil
}

// runHydration performs the background hydration process.
func (f *VFSFile) runHydration(infos []*ltx.FileInfo) {
	defer f.wg.Done()

	hydrationTXID := f.hydrator.TXID()

	f.mu.Lock()
	currentTXID := f.pos.TXID
	f.mu.Unlock()

	if hydrationTXID > 0 && currentTXID >= hydrationTXID {
		f.logger.Debug("resuming hydration from persistent file", "txid", hydrationTXID.String())
	} else {
		if hydrationTXID > 0 {
			f.logger.Warn("remote TXID regressed, discarding persistent hydration",
				"hydration_txid", hydrationTXID.String(),
				"current_txid", currentTXID.String())
			if err := f.hydrator.Truncate(0); err != nil {
				f.hydrator.SetErr(err)
				f.logger.Error("hydration truncate failed", "error", err)
				return
			}
		}
		if err := f.hydrator.Restore(f.ctx, infos); err != nil {
			f.hydrator.SetErr(err)
			f.logger.Error("hydration failed", "error", err)
			return
		}
		hydrationTXID = f.hydrator.TXID()
	}

	if currentTXID > hydrationTXID {
		if err := f.hydrator.CatchUp(f.ctx, hydrationTXID, currentTXID); err != nil {
			f.hydrator.SetErr(err)
			f.logger.Error("hydration catch-up failed", "error", err)
			return
		}
	}

	f.hydrator.SetComplete()

	// Clear cache since we'll now read from hydration file
	f.cache.Purge()

	f.logger.Debug("hydration complete", "path", f.hydrationPath, "txid", f.hydrator.TXID().String())
}

// applySyncedPagesToHydratedFile writes synced dirty pages to the hydrated file.
// Must be called with f.mu held.
func (f *VFSFile) applySyncedPagesToHydratedFile() error {
	for pgno, bufferOff := range f.dirty {
		data := make([]byte, f.pageSize)
		if _, err := f.bufferFile.ReadAt(data, bufferOff); err != nil {
			return fmt.Errorf("read dirty page %d from buffer: %w", pgno, err)
		}

		if err := f.hydrator.WritePage(pgno, data); err != nil {
			return err
		}
	}

	f.hydrator.SetTXID(f.expectedTXID)
	return nil
}

func (f *VFSFile) Close() error {
	f.logger.Debug("closing file")

	// Stop sync loop and ticker if running (need mutex for syncStop)
	f.mu.Lock()
	if f.syncStop != nil {
		close(f.syncStop)
		f.syncStop = nil
	}
	if f.syncTicker != nil {
		f.syncTicker.Stop()
	}
	f.mu.Unlock()

	// Stop compaction monitors if running
	if f.compactionCancel != nil {
		f.compactionCancel()
		f.compactionWg.Wait()
	}

	// Final sync of dirty pages before closing
	f.mu.Lock()
	if f.writeEnabled && len(f.dirty) > 0 {
		if err := f.syncToRemoteWithLock(); err != nil {
			f.logger.Error("failed to sync on close", "error", err)
		}
	}
	f.mu.Unlock()

	f.cancel()
	f.wg.Wait()

	// Close and remove buffer file if open
	if f.bufferFile != nil {
		f.bufferFile.Close()
		os.Remove(f.bufferPath)
	}

	// Close and remove hydration file
	if f.hydrator != nil {
		if err := f.hydrator.Close(); err != nil {
			f.logger.Warn("failed to close hydration file", "error", err)
		}
	}

	if f.writeEnabled && f.vfs != nil {
		f.vfs.writeMu.Lock()
		if f.vfs.writeFile == f {
			f.vfs.writeFile = nil
		}
		f.vfs.writeMu.Unlock()
	}
	if f.vfs != nil {
		f.vfs.openFiles.Delete(f)
	}

	return nil
}

func (f *VFSFile) ReadAt(p []byte, off int64) (n int, err error) {
	f.logger.Debug("reading at", "off", off, "len", len(p))
	pageSize, err := f.pageSizeBytes()
	if err != nil {
		return 0, err
	}

	pgno := uint32(off/int64(pageSize)) + 1
	pageOffset := int(off % int64(pageSize))

	// Check dirty pages first (takes priority over cache and remote)
	f.mu.Lock()
	if f.writeEnabled {
		if bufferOff, ok := f.dirty[pgno]; ok {
			// Read page from buffer file
			data := make([]byte, pageSize)
			if _, err := f.bufferFile.ReadAt(data, bufferOff); err != nil {
				f.mu.Unlock()
				return 0, fmt.Errorf("read dirty page from buffer: %w", err)
			}
			n = copy(p, data[pageOffset:])
			f.mu.Unlock()
			f.logger.Debug("dirty page hit", "page", pgno, "n", n)

			// Update the first page to pretend like we are in journal mode.
			if off == 0 && len(p) >= 28 {
				p[18], p[19] = 0x01, 0x01
				_, _ = rand.Read(p[24:28])
			}

			return n, nil
		}
	}
	f.mu.Unlock()

	// If hydration complete, read from local file
	if f.hydrator != nil && f.hydrator.Complete() {
		return f.hydrator.ReadAt(p, off)
	}

	// Check cache (cache is thread-safe)
	if data, ok := f.cache.Get(pgno); ok {
		n = copy(p, data[pageOffset:])
		f.logger.Debug("cache hit", "page", pgno, "n", n)

		// Update the first page to pretend like we are in journal mode.
		if off == 0 {
			p[18], p[19] = 0x01, 0x01
			_, _ = rand.Read(p[24:28])
		}

		return n, nil
	}

	// Get page index element for the live local writable view.
	f.mu.Lock()
	writeEnabled := f.writeEnabled // capture while holding lock to avoid data race
	commit := f.commit
	index := f.index
	if writeEnabled && pgno > commit {
		f.mu.Unlock()
		f.logger.Debug("page beyond local commit, returning zeros", "page", pgno, "commit", commit)
		for i := range p {
			p[i] = 0
		}
		return len(p), nil
	}
	elem, ok := index[pgno]
	f.mu.Unlock()

	if !ok {
		if writeEnabled {
			if pgno > commit {
				f.logger.Debug("page not found beyond local commit, returning zeros for write mode", "page", pgno, "commit", commit)
				for i := range p {
					p[i] = 0
				}
				return len(p), nil
			}
			f.logger.Error("page missing from local index within commit", "page", pgno, "commit", commit)
			return 0, fmt.Errorf("%w: %d", errPageNotFound, pgno)
		}
		f.logger.Error("page not found", "page", pgno)
		return 0, fmt.Errorf("%w: %d", errPageNotFound, pgno)
	}

	var data []byte
	var lastErr error
	ctx := f.ctx
	for attempt := 0; attempt < pageFetchRetryAttempts; attempt++ {
		_, data, lastErr = FetchPage(ctx, f.client, elem.Level, elem.MinTXID, elem.MaxTXID, elem.Offset, elem.Size)
		if lastErr == nil {
			break
		}
		if !isRetryablePageError(lastErr) {
			f.logger.Error("cannot fetch page", "page", pgno, "attempt", attempt+1, "error", lastErr)
			return 0, fmt.Errorf("fetch page: %w", lastErr)
		}

		if attempt == pageFetchRetryAttempts-1 {
			f.logger.Error("cannot fetch page after retries", "page", pgno, "attempts", pageFetchRetryAttempts, "error", lastErr)
			return 0, sqlite3vfs.BusyError
		}

		delay := pageFetchRetryDelay * time.Duration(attempt+1)
		f.logger.Warn("transient page fetch error, retrying", "page", pgno, "attempt", attempt+1, "delay", delay, "error", lastErr)

		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-f.ctx.Done():
			timer.Stop()
			return 0, fmt.Errorf("fetch page: %w", lastErr)
		}
		timer.Stop()
	}

	// Add to cache (cache is thread-safe)
	f.cache.Add(pgno, data)

	n = copy(p, data[pageOffset:])
	f.logger.Debug("data read from storage", "page", pgno, "n", n, "data", len(data))

	// Update the first page to pretend like we are in journal mode.
	if off == 0 {
		p[18], p[19] = 0x01, 0x01
		_, _ = rand.Read(p[24:28])
	}

	return n, nil
}

func (f *VFSFile) WriteAt(b []byte, off int64) (n int, err error) {
	f.logger.Debug("write at", "off", off, "len", len(b))

	pageSize, err := f.pageSizeBytes()
	if err != nil {
		return 0, err
	}

	// Calculate page number and offset within page
	pgno := uint32(off/int64(pageSize)) + 1
	pageOffset := int(off % int64(pageSize))

	// Skip lock page
	if pgno == ltx.LockPgno(pageSize) {
		return 0, fmt.Errorf("cannot write to lock page")
	}

	f.mu.Lock()
	defer f.mu.Unlock()

	// If write support is not enabled, return read-only error
	if !f.writeEnabled {
		return 0, sqlite3vfs.ReadOnlyError
	}

	// Get page data - either from buffer file (if dirty) or from cache/remote
	page := make([]byte, pageSize)
	currentCommit := f.commit
	if bufferOff, ok := f.dirty[pgno]; ok {
		// Page is already dirty - read from buffer file
		if _, err := f.bufferFile.ReadAt(page, bufferOff); err != nil {
			return 0, fmt.Errorf("read dirty page from buffer: %w", err)
		}
	} else {
		// Page is not dirty - read from cache/remote
		if err := f.readPageForWrite(pgno, page); err != nil {
			if errors.Is(err, errPageNotFound) && pgno > currentCommit {
				f.logger.Debug("page not found, using empty page", "pgno", pgno)
			} else {
				f.logger.Error("readPageForWrite failed",
					"pgno", pgno,
					"currentCommit", currentCommit,
					"error", err,
				)
				return 0, err
			}
		}
	}

	// Apply write to page
	n = copy(page[pageOffset:], b)

	// Update commit count if this extends the database
	if pgno > f.commit {
		f.commit = pgno
	}

	// Write to buffer for durability (this updates f.dirty with the offset)
	if err := f.writeToBuffer(pgno, page); err != nil {
		f.logger.Error("failed to write to buffer", "error", err)
		return 0, fmt.Errorf("write to buffer: %w", err)
	}

	f.logger.Debug("wrote to dirty page", "pgno", pgno, "offset", pageOffset, "len", n, "commit", f.commit)
	return n, nil
}

// readPageForWrite reads a page into buf for modification.
// Must be called with f.mu held.
func (f *VFSFile) readPageForWrite(pgno uint32, buf []byte) error {
	pageSize := uint32(len(buf))

	// Check cache first (cache is thread-safe, but we hold the lock anyway)
	if data, ok := f.cache.Get(pgno); ok {
		copy(buf, data)
		return nil
	}

	if f.hydrator != nil && f.hydrator.Complete() {
		off := int64(pgno-1) * int64(pageSize)
		n, err := f.hydrator.ReadAt(buf, off)
		if err != nil && err != io.EOF {
			f.logger.Error("hydrator read failed", "pgno", pgno, "off", off, "pageSize", pageSize, "error", err)
			return err
		}
		if n == 0 {
			return fmt.Errorf("%w: %d", errPageNotFound, pgno)
		}
		if n != len(buf) {
			f.logger.Error("hydrator short read", "pgno", pgno, "off", off, "pageSize", pageSize, "read", n)
			return fmt.Errorf("hydrated page short read: got %d want %d", n, len(buf))
		}
		f.cache.Add(pgno, append([]byte(nil), buf...))
		return nil
	}

	// Get page index element.
	index := f.index
	elem, ok := index[pgno]
	if !ok {
		return fmt.Errorf("%w: %d", errPageNotFound, pgno)
	}

	// Fetch from remote
	_, data, err := FetchPage(f.ctx, f.client, elem.Level, elem.MinTXID, elem.MaxTXID, elem.Offset, elem.Size)
	if err != nil {
		return err
	}

	if uint32(len(data)) != pageSize {
		return fmt.Errorf("page size mismatch: got %d, expected %d", len(data), pageSize)
	}

	copy(buf, data)
	f.cache.Add(pgno, data)
	return nil
}

func (f *VFSFile) Truncate(size int64) error {
	f.logger.Debug("truncating file", "size", size)

	pageSize, err := f.pageSizeBytes()
	if err != nil {
		return err
	}

	newCommit := uint32(size / int64(pageSize))

	f.mu.Lock()
	defer f.mu.Unlock()

	// If write support is not enabled, return read-only error
	if !f.writeEnabled {
		return sqlite3vfs.ReadOnlyError
	}

	// Remove dirty pages beyond new size
	for pgno := range f.dirty {
		if pgno > newCommit {
			delete(f.dirty, pgno)
		}
	}
	if f.cache != nil {
		f.cache.Purge()
	}

	f.commit = newCommit
	if newCommit < f.baseCommit {
		f.baseCommit = newCommit
	}
	for pgno := range f.index {
		if pgno > newCommit {
			delete(f.index, pgno)
		}
	}
	f.logger.Debug("truncated", "newCommit", newCommit)

	// Truncate hydrated file if hydration is complete
	if f.hydrator != nil && f.hydrator.Complete() {
		if err := f.hydrator.Truncate(size); err != nil {
			f.logger.Error("failed to truncate hydration file", "error", err)
			// Don't fail the operation - continue with degraded performance
		}
	}

	return nil
}

func (f *VFSFile) Sync(flag sqlite3vfs.SyncType) error {
	f.logger.Debug("syncing file", "flag", flag)

	f.mu.Lock()
	defer f.mu.Unlock()

	// If write support is not enabled, no-op
	if !f.writeEnabled {
		return nil
	}

	// Skip sync if no dirty pages
	if len(f.dirty) == 0 {
		return nil
	}
	// Skip sync during active transaction
	if f.inTransaction {
		f.logger.Debug("skipping sync during transaction")
		return nil
	}

	return f.syncToRemoteWithLock()
}

// SetWriteEnabled enables or disables write support at runtime.
// This is equivalent to SetWriteEnabledWithTimeout(enabled, 0) which waits indefinitely.
func (f *VFSFile) SetWriteEnabled(enabled bool) error {
	return f.SetWriteEnabledWithTimeout(enabled, 0)
}

// SetWriteEnabledWithTimeout enables or disables write support at runtime with an optional timeout.
//
// When disabling (enabled=false):
//   - If called during an active transaction, waits for completion
//   - If timeout > 0, returns error after timeout if transaction doesn't complete
//   - If timeout == 0, waits indefinitely (or until context cancellation)
//   - Syncs all dirty pages to replica before returning
//   - Returns error if sync fails (writes remain enabled)
//   - Stops the sync ticker if running
//
// When enabling (enabled=true):
//   - Initializes buffer file if not already present (cold enable)
//   - Starts sync ticker using DefaultSyncInterval if not configured
//   - Starts sync ticker if syncInterval > 0 and not already running
func (f *VFSFile) SetWriteEnabledWithTimeout(enabled bool, timeout time.Duration) error {
	f.mu.Lock()

	// No-op if already in the requested state
	if f.writeEnabled == enabled {
		f.mu.Unlock()
		return nil
	}

	if !enabled {
		// DISABLING writes

		// Set disabling flag to prevent new transactions from starting
		f.disabling = true

		// Start goroutine to wake us on context cancellation or timeout
		// This ensures we don't block forever if context is cancelled or timeout expires
		waitDone := make(chan struct{})
		var timeoutCh <-chan time.Time
		if timeout > 0 {
			timer := time.NewTimer(timeout)
			defer timer.Stop()
			timeoutCh = timer.C
		}
		go func() {
			select {
			case <-f.ctx.Done():
				f.cond.Broadcast() // Wake cond.Wait()
			case <-timeoutCh:
				f.cond.Broadcast() // Wake cond.Wait() on timeout
			case <-waitDone:
				// Normal completion, nothing to do
			}
		}()

		// Wait for active transaction to complete
		deadline := time.Now().Add(timeout)
		for f.inTransaction {
			// Check context before waiting
			select {
			case <-f.ctx.Done():
				close(waitDone)
				f.disabling = false
				f.cond.Broadcast() // Wake any waiting Lock() calls
				f.mu.Unlock()
				return fmt.Errorf("context cancelled while waiting for transaction: %w", f.ctx.Err())
			default:
			}
			// Check timeout if specified
			if timeout > 0 && time.Now().After(deadline) {
				close(waitDone)
				f.disabling = false
				f.cond.Broadcast() // Wake any waiting Lock() calls
				f.mu.Unlock()
				return fmt.Errorf("timeout waiting for transaction to complete (waited %v)", timeout)
			}
			f.cond.Wait() // Unlocks mu, waits for signal, relocks mu
		}
		close(waitDone) // Stop the watcher goroutine

		// Sync dirty pages if any exist
		if len(f.dirty) > 0 {
			if err := f.syncToRemoteWithLock(); err != nil {
				f.disabling = false
				f.cond.Broadcast() // Wake any waiting Lock() calls
				f.mu.Unlock()
				return fmt.Errorf("sync before disable: %w", err)
			}
		}

		// Stop sync loop and ticker if running
		if f.syncStop != nil {
			close(f.syncStop)
			f.syncStop = nil
		}
		if f.syncTicker != nil {
			f.syncTicker.Stop()
			f.syncTicker = nil
		}

		f.writeEnabled = false
		f.disabling = false
		f.cond.Broadcast() // Wake any Lock() calls waiting for disable to complete
		f.logger.Info("write support disabled")
		f.mu.Unlock()
		return nil
	}

	// ENABLING writes (cold enable supported)

	// Initialize dirty map if not present
	if f.dirty == nil {
		f.dirty = make(map[uint32]int64)
	}

	// Set sync interval from VFS config if not set, falling back to default
	// This mirrors the startup behavior where WriteSyncInterval==0 uses DefaultSyncInterval
	if f.syncInterval == 0 && f.vfs != nil {
		f.syncInterval = f.vfs.WriteSyncInterval
		if f.syncInterval == 0 {
			f.syncInterval = DefaultSyncInterval
		}
	}

	// Set buffer path if not set
	if f.bufferPath == "" {
		if f.vfs != nil && f.vfs.WriteBufferPath != "" {
			f.bufferPath = f.vfs.WriteBufferPath
		} else if f.vfs != nil {
			// Use VFS temp directory
			dir, err := f.vfs.ensureTempDir()
			if err != nil {
				f.mu.Unlock()
				return fmt.Errorf("create temp dir for write buffer: %w", err)
			}
			f.bufferPath = filepath.Join(dir, "write-buffer")
		} else {
			// Fallback to os.TempDir() for cold enable without VFS reference
			f.bufferPath = filepath.Join(os.TempDir(), "litestream-write-buffer")
		}
	}

	// Initialize buffer file if not present
	if f.bufferFile == nil {
		if err := f.initWriteBufferWithLock(); err != nil {
			f.mu.Unlock()
			return fmt.Errorf("init write buffer: %w", err)
		}
	}

	// Initialize write tracking state if this is a cold enable
	if f.pendingTXID == 0 {
		f.expectedTXID = f.pos.TXID
		f.pendingTXID = f.pos.TXID + 1
	}

	// Start sync ticker if not running and interval > 0
	// (syncInterval == 0 means no periodic sync, only manual Sync() calls)
	if f.syncTicker == nil && f.syncInterval > 0 {
		f.syncTicker = time.NewTicker(f.syncInterval)
		f.syncStop = make(chan struct{})
		stopCh := f.syncStop
		tickerCh := f.syncTicker.C
		f.wg.Add(1)
		go func() { defer f.wg.Done(); f.syncLoop(stopCh, tickerCh) }()
	}

	f.writeEnabled = true
	f.logger.Info("write support enabled", "pendingTXID", f.pendingTXID)
	f.mu.Unlock()
	return nil
}

// syncLoop runs periodic sync in the background.
// The stop channel and ticker channel are passed as parameters to avoid races
// with SetWriteEnabled potentially nilling them out before this goroutine starts.
func (f *VFSFile) syncLoop(stopCh <-chan struct{}, tickerCh <-chan time.Time) {
	f.logger.Debug("starting sync loop", "interval", f.syncInterval)

	for {
		select {
		case <-f.ctx.Done():
			f.logger.Debug("sync loop stopped (context cancelled)")
			return
		case <-stopCh:
			f.logger.Debug("sync loop stopped (write disabled)")
			return
		case <-tickerCh:
			if err := f.Sync(0); err != nil {
				f.logger.Error("periodic sync failed", "error", err)
			}
		}
	}
}

// syncToRemote syncs dirty pages to the remote replica.
// This function acquires f.mu internally.
func (f *VFSFile) syncToRemote() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.syncToRemoteWithLock()
}

// syncToRemoteWithLock syncs dirty pages to the remote replica.
// Caller must hold f.mu.
func (f *VFSFile) syncToRemoteWithLock() error {
	// Double-check dirty pages exist
	if len(f.dirty) == 0 {
		return nil
	}

	ctx := f.ctx

	// Check for conflicts
	if err := f.checkForConflict(ctx); err != nil {
		return err
	}

	// Create LTX file from dirty pages and build its page index locally.
	ltxReader, resultCh := f.createLTXFromDirty()

	// Upload LTX file to remote
	info, err := f.client.WriteLTXFile(ctx, 0, f.pendingTXID, f.pendingTXID, ltxReader)
	result := <-resultCh
	if result.err != nil {
		return result.err
	}
	if err != nil {
		return fmt.Errorf("upload LTX: %w", err)
	}
	if os.Getenv("LITESTREAM_VERIFY_SYNC_INDEX") == "1" {
		fetchedIdx, fetchErr := FetchPageIndex(ctx, f.client, info)
		if fetchErr != nil {
			return fmt.Errorf("verify uploaded page index: %w", fetchErr)
		}
		if len(fetchedIdx) != len(result.index) {
			return fmt.Errorf("verify uploaded page index length mismatch: fetched=%d local=%d", len(fetchedIdx), len(result.index))
		}
		for pgno, fetchedElem := range fetchedIdx {
			localElem, ok := result.index[pgno]
			if !ok {
				return fmt.Errorf("verify uploaded page index missing local page %d", pgno)
			}
			if localElem != fetchedElem {
				return fmt.Errorf("verify uploaded page index mismatch for page %d: fetched=%+v local=%+v", pgno, fetchedElem, localElem)
			}
		}
	}

	f.logger.Info("synced to remote",
		"txid", info.MaxTXID,
		"pages", len(result.index),
		"size", info.Size)

	f.applyRemoteSyncLocked(f.pendingTXID, f.commit, result.index)

	if f.vfs != nil {
		f.vfs.writeMu.Lock()
		if f.expectedTXID > f.vfs.lastSyncedTXID {
			f.vfs.lastSyncedTXID = f.expectedTXID
		}
		f.vfs.writeMu.Unlock()
	}

	// Update cache with synced pages (index will be populated naturally when pages are fetched)
	for pgno, bufferOff := range f.dirty {
		cachedData := make([]byte, f.pageSize)
		if _, err := f.bufferFile.ReadAt(cachedData, bufferOff); err != nil {
			return fmt.Errorf("read page %d from buffer for cache: %w", pgno, err)
		}
		f.cache.Add(pgno, cachedData)
	}

	// Apply synced pages to hydrated file if hydration is complete
	// Must be done before clearing f.dirty since we need the page offsets
	if f.hydrator != nil && f.hydrator.Complete() {
		if err := f.applySyncedPagesToHydratedFile(); err != nil {
			f.logger.Error("failed to apply synced pages to hydrated file", "error", err)
			// Don't fail the sync - hydration will catch up on next poll
		}
	}

	// Clear dirty pages
	f.dirty = make(map[uint32]int64)

	// Clear write buffer after successful sync
	if err := f.clearWriteBuffer(); err != nil {
		f.logger.Error("failed to clear write buffer", "error", err)
		return fmt.Errorf("clear write buffer: %w", err)
	}

	return nil
}

// checkForConflict checks if the remote has newer transactions than expected.
// Must be called with f.mu held.
func (f *VFSFile) checkForConflict(ctx context.Context) error {
	// Get latest remote position
	itr, err := f.client.LTXFiles(ctx, 0, f.expectedTXID, false)
	if err != nil {
		return fmt.Errorf("check remote position: %w", err)
	}
	defer itr.Close()

	var remoteTXID ltx.TXID
	for itr.Next() {
		info := itr.Item()
		if info.MaxTXID > remoteTXID {
			remoteTXID = info.MaxTXID
		}
	}
	if err := itr.Close(); err != nil {
		return fmt.Errorf("iterate remote files: %w", err)
	}

	// If remote has advanced beyond our expected position, we have a conflict
	if remoteTXID > f.expectedTXID {
		f.logger.Warn("conflict detected",
			"expected", f.expectedTXID,
			"remote", remoteTXID)
		return fmt.Errorf("%w: expected TXID %d but remote has %d",
			ErrConflict, f.expectedTXID, remoteTXID)
	}

	return nil
}

// createLTXFromDirty creates an LTX file from dirty pages.
// Returns a streaming reader plus a result channel containing the locally
// built page index for the encoded LTX.
// Must be called with f.mu held.
func (f *VFSFile) createLTXFromDirty() (io.Reader, <-chan syncLTXResult) {
	pr, pw := io.Pipe()
	resultCh := make(chan syncLTXResult, 1)

	// Only encode dirty pages within the current local commit. SQLite can dirty
	// pages beyond the final commit before a shrink/truncate is finalized.
	pgnos := f.orderedDirtyPagesWithinCommit()
	slices.Sort(pgnos)

	// Copy dirty map offsets for goroutine access
	dirtyOffsets := make(map[uint32]int64, len(f.dirty))
	for pgno, off := range f.dirty {
		dirtyOffsets[pgno] = off
	}

	// Capture values for goroutine
	pageSize := f.pageSize
	commit := f.commit
	pendingTXID := f.pendingTXID
	bufferFile := f.bufferFile

	go func() {
		var err error
		result := syncLTXResult{
			index: make(map[uint32]ltx.PageIndexElem, len(pgnos)),
		}
		defer func() {
			if err != nil {
				result.err = err
			}
			resultCh <- result
			close(resultCh)
		}()
		defer func() {
			pw.CloseWithError(err)
		}()

		cw := &countingWriter{w: pw}
		enc, encErr := ltx.NewEncoder(cw)
		if encErr != nil {
			err = encErr
			return
		}

		// Encode header
		if err = enc.EncodeHeader(ltx.Header{
			Version:   ltx.Version,
			Flags:     ltx.HeaderFlagNoChecksum,
			PageSize:  pageSize,
			Commit:    commit,
			MinTXID:   pendingTXID,
			MaxTXID:   pendingTXID,
			Timestamp: time.Now().UnixMilli(),
		}); err != nil {
			err = fmt.Errorf("encode header: %w", err)
			return
		}

		// Encode each dirty page
		lockPgno := ltx.LockPgno(pageSize)
		for _, pgno := range pgnos {
			if pgno == lockPgno {
				continue // Skip lock page
			}

			// Read page data from buffer file
			bufferOff := dirtyOffsets[pgno]
			data := make([]byte, pageSize)
			if _, err = bufferFile.ReadAt(data, bufferOff); err != nil {
				err = fmt.Errorf("read page %d from buffer: %w", pgno, err)
				return
			}

			offset := cw.n
			if err = enc.EncodePage(ltx.PageHeader{Pgno: pgno}, data); err != nil {
				err = fmt.Errorf("encode page %d: %w", pgno, err)
				return
			}
			result.index[pgno] = ltx.PageIndexElem{
				Level:   0,
				MinTXID: pendingTXID,
				MaxTXID: pendingTXID,
				Offset:  offset,
				Size:    cw.n - offset,
			}
		}

		// Close encoder (writes trailer and page index)
		if err = enc.Close(); err != nil {
			err = fmt.Errorf("close encoder: %w", err)
			return
		}
	}()

	return pr, resultCh
}

func (f *VFSFile) orderedDirtyPagesWithinCommit() []uint32 {
	pgnos := make([]uint32, 0, len(f.dirty))
	for pgno := range f.dirty {
		if pgno <= f.commit {
			pgnos = append(pgnos, pgno)
		}
	}
	return pgnos
}

// initWriteBuffer initializes the write buffer file for durability.
// Any existing buffer content is discarded since unsync'd changes are lost on restart.
// This function acquires f.mu internally.
func (f *VFSFile) initWriteBuffer() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.initWriteBufferWithLock()
}

// initWriteBufferWithLock initializes the write buffer file for durability.
// Any existing buffer content is discarded since unsync'd changes are lost on restart.
// Caller must hold f.mu.
func (f *VFSFile) initWriteBufferWithLock() error {
	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(f.bufferPath), 0755); err != nil {
		return fmt.Errorf("create buffer directory: %w", err)
	}

	// Open or create buffer file, truncating any existing content
	file, err := os.OpenFile(f.bufferPath, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("open buffer file: %w", err)
	}
	f.bufferFile = file
	f.bufferNextOff = 0

	return nil
}

// writeToBuffer writes a dirty page to the write buffer for durability.
// If the page already exists in the buffer, it overwrites at the same offset.
// Otherwise, it appends to the end of the file.
// Must be called with f.mu held.
func (f *VFSFile) writeToBuffer(pgno uint32, data []byte) error {
	var writeOffset int64
	if existingOff, ok := f.dirty[pgno]; ok {
		// Page already exists - overwrite at same offset
		writeOffset = existingOff
	} else {
		// New page - append to end of file
		writeOffset = f.bufferNextOff
		f.bufferNextOff += int64(len(data))
	}

	// Write page data (no header, just raw page data)
	if _, err := f.bufferFile.WriteAt(data, writeOffset); err != nil {
		return fmt.Errorf("write page to buffer: %w", err)
	}

	// Update dirty map with offset
	f.dirty[pgno] = writeOffset

	return nil
}

// clearWriteBuffer clears and resets the write buffer after successful sync.
func (f *VFSFile) clearWriteBuffer() error {
	// Truncate file to zero
	if err := f.bufferFile.Truncate(0); err != nil {
		return fmt.Errorf("truncate buffer: %w", err)
	}

	// Reset next write offset
	f.bufferNextOff = 0

	return nil
}

func (f *VFSFile) FileSize() (size int64, err error) {
	pageSize, err := f.pageSizeBytes()
	if err != nil {
		return 0, err
	}

	f.mu.Lock()
	if v := int64(f.commit) * int64(pageSize); v > size {
		size = v
	}
	for pgno := range f.index {
		if v := int64(pgno) * int64(pageSize); v > size {
			size = v
		}
	}
	for pgno := range f.pending {
		if v := int64(pgno) * int64(pageSize); v > size {
			size = v
		}
	}
	// Include dirty pages in size calculation
	for pgno := range f.dirty {
		if v := int64(pgno) * int64(pageSize); v > size {
			size = v
		}
	}
	f.mu.Unlock()

	f.logger.Debug("file size", "size", size)
	return size, nil
}

func (f *VFSFile) Lock(elock sqlite3vfs.LockType) error {
	f.logger.Debug("locking file", "lock", elock)

	f.mu.Lock()
	defer f.mu.Unlock()

	if elock < f.lockType {
		return fmt.Errorf("invalid lock downgrade: current=%s target=%s", f.lockType, elock)
	}

	if elock >= sqlite3vfs.LockReserved {
		// Wait for any disable operation to complete before allowing RESERVED lock.
		// This prevents new write transactions from starting during disable.
		for f.disabling {
			f.logger.Debug("waiting for disable to complete before acquiring RESERVED lock")
			f.cond.Wait()
		}

		// Reject write-intent locks when writes are disabled. Since we always
		// report OpenReadWrite to SQLite (to support cold enable), SQLite may
		// attempt write transactions even when writes are logically disabled.
		if !f.writeEnabled {
			return sqlite3vfs.ReadOnlyError
		}
	}

	if f.writeEnabled && elock >= sqlite3vfs.LockReserved && !f.inTransaction {
		if f.vfs != nil {
			f.vfs.writeMu.Lock()
			if f.vfs.writeFile != nil && f.vfs.writeFile != f {
				f.vfs.writeMu.Unlock()
				return sqlite3vfs.BusyError
			}
			f.vfs.writeFile = f
			if f.vfs.lastSyncedTXID > f.expectedTXID && len(f.dirty) == 0 {
				f.expectedTXID = f.vfs.lastSyncedTXID
				f.pendingTXID = f.vfs.lastSyncedTXID + 1
				f.pos = ltx.Pos{TXID: f.expectedTXID}
			}
			f.vfs.writeMu.Unlock()
		}
		f.inTransaction = true
		f.logger.Debug("transaction started", "expectedTXID", f.expectedTXID)
	}

	f.lockType = elock
	return nil
}

func (f *VFSFile) Unlock(elock sqlite3vfs.LockType) error {
	f.logger.Debug("unlocking file", "lock", elock)

	f.mu.Lock()
	defer f.mu.Unlock()

	if elock != sqlite3vfs.LockShared && elock != sqlite3vfs.LockNone {
		return fmt.Errorf("invalid unlock target: %s", elock)
	}

	if f.writeEnabled && f.inTransaction && elock < sqlite3vfs.LockReserved {
		f.inTransaction = false
		if f.vfs != nil {
			f.vfs.writeMu.Lock()
			if f.vfs.writeFile == f {
				f.vfs.writeFile = nil
			}
			f.vfs.writeMu.Unlock()
		}
		f.logger.Debug("transaction ended", "dirtyPages", len(f.dirty))
		f.cond.Broadcast() // Wake up SetWriteEnabledWithTimeout if waiting
	}

	f.lockType = elock

	// Copy pending index to main index and invalidate affected pages in cache.
	if f.pendingReplace {
		// Replace entire index
		count := len(f.index)
		f.index = f.pending
		f.logger.Debug("cache invalidated all pages", "count", count)
		// Invalidate entire cache since we replaced the index
		f.cache.Purge()
	} else if len(f.pending) > 0 {
		// Merge pending into index
		count := len(f.pending)
		for k, v := range f.pending {
			f.index[k] = v
			f.cache.Remove(k)
		}
		f.logger.Debug("cache invalidated pages", "count", count)
	}
	f.pending = make(map[uint32]ltx.PageIndexElem)
	f.pendingReplace = false

	return nil
}

func (f *VFSFile) CheckReservedLock() (bool, error) {
	f.logger.Debug("checking reserved lock")
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.lockType >= sqlite3vfs.LockReserved {
		return true, nil
	}
	if f.vfs != nil {
		f.vfs.writeMu.Lock()
		held := f.vfs.writeFile != nil
		f.vfs.writeMu.Unlock()
		return held, nil
	}
	return false, nil
}

func (f *VFSFile) SectorSize() int64 {
	f.logger.Debug("sector size")
	return 0
}

func (f *VFSFile) DeviceCharacteristics() sqlite3vfs.DeviceCharacteristic {
	f.logger.Debug("device characteristics")
	return 0
}

// FileControl handles file control operations, specifically PRAGMA commands for time travel.
func (f *VFSFile) FileControl(op int, pragmaName string, pragmaValue *string) (*string, error) {
	const SQLITE_FCNTL_PRAGMA = 14

	if op != SQLITE_FCNTL_PRAGMA {
		return nil, fmt.Errorf("unsupported file control op: %d", op)
	}

	name := strings.ToLower(pragmaName)

	f.logger.Debug("file control", "pragma", name, "value", pragmaValue)

	switch name {
	case "litestream_txid":
		if pragmaValue != nil {
			return nil, fmt.Errorf("litestream_txid is read-only")
		}
		txid := f.Pos().TXID
		result := txid.String()
		return &result, nil

	case "litestream_lag":
		if pragmaValue != nil {
			return nil, fmt.Errorf("litestream_lag is read-only")
		}
		lastPoll := f.LastPollSuccess()
		if lastPoll.IsZero() {
			result := "-1" // Never polled successfully
			return &result, nil
		}
		lag := int64(time.Since(lastPoll).Seconds())
		result := strconv.FormatInt(lag, 10)
		return &result, nil

	case "litestream_replicated_txid":
		if pragmaValue != nil {
			return nil, fmt.Errorf("litestream_replicated_txid is read-only")
		}
		result := f.remotePos.TXID.String()
		return &result, nil

	case "litestream_force_sync":
		if pragmaValue != nil {
			return nil, fmt.Errorf("litestream_force_sync is write-only")
		}
		if err := f.Sync(0); err != nil {
			return nil, err
		}
		result := f.Pos().TXID.String()
		return &result, nil

	case "litestream_force_poll":
		if pragmaValue != nil {
			return nil, fmt.Errorf("litestream_force_poll is write-only")
		}
		if err := f.pollReplicaClient(context.Background()); err != nil {
			return nil, err
		}
		result := f.remotePos.TXID.String()
		return &result, nil

	case "litestream_global_txid":
		if pragmaValue != nil {
			return nil, fmt.Errorf("litestream_global_txid is read-only")
		}
		if f.vfs == nil {
			result := f.Pos().TXID.String()
			return &result, nil
		}
		result := f.vfs.globalTXID().String()
		return &result, nil

	case "litestream_global_replicated_txid":
		if pragmaValue != nil {
			return nil, fmt.Errorf("litestream_global_replicated_txid is read-only")
		}
		if f.vfs == nil {
			result := f.remotePos.TXID.String()
			return &result, nil
		}
		result := f.vfs.globalReplicatedTXID().String()
		return &result, nil

	case "litestream_time":
		if pragmaValue == nil {
			result := f.currentTimeString()
			return &result, nil
		}

		if strings.EqualFold(*pragmaValue, "latest") {
			if err := f.ResetTime(context.Background()); err != nil {
				return nil, err
			}
			return nil, nil
		}

		t, err := parseTimeValue(*pragmaValue)
		if err != nil {
			return nil, err
		}
		if err := f.SetTargetTime(context.Background(), t); err != nil {
			return nil, err
		}
		return nil, nil

	case "litestream_hydration_progress":
		if pragmaValue != nil {
			return nil, fmt.Errorf("litestream_hydration_progress is read-only")
		}
		if f.hydrator == nil {
			result := "0"
			return &result, nil
		}
		pct := f.hydrator.Status().Pct() * 100
		result := strconv.FormatFloat(pct, 'f', 1, 64)
		return &result, nil

	case "litestream_hydration_file":
		if pragmaValue != nil {
			return nil, fmt.Errorf("litestream_hydration_file is read-only")
		}
		result := f.hydrationPath
		return &result, nil

	case "litestream_write_enabled":
		if pragmaValue == nil {
			// READ mode - return current state
			f.mu.Lock()
			enabled := f.writeEnabled
			f.mu.Unlock()
			if enabled {
				result := "1"
				return &result, nil
			}
			result := "0"
			return &result, nil
		}
		// WRITE mode - enable or disable
		switch strings.ToLower(*pragmaValue) {
		case "0", "false", "off":
			if err := f.SetWriteEnabled(false); err != nil {
				return nil, err
			}
			return nil, nil
		case "1", "true", "on":
			if err := f.SetWriteEnabled(true); err != nil {
				return nil, err
			}
			return nil, nil
		default:
			return nil, fmt.Errorf("invalid value for litestream_write_enabled: %s (use 0 or 1)", *pragmaValue)
		}

	default:
		return nil, sqlite3vfs.NotFoundError
	}
}

// currentTimeString returns the current target time as a string.
func (f *VFSFile) currentTimeString() string {
	if t := f.TargetTime(); t != nil {
		return t.Format(time.RFC3339Nano)
	}
	if t := f.LatestLTXTime(); !t.IsZero() {
		return t.Format(time.RFC3339Nano)
	}
	return "latest" // Fallback if no LTX files loaded
}

func isRetryablePageError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return true
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	// Some remote clients wrap EOF in custom errors so we fall back to string matching.
	if strings.Contains(err.Error(), "unexpected EOF") {
		return true
	}
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	return false
}

func (f *VFSFile) monitorReplicaClient(ctx context.Context) {
	ticker := time.NewTicker(f.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if f.hasTargetTime() {
				continue
			}
			if err := f.pollReplicaClient(ctx); err != nil {
				// Don't log context cancellation errors during shutdown
				if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
					f.logger.Error("cannot fetch new ltx files", "error", err)
				}
			} else {
				// Track successful poll time
				f.mu.Lock()
				f.lastPollSuccess = time.Now()
				f.mu.Unlock()
			}
		}
	}
}

// pollReplicaClient fetches new LTX files from the replica client and updates
// the page index & the current position.
func (f *VFSFile) pollReplicaClient(ctx context.Context) error {
	pos := f.Pos()

	combined := make(map[uint32]ltx.PageIndexElem)

	f.mu.Lock()
	writeEnabled := f.writeEnabled
	if writeEnabled {
		pos = f.remotePos
	}
	baseCommit := f.commit
	maxTXID1Snapshot := f.maxTXID1
	if writeEnabled {
		baseCommit = f.remoteCommit
		maxTXID1Snapshot = f.remoteMaxTXID1
	}
	f.mu.Unlock()

	f.logger.Debug("polling replica client", "txid", pos.TXID.String(), "writeEnabled", writeEnabled)

	newCommit := baseCommit
	replaceIndex := false

	maxTXID0, idx0, commit0, replace0, err := f.pollLevel(ctx, 0, pos.TXID, baseCommit)
	if err != nil {
		return fmt.Errorf("poll L0: %w", err)
	}
	if replace0 {
		replaceIndex = true
		baseCommit = commit0
		newCommit = commit0
		combined = idx0
	} else {
		if len(idx0) > 0 {
			baseCommit = commit0
		}
		for k, v := range idx0 {
			combined[k] = v
		}
		if commit0 > newCommit {
			newCommit = commit0
		}
	}

	maxTXID1, idx1, commit1, replace1, err := f.pollLevel(ctx, 1, maxTXID1Snapshot, baseCommit)
	if err != nil {
		return fmt.Errorf("poll L1: %w", err)
	}
	if replace1 {
		replaceIndex = true
		baseCommit = commit1
		newCommit = commit1
		combined = idx1
	} else {
		for k, v := range idx1 {
			combined[k] = v
		}
		if commit1 > newCommit {
			newCommit = commit1
		}
	}

	// Send updates to a pending list if there are active readers.
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.targetTime != nil {
		// Skip applying updates while time travel is active to avoid
		// overwriting the historical snapshot state.
		return nil
	}

	f.applyPollResultLocked(writeEnabled, replaceIndex, combined, newCommit, maxTXID0, maxTXID1)

	// Apply updates to hydrated file if hydration is complete
	if f.hydrator != nil && f.hydrator.Complete() && len(combined) > 0 {
		if err := f.hydrator.ApplyUpdates(f.ctx, combined); err != nil {
			f.logger.Error("failed to apply updates to hydrated file", "error", err)
		}
	}

	return nil
}

// pollLevel fetches LTX files for a specific level and returns the highest TXID seen,
// any index updates, the latest commit value, and if the index should be replaced.
func (f *VFSFile) pollLevel(ctx context.Context, level int, prevMaxTXID ltx.TXID, baseCommit uint32) (ltx.TXID, map[uint32]ltx.PageIndexElem, uint32, bool, error) {
	itr, err := f.client.LTXFiles(ctx, level, prevMaxTXID+1, false)
	if err != nil {
		return prevMaxTXID, nil, baseCommit, false, fmt.Errorf("ltx files: %w", err)
	}
	defer func() { _ = itr.Close() }()

	index := make(map[uint32]ltx.PageIndexElem)
	maxTXID := prevMaxTXID
	lastCommit := baseCommit
	newCommit := baseCommit
	replaceIndex := false

	for itr.Next() {
		info := itr.Item()

		f.mu.Lock()
		isNextTXID := info.MinTXID == maxTXID+1
		if level > 0 && maxTXID == 0 {
			isNextTXID = true
		}
		f.mu.Unlock()
		if !isNextTXID {
			if level == 0 && info.MinTXID > maxTXID+1 {
				f.logger.Warn("ltx gap detected at L0, deferring to higher levels", "expected", maxTXID+1, "next", info.MinTXID)
				break
			}
			return maxTXID, nil, newCommit, replaceIndex, fmt.Errorf("non-contiguous ltx file: level=%d, current=%s, next=%s-%s", level, maxTXID, info.MinTXID, info.MaxTXID)
		}

		f.logger.Debug("new ltx file", "level", info.Level, "min", info.MinTXID, "max", info.MaxTXID)

		idx, err := FetchPageIndex(ctx, f.client, info)
		if err != nil {
			return maxTXID, nil, newCommit, replaceIndex, fmt.Errorf("fetch page index: %w", err)
		}
		hdr, err := FetchLTXHeader(ctx, f.client, info)
		if err != nil {
			return maxTXID, nil, newCommit, replaceIndex, fmt.Errorf("fetch header: %w", err)
		}

		if hdr.Commit < lastCommit {
			replaceIndex = true
			index = make(map[uint32]ltx.PageIndexElem)
		}
		lastCommit = hdr.Commit
		newCommit = hdr.Commit

		for k, v := range idx {
			f.logger.Debug("adding new page index", "page", k, "elem", v)
			index[k] = v
		}
		maxTXID = info.MaxTXID
	}

	return maxTXID, index, newCommit, replaceIndex, nil
}

func (f *VFSFile) pageSizeBytes() (uint32, error) {
	f.mu.Lock()
	pageSize := f.pageSize
	f.mu.Unlock()
	if pageSize == 0 {
		f.logger.Debug("page size not initialized", "pageSize", 0)
		return 0, &DBNotReadyError{Reason: "page size not initialized"}
	}
	return pageSize, nil
}

func detectPageSizeFromInfos(ctx context.Context, client ReplicaClient, infos []*ltx.FileInfo) (uint32, error) {
	var lastErr error
	for i := len(infos) - 1; i >= 0; i-- {
		pageSize, err := readPageSizeFromInfo(ctx, client, infos[i])
		if err != nil {
			lastErr = err
			continue
		}
		if !isSupportedPageSize(pageSize) {
			return 0, fmt.Errorf("unsupported page size: %d", pageSize)
		}
		return pageSize, nil
	}
	if lastErr != nil {
		return 0, fmt.Errorf("read ltx header: %w", lastErr)
	}
	return 0, fmt.Errorf("no ltx file available to determine page size")
}

func readPageSizeFromInfo(ctx context.Context, client ReplicaClient, info *ltx.FileInfo) (uint32, error) {
	rc, err := client.OpenLTXFile(ctx, info.Level, info.MinTXID, info.MaxTXID, 0, ltx.HeaderSize)
	if err != nil {
		return 0, fmt.Errorf("open ltx file: %w", err)
	}
	defer rc.Close()
	dec := ltx.NewDecoder(rc)
	if err := dec.DecodeHeader(); err != nil {
		return 0, fmt.Errorf("decode ltx header: %w", err)
	}
	return dec.Header().PageSize, nil
}

func isSupportedPageSize(pageSize uint32) bool {
	switch pageSize {
	case 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536:
		return true
	default:
		return false
	}
}

func (f *VFSFile) waitForRestorePlan() ([]*ltx.FileInfo, error) {
	// If write mode is enabled, don't wait - return immediately so we can
	// create a new database if no files exist.
	if f.writeEnabled {
		infos, err := CalcRestorePlan(f.ctx, f.client, 0, time.Time{}, f.logger)
		if err != nil {
			return nil, err
		}
		return infos, nil
	}

	// For read-only mode, wait for files to become available
	for {
		infos, err := CalcRestorePlan(f.ctx, f.client, 0, time.Time{}, f.logger)
		if err == nil {
			return infos, nil
		}
		if !errors.Is(err, ErrTxNotAvailable) {
			return nil, fmt.Errorf("cannot calc restore plan: %w", err)
		}

		f.logger.Debug("no backup files available yet, waiting", "interval", f.PollInterval)
		select {
		case <-time.After(f.PollInterval):
		case <-f.ctx.Done():
			return nil, fmt.Errorf("no backup files available: %w", f.ctx.Err())
		}
	}
}

// RegisterVFSConnection maps a SQLite connection handle to its VFS file ID.
func RegisterVFSConnection(dbPtr uintptr, fileID uint64) error {
	if _, ok := lookupVFSFile(fileID); !ok {
		return fmt.Errorf("vfs file not found: id=%d", fileID)
	}
	vfsConnectionMap.Store(dbPtr, fileID)
	return nil
}

// UnregisterVFSConnection removes a connection mapping.
func UnregisterVFSConnection(dbPtr uintptr) {
	vfsConnectionMap.Delete(dbPtr)
}

// SetVFSConnectionTime rebuilds the VFS index for a connection at a timestamp.
func SetVFSConnectionTime(dbPtr uintptr, timestamp string) error {
	file, err := vfsFileForConnection(dbPtr)
	if err != nil {
		return err
	}

	t, err := parseTimeValue(timestamp)
	if err != nil {
		return err
	}
	return file.SetTargetTime(context.Background(), t)
}

// ResetVFSConnectionTime rebuilds the VFS index to the latest state.
func ResetVFSConnectionTime(dbPtr uintptr) error {
	file, err := vfsFileForConnection(dbPtr)
	if err != nil {
		return err
	}
	return file.ResetTime(context.Background())
}

// GetVFSConnectionTime returns the current time for a connection.
func GetVFSConnectionTime(dbPtr uintptr) (string, error) {
	file, err := vfsFileForConnection(dbPtr)
	if err != nil {
		return "", err
	}
	return file.currentTimeString(), nil
}

// GetVFSConnectionTXID returns the current transaction ID for a connection as a hex string.
func GetVFSConnectionTXID(dbPtr uintptr) (string, error) {
	file, err := vfsFileForConnection(dbPtr)
	if err != nil {
		return "", err
	}
	return file.Pos().TXID.String(), nil
}

// GetVFSConnectionReplicatedTXID returns the current remote recoverable TXID for a connection.
func GetVFSConnectionReplicatedTXID(dbPtr uintptr) (string, error) {
	file, err := vfsFileForConnection(dbPtr)
	if err != nil {
		return "", err
	}
	return file.remotePos.TXID.String(), nil
}

// GetVFSConnectionGlobalTXID returns the highest local TXID visible across the VFS.
func GetVFSConnectionGlobalTXID(dbPtr uintptr) (string, error) {
	file, err := vfsFileForConnection(dbPtr)
	if err != nil {
		return "", err
	}
	if file.vfs == nil {
		return file.Pos().TXID.String(), nil
	}
	return file.vfs.globalTXID().String(), nil
}

// GetVFSConnectionGlobalReplicatedTXID returns the highest durable remote TXID across the VFS.
func GetVFSConnectionGlobalReplicatedTXID(dbPtr uintptr) (string, error) {
	file, err := vfsFileForConnection(dbPtr)
	if err != nil {
		return "", err
	}
	if file.vfs == nil {
		return file.remotePos.TXID.String(), nil
	}
	return file.vfs.globalReplicatedTXID().String(), nil
}

// GetVFSConnectionLag returns seconds since last successful poll for a connection.
func GetVFSConnectionLag(dbPtr uintptr) (int64, error) {
	file, err := vfsFileForConnection(dbPtr)
	if err != nil {
		return 0, err
	}
	lastPoll := file.LastPollSuccess()
	if lastPoll.IsZero() {
		return -1, nil
	}
	return int64(time.Since(lastPoll).Seconds()), nil
}

func vfsFileForConnection(dbPtr uintptr) (*VFSFile, error) {
	v, ok := vfsConnectionMap.Load(dbPtr)
	if !ok {
		return nil, fmt.Errorf("connection not registered")
	}
	fileID, ok := v.(uint64)
	if !ok {
		return nil, fmt.Errorf("invalid connection mapping")
	}
	file, ok := lookupVFSFile(fileID)
	if !ok {
		return nil, fmt.Errorf("vfs file not found: id=%d", fileID)
	}
	return file, nil
}

func lookupVFSFile(fileID uint64) (*VFSFile, bool) {
	sqlite3vfsFileMux.Lock()
	defer sqlite3vfsFileMux.Unlock()

	file, ok := sqlite3vfsFileMap[fileID]
	if !ok {
		return nil, false
	}

	vfsFile, ok := file.(*VFSFile)
	return vfsFile, ok
}

func (vfs *VFS) globalTXID() ltx.TXID {
	maxTXID := vfs.lastSyncedTXID
	for _, f := range vfs.filesSnapshot() {
		f.mu.Lock()
		txid := f.pos.TXID
		if f.writeEnabled {
			if f.expectedTXID > txid {
				txid = f.expectedTXID
			}
			if f.pendingTXID > 0 && f.pendingTXID-1 > txid {
				txid = f.pendingTXID - 1
			}
		}
		f.mu.Unlock()
		if txid > maxTXID {
			maxTXID = txid
		}
	}
	return maxTXID
}

func (vfs *VFS) globalReplicatedTXID() ltx.TXID {
	maxTXID := vfs.lastSyncedTXID
	for _, f := range vfs.filesSnapshot() {
		f.mu.Lock()
		txid := f.remotePos.TXID
		f.mu.Unlock()
		if txid > maxTXID {
			maxTXID = txid
		}
	}
	return maxTXID
}

func (vfs *VFS) filesSnapshot() []*VFSFile {
	sqlite3vfsFileMux.Lock()
	defer sqlite3vfsFileMux.Unlock()

	files := make([]*VFSFile, 0, len(sqlite3vfsFileMap))
	for _, file := range sqlite3vfsFileMap {
		vfsFile, ok := file.(*VFSFile)
		if !ok || vfsFile.vfs != vfs {
			continue
		}
		files = append(files, vfsFile)
	}
	return files
}

// startCompactionMonitors starts background goroutines for compaction and snapshots.
func (f *VFSFile) startCompactionMonitors() {
	f.compactionCtx, f.compactionCancel = context.WithCancel(f.ctx)

	// Use configured levels or defaults
	levels := f.vfs.CompactionLevels
	if levels == nil {
		levels = DefaultCompactionLevels
	}

	// Start compaction monitors for each level
	for _, lvl := range levels {
		if lvl.Level == 0 {
			continue // L0 doesn't need compaction (source level)
		}
		f.compactionWg.Add(1)
		go func(level *CompactionLevel) {
			defer f.compactionWg.Done()
			f.monitorCompaction(f.compactionCtx, level)
		}(lvl)
	}

	// Start snapshot monitor if configured
	if f.vfs.SnapshotInterval > 0 {
		f.compactionWg.Add(1)
		go func() {
			defer f.compactionWg.Done()
			f.monitorSnapshots(f.compactionCtx)
		}()
	}

	// Start L0 retention monitor if configured
	if f.vfs.L0Retention > 0 {
		f.compactionWg.Add(1)
		go func() {
			defer f.compactionWg.Done()
			f.monitorL0Retention(f.compactionCtx)
		}()
	}

	f.logger.Info("compaction monitors started",
		"levels", len(levels),
		"snapshotInterval", f.vfs.SnapshotInterval,
		"l0Retention", f.vfs.L0Retention)
}

// Compact compacts source level files into the destination level.
// Returns ErrNoCompaction if there are no files to compact.
func (f *VFSFile) Compact(ctx context.Context, level int) (*ltx.FileInfo, error) {
	if f.compactor == nil {
		return nil, fmt.Errorf("compaction not enabled")
	}
	return f.compactor.Compact(ctx, level)
}

// Snapshot creates a full database snapshot from remote LTX files.
// Unlike DB.Snapshot(), this reads from remote rather than local WAL.
func (f *VFSFile) Snapshot(ctx context.Context) (*ltx.FileInfo, error) {
	if f.compactor == nil {
		return nil, fmt.Errorf("compaction not enabled")
	}

	pageSize, commit, pos, pages := f.remoteSnapshotState()

	if pageSize == 0 {
		f.logger.Debug("snapshot skipped, page size not initialized", "pageSize", 0)
		return nil, &DBNotReadyError{Reason: "page size not initialized"}
	}

	lockPgno := ltx.LockPgno(pageSize)
	for pgno := uint32(1); pgno <= commit; pgno++ {
		if pgno == lockPgno {
			continue
		}
		if _, ok := pages[pgno]; !ok {
			f.logger.Debug("snapshot skipped, remote coverage incomplete", "commit", commit, "missing_page", pgno, "indexed_pages", len(pages))
			return nil, &DBNotReadyError{Reason: fmt.Sprintf("remote coverage incomplete at page %d", pgno)}
		}
	}

	// Stream snapshot creation
	pr, pw := io.Pipe()
	go func() {
		enc, err := ltx.NewEncoder(pw)
		if err != nil {
			pw.CloseWithError(err)
			return
		}

		if err := enc.EncodeHeader(ltx.Header{
			Version:   ltx.Version,
			Flags:     ltx.HeaderFlagNoChecksum,
			PageSize:  pageSize,
			Commit:    commit,
			MinTXID:   1,
			MaxTXID:   pos.TXID,
			Timestamp: time.Now().UnixMilli(),
		}); err != nil {
			pw.CloseWithError(fmt.Errorf("encode header: %w", err))
			return
		}

		for pgno := uint32(1); pgno <= commit; pgno++ {
			if pgno == lockPgno {
				continue
			}

			elem := pages[pgno]
			_, data, err := FetchPage(ctx, f.client, elem.Level, elem.MinTXID, elem.MaxTXID, elem.Offset, elem.Size)
			if err != nil {
				pw.CloseWithError(fmt.Errorf("fetch page %d: %w", pgno, err))
				return
			}
			if err := enc.EncodePage(ltx.PageHeader{Pgno: pgno}, data); err != nil {
				pw.CloseWithError(fmt.Errorf("encode page %d: %w", pgno, err))
				return
			}
		}

		if err := enc.Close(); err != nil {
			pw.CloseWithError(fmt.Errorf("close encoder: %w", err))
			return
		}
		pw.Close()
	}()

	return f.client.WriteLTXFile(ctx, SnapshotLevel, 1, pos.TXID, pr)
}

// RunMaintenance performs a one-shot compaction/snapshot maintenance pass over
// open database files. It is intended for shutdown paths that cannot wait for
// the background maintenance tickers to fire.
func (vfs *VFS) RunMaintenance(ctx context.Context, opts MaintenanceOptions) (MaintenanceStats, error) {
	var stats MaintenanceStats
	for _, f := range vfs.filesSnapshot() {
		if f == nil || f.compactor == nil {
			continue
		}
		stats.OpenFiles++

		if opts.CompactLevel > 0 {
			info, err := f.Compact(ctx, opts.CompactLevel)
			if err != nil {
				if errors.Is(err, ErrNoCompaction) {
					stats.CompactionSkipped = true
					stats.CompactionSkipReason = err.Error()
				} else {
					return stats, err
				}
			} else if info != nil {
				stats.Compacted = true
				stats.CompactionLevel = info.Level
				stats.CompactionMinTXID = uint64(info.MinTXID)
				stats.CompactionMaxTXID = uint64(info.MaxTXID)
				stats.CompactionSize = info.Size
				if f.writeEnabled {
					if err := f.applyRemoteFileInfo(ctx, info); err != nil {
						return stats, fmt.Errorf("apply compaction remote state: %w", err)
					}
				}
			}
		}

		if opts.Snapshot {
			info, err := f.Snapshot(ctx)
			if err != nil {
				if errors.Is(err, ErrDBNotReady) {
					stats.SnapshotSkipped = true
					stats.SnapshotSkipReason = err.Error()
				} else {
					return stats, err
				}
			} else if info != nil {
				stats.SnapshotCreated = true
				stats.SnapshotMinTXID = uint64(info.MinTXID)
				stats.SnapshotMaxTXID = uint64(info.MaxTXID)
				stats.SnapshotSize = info.Size
			}
		}

		if opts.EnforceSnapshotRetention {
			minTXID, err := f.compactor.EnforceSnapshotRetention(ctx, opts.SnapshotRetention)
			if err != nil {
				return stats, err
			}
			stats.SnapshotRetentionMinTXID = uint64(minTXID)
		}

		if opts.EnforceL0Retention {
			if err := f.compactor.EnforceL0Retention(ctx, opts.L0Retention); err != nil {
				return stats, err
			}
			stats.L0RetentionEnforced = true
		}
	}
	return stats, nil
}

// monitorCompaction runs periodic compaction for a level.
func (f *VFSFile) monitorCompaction(ctx context.Context, lvl *CompactionLevel) {
	f.logger.Info("starting VFS compaction monitor", "level", lvl.Level, "interval", lvl.Interval)

	ticker := time.NewTicker(lvl.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			info, err := f.Compact(ctx, lvl.Level)
			if err != nil {
				if !errors.Is(err, ErrNoCompaction) &&
					!errors.Is(err, context.Canceled) &&
					!errors.Is(err, context.DeadlineExceeded) {
					f.logger.Error("compaction failed", "level", lvl.Level, "error", err)
				}
			} else {
				if f.writeEnabled {
					if err := f.applyRemoteFileInfo(ctx, info); err != nil {
						f.logger.Error("failed to apply compaction remote state", "level", lvl.Level, "error", err)
					}
				}
				f.logger.Debug("compaction completed",
					"level", lvl.Level,
					"minTXID", info.MinTXID,
					"maxTXID", info.MaxTXID,
					"size", info.Size)
			}
		}
	}
}

// monitorSnapshots runs periodic snapshot creation.
func (f *VFSFile) monitorSnapshots(ctx context.Context) {
	f.logger.Info("starting VFS snapshot monitor", "interval", f.vfs.SnapshotInterval)

	ticker := time.NewTicker(f.vfs.SnapshotInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			info, err := f.Snapshot(ctx)
			if err != nil {
				// DBNotReadyError is already logged at debug level in Snapshot()
				if !errors.Is(err, context.Canceled) &&
					!errors.Is(err, context.DeadlineExceeded) &&
					!errors.Is(err, ErrDBNotReady) {
					f.logger.Error("snapshot failed", "error", err)
				}
			} else {
				f.logger.Debug("snapshot created",
					"maxTXID", info.MaxTXID,
					"size", info.Size)

				// Enforce snapshot retention after creating new snapshot
				if f.vfs.SnapshotRetention > 0 {
					if _, err := f.compactor.EnforceSnapshotRetention(ctx, f.vfs.SnapshotRetention); err != nil {
						f.logger.Error("snapshot retention failed", "error", err)
					}
				}
			}
		}
	}
}

// monitorL0Retention runs periodic L0 retention enforcement.
func (f *VFSFile) monitorL0Retention(ctx context.Context) {
	f.logger.Info("starting VFS L0 retention monitor", "retention", f.vfs.L0Retention)

	// Check more frequently than the retention period
	checkInterval := f.vfs.L0Retention / 4
	if checkInterval < time.Minute {
		checkInterval = time.Minute
	}

	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := f.compactor.EnforceL0Retention(ctx, f.vfs.L0Retention); err != nil {
				if !errors.Is(err, context.Canceled) &&
					!errors.Is(err, context.DeadlineExceeded) {
					f.logger.Error("L0 retention enforcement failed", "error", err)
				}
			}
		}
	}
}
