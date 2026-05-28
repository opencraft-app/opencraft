//go:build litestreamvfs && vfs

package meta

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/benbjohnson/litestream"
	"github.com/juicedata/juicefs/pkg/object"
	"github.com/superfly/ltx"
)

const (
	smhLitestreamOpenLTXAttempts  = 3
	smhLitestreamOpenLTXRetryBase = 250 * time.Millisecond
	smhLitestreamLayoutDir        = "dir"
	smhLitestreamLayoutFlat       = "flat"
	smhLitestreamLTXCacheMaxFile  = 8 << 20
	smhLitestreamLTXCacheMaxBytes = 64 << 20
)

func init() {
	litestream.RegisterReplicaClientFactory("smh", newSMHLitestreamReplicaClientFromURL)
}

type smhLitestreamReplicaClient struct {
	traceID         uint64
	store           object.ObjectStorage
	logger          *slog.Logger
	layout          string
	flatBase        string
	cacheNamespace  string
	flatListMu      sync.Mutex
	flatListCache   []object.Object
	flatListCacheOK bool
	ltxCacheMu      sync.Mutex
	ltxCache        map[string][]byte
	ltxCacheBytes   int64
}

var (
	smhLitestreamClientSeq atomic.Uint64
	smhGlobalLTXFileCache  ltxFileContentCache
)

type ltxFileContentCache struct {
	mu       sync.Mutex
	files    map[string][]byte
	sizes    map[string]int64
	bytes    int64
	inflight map[string]*ltxFileContentCacheFlight
}

type ltxFileContentCacheFlight struct {
	done chan struct{}
	data []byte
	err  error
}

func newSMHLitestreamReplicaClientFromURL(scheme, host, urlPath string, query url.Values, userinfo *url.Userinfo) (litestream.ReplicaClient, error) {
	endpoint := strings.TrimSpace(query.Get("endpoint"))
	if endpoint == "" {
		if host == "" {
			return nil, fmt.Errorf("smh replica endpoint host required")
		}
		endpoint = "https://" + host
	} else if !strings.Contains(endpoint, "://") {
		endpoint = "https://" + endpoint
	}

	libraryID := strings.TrimSpace(query.Get("library_id"))
	spaceID := strings.TrimSpace(query.Get("space_id"))
	if libraryID == "" || spaceID == "" {
		return nil, fmt.Errorf("smh replica requires library_id and space_id")
	}

	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("parse smh replica endpoint: %w", err)
	}
	q := u.Query()
	q.Set("library_id", libraryID)
	q.Set("space_id", spaceID)
	if v := strings.TrimSpace(query.Get("permanent")); v != "" {
		q.Set("permanent", v)
	}
	u.RawQuery = q.Encode()

	accessToken := strings.TrimSpace(query.Get("access_token"))
	if accessToken == "" && userinfo != nil {
		accessToken, _ = userinfo.Password()
		if accessToken == "" {
			accessToken = userinfo.Username()
		}
	}

	store, err := object.CreateStorage("smh", u.String(), accessToken, "", "")
	if err != nil {
		return nil, err
	}

	prefix := strings.Trim(strings.TrimSpace(urlPath), "/")
	if v := strings.Trim(strings.TrimSpace(query.Get("prefix")), "/"); v != "" {
		prefix = v
	}
	layout := strings.TrimSpace(query.Get("layout"))
	if layout == "" {
		layout = smhLitestreamLayoutFlat
	}
	switch layout {
	case smhLitestreamLayoutFlat:
		parent := strings.Trim(path.Dir("/"+prefix), "/")
		if parent != "" && parent != "." {
			store = object.WithPrefix(store, parent+"/")
		}
	case smhLitestreamLayoutDir:
		if prefix != "" {
			store = object.WithPrefix(store, prefix+"/")
		}
	default:
		return nil, fmt.Errorf("unsupported smh replica layout %q", layout)
	}
	flatBase := path.Base(prefix)
	if flatBase == "." || flatBase == "/" {
		flatBase = "meta.db"
	}

	client := &smhLitestreamReplicaClient{
		traceID:        smhLitestreamClientSeq.Add(1),
		store:          store,
		logger:         slog.Default().WithGroup("smh"),
		layout:         layout,
		flatBase:       flatBase,
		cacheNamespace: strings.Join([]string{endpoint, libraryID, spaceID, prefix, layout}, "|"),
	}
	client.trace("client_created", "layout", layout, "prefix", prefix, "flat_base", flatBase, "space_id", spaceID)
	return client, nil
}

func (c *smhLitestreamReplicaClient) Type() string { return "smh" }

func (c *smhLitestreamReplicaClient) Init(ctx context.Context) error {
	c.trace("client_init")
	return nil
}

func (c *smhLitestreamReplicaClient) SetLogger(logger *slog.Logger) {
	c.logger = logger.WithGroup("smh")
}

func (c *smhLitestreamReplicaClient) LTXFiles(ctx context.Context, level int, seek ltx.TXID, useMetadata bool) (ltx.FileIterator, error) {
	c.trace("ltx_files_start", "level", level, "seek", seek, "use_metadata", useMetadata, "layout", c.layout)
	var infos []*ltx.FileInfo
	if c.layout == smhLitestreamLayoutFlat {
		objs, err := c.flatLTXObjects(ctx)
		if err != nil {
			c.trace("ltx_files_error", "level", level, "error", err)
			return nil, err
		}
		for _, obj := range objs {
			if obj == nil || obj.IsDir() {
				continue
			}
			info, ok, err := c.ltxInfoFromKey(ctx, level, seek, useMetadata, obj)
			if err != nil {
				c.trace("ltx_files_error", "level", level, "error", err)
				return nil, err
			}
			if ok {
				infos = append(infos, info)
			}
		}
		slices.SortFunc(infos, compareLTXFileInfo)
		c.trace("ltx_files_done", "level", level, "count", len(infos))
		return ltx.NewFileInfoSliceIterator(infos), nil
	}

	prefix := c.ltxListPrefix(level)
	startAfter := ""
	for {
		objs, hasMore, nextMarker, err := c.store.List(ctx, prefix, startAfter, "", "/", 1000, false)
		if err != nil {
			c.trace("ltx_files_error", "level", level, "error", err)
			return nil, err
		}
		for _, obj := range objs {
			if obj == nil || obj.IsDir() {
				continue
			}
			info, ok, err := c.ltxInfoFromKey(ctx, level, seek, useMetadata, obj)
			if err != nil {
				c.trace("ltx_files_error", "level", level, "error", err)
				return nil, err
			}
			if ok {
				infos = append(infos, info)
			}
		}
		if !hasMore {
			break
		}
		startAfter = nextMarker
		if startAfter == "" && len(objs) > 0 {
			startAfter = objs[len(objs)-1].Key()
		}
		if startAfter == "" {
			break
		}
	}
	slices.SortFunc(infos, compareLTXFileInfo)
	c.trace("ltx_files_done", "level", level, "count", len(infos))
	return ltx.NewFileInfoSliceIterator(infos), nil
}

func (c *smhLitestreamReplicaClient) OpenLTXFile(ctx context.Context, level int, minTXID, maxTXID ltx.TXID, offset, size int64) (io.ReadCloser, error) {
	key := c.ltxFileKey(level, minTXID, maxTXID)
	c.trace("open_ltx_start", "level", level, "min_txid", minTXID, "max_txid", maxTXID, "offset", offset, "size", size, "key", key)
	rc, err := c.openLTXFileCached(ctx, key, offset, size)
	if os.IsNotExist(err) {
		c.trace("open_ltx_missing", "level", level, "min_txid", minTXID, "max_txid", maxTXID, "key", key)
		return nil, litestream.NewLTXError("open", key, level, uint64(minTXID), uint64(maxTXID), err)
	}
	if err != nil {
		c.trace("open_ltx_error", "level", level, "min_txid", minTXID, "max_txid", maxTXID, "key", key, "error", err)
		return nil, err
	}
	c.trace("open_ltx_done", "level", level, "min_txid", minTXID, "max_txid", maxTXID, "key", key)
	return rc, nil
}

func (c *smhLitestreamReplicaClient) openLTXFileCached(ctx context.Context, key string, offset, size int64) (io.ReadCloser, error) {
	if data, ok := c.cachedLTXFile(key); ok {
		c.trace("open_ltx_cache_hit", "key", key, "scope", "local_or_global")
		return ltxCacheReader(data, offset, size), nil
	}
	if data, ok, err := smhGlobalLTXFileCache.wait(c.globalLTXCacheKey(key)); ok || err != nil {
		if err != nil {
			c.trace("open_ltx_cache_wait_error", "key", key, "error", err)
			return nil, err
		}
		c.trace("open_ltx_cache_wait_hit", "key", key)
		c.setLocalCachedLTXFile(key, data)
		return ltxCacheReader(data, offset, size), nil
	}
	if !c.shouldCacheLTXOpen(key, offset, size) {
		c.trace("open_ltx_remote_range", "key", key, "offset", offset, "size", size)
		return c.openLTXFileWithRetry(ctx, key, offset, size)
	}
	c.trace("open_ltx_remote_full", "key", key, "requested_offset", offset, "requested_size", size)
	data, err := smhGlobalLTXFileCache.load(c.globalLTXCacheKey(key), func() ([]byte, error) {
		if data, ok := c.cachedLTXFile(key); ok {
			return data, nil
		}
		rc, err := c.openLTXFileWithRetry(ctx, key, 0, -1)
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		data, err := io.ReadAll(rc)
		if err != nil {
			return nil, err
		}
		c.setLocalCachedLTXFile(key, data)
		return data, nil
	})
	if err != nil {
		return nil, err
	}
	return ltxCacheReader(data, offset, size), nil
}

func (c *smhLitestreamReplicaClient) openLTXFileWithRetry(ctx context.Context, key string, offset, size int64) (io.ReadCloser, error) {
	var lastErr error
	for attempt := 1; attempt <= smhLitestreamOpenLTXAttempts; attempt++ {
		c.trace("open_ltx_remote_attempt", "key", key, "offset", offset, "size", size, "attempt", attempt)
		rc, err := c.store.Get(ctx, key, offset, size)
		if err == nil || !isRetryableSMHLTXOpenError(err) || attempt == smhLitestreamOpenLTXAttempts {
			return rc, err
		}
		lastErr = err
		delay := smhLitestreamOpenLTXRetryBase * time.Duration(attempt)
		c.logger.Warn("retrying ltx open after transient smh read failure", "path", key, "attempt", attempt, "delay", delay, "error", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
	}
	return nil, lastErr
}

func (c *smhLitestreamReplicaClient) shouldCacheLTXOpen(key string, offset, size int64) bool {
	if size <= 0 {
		return true
	}
	if size > smhLitestreamLTXCacheMaxFile {
		return false
	}
	fullSize, ok := c.cachedLTXObjectSize(key)
	if ok {
		return fullSize <= smhLitestreamLTXCacheMaxFile
	}
	return offset == 0 && size <= int64(ltx.HeaderSize)
}

func (c *smhLitestreamReplicaClient) cachedLTXObjectSize(key string) (int64, bool) {
	c.flatListMu.Lock()
	defer c.flatListMu.Unlock()
	if !c.flatListCacheOK {
		return 0, false
	}
	for _, obj := range c.flatListCache {
		if obj != nil && obj.Key() == key {
			return obj.Size(), true
		}
	}
	return smhGlobalLTXFileCache.size(c.globalLTXCacheKey(key))
}

func (c *smhLitestreamReplicaClient) cachedLTXFile(key string) ([]byte, bool) {
	c.ltxCacheMu.Lock()
	defer c.ltxCacheMu.Unlock()
	data, ok := c.ltxCache[key]
	if !ok {
		return smhGlobalLTXFileCache.get(c.globalLTXCacheKey(key))
	}
	return bytes.Clone(data), true
}

func (c *smhLitestreamReplicaClient) setCachedLTXFile(key string, data []byte) {
	c.setLocalCachedLTXFile(key, data)
	smhGlobalLTXFileCache.set(c.globalLTXCacheKey(key), data)
}

func (c *smhLitestreamReplicaClient) setLocalCachedLTXFile(key string, data []byte) {
	if len(data) > smhLitestreamLTXCacheMaxFile {
		return
	}
	c.ltxCacheMu.Lock()
	defer c.ltxCacheMu.Unlock()
	if c.ltxCache == nil {
		c.ltxCache = make(map[string][]byte)
	}
	if old, ok := c.ltxCache[key]; ok {
		c.ltxCacheBytes -= int64(len(old))
	}
	c.ltxCache[key] = bytes.Clone(data)
	c.ltxCacheBytes += int64(len(data))
	if c.ltxCacheBytes > smhLitestreamLTXCacheMaxBytes {
		c.ltxCache = nil
		c.ltxCacheBytes = 0
	}
}

func (c *smhLitestreamReplicaClient) invalidateLTXFileCache() {
	c.ltxCacheMu.Lock()
	c.ltxCache = nil
	c.ltxCacheBytes = 0
	c.ltxCacheMu.Unlock()
	smhGlobalLTXFileCache.invalidateNamespace(c.globalLTXCacheKey(""))
}

func (c *smhLitestreamReplicaClient) globalLTXCacheKey(key string) string {
	return c.cacheNamespace + "\x00" + key
}

func (c *ltxFileContentCache) get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	data, ok := c.files[key]
	if !ok {
		return nil, false
	}
	return bytes.Clone(data), true
}

func (c *ltxFileContentCache) wait(key string) ([]byte, bool, error) {
	c.mu.Lock()
	flight, ok := c.inflight[key]
	if !ok {
		c.mu.Unlock()
		return nil, false, nil
	}
	done := flight.done
	c.mu.Unlock()
	<-done
	if flight.err != nil {
		return nil, true, flight.err
	}
	return bytes.Clone(flight.data), true, nil
}

func (c *ltxFileContentCache) set(key string, data []byte) {
	if len(data) > smhLitestreamLTXCacheMaxFile {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.files == nil {
		c.files = make(map[string][]byte)
	}
	if old, ok := c.files[key]; ok {
		c.bytes -= int64(len(old))
	}
	c.files[key] = bytes.Clone(data)
	c.bytes += int64(len(data))
	if c.bytes > smhLitestreamLTXCacheMaxBytes {
		c.files = nil
		c.bytes = 0
	}
}

func (c *ltxFileContentCache) rememberSize(key string, size int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sizes == nil {
		c.sizes = make(map[string]int64)
	}
	c.sizes[key] = size
}

func (c *ltxFileContentCache) size(key string) (int64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	size, ok := c.sizes[key]
	return size, ok
}

func (c *ltxFileContentCache) load(key string, fn func() ([]byte, error)) ([]byte, error) {
	c.mu.Lock()
	if data, ok := c.files[key]; ok {
		c.mu.Unlock()
		return bytes.Clone(data), nil
	}
	if flight, ok := c.inflight[key]; ok {
		done := flight.done
		c.mu.Unlock()
		<-done
		if flight.err != nil {
			return nil, flight.err
		}
		return bytes.Clone(flight.data), nil
	}
	if c.inflight == nil {
		c.inflight = make(map[string]*ltxFileContentCacheFlight)
	}
	flight := &ltxFileContentCacheFlight{done: make(chan struct{})}
	c.inflight[key] = flight
	c.mu.Unlock()

	data, err := fn()
	if err == nil {
		data = bytes.Clone(data)
	}

	c.mu.Lock()
	if err == nil && len(data) <= smhLitestreamLTXCacheMaxFile {
		if c.files == nil {
			c.files = make(map[string][]byte)
		}
		if old, ok := c.files[key]; ok {
			c.bytes -= int64(len(old))
		}
		c.files[key] = data
		c.bytes += int64(len(data))
		if c.bytes > smhLitestreamLTXCacheMaxBytes {
			c.files = nil
			c.bytes = 0
		}
	}
	if err == nil {
		flight.data = bytes.Clone(data)
	}
	flight.err = err
	delete(c.inflight, key)
	close(flight.done)
	c.mu.Unlock()

	if err != nil {
		return nil, err
	}
	return bytes.Clone(data), nil
}

func (c *ltxFileContentCache) invalidateNamespace(prefix string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, data := range c.files {
		if strings.HasPrefix(key, prefix) {
			c.bytes -= int64(len(data))
			delete(c.files, key)
		}
	}
	for key := range c.sizes {
		if strings.HasPrefix(key, prefix) {
			delete(c.sizes, key)
		}
	}
	if c.bytes < 0 {
		c.files = nil
		c.bytes = 0
	}
}

func ltxCacheReader(data []byte, offset, size int64) io.ReadCloser {
	if offset < 0 {
		offset = 0
	}
	if offset > int64(len(data)) {
		offset = int64(len(data))
	}
	end := int64(len(data))
	if size > 0 && offset+size < end {
		end = offset + size
	}
	return io.NopCloser(bytes.NewReader(data[offset:end]))
}

func isRetryableSMHLTXOpenError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || os.IsNotExist(err) {
		return false
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "timeout awaiting response headers")
}

func (c *smhLitestreamReplicaClient) WriteLTXFile(ctx context.Context, level int, minTXID, maxTXID ltx.TXID, r io.Reader) (*ltx.FileInfo, error) {
	hdr, payload, err := ltx.PeekHeader(r)
	if err != nil {
		return nil, fmt.Errorf("extract timestamp from LTX header: %w", err)
	}
	counter := &readCounter{r: payload}
	key := c.ltxFileKey(level, minTXID, maxTXID)
	c.trace("write_ltx_start", "level", level, "min_txid", minTXID, "max_txid", maxTXID, "key", key)
	if err := c.store.Put(ctx, key, counter); err != nil {
		c.trace("write_ltx_error", "level", level, "min_txid", minTXID, "max_txid", maxTXID, "key", key, "error", err)
		return nil, err
	}
	c.invalidateFlatListCache()
	c.invalidateLTXFileCache()
	c.trace("write_ltx_done", "level", level, "min_txid", minTXID, "max_txid", maxTXID, "key", key, "size", counter.n)
	return &ltx.FileInfo{
		Level:     level,
		MinTXID:   minTXID,
		MaxTXID:   maxTXID,
		Size:      counter.n,
		CreatedAt: time.UnixMilli(hdr.Timestamp).UTC(),
	}, nil
}

type readCounter struct {
	r io.Reader
	n int64
}

func (r *readCounter) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	r.n += int64(n)
	return n, err
}

func (c *smhLitestreamReplicaClient) DeleteLTXFiles(ctx context.Context, infos []*ltx.FileInfo) error {
	deleted := false
	for _, info := range infos {
		if info == nil {
			continue
		}
		key := c.ltxFileKey(info.Level, info.MinTXID, info.MaxTXID)
		c.logger.Debug("deleting ltx file", "level", info.Level, "minTXID", info.MinTXID, "maxTXID", info.MaxTXID, "path", key)
		if err := c.store.Delete(ctx, key); err != nil && !os.IsNotExist(err) {
			return err
		}
		deleted = true
	}
	if deleted {
		c.invalidateFlatListCache()
		c.invalidateLTXFileCache()
	}
	return nil
}

func (c *smhLitestreamReplicaClient) DeleteAll(ctx context.Context) error {
	startAfter := ""
	prefix := c.ltxDeleteAllPrefix()
	deleted := false
	for {
		objs, hasMore, nextMarker, err := c.store.List(ctx, prefix, startAfter, "", "/", 1000, false)
		if err != nil {
			return err
		}
		for _, obj := range objs {
			if obj == nil || obj.IsDir() {
				continue
			}
			if err := c.store.Delete(ctx, obj.Key()); err != nil && !os.IsNotExist(err) {
				return err
			}
			deleted = true
		}
		if !hasMore {
			if deleted {
				c.invalidateFlatListCache()
				c.invalidateLTXFileCache()
			}
			return nil
		}
		startAfter = nextMarker
		if startAfter == "" && len(objs) > 0 {
			startAfter = objs[len(objs)-1].Key()
		}
		if startAfter == "" {
			if deleted {
				c.invalidateFlatListCache()
				c.invalidateLTXFileCache()
			}
			return nil
		}
	}
}

func (c *smhLitestreamReplicaClient) flatLTXObjects(ctx context.Context) ([]object.Object, error) {
	c.flatListMu.Lock()
	defer c.flatListMu.Unlock()
	if c.flatListCacheOK {
		c.trace("flat_list_cache_hit", "count", len(c.flatListCache))
		return slices.Clone(c.flatListCache), nil
	}

	prefix := c.ltxDeleteAllPrefix()
	c.trace("flat_list_remote_start", "prefix", prefix)
	startAfter := ""
	var all []object.Object
	for {
		objs, hasMore, nextMarker, err := c.store.List(ctx, prefix, startAfter, "", "/", 1000, false)
		if err != nil {
			c.trace("flat_list_remote_error", "prefix", prefix, "error", err)
			return nil, err
		}
		all = append(all, objs...)
		if !hasMore {
			break
		}
		if len(objs) > 0 {
			startAfter = objs[len(objs)-1].Key()
		} else {
			startAfter = nextMarker
		}
		if startAfter == "" {
			break
		}
	}

	c.flatListCache = slices.Clone(all)
	c.flatListCacheOK = true
	c.trace("flat_list_remote_done", "prefix", prefix, "count", len(all))
	return slices.Clone(all), nil
}

func (c *smhLitestreamReplicaClient) invalidateFlatListCache() {
	if c.layout != smhLitestreamLayoutFlat {
		return
	}
	c.flatListMu.Lock()
	c.flatListCache = nil
	c.flatListCacheOK = false
	c.flatListMu.Unlock()
}

func (c *smhLitestreamReplicaClient) ltxInfoFromKey(ctx context.Context, level int, seek ltx.TXID, useMetadata bool, obj object.Object) (*ltx.FileInfo, bool, error) {
	filename, ok := c.ltxFilenameFromKey(level, obj.Key())
	if !ok {
		return nil, false, nil
	}
	minTXID, maxTXID, err := ltx.ParseFilename(filename)
	if err != nil || minTXID < seek {
		return nil, false, nil
	}
	info := &ltx.FileInfo{
		Level:     level,
		MinTXID:   minTXID,
		MaxTXID:   maxTXID,
		Size:      obj.Size(),
		CreatedAt: obj.Mtime().UTC(),
	}
	c.rememberLTXObjectSize(obj.Key(), obj.Size())
	if useMetadata {
		hdr, err := litestream.FetchLTXHeader(ctx, c, info)
		if err != nil {
			return nil, false, err
		}
		info.CreatedAt = time.UnixMilli(hdr.Timestamp).UTC()
	}
	return info, true, nil
}

func (c *smhLitestreamReplicaClient) rememberLTXObjectSize(key string, size int64) {
	if size <= 0 {
		return
	}
	smhGlobalLTXFileCache.rememberSize(c.globalLTXCacheKey(key), size)
}

func compareLTXFileInfo(a, b *ltx.FileInfo) int {
	if a.MinTXID < b.MinTXID {
		return -1
	}
	if a.MinTXID > b.MinTXID {
		return 1
	}
	if a.MaxTXID < b.MaxTXID {
		return -1
	}
	if a.MaxTXID > b.MaxTXID {
		return 1
	}
	return 0
}

func (c *smhLitestreamReplicaClient) ltxListPrefix(level int) string {
	if c.layout == smhLitestreamLayoutFlat {
		return c.flatLTXPrefix(level)
	}
	prefix := litestream.LTXLevelDir("", level)
	if prefix != "" {
		prefix += "/"
	}
	return prefix
}

func (c *smhLitestreamReplicaClient) ltxFileKey(level int, minTXID, maxTXID ltx.TXID) string {
	if c.layout == smhLitestreamLayoutFlat {
		return c.flatLTXPrefix(level) + ltx.FormatFilename(minTXID, maxTXID)
	}
	return litestream.LTXFilePath("", level, minTXID, maxTXID)
}

func (c *smhLitestreamReplicaClient) ltxFilenameFromKey(level int, key string) (string, bool) {
	if c.layout == smhLitestreamLayoutFlat {
		filename, ok := strings.CutPrefix(key, c.flatLTXPrefix(level))
		return filename, ok
	}
	return path.Base(key), true
}

func (c *smhLitestreamReplicaClient) ltxDeleteAllPrefix() string {
	if c.layout == smhLitestreamLayoutFlat {
		return c.flatBase + "--ltx--"
	}
	return ""
}

func (c *smhLitestreamReplicaClient) flatLTXPrefix(level int) string {
	return c.flatBase + "--ltx--" + fmt.Sprintf("%04x", level) + "--"
}

func (c *smhLitestreamReplicaClient) trace(event string, attrs ...any) {
	if c == nil {
		return
	}
	all := append([]any{"client_id", c.traceID}, attrs...)
	sqliteLitestreamTrace("smh_"+event, all...)
}

var _ litestream.ReplicaClient = (*smhLitestreamReplicaClient)(nil)
