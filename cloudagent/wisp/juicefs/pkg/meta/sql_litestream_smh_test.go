//go:build litestreamvfs && vfs

package meta

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/benbjohnson/litestream"
	"github.com/juicedata/juicefs/pkg/object"
	"github.com/superfly/ltx"
)

func TestSMHLitestreamReplicaClientFromURL(t *testing.T) {
	t.Setenv("SMH_ACCESS_TOKEN", "token")
	client, err := litestream.NewReplicaClientFromURL("smh://example.api.tencentsmh.cn/workspace/demo/meta.db?endpoint=https%3A%2F%2Fexample.api.tencentsmh.cn&library_id=lib&space_id=space")
	if err != nil {
		t.Fatal(err)
	}
	if client.Type() != "smh" {
		t.Fatalf("type=%q", client.Type())
	}
	smhClient, ok := client.(*smhLitestreamReplicaClient)
	if !ok {
		t.Fatalf("client type %T", client)
	}
	if smhClient.layout != smhLitestreamLayoutFlat || smhClient.flatBase != "meta.db" {
		t.Fatalf("layout=%q flat_base=%q", smhClient.layout, smhClient.flatBase)
	}
}

func TestSMHLitestreamReplicaClientFromURLRequiresLibraryAndSpace(t *testing.T) {
	t.Setenv("SMH_ACCESS_TOKEN", "token")
	_, err := litestream.NewReplicaClientFromURL("smh://example.api.tencentsmh.cn/workspace/demo/meta.db")
	if err == nil {
		t.Fatal("expected missing library/space error")
	}
}

func TestSMHLitestreamReplicaClientWriteLTXFileStreamsPayload(t *testing.T) {
	base, err := object.CreateStorage("mem", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	store := &captureSMHStore{ObjectStorage: base}
	client := &smhLitestreamReplicaClient{store: store, logger: slog.Default(), cacheNamespace: "test-retry-timeout"}
	timestamp := time.Date(2026, 5, 20, 12, 0, 0, 123000000, time.UTC)
	hdr := &ltx.Header{
		Version:   ltx.Version,
		Flags:     ltx.HeaderFlagNoChecksum,
		PageSize:  4096,
		Commit:    1,
		MinTXID:   5,
		MaxTXID:   6,
		Timestamp: timestamp.UnixMilli(),
	}
	header, err := hdr.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	payload := append(header, []byte("payload")...)

	info, err := client.WriteLTXFile(context.Background(), 0, 5, 6, bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	if store.sawSeekablePayload {
		t.Fatal("expected SMH Litestream write to stream a non-seekable payload")
	}
	if got, want := store.key, litestream.LTXFilePath("", 0, 5, 6); got != want {
		t.Fatalf("key=%q want=%q", got, want)
	}
	if !bytes.Equal(store.body, payload) {
		t.Fatalf("stored payload mismatch")
	}
	if got, want := info.Size, int64(len(payload)); got != want {
		t.Fatalf("size=%d want=%d", got, want)
	}
	if !info.CreatedAt.Equal(timestamp) {
		t.Fatalf("created_at=%s want=%s", info.CreatedAt, timestamp)
	}
}

func TestSMHLitestreamReplicaClientFlatLayoutRoundTrip(t *testing.T) {
	base, err := object.CreateStorage("mem", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	client := &smhLitestreamReplicaClient{
		store:    object.WithPrefix(base, "workspace/demo/"),
		logger:   slog.Default(),
		layout:   smhLitestreamLayoutFlat,
		flatBase: "meta.db",
	}
	payload := makeLTXPayloadForBenchmark(t, 4096)
	if _, err := client.WriteLTXFile(context.Background(), litestream.SnapshotLevel, 5, 6, bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}

	wantKey := "workspace/demo/meta.db--ltx--0009--" + ltx.FormatFilename(5, 6)
	objs, _, _, err := base.List(context.Background(), "workspace/demo/meta.db--ltx--0009--", "", "", "", 100, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(objs) != 1 || objs[0].Key() != wantKey {
		t.Fatalf("flat objects=%v want key %q", objectKeys(objs), wantKey)
	}

	itr, err := client.LTXFiles(context.Background(), litestream.SnapshotLevel, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	infos, err := ltx.SliceFileIterator(itr)
	if err != nil {
		t.Fatal(err)
	}
	if len(infos) != 1 || infos[0].Level != litestream.SnapshotLevel || infos[0].MinTXID != 5 || infos[0].MaxTXID != 6 {
		t.Fatalf("infos=%+v", infos)
	}

	rc, err := client.OpenLTXFile(context.Background(), litestream.SnapshotLevel, 5, 6, 0, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	got, err := io.ReadAll(rc)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("payload mismatch")
	}
}

func TestSMHLitestreamReplicaClientFlatLayoutListsOnlyOneLevel(t *testing.T) {
	base, err := object.CreateStorage("mem", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	payload := makeLTXPayloadForBenchmark(t, 4096)
	if err := base.Put(context.Background(), "workspace/demo/meta.db--ltx--0000--"+ltx.FormatFilename(5, 6), bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}
	if err := base.Put(context.Background(), "workspace/demo/data/default/chunks/0/0/1_2_4096", bytes.NewReader([]byte("chunk"))); err != nil {
		t.Fatal(err)
	}
	store := &listCountingSMHStore{ObjectStorage: object.WithPrefix(base, "workspace/demo/")}
	client := &smhLitestreamReplicaClient{
		store:    store,
		logger:   slog.Default(),
		layout:   smhLitestreamLayoutFlat,
		flatBase: "meta.db",
	}
	itr, err := client.LTXFiles(context.Background(), 0, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	infos, err := ltx.SliceFileIterator(itr)
	if err != nil {
		t.Fatal(err)
	}
	if len(infos) != 1 || infos[0].MinTXID != 5 || infos[0].MaxTXID != 6 {
		t.Fatalf("infos=%+v", infos)
	}
	if store.listCalls != 1 {
		t.Fatalf("list calls=%d want 1", store.listCalls)
	}
	if got := store.prefixes[0]; got != "meta.db--ltx--" {
		t.Fatalf("list prefix=%q want meta.db--ltx--", got)
	}
	if got := store.delimiters[0]; got != "/" {
		t.Fatalf("list delimiter=%q want /", got)
	}
}

func TestSMHLitestreamReplicaClientFlatDeleteAllKeepsWorkspaceData(t *testing.T) {
	base, err := object.CreateStorage("mem", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	client := &smhLitestreamReplicaClient{
		store:    object.WithPrefix(base, "workspace/demo/"),
		logger:   slog.Default(),
		layout:   smhLitestreamLayoutFlat,
		flatBase: "meta.db",
	}
	if _, err := client.WriteLTXFile(context.Background(), 0, 5, 6, bytes.NewReader(makeLTXPayloadForBenchmark(t, 4096))); err != nil {
		t.Fatal(err)
	}
	if err := base.Put(context.Background(), "workspace/demo/data/chunk", bytes.NewReader([]byte("keep"))); err != nil {
		t.Fatal(err)
	}
	if err := client.DeleteAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := base.Head(context.Background(), "workspace/demo/meta.db--ltx--0000--"+ltx.FormatFilename(5, 6)); err == nil {
		t.Fatal("expected flat LTX file to be deleted")
	}
	if _, err := base.Head(context.Background(), "workspace/demo/data/chunk"); err != nil {
		t.Fatalf("workspace data should remain: %v", err)
	}
}

func TestSMHLitestreamReplicaClientFlatLayoutCachesParentList(t *testing.T) {
	base, err := object.CreateStorage("mem", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := base.Put(context.Background(), "workspace/demo/meta.db--ltx--0000--"+ltx.FormatFilename(5, 6), bytes.NewReader(makeLTXPayloadForBenchmark(t, 4096))); err != nil {
		t.Fatal(err)
	}
	if err := base.Put(context.Background(), "workspace/demo/meta.db--ltx--0009--"+ltx.FormatFilename(1, 2), bytes.NewReader(makeLTXPayloadForBenchmark(t, 4096))); err != nil {
		t.Fatal(err)
	}
	store := &listCountingSMHStore{ObjectStorage: base}
	client := &smhLitestreamReplicaClient{
		store:    object.WithPrefix(store, "workspace/demo/"),
		logger:   slog.Default(),
		layout:   smhLitestreamLayoutFlat,
		flatBase: "meta.db",
	}
	for _, level := range []int{0, litestream.SnapshotLevel, 1} {
		itr, err := client.LTXFiles(context.Background(), level, 0, false)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ltx.SliceFileIterator(itr); err != nil {
			t.Fatal(err)
		}
	}
	if store.listCalls != 1 {
		t.Fatalf("list calls=%d want 1", store.listCalls)
	}
	if store.prefixes[0] != "workspace/demo/meta.db--ltx--" {
		t.Fatalf("list prefix=%q", store.prefixes[0])
	}
}

func TestSMHLitestreamReplicaClientCachesSmallFlatLTXReads(t *testing.T) {
	resetSMHGlobalLTXFileCache(t)
	base, err := object.CreateStorage("mem", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	payload := makeLTXPayloadForBenchmark(t, 4096)
	key := "workspace/demo/meta.db--ltx--0000--" + ltx.FormatFilename(5, 6)
	if err := base.Put(context.Background(), key, bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}
	store := &getCountingSMHStore{ObjectStorage: base}
	client := &smhLitestreamReplicaClient{
		store:          object.WithPrefix(store, "workspace/demo/"),
		logger:         slog.Default(),
		layout:         smhLitestreamLayoutFlat,
		flatBase:       "meta.db",
		cacheNamespace: "test-small-flat",
	}
	itr, err := client.LTXFiles(context.Background(), 0, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ltx.SliceFileIterator(itr); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		offset int64
		size   int64
	}{
		{offset: 0, size: int64(ltx.HeaderSize)},
		{offset: 0, size: -1},
		{offset: 16, size: 128},
	} {
		rc, err := client.OpenLTXFile(context.Background(), 0, 5, 6, tc.offset, tc.size)
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		wantEnd := int64(len(payload))
		if tc.size > 0 && tc.offset+tc.size < wantEnd {
			wantEnd = tc.offset + tc.size
		}
		if !bytes.Equal(got, payload[tc.offset:wantEnd]) {
			t.Fatalf("range offset=%d size=%d mismatch", tc.offset, tc.size)
		}
	}
	if store.getCalls != 1 {
		t.Fatalf("get calls=%d want 1", store.getCalls)
	}
	if store.offsets[0] != 0 || store.limits[0] != -1 {
		t.Fatalf("first get offset=%d limit=%d, want full read", store.offsets[0], store.limits[0])
	}
}

func TestSMHLitestreamReplicaClientSharesSmallLTXCacheAcrossClients(t *testing.T) {
	resetSMHGlobalLTXFileCache(t)
	base, err := object.CreateStorage("mem", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	payload := makeLTXPayloadForBenchmark(t, 4096)
	key := "workspace/demo/meta.db--ltx--0000--" + ltx.FormatFilename(5, 6)
	if err := base.Put(context.Background(), key, bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}
	store := &getCountingSMHStore{ObjectStorage: base}
	newClient := func() *smhLitestreamReplicaClient {
		return &smhLitestreamReplicaClient{
			store:          object.WithPrefix(store, "workspace/demo/"),
			logger:         slog.Default(),
			layout:         smhLitestreamLayoutFlat,
			flatBase:       "meta.db",
			cacheNamespace: "test-shared-flat",
		}
	}
	first := newClient()
	itr, err := first.LTXFiles(context.Background(), 0, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ltx.SliceFileIterator(itr); err != nil {
		t.Fatal(err)
	}
	rc, err := first.OpenLTXFile(context.Background(), 0, 5, 6, 0, int64(ltx.HeaderSize))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, rc)
	_ = rc.Close()

	second := newClient()
	rc, err = second.OpenLTXFile(context.Background(), 0, 5, 6, 0, -1)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(rc)
	_ = rc.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("payload mismatch")
	}
	if store.getCalls != 1 {
		t.Fatalf("get calls=%d want 1", store.getCalls)
	}
}

func TestSMHLitestreamReplicaClientSingleflightsConcurrentSmallLTXReads(t *testing.T) {
	resetSMHGlobalLTXFileCache(t)
	base, err := object.CreateStorage("mem", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	payload := makeLTXPayloadForBenchmark(t, 4096)
	key := "workspace/demo/meta.db--ltx--0000--" + ltx.FormatFilename(5, 6)
	if err := base.Put(context.Background(), key, bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}
	store := &blockingGetSMHStore{ObjectStorage: base, started: make(chan struct{}), release: make(chan struct{})}
	newClient := func() *smhLitestreamReplicaClient {
		return &smhLitestreamReplicaClient{
			store:          object.WithPrefix(store, "workspace/demo/"),
			logger:         slog.Default(),
			layout:         smhLitestreamLayoutFlat,
			flatBase:       "meta.db",
			cacheNamespace: "test-singleflight-flat",
		}
	}
	first := newClient()
	itr, err := first.LTXFiles(context.Background(), 0, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ltx.SliceFileIterator(itr); err != nil {
		t.Fatal(err)
	}
	if size, ok := smhGlobalLTXFileCache.size(first.globalLTXCacheKey(first.ltxFileKey(0, 5, 6))); !ok || size != int64(len(payload)) {
		t.Fatalf("global ltx size cache size=%d ok=%v want=%d", size, ok, len(payload))
	}

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, client := range []*smhLitestreamReplicaClient{first, newClient()} {
		wg.Add(1)
		go func(client *smhLitestreamReplicaClient) {
			defer wg.Done()
			rc, err := client.OpenLTXFile(context.Background(), 0, 5, 6, 0, int64(ltx.HeaderSize))
			if err != nil {
				errs <- err
				return
			}
			defer rc.Close()
			got, err := io.ReadAll(rc)
			if err != nil {
				errs <- err
				return
			}
			if !bytes.Equal(got, payload[:ltx.HeaderSize]) {
				errs <- fmt.Errorf("payload mismatch")
			}
		}(client)
	}
	<-store.started
	close(store.release)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if store.getCalls != 1 {
		t.Fatalf("get calls=%d want 1", store.getCalls)
	}
}

func TestSMHLitestreamReplicaClientOpenLTXFileRetriesTransientTimeout(t *testing.T) {
	base, err := object.CreateStorage("mem", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	key := litestream.LTXFilePath("", 0, 5, 6)
	if err := base.Put(context.Background(), key, bytes.NewReader([]byte("ltx-body"))); err != nil {
		t.Fatal(err)
	}
	store := &retryOpenSMHStore{
		ObjectStorage: base,
		failures:      1,
		err:           timeoutHeaderError{},
	}
	client := &smhLitestreamReplicaClient{store: store, logger: slog.Default(), cacheNamespace: "test-retry-missing"}

	rc, err := client.OpenLTXFile(context.Background(), 0, 5, 6, 0, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	body, err := io.ReadAll(rc)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "ltx-body" {
		t.Fatalf("body=%q", body)
	}
	if store.gets != 2 {
		t.Fatalf("gets=%d want=2", store.gets)
	}
}

func TestSMHLitestreamReplicaClientOpenLTXFileDoesNotRetryMissing(t *testing.T) {
	base, err := object.CreateStorage("mem", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	store := &retryOpenSMHStore{
		ObjectStorage: base,
		failures:      1,
		err:           os.ErrNotExist,
	}
	client := &smhLitestreamReplicaClient{store: store, logger: slog.Default()}

	_, err = client.OpenLTXFile(context.Background(), 0, 5, 6, 0, -1)
	if err == nil {
		t.Fatal("expected missing LTX error")
	}
	if store.gets != 1 {
		t.Fatalf("gets=%d want=1", store.gets)
	}
}

func BenchmarkSMHLitestreamWriteLTXFile(b *testing.B) {
	for _, size := range []int{1 << 20, 64 << 20} {
		payload := makeLTXPayloadForBenchmark(b, size)
		b.Run(fmt.Sprintf("stream/%dMiB", size>>20), func(b *testing.B) {
			base, err := object.CreateStorage("mem", "", "", "", "")
			if err != nil {
				b.Fatal(err)
			}
			client := &smhLitestreamReplicaClient{store: discardSMHStore{ObjectStorage: base}, logger: slog.Default()}
			b.SetBytes(int64(len(payload)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := client.WriteLTXFile(context.Background(), 0, 5, 6, bytes.NewReader(payload)); err != nil {
					b.Fatal(err)
				}
			}
		})
		b.Run(fmt.Sprintf("old-buffer/%dMiB", size>>20), func(b *testing.B) {
			base, err := object.CreateStorage("mem", "", "", "", "")
			if err != nil {
				b.Fatal(err)
			}
			store := discardSMHStore{ObjectStorage: base}
			b.SetBytes(int64(len(payload)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if err := writeLTXFileWithOldBufferForBenchmark(context.Background(), store, 0, 5, 6, bytes.NewReader(payload)); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func makeLTXPayloadForBenchmark(tb testing.TB, size int) []byte {
	tb.Helper()
	if size < ltx.HeaderSize {
		size = ltx.HeaderSize
	}
	hdr := &ltx.Header{
		Version:   ltx.Version,
		Flags:     ltx.HeaderFlagNoChecksum,
		PageSize:  4096,
		Commit:    1,
		MinTXID:   5,
		MaxTXID:   6,
		Timestamp: time.Date(2026, 5, 20, 12, 0, 0, 0, time.UTC).UnixMilli(),
	}
	header, err := hdr.MarshalBinary()
	if err != nil {
		tb.Fatal(err)
	}
	payload := make([]byte, size)
	copy(payload, header)
	return payload
}

func writeLTXFileWithOldBufferForBenchmark(ctx context.Context, store object.ObjectStorage, level int, minTXID, maxTXID ltx.TXID, r io.Reader) error {
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, r); err != nil {
		return err
	}
	if _, _, err := ltx.PeekHeader(bytes.NewReader(buf.Bytes())); err != nil {
		return err
	}
	return store.Put(ctx, litestream.LTXFilePath("", level, minTXID, maxTXID), bytes.NewReader(buf.Bytes()))
}

func objectKeys(objs []object.Object) []string {
	keys := make([]string, 0, len(objs))
	for _, obj := range objs {
		if obj != nil {
			keys = append(keys, obj.Key())
		}
	}
	return keys
}

func resetSMHGlobalLTXFileCache(tb testing.TB) {
	tb.Helper()
	smhGlobalLTXFileCache.mu.Lock()
	oldFiles := smhGlobalLTXFileCache.files
	oldSizes := smhGlobalLTXFileCache.sizes
	oldBytes := smhGlobalLTXFileCache.bytes
	smhGlobalLTXFileCache.files = nil
	smhGlobalLTXFileCache.sizes = nil
	smhGlobalLTXFileCache.bytes = 0
	smhGlobalLTXFileCache.inflight = nil
	smhGlobalLTXFileCache.mu.Unlock()
	tb.Cleanup(func() {
		smhGlobalLTXFileCache.mu.Lock()
		smhGlobalLTXFileCache.files = oldFiles
		smhGlobalLTXFileCache.sizes = oldSizes
		smhGlobalLTXFileCache.bytes = oldBytes
		smhGlobalLTXFileCache.inflight = nil
		smhGlobalLTXFileCache.mu.Unlock()
	})
}

type captureSMHStore struct {
	object.ObjectStorage
	key                string
	body               []byte
	sawSeekablePayload bool
}

type discardSMHStore struct {
	object.ObjectStorage
}

type retryOpenSMHStore struct {
	object.ObjectStorage
	failures int
	gets     int
	err      error
}

type listCountingSMHStore struct {
	object.ObjectStorage
	listCalls  int
	prefixes   []string
	delimiters []string
}

type getCountingSMHStore struct {
	object.ObjectStorage
	getCalls int
	offsets  []int64
	limits   []int64
}

type blockingGetSMHStore struct {
	object.ObjectStorage
	mu        sync.Mutex
	getCalls  int
	started   chan struct{}
	release   chan struct{}
	startOnce sync.Once
}

func (s *retryOpenSMHStore) Get(ctx context.Context, key string, off, limit int64, getters ...object.AttrGetter) (io.ReadCloser, error) {
	s.gets++
	if s.failures > 0 {
		s.failures--
		return nil, s.err
	}
	return s.ObjectStorage.Get(ctx, key, off, limit, getters...)
}

func (s *listCountingSMHStore) List(ctx context.Context, prefix, startAfter, token, delimiter string, limit int64, followLink bool) ([]object.Object, bool, string, error) {
	s.listCalls++
	s.prefixes = append(s.prefixes, prefix)
	s.delimiters = append(s.delimiters, delimiter)
	return s.ObjectStorage.List(ctx, prefix, startAfter, token, delimiter, limit, followLink)
}

func (s *getCountingSMHStore) Get(ctx context.Context, key string, off, limit int64, getters ...object.AttrGetter) (io.ReadCloser, error) {
	s.getCalls++
	s.offsets = append(s.offsets, off)
	s.limits = append(s.limits, limit)
	return s.ObjectStorage.Get(ctx, key, off, limit, getters...)
}

func (s *blockingGetSMHStore) Get(ctx context.Context, key string, off, limit int64, getters ...object.AttrGetter) (io.ReadCloser, error) {
	s.mu.Lock()
	s.getCalls++
	started := s.started
	release := s.release
	s.mu.Unlock()
	s.startOnce.Do(func() { close(started) })
	select {
	case <-release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return s.ObjectStorage.Get(ctx, key, off, limit, getters...)
}

type timeoutHeaderError struct{}

func (timeoutHeaderError) Error() string   { return "net/http: timeout awaiting response headers" }
func (timeoutHeaderError) Timeout() bool   { return true }
func (timeoutHeaderError) Temporary() bool { return true }

func (discardSMHStore) Put(ctx context.Context, key string, in io.Reader, getters ...object.AttrGetter) error {
	_, err := io.Copy(io.Discard, in)
	return err
}

func (s *captureSMHStore) Put(ctx context.Context, key string, in io.Reader, getters ...object.AttrGetter) error {
	if seeker, ok := in.(io.Seeker); ok {
		s.sawSeekablePayload = true
		if _, err := seeker.Seek(0, io.SeekStart); err != nil {
			return err
		}
	}
	body, err := io.ReadAll(in)
	if err != nil {
		return err
	}
	s.key = key
	s.body = body
	return nil
}
