package sqliteredis

import (
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"reflect"
	"sync"
	"syscall"
	"testing"
	"time"

	aclAPI "github.com/juicedata/juicefs/pkg/acl"
	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/redis/go-redis/v9"
)

func startTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "meta.db")
	srv, err := New(Options{Path: dbPath})
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		_ = srv.Serve(ln)
	}()
	t.Cleanup(func() {
		_ = srv.Close()
	})
	return srv, ln.Addr().String()
}

func newRedisClient(addr string) *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr:            addr,
		DB:              0,
		DisableIdentity: true,
		ReadTimeout:     2 * time.Second,
		WriteTimeout:    2 * time.Second,
	})
}

func TestProtocolBasicCommands(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	ctx := meta.Background()

	attr := (&meta.Attr{Typ: meta.TypeFile, Mode: 0644, Uid: 1, Gid: 1, Nlink: 1}).Marshal()
	if err := c.Set(ctx, "i2", string(attr), 0).Err(); err != nil {
		t.Fatal(err)
	}
	if got, err := c.Get(ctx, "i2").Bytes(); err != nil || string(got) != string(attr) {
		t.Fatalf("get i2 = %v, %v", got, err)
	}
	if n, err := c.HSet(ctx, "d1", "a", string(packEntry(meta.TypeFile, 2)), "b", string(packEntry(meta.TypeDirectory, 3))).Result(); err != nil || n != 2 {
		t.Fatalf("hset = %d, %v", n, err)
	}
	if vals, err := c.HGetAll(ctx, "d1").Result(); err != nil || vals["a"] != string(packEntry(meta.TypeFile, 2)) || vals["b"] != string(packEntry(meta.TypeDirectory, 3)) {
		t.Fatalf("hgetall = %#v, %v", vals, err)
	}
	if n, err := c.ZAdd(ctx, "allSessions", redis.Z{Score: 2, Member: "2"}, redis.Z{Score: 1, Member: "1"}).Result(); err != nil || n != 2 {
		t.Fatalf("zadd = %d, %v", n, err)
	}
	if vals, err := c.ZRange(ctx, "allSessions", 0, -1).Result(); err != nil || len(vals) != 2 || vals[0] != "1" || vals[1] != "2" {
		t.Fatalf("zrange = %#v, %v", vals, err)
	}
}

func TestProtocolWatchMultiExec(t *testing.T) {
	_, addr := startTestServer(t)
	ctx := meta.Background()
	c1 := newRedisClient(addr)
	defer c1.Close()
	c2 := newRedisClient(addr)
	defer c2.Close()

	if err := c1.Set(ctx, "usedSpace", "1", 0).Err(); err != nil {
		t.Fatal(err)
	}
	err := c1.Watch(ctx, func(tx *redis.Tx) error {
		if err := c2.Set(ctx, "usedSpace", "2", 0).Err(); err != nil {
			return err
		}
		_, err := tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			pipe.Set(ctx, "usedSpace", "3", 0)
			return nil
		})
		return err
	}, "usedSpace")
	if err != redis.TxFailedErr {
		t.Fatalf("expected TxFailedErr, got %v", err)
	}
}

func TestProtocolScriptLoadEvalSha(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	ctx := meta.Background()

	lookupSHA, ok := whitelistScript(scriptsByName()["lookup"])
	if !ok {
		t.Fatal("lookup script not found")
	}
	if err := c.HSet(ctx, "d1", "name", string(packEntry(meta.TypeFile, 2))).Err(); err != nil {
		t.Fatal(err)
	}
	attr := (&meta.Attr{Typ: meta.TypeFile, Mode: 0644, Uid: 1, Gid: 1, Nlink: 1}).Marshal()
	if err := c.Set(ctx, "i2", string(attr), 0).Err(); err != nil {
		t.Fatal(err)
	}
	sha, err := c.ScriptLoad(ctx, scriptsByName()["lookup"]).Result()
	if err != nil || sha != lookupSHA {
		t.Fatalf("script load sha=%q err=%v", sha, err)
	}
	val, err := c.EvalSha(ctx, sha, []string{"d1", "name"}).Result()
	if err != nil {
		t.Fatal(err)
	}
	arr, ok := val.([]interface{})
	if !ok || len(arr) != 2 {
		t.Fatalf("unexpected eval result %#v", val)
	}
}

func TestProtocolCleanupKeyFamilies(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	ctx := meta.Background()

	if n, err := c.HIncrBy(ctx, "sliceRef", "k10_4096", 2).Result(); err != nil || n != 2 {
		t.Fatalf("sliceRef hincrby = %d, %v", n, err)
	}
	if got, err := c.HGet(ctx, "sliceRef", "k10_4096").Result(); err != nil || got != "2" {
		t.Fatalf("sliceRef hget = %q, %v", got, err)
	}
	if vals, _, err := c.HScan(ctx, "sliceRef", 0, "*", 10).Result(); err != nil || len(vals) != 2 || vals[0] != "k10_4096" || vals[1] != "2" {
		t.Fatalf("sliceRef hscan = %#v, %v", vals, err)
	}

	if err := c.HSet(ctx, "delSlices", "10_123", string([]byte("payload"))).Err(); err != nil {
		t.Fatal(err)
	}
	if got, err := c.HGet(ctx, "delSlices", "10_123").Result(); err != nil || got != "payload" {
		t.Fatalf("delSlices hget = %q, %v", got, err)
	}

	if n, err := c.ZAdd(ctx, "delfiles", redis.Z{Score: 100, Member: "5:8192"}).Result(); err != nil || n != 1 {
		t.Fatalf("delfiles zadd = %d, %v", n, err)
	}
	if vals, err := c.ZRangeByScore(ctx, "delfiles", &redis.ZRangeBy{Min: "-inf", Max: "100"}).Result(); err != nil || len(vals) != 1 || vals[0] != "5:8192" {
		t.Fatalf("delfiles zrangebyscore = %#v, %v", vals, err)
	}

	if n, err := c.ZAdd(ctx, "detachedNodes", redis.Z{Score: 200, Member: "7"}).Result(); err != nil || n != 1 {
		t.Fatalf("detachedNodes zadd = %d, %v", n, err)
	}
	if score, err := c.ZScore(ctx, "detachedNodes", "7").Result(); err != nil || score != 200 {
		t.Fatalf("detachedNodes zscore = %v, %v", score, err)
	}

	keys, _, err := c.Scan(ctx, 0, "*", 100).Result()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"sliceRef":      false,
		"delSlices":     false,
		"delfiles":      false,
		"detachedNodes": false,
	}
	for _, k := range keys {
		if _, ok := want[k]; ok {
			want[k] = true
		}
	}
	for k, ok := range want {
		if !ok {
			t.Fatalf("scan missing key %s in %#v", k, keys)
		}
	}
}

func TestProtocolLegacySessionsCompat(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	ctx := meta.Background()

	if n, err := c.ZAdd(ctx, "sessions", redis.Z{Score: 10, Member: "1"}).Result(); err != nil || n != 1 {
		t.Fatalf("legacy sessions zadd = %d, %v", n, err)
	}
	if score, err := c.ZScore(ctx, "sessions", "1").Result(); err != nil || score != 10 {
		t.Fatalf("legacy sessions zscore = %v, %v", score, err)
	}
	if vals, err := c.ZRangeWithScores(ctx, "sessions", 0, -1).Result(); err != nil || len(vals) != 1 || vals[0].Member != "1" || vals[0].Score != 10 {
		t.Fatalf("legacy sessions zrange withscores = %#v, %v", vals, err)
	}
	if vals, err := c.ZRangeByScore(ctx, "sessions", &redis.ZRangeBy{Min: "-inf", Max: "10"}).Result(); err != nil || len(vals) != 1 || vals[0] != "1" {
		t.Fatalf("legacy sessions zrangebyscore = %#v, %v", vals, err)
	}
	if n, err := c.ZRem(ctx, "sessions", "1").Result(); err != nil || n != 1 {
		t.Fatalf("legacy sessions zrem = %d, %v", n, err)
	}
}

func TestJuiceFSMetaBasicFlow(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "test", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var dir meta.Ino
	var dirAttr meta.Attr
	if st := m.Mkdir(ctx, meta.RootInode, "dir", 0755, 0, 0, &dir, &dirAttr); st != 0 {
		t.Fatalf("mkdir: %v", st)
	}

	var file meta.Ino
	var fileAttr meta.Attr
	if st := m.Create(ctx, dir, "file", 0644, 0, 0, &file, &fileAttr); st != 0 {
		t.Fatalf("create: %v", st)
	}

	var lookupIno meta.Ino
	var lookupAttr meta.Attr
	if st := m.Lookup(ctx, dir, "file", &lookupIno, &lookupAttr, true); st != 0 || lookupIno != file {
		t.Fatalf("lookup: ino=%d st=%v", lookupIno, st)
	}

	var entries []*meta.Entry
	if st := m.Readdir(ctx, dir, 1, &entries); st != 0 {
		t.Fatalf("readdir: %v", st)
	}
	found := false
	for _, e := range entries {
		if string(e.Name) == "file" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("entries = %#v", entries)
	}

	var resolvedIno meta.Ino
	var resolvedAttr meta.Attr
	if st := m.Resolve(ctx, meta.RootInode, "/dir/file", &resolvedIno, &resolvedAttr, false); st != 0 || resolvedIno != file {
		t.Fatalf("resolve: ino=%d st=%v", resolvedIno, st)
	}

	if st := m.Rename(ctx, dir, "file", dir, "file2", 0, nil, nil); st != 0 {
		t.Fatalf("rename: %v", st)
	}
	if st := m.Unlink(ctx, dir, "file2"); st != 0 {
		t.Fatalf("unlink: %v", st)
	}
}

func TestJuiceFSMetaSymlinkAndXattr(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "xattr-symlink", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var file meta.Ino
	var fileAttr meta.Attr
	if st := m.Create(ctx, meta.RootInode, "file", 0644, 0, 0, &file, &fileAttr); st != 0 {
		t.Fatalf("create: %v", st)
	}
	if st := m.SetXattr(ctx, file, "user.tag", []byte("hello"), meta.XattrCreateOrReplace); st != 0 {
		t.Fatalf("setxattr: %v", st)
	}

	var val []byte
	if st := m.GetXattr(ctx, file, "user.tag", &val); st != 0 || string(val) != "hello" {
		t.Fatalf("getxattr: val=%q st=%v", string(val), st)
	}
	if st := m.ListXattr(ctx, file, &val); st != 0 || string(val) != "user.tag\x00" {
		t.Fatalf("listxattr: val=%q st=%v", string(val), st)
	}

	var link meta.Ino
	if st := m.Symlink(ctx, meta.RootInode, "sym", "/target/path", &link, nil); st != 0 {
		t.Fatalf("symlink: %v", st)
	}
	var target []byte
	if st := m.ReadLink(ctx, link, &target); st != 0 || string(target) != "/target/path" {
		t.Fatalf("readlink: target=%q st=%v", string(target), st)
	}
}

func TestJuiceFSMetaHardLinkParents(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "hardlink", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode meta.Ino
	var attr meta.Attr
	if st := m.Create(ctx, meta.RootInode, "file", 0644, 0, 0, &inode, &attr); st != 0 {
		t.Fatalf("create: %v", st)
	}
	if st := m.Link(ctx, inode, meta.RootInode, "file2", &attr); st != 0 {
		t.Fatalf("link: %v", st)
	}

	var gotIno meta.Ino
	var gotAttr meta.Attr
	if st := m.Lookup(ctx, meta.RootInode, "file2", &gotIno, &gotAttr, false); st != 0 || gotIno != inode {
		t.Fatalf("lookup hardlink: ino=%d st=%v", gotIno, st)
	}
	if st := m.GetAttr(ctx, inode, &gotAttr); st != 0 || gotAttr.Nlink != 2 {
		t.Fatalf("getattr nlink after link: nlink=%d st=%v", gotAttr.Nlink, st)
	}
	parents := m.GetParents(ctx, inode)
	if parents[meta.RootInode] != 2 {
		t.Fatalf("parents after link = %#v", parents)
	}

	if st := m.Unlink(ctx, meta.RootInode, "file2"); st != 0 {
		t.Fatalf("unlink hardlink: %v", st)
	}
	if st := m.GetAttr(ctx, inode, &gotAttr); st != 0 || gotAttr.Nlink != 1 {
		t.Fatalf("getattr nlink after unlink: nlink=%d st=%v", gotAttr.Nlink, st)
	}
	parents = m.GetParents(ctx, inode)
	if parents[meta.RootInode] != 1 {
		t.Fatalf("parents after unlink = %#v", parents)
	}
}

func TestJuiceFSMetaUnlinkRemovesInode(t *testing.T) {
	srv, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "unlink-removes-inode", DirStats: true, TrashDays: 0}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode meta.Ino
	var attr meta.Attr
	if st := m.Create(ctx, meta.RootInode, "gone", 0644, 0, 0, &inode, &attr); st != 0 {
		t.Fatalf("create: %v", st)
	}
	if st := m.Close(ctx, inode); st != 0 {
		t.Fatalf("close: %v", st)
	}
	if st := m.Unlink(ctx, meta.RootInode, "gone"); st != 0 {
		t.Fatalf("unlink: %v", st)
	}
	if n, err := c.Exists(ctx, fmt.Sprintf("i%d", inode)).Result(); err != nil || n != 0 {
		var inodeRows, delfileRows, sustainedRows int
		_ = srv.db.QueryRow(`SELECT COUNT(*) FROM inode WHERE inode=?`, inode).Scan(&inodeRows)
		_ = srv.db.QueryRow(`SELECT COUNT(*) FROM deleted_file_queue WHERE inode=?`, inode).Scan(&delfileRows)
		_ = srv.db.QueryRow(`SELECT COUNT(*) FROM session_sustained_inode WHERE inode=?`, inode).Scan(&sustainedRows)
		t.Fatalf("expected inode key removed after unlink, exists=%d err=%v inodeRows=%d delfiles=%d sustained=%d", n, err, inodeRows, delfileRows, sustainedRows)
	}
}

func TestJuiceFSMetaLocks(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "locks", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode meta.Ino
	var attr meta.Attr
	if st := m.Create(ctx, meta.RootInode, "f", 0644, 0, 0, &inode, &attr); st != 0 {
		t.Fatalf("create: %v", st)
	}
	defer m.Unlink(ctx, meta.RootInode, "f")

	o1 := uint64(0xF000000000000001)
	if st := m.Flock(ctx, inode, o1, syscall.F_WRLCK, false); st != 0 {
		t.Fatalf("flock wlock: %v", st)
	}
	if st := m.Flock(ctx, inode, 2, syscall.F_RDLCK, false); st != syscall.EAGAIN {
		t.Fatalf("flock conflicting rlock: %v", st)
	}
	if st := m.Flock(ctx, inode, o1, syscall.F_UNLCK, false); st != 0 {
		t.Fatalf("flock unlock: %v", st)
	}

	if st := m.Setlk(ctx, inode, o1, false, syscall.F_RDLCK, 0, 0xFFFF, 1); st != 0 {
		t.Fatalf("setlk rlock: %v", st)
	}
	if st := m.Setlk(ctx, inode, 2, false, syscall.F_WRLCK, 0, 0xFFFF, 1); st != syscall.EAGAIN {
		t.Fatalf("setlk conflicting wlock: %v", st)
	}
	if st := m.Setlk(ctx, inode, o1, false, syscall.F_UNLCK, 0, 0xFFFF, 1); st != 0 {
		t.Fatalf("setlk unlock: %v", st)
	}

	plocks, flocks, err := m.ListLocks(ctx, inode)
	if err != nil {
		t.Fatal(err)
	}
	if len(plocks) != 0 || len(flocks) != 0 {
		t.Fatalf("locks leaked: plocks=%d flocks=%d", len(plocks), len(flocks))
	}
}

func TestJuiceFSMetaQuotaBasic(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "quota", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var dir meta.Ino
	var attr meta.Attr
	if st := m.Mkdir(ctx, meta.RootInode, "quota", 0755, 0, 0, &dir, &attr); st != 0 {
		t.Fatalf("mkdir quota: %v", st)
	}

	qs := map[string]*meta.Quota{}
	if err := m.HandleQuota(ctx, meta.QuotaSet, "/quota", meta.DirQuotaType, map[string]*meta.Quota{
		"/quota": {MaxSpace: 1 << 20, MaxInodes: 10},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.HandleQuota(ctx, meta.QuotaGet, "/quota", meta.DirQuotaType, qs, false, false, false); err != nil {
		t.Fatal(err)
	}
	q := qs["/quota"]
	if q == nil || q.MaxSpace != 1<<20 || q.MaxInodes != 10 {
		t.Fatalf("bad quota: %+v", q)
	}

	qs = map[string]*meta.Quota{}
	if err := m.HandleQuota(ctx, meta.QuotaList, "", meta.AllQuotaType, qs, false, false, false); err != nil {
		t.Fatal(err)
	}
	if _, ok := qs["/quota"]; !ok {
		t.Fatalf("quota list missing /quota: %+v", qs)
	}

	if err := m.HandleQuota(ctx, meta.QuotaDel, "/quota", meta.DirQuotaType, nil, false, false, false); err != nil {
		t.Fatal(err)
	}
	qs = map[string]*meta.Quota{}
	if err := m.HandleQuota(ctx, meta.QuotaGet, "/quota", meta.DirQuotaType, qs, false, false, false); err != nil {
		t.Fatal(err)
	}
	if _, ok := qs["/quota"]; ok {
		t.Fatalf("quota should be deleted: %+v", qs["/quota"])
	}
}

func TestJuiceFSMetaStaleSessionCleanup(t *testing.T) {
	srv, addr := startTestServer(t)
	m1 := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m1.Shutdown()

	format := &meta.Format{Name: "sessions", DirStats: true}
	if err := m1.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m1.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m1.CloseSession()

	sessions, err := m1.ListSessions()
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}

	staleSID := sessions[0].Sid
	if _, err := srv.db.Exec(`UPDATE session SET expire_at=? WHERE sid=?`, time.Now().Add(-time.Hour).Unix(), staleSID); err != nil {
		t.Fatal(err)
	}

	m1.CleanStaleSessions(meta.Background())

	sessions, err = m1.ListSessions()
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 0 {
		t.Fatalf("expected 0 session after cleanup, got %d", len(sessions))
	}
}

func TestJuiceFSMetaTrashCleanupAndDeleteData(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	m.OnMsg(meta.DeleteSlice, func(args ...interface{}) error { return nil })

	format := &meta.Format{Name: "trash-cleanup", DirStats: true, TrashDays: 1}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode meta.Ino
	var attr meta.Attr
	if st := m.Create(ctx, meta.RootInode, "trash-file", 0644, 0, 0, &inode, &attr); st != 0 {
		t.Fatalf("create: %v", st)
	}

	var sliceID uint64
	m.NewSlice(ctx, &sliceID)
	if st := m.Write(ctx, inode, 0, 0, meta.Slice{Id: sliceID, Size: 4096, Len: 4096}, time.Now()); st != 0 {
		t.Fatalf("write: %v", st)
	}
	if st := m.Unlink(ctx, meta.RootInode, "trash-file"); st != 0 {
		t.Fatalf("unlink to trash: %v", st)
	}

	stats := &meta.CleanupTrashStats{}
	if st := m.CleanupTrashBefore(ctx, time.Now().Add(2*time.Hour), nil, stats); st != 0 {
		t.Fatalf("cleanup trash: %v", st)
	}
	if stats.DeletedFiles == 0 {
		t.Fatalf("expected trash cleanup to delete at least one file")
	}
	var trashFiles int
	if err := m.ScanDeletedObject(ctx, nil, nil, func(ino meta.Ino, size uint64, ts time.Time) (bool, error) {
		trashFiles++
		return false, nil
	}, nil); err != nil {
		t.Fatal(err)
	}
	if trashFiles != 0 {
		t.Fatalf("expected no trash files after cleanup, got %d", trashFiles)
	}
}

func TestJuiceFSMetaPendingDeletedFilesScan(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	m.OnMsg(meta.DeleteSlice, func(args ...interface{}) error { return nil })

	format := &meta.Format{Name: "pending-delfiles", DirStats: true, TrashDays: 0}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode meta.Ino
	var attr meta.Attr
	if st := m.Create(ctx, meta.RootInode, "pending-file", 0644, 0, 0, &inode, &attr); st != 0 {
		t.Fatalf("create: %v", st)
	}

	var sliceID uint64
	m.NewSlice(ctx, &sliceID)
	if st := m.Write(ctx, inode, 0, 0, meta.Slice{Id: sliceID, Size: 4096, Len: 4096}, time.Now()); st != 0 {
		t.Fatalf("write: %v", st)
	}
	if _, err := c.ZAdd(ctx, "delfiles", redis.Z{Score: float64(time.Now().Add(-time.Hour).Unix()), Member: fmt.Sprintf("%d:%d", inode, 4096)}).Result(); err != nil {
		t.Fatal(err)
	}

	var seen []string
	if err := m.ScanDeletedObject(ctx, nil, nil, nil, func(ino meta.Ino, size uint64, ts int64) (bool, error) {
		seen = append(seen, fmt.Sprintf("%d:%d", ino, size))
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(seen) == 0 {
		t.Fatalf("expected pending deleted file scan to see delfiles entry")
	}
	if vals, err := c.ZRange(ctx, "delfiles", 0, -1).Result(); err != nil || len(vals) != 0 {
		t.Fatalf("expected delfiles to be drained, got %#v, %v", vals, err)
	}
	if n, err := c.LLen(ctx, fmt.Sprintf("c%d_0", inode)).Result(); err != nil || n != 0 {
		t.Fatalf("expected pending file chunks to be deleted, llen=%d err=%v", n, err)
	}
}

func TestJuiceFSMetaDelayedSliceScanAndCleanup(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	m.OnMsg(meta.DeleteSlice, func(args ...interface{}) error { return nil })
	m.OnMsg(meta.CompactChunk, func(args ...interface{}) error { return nil })

	format := &meta.Format{Name: "delayed-slices", DirStats: true, TrashDays: 1}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode meta.Ino
	var attr meta.Attr
	if st := m.Create(ctx, meta.RootInode, "compact-file", 0644, 0, 0, &inode, &attr); st != 0 {
		t.Fatalf("create: %v", st)
	}

	var sid uint64
	m.NewSlice(ctx, &sid)
	_ = m.Write(ctx, inode, 1, 0, meta.Slice{Id: sid, Size: 64 << 20, Len: 64 << 20}, time.Now())
	m.NewSlice(ctx, &sid)
	_ = m.Write(ctx, inode, 1, 30<<20, meta.Slice{Id: sid, Size: 8, Len: 8}, time.Now())
	m.NewSlice(ctx, &sid)
	_ = m.Write(ctx, inode, 1, 40<<20, meta.Slice{Id: sid, Size: 8, Len: 8}, time.Now())

	if st := m.Compact(ctx, inode, 1, func() {}, func() {}); st != 0 {
		t.Fatalf("compact: %v", st)
	}

	if n, err := c.HLen(ctx, "delSlices").Result(); err != nil || n == 0 {
		t.Fatalf("expected delayed slices after compact, hlen=%d err=%v", n, err)
	}

	var delayed int
	if err := m.ScanDeletedObject(ctx, func(ss []meta.Slice, ts int64) (bool, error) {
		delayed += len(ss)
		return true, nil
	}, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if delayed == 0 {
		t.Fatalf("expected delayed slice scanner to see compacted slices")
	}
	if n, err := c.HLen(ctx, "delSlices").Result(); err != nil || n != 0 {
		t.Fatalf("expected delayed slices to be drained, hlen=%d err=%v", n, err)
	}
}

func TestJuiceFSMetaCompactionPatterns(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	m.OnMsg(meta.DeleteSlice, func(args ...interface{}) error { return nil })
	m.OnMsg(meta.CompactChunk, func(args ...interface{}) error { return nil })

	format := &meta.Format{Name: "compaction-patterns", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(false); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode meta.Ino
	attr := &meta.Attr{}
	_ = m.Unlink(ctx, meta.RootInode, "f")
	if st := m.Create(ctx, meta.RootInode, "f", 0650, 022, 0, &inode, attr); st != 0 {
		t.Fatalf("create file: %v", st)
	}
	defer m.Unlink(ctx, meta.RootInode, "f")

	var sliceID uint64
	m.NewSlice(ctx, &sliceID)
	_ = m.Write(ctx, inode, 0, 0, meta.Slice{Id: sliceID, Size: 100000, Len: 100000}, time.Now())
	m.NewSlice(ctx, &sliceID)
	_ = m.Write(ctx, inode, 0, 100000, meta.Slice{Id: sliceID, Size: 100000, Len: 100000}, time.Now())
	m.NewSlice(ctx, &sliceID)
	_ = m.Write(ctx, inode, 0, 200000, meta.Slice{Id: sliceID, Size: 100000, Len: 100000}, time.Now())
	if st := m.Compact(ctx, inode, 1, func() {}, func() {}); st != 0 {
		t.Fatalf("compact append pattern: %v", st)
	}
	var slices []meta.Slice
	if st := m.Read(ctx, inode, 0, &slices); st != 0 {
		t.Fatalf("read chunk 0: %v", st)
	}
	if len(slices) >= 3 {
		t.Fatalf("expected append pattern to compact, got %d slices: %+v", len(slices), slices)
	}
	var total uint32
	for _, s := range slices {
		total += s.Len
	}
	if total != 300000 {
		t.Fatalf("expected compacted length 300000, got %d", total)
	}

	if st := m.Truncate(ctx, inode, 0, 64<<10, attr, false); st != 0 {
		t.Fatalf("truncate to 64K: %v", st)
	}
	m.NewSlice(ctx, &sliceID)
	_ = m.Write(ctx, inode, 0, uint32(1<<20), meta.Slice{Id: sliceID, Size: 2 << 20, Len: 2 << 20}, time.Now())
	if st := m.Compact(ctx, inode, 1, func() {}, func() {}); st != 0 {
		t.Fatalf("compact sparse pattern: %v", st)
	}
	slices = nil
	if st := m.Read(ctx, inode, 0, &slices); st != 0 {
		t.Fatalf("read sparse chunk: %v", st)
	}
	if len(slices) != 1 || slices[0].Len != 3<<20 {
		t.Fatalf("expected sparse pattern to compact into one 3MiB slice, got %+v", slices)
	}
}

func TestJuiceFSMetaCheckAndRepairDirectories(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "check-repair", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	dirAttr := &meta.Attr{Mode: 0644, Full: true, Typ: meta.TypeDirectory, Nlink: 3}
	var checkIno, d1, d2 meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "check", 0640, 022, 0, &checkIno, dirAttr); st != 0 {
		t.Fatalf("mkdir check: %v", st)
	}
	if st := m.Mkdir(ctx, checkIno, "d1", 0640, 022, 0, &d1, dirAttr); st != 0 {
		t.Fatalf("mkdir d1: %v", st)
	}
	if st := m.Mkdir(ctx, d1, "d2", 0640, 022, 0, &d2, dirAttr); st != 0 {
		t.Fatalf("mkdir d2: %v", st)
	}

	var broken meta.Attr
	if st := m.GetAttr(ctx, checkIno, &broken); st != 0 {
		t.Fatalf("getattr check: %v", st)
	}
	broken.Nlink = 0
	if err := c.Set(ctx, fmt.Sprintf("i%d", checkIno), string(broken.Marshal()), 0).Err(); err != nil {
		t.Fatal(err)
	}
	if st := m.GetAttr(ctx, d1, &broken); st != 0 {
		t.Fatalf("getattr d1: %v", st)
	}
	broken.Nlink = 0
	if err := c.Set(ctx, fmt.Sprintf("i%d", d1), string(broken.Marshal()), 0).Err(); err != nil {
		t.Fatal(err)
	}
	if st := m.GetAttr(ctx, d2, &broken); st != 0 {
		t.Fatalf("getattr d2: %v", st)
	}
	broken.Full = false
	broken.Nlink = 0
	if err := c.Set(ctx, fmt.Sprintf("i%d", d2), string(broken.Marshal()), 0).Err(); err != nil {
		t.Fatal(err)
	}

	slices := make(map[meta.Ino][]meta.Slice)
	if err := m.Check(ctx, "/check", &meta.CheckOpt{
		ShowProgress: func(int) {},
		Slices:       slices,
	}); err == nil {
		t.Fatalf("check should report broken attrs without repair")
	}

	if err := m.Check(ctx, "/check", &meta.CheckOpt{
		Repair:       true,
		Recursive:    true,
		ShowProgress: func(int) {},
		Slices:       slices,
	}); err != nil {
		t.Fatalf("check repair: %v", err)
	}

	var repaired meta.Attr
	if st := m.GetAttr(ctx, checkIno, &repaired); st != 0 || repaired.Nlink != 3 || repaired.Parent != meta.RootInode {
		t.Fatalf("check inode not repaired: attr=%+v st=%v", repaired, st)
	}
	if st := m.GetAttr(ctx, d1, &repaired); st != 0 || repaired.Nlink != 3 || repaired.Parent != checkIno {
		t.Fatalf("d1 not repaired: attr=%+v st=%v", repaired, st)
	}
	if st := m.GetAttr(ctx, d2, &repaired); st != 0 || !repaired.Full || repaired.Nlink != 2 || repaired.Parent != d1 {
		t.Fatalf("d2 not repaired: attr=%+v st=%v", repaired, st)
	}
}

func TestJuiceFSMetaCheckAndSyncDirStat(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "check-sync-dirstat", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var dir meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "statcheck", 0755, 0, 0, &dir, nil); st != 0 {
		t.Fatalf("mkdir: %v", st)
	}
	var file meta.Ino
	if st := m.Create(ctx, dir, "f", 0644, 0, 0, &file, nil); st != 0 {
		t.Fatalf("create: %v", st)
	}
	if st := m.Close(ctx, file); st != 0 {
		t.Fatalf("close: %v", st)
	}

	field := dir.String()
	deadline := time.Now().Add(2 * time.Second)
	for {
		usedInodes, err := c.HGet(ctx, "dirUsedInodes", field).Int64()
		if err == nil && usedInodes == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("dir stat not ready before corruption: err=%v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}

	if err := c.HSet(ctx, "dirDataLength", field, "-1").Err(); err != nil {
		t.Fatal(err)
	}
	if err := c.HSet(ctx, "dirUsedSpace", field, "-1").Err(); err != nil {
		t.Fatal(err)
	}
	if err := c.HSet(ctx, "dirUsedInodes", field, "-1").Err(); err != nil {
		t.Fatal(err)
	}

	if err := m.Check(ctx, "/statcheck", &meta.CheckOpt{
		ShowProgress: func(int) {},
		Slices:       map[meta.Ino][]meta.Slice{},
	}); err == nil {
		t.Fatalf("check should fail when dir stat is broken")
	}

	if err := m.Check(ctx, "/statcheck", &meta.CheckOpt{
		Repair:       true,
		SyncDirStat:  true,
		ShowProgress: func(int) {},
		Slices:       map[meta.Ino][]meta.Slice{},
	}); err != nil {
		t.Fatalf("check repair sync-dir-stat: %v", err)
	}

	dataLength, err := c.HGet(ctx, "dirDataLength", field).Int64()
	if err != nil {
		t.Fatal(err)
	}
	usedSpace, err := c.HGet(ctx, "dirUsedSpace", field).Int64()
	if err != nil {
		t.Fatal(err)
	}
	usedInodes, err := c.HGet(ctx, "dirUsedInodes", field).Int64()
	if err != nil {
		t.Fatal(err)
	}
	if dataLength != 0 || usedSpace != 4096 || usedInodes != 1 {
		t.Fatalf("dir stat not repaired: length=%d space=%d inodes=%d", dataLength, usedSpace, usedInodes)
	}
}

func TestJuiceFSMetaCheckRepairRecursiveRoot(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "check-root-recursive", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var checkIno, d1, d2, d3 meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "checkroot", 0755, 0, 0, &checkIno, nil); st != 0 {
		t.Fatalf("mkdir checkroot: %v", st)
	}
	if st := m.Mkdir(ctx, checkIno, "d1", 0755, 0, 0, &d1, nil); st != 0 {
		t.Fatalf("mkdir d1: %v", st)
	}
	if st := m.Mkdir(ctx, d1, "d2", 0755, 0, 0, &d2, nil); st != 0 {
		t.Fatalf("mkdir d2: %v", st)
	}
	if st := m.Mkdir(ctx, d2, "d3", 0755, 0, 0, &d3, nil); st != 0 {
		t.Fatalf("mkdir d3: %v", st)
	}

	for _, ino := range []meta.Ino{checkIno, d1, d2, d3} {
		var attr meta.Attr
		if st := m.GetAttr(ctx, ino, &attr); st != 0 {
			t.Fatalf("getattr %d: %v", ino, st)
		}
		attr.Nlink = 0
		if ino == d3 {
			attr.Full = false
		}
		if err := c.Set(ctx, fmt.Sprintf("i%d", ino), string(attr.Marshal()), 0).Err(); err != nil {
			t.Fatal(err)
		}
		field := ino.String()
		if err := c.HSet(ctx, "dirDataLength", field, "-1").Err(); err != nil {
			t.Fatal(err)
		}
		if err := c.HSet(ctx, "dirUsedSpace", field, "-1").Err(); err != nil {
			t.Fatal(err)
		}
		if err := c.HSet(ctx, "dirUsedInodes", field, "-1").Err(); err != nil {
			t.Fatal(err)
		}
	}

	if err := m.Check(ctx, "/", &meta.CheckOpt{
		Repair:       true,
		Recursive:    true,
		SyncDirStat:  true,
		ShowProgress: func(int) {},
		Slices:       map[meta.Ino][]meta.Slice{},
	}); err != nil {
		t.Fatalf("recursive root repair: %v", err)
	}

	type want struct {
		parent meta.Ino
		nlink  uint32
	}
	wants := map[meta.Ino]want{
		checkIno: {parent: meta.RootInode, nlink: 3},
		d1:       {parent: checkIno, nlink: 3},
		d2:       {parent: d1, nlink: 3},
		d3:       {parent: d2, nlink: 2},
	}
	for ino, w := range wants {
		var attr meta.Attr
		if st := m.GetAttr(ctx, ino, &attr); st != 0 {
			t.Fatalf("getattr repaired %d: %v", ino, st)
		}
		if !attr.Full || attr.Parent != w.parent || attr.Nlink != w.nlink {
			t.Fatalf("inode %d not repaired: attr=%+v wantParent=%d wantNlink=%d", ino, attr, w.parent, w.nlink)
		}
		field := ino.String()
		dataLength, err := c.HGet(ctx, "dirDataLength", field).Int64()
		if err != nil {
			t.Fatalf("dirDataLength %d: %v", ino, err)
		}
		usedSpace, err := c.HGet(ctx, "dirUsedSpace", field).Int64()
		if err != nil {
			t.Fatalf("dirUsedSpace %d: %v", ino, err)
		}
		usedInodes, err := c.HGet(ctx, "dirUsedInodes", field).Int64()
		if err != nil {
			t.Fatalf("dirUsedInodes %d: %v", ino, err)
		}
		if dataLength < 0 || usedSpace < 0 || usedInodes < 0 {
			t.Fatalf("dir stat not repaired for %d: length=%d space=%d inodes=%d", ino, dataLength, usedSpace, usedInodes)
		}
	}
}

func TestJuiceFSMetaHardlinkDirStatAndQuota(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	sessionOpen := false

	format := &meta.Format{Name: "hardlink-dirstat-quota", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	sessionOpen = true
	defer func() {
		if sessionOpen {
			_ = m.CloseSession()
		}
	}()

	ctx := meta.Background()
	var parent meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "ugquota", 0755, 0, 0, &parent, nil); st != 0 {
		t.Fatalf("mkdir ugquota: %v", st)
	}

	uid, gid := uint32(12345), uint32(23456)
	if err := m.HandleQuota(ctx, meta.QuotaSet, fmt.Sprintf("%d", uid), meta.UserQuotaType, map[string]*meta.Quota{
		fmt.Sprintf("%d", uid): {MaxSpace: 100 << 20, MaxInodes: 100},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.HandleQuota(ctx, meta.QuotaSet, fmt.Sprintf("%d", gid), meta.GroupQuotaType, map[string]*meta.Quota{
		fmt.Sprintf("%d", gid): {MaxSpace: 100 << 20, MaxInodes: 100},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.HandleQuota(ctx, meta.QuotaSet, "/ugquota", meta.DirQuotaType, map[string]*meta.Quota{
		"/ugquota": {MaxSpace: 200 << 20, MaxInodes: 200},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.CloseSession(); err != nil {
		t.Fatal(err)
	}
	sessionOpen = false
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	sessionOpen = true

	var original meta.Ino
	var attr meta.Attr
	if st := m.Create(ctx, parent, "orig", 0644, 0, 0, &original, &attr); st != 0 {
		t.Fatalf("create original: %v", st)
	}
	if st := m.SetAttr(ctx, original, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: uid, Gid: gid}); st != 0 {
		t.Fatalf("setattr uid gid: %v", st)
	}
	var sliceID uint64
	if st := m.NewSlice(ctx, &sliceID); st != 0 {
		t.Fatalf("new slice: %v", st)
	}
	if st := m.Write(ctx, original, 0, 0, meta.Slice{Id: sliceID, Size: 8192, Len: 8192}, time.Now()); st != 0 {
		t.Fatalf("write original: %v", st)
	}
	if st := m.Close(ctx, original); st != 0 {
		t.Fatalf("close original: %v", st)
	}
	m.FlushSession()

	waitQuota := func(qkey string, qtype uint32) *meta.Quota {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for {
			qs := map[string]*meta.Quota{}
			if err := m.HandleQuota(ctx, meta.QuotaGet, qkey, qtype, qs, false, false, false); err != nil {
				t.Fatal(err)
			}
			if q := qs[qkey]; q != nil {
				return q
			}
			if time.Now().After(deadline) {
				t.Fatalf("quota %s type %d not ready", qkey, qtype)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	waitDirStat := func(ino meta.Ino, wantLength, wantSpace, wantInodes int64) {
		t.Helper()
		field := ino.String()
		deadline := time.Now().Add(3 * time.Second)
		for {
			dataLength, err1 := c.HGet(ctx, "dirDataLength", field).Int64()
			usedSpace, err2 := c.HGet(ctx, "dirUsedSpace", field).Int64()
			usedInodes, err3 := c.HGet(ctx, "dirUsedInodes", field).Int64()
			if err1 == nil && err2 == nil && err3 == nil &&
				dataLength == wantLength && usedSpace == wantSpace && usedInodes == wantInodes {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf(
					"dir stat mismatch: length=%d err=%v space=%d err=%v inodes=%d err=%v want=(%d,%d,%d)",
					dataLength, err1, usedSpace, err2, usedInodes, err3, wantLength, wantSpace, wantInodes,
				)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}

	userAfterFile := waitQuota(fmt.Sprintf("%d", uid), meta.UserQuotaType)
	dirAfterFile := waitQuota("/ugquota", meta.DirQuotaType)
	waitDirStat(parent, 8192, 8192, 1)

	if st := m.Link(ctx, original, parent, "hard", &attr); st != 0 {
		t.Fatalf("link hard: %v", st)
	}
	m.FlushSession()

	userAfterHardlink := waitQuota(fmt.Sprintf("%d", uid), meta.UserQuotaType)
	dirAfterHardlink := waitQuota("/ugquota", meta.DirQuotaType)
	waitDirStat(parent, 16384, 16384, 2)

	if userAfterHardlink.UsedSpace-userAfterFile.UsedSpace != 0 || userAfterHardlink.UsedInodes-userAfterFile.UsedInodes != 0 {
		t.Fatalf("user quota should not increase on hardlink: before=%+v after=%+v", userAfterFile, userAfterHardlink)
	}
	if dirAfterHardlink.UsedSpace-dirAfterFile.UsedSpace != 8192 || dirAfterHardlink.UsedInodes-dirAfterFile.UsedInodes != 1 {
		t.Fatalf("dir quota mismatch after hardlink: before=%+v after=%+v", dirAfterFile, dirAfterHardlink)
	}

	if st := m.Unlink(ctx, parent, "hard", true); st != 0 {
		t.Fatalf("unlink hard: %v", st)
	}
	m.FlushSession()

	userAfterUnlink := waitQuota(fmt.Sprintf("%d", uid), meta.UserQuotaType)
	dirAfterUnlink := waitQuota("/ugquota", meta.DirQuotaType)
	waitDirStat(parent, 8192, 8192, 1)

	if userAfterHardlink.UsedSpace-userAfterUnlink.UsedSpace != 0 || userAfterHardlink.UsedInodes-userAfterUnlink.UsedInodes != 0 {
		t.Fatalf("user quota should not decrease on hardlink unlink: hard=%+v unlink=%+v", userAfterHardlink, userAfterUnlink)
	}
	if dirAfterHardlink.UsedSpace-dirAfterUnlink.UsedSpace != 8192 || dirAfterHardlink.UsedInodes-dirAfterUnlink.UsedInodes != 1 {
		t.Fatalf("dir quota mismatch after hardlink unlink: hard=%+v unlink=%+v", dirAfterHardlink, dirAfterUnlink)
	}
}

func TestJuiceFSMetaMultiHardlinkQuotaAndDirStat(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	sessionOpen := false

	format := &meta.Format{Name: "multi-hardlink-quota", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	sessionOpen = true
	defer func() {
		if sessionOpen {
			_ = m.CloseSession()
		}
	}()

	ctx := meta.Background()
	var parent meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "multiquota", 0755, 0, 0, &parent, nil); st != 0 {
		t.Fatalf("mkdir multiquota: %v", st)
	}

	uid, gid := uint32(32345), uint32(42356)
	if err := m.HandleQuota(ctx, meta.QuotaSet, fmt.Sprintf("%d", uid), meta.UserQuotaType, map[string]*meta.Quota{
		fmt.Sprintf("%d", uid): {MaxSpace: 100 << 20, MaxInodes: 100},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.HandleQuota(ctx, meta.QuotaSet, fmt.Sprintf("%d", gid), meta.GroupQuotaType, map[string]*meta.Quota{
		fmt.Sprintf("%d", gid): {MaxSpace: 100 << 20, MaxInodes: 100},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.HandleQuota(ctx, meta.QuotaSet, "/multiquota", meta.DirQuotaType, map[string]*meta.Quota{
		"/multiquota": {MaxSpace: 200 << 20, MaxInodes: 200},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.CloseSession(); err != nil {
		t.Fatal(err)
	}
	sessionOpen = false
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	sessionOpen = true

	waitQuota := func(qkey string, qtype uint32) *meta.Quota {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for {
			qs := map[string]*meta.Quota{}
			if err := m.HandleQuota(ctx, meta.QuotaGet, qkey, qtype, qs, false, false, false); err != nil {
				t.Fatal(err)
			}
			if q := qs[qkey]; q != nil {
				return q
			}
			if time.Now().After(deadline) {
				t.Fatalf("quota %s type %d not ready", qkey, qtype)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	waitDirStat := func(ino meta.Ino, wantLength, wantSpace, wantInodes int64) {
		t.Helper()
		field := ino.String()
		deadline := time.Now().Add(3 * time.Second)
		for {
			dataLength, err1 := c.HGet(ctx, "dirDataLength", field).Int64()
			usedSpace, err2 := c.HGet(ctx, "dirUsedSpace", field).Int64()
			usedInodes, err3 := c.HGet(ctx, "dirUsedInodes", field).Int64()
			if err1 == nil && err2 == nil && err3 == nil &&
				dataLength == wantLength && usedSpace == wantSpace && usedInodes == wantInodes {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf(
					"dir stat mismatch: length=%d err=%v space=%d err=%v inodes=%d err=%v want=(%d,%d,%d)",
					dataLength, err1, usedSpace, err2, usedInodes, err3, wantLength, wantSpace, wantInodes,
				)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}

	var original meta.Ino
	var attr meta.Attr
	if st := m.Create(ctx, parent, "orig", 0644, 0, 0, &original, &attr); st != 0 {
		t.Fatalf("create original: %v", st)
	}
	if st := m.SetAttr(ctx, original, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: uid, Gid: gid}); st != 0 {
		t.Fatalf("setattr uid gid: %v", st)
	}
	var sliceID uint64
	if st := m.NewSlice(ctx, &sliceID); st != 0 {
		t.Fatalf("new slice: %v", st)
	}
	if st := m.Write(ctx, original, 0, 0, meta.Slice{Id: sliceID, Size: 12288, Len: 12288}, time.Now()); st != 0 {
		t.Fatalf("write original: %v", st)
	}
	if st := m.Close(ctx, original); st != 0 {
		t.Fatalf("close original: %v", st)
	}
	m.FlushSession()

	userAfterFile := waitQuota(fmt.Sprintf("%d", uid), meta.UserQuotaType)
	dirAfterFile := waitQuota("/multiquota", meta.DirQuotaType)
	waitDirStat(parent, 12288, 12288, 1)

	links := []string{"h1", "h2", "h3"}
	for _, name := range links {
		if st := m.Link(ctx, original, parent, name, &attr); st != 0 {
			t.Fatalf("link %s: %v", name, st)
		}
	}
	m.FlushSession()

	userAfterLinks := waitQuota(fmt.Sprintf("%d", uid), meta.UserQuotaType)
	dirAfterLinks := waitQuota("/multiquota", meta.DirQuotaType)
	waitDirStat(parent, 12288*4, 12288*4, 4)

	if userAfterLinks.UsedSpace-userAfterFile.UsedSpace != 0 || userAfterLinks.UsedInodes-userAfterFile.UsedInodes != 0 {
		t.Fatalf("user quota should not increase on multi hardlink: before=%+v after=%+v", userAfterFile, userAfterLinks)
	}
	if dirAfterLinks.UsedSpace-dirAfterFile.UsedSpace != 12288*3 || dirAfterLinks.UsedInodes-dirAfterFile.UsedInodes != 3 {
		t.Fatalf("dir quota mismatch after multi hardlink: before=%+v after=%+v", dirAfterFile, dirAfterLinks)
	}

	var inodeAttr meta.Attr
	if st := m.GetAttr(ctx, original, &inodeAttr); st != 0 {
		t.Fatalf("getattr original after links: %v", st)
	}
	if inodeAttr.Nlink != 4 {
		t.Fatalf("nlink after links = %d, want 4", inodeAttr.Nlink)
	}

	for i, name := range links {
		if st := m.Unlink(ctx, parent, name, true); st != 0 {
			t.Fatalf("unlink %s: %v", name, st)
		}
		m.FlushSession()
		if st := m.GetAttr(ctx, original, &inodeAttr); st != 0 {
			t.Fatalf("getattr original after unlink %s: %v", name, st)
		}
		wantNlink := uint32(len(links) - i)
		if inodeAttr.Nlink != wantNlink {
			t.Fatalf("nlink after unlink %s = %d, want %d", name, inodeAttr.Nlink, wantNlink)
		}
	}

	userAfterUnlinks := waitQuota(fmt.Sprintf("%d", uid), meta.UserQuotaType)
	dirAfterUnlinks := waitQuota("/multiquota", meta.DirQuotaType)
	waitDirStat(parent, 12288, 12288, 1)

	if userAfterLinks.UsedSpace-userAfterUnlinks.UsedSpace != 0 || userAfterLinks.UsedInodes-userAfterUnlinks.UsedInodes != 0 {
		t.Fatalf("user quota should not decrease on multi hardlink unlink: before=%+v after=%+v", userAfterLinks, userAfterUnlinks)
	}
	if dirAfterLinks.UsedSpace-dirAfterUnlinks.UsedSpace != 12288*3 || dirAfterLinks.UsedInodes-dirAfterUnlinks.UsedInodes != 3 {
		t.Fatalf("dir quota mismatch after multi hardlink unlink: before=%+v after=%+v", dirAfterLinks, dirAfterUnlinks)
	}

	for _, name := range links {
		var inode meta.Ino
		var linkAttr meta.Attr
		if st := m.Lookup(ctx, parent, name, &inode, &linkAttr, false); st == 0 {
			t.Fatalf("hardlink %s should have been removed", name)
		}
	}
}

func TestJuiceFSMetaNestedDirQuotaScenarios(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	sessionOpen := false

	format := &meta.Format{Name: "nested-dir-quota", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	sessionOpen = true
	defer func() {
		if sessionOpen {
			_ = m.CloseSession()
		}
	}()
	restartSession := func() {
		t.Helper()
		if err := m.CloseSession(); err != nil {
			t.Fatal(err)
		}
		sessionOpen = false
		if err := m.NewSession(true); err != nil {
			t.Fatal(err)
		}
		sessionOpen = true
	}

	ctx := meta.Background()
	var quotaDir meta.Ino
	var attr meta.Attr
	if st := m.Mkdir(ctx, meta.RootInode, "quota", 0755, 0, 0, &quotaDir, &attr); st != 0 {
		t.Fatalf("mkdir quota: %v", st)
	}

	waitQuota := func(path string, wantSpace, wantInodes int64) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for {
			qs := map[string]*meta.Quota{}
			if err := m.HandleQuota(ctx, meta.QuotaGet, path, meta.DirQuotaType, qs, false, false, false); err != nil {
				t.Fatal(err)
			}
			if q := qs[path]; q != nil && q.UsedSpace == wantSpace && q.UsedInodes == wantInodes {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("quota %s mismatch, want space=%d inodes=%d got=%+v", path, wantSpace, wantInodes, qs[path])
			}
			time.Sleep(20 * time.Millisecond)
		}
	}

	if err := m.HandleQuota(ctx, meta.QuotaSet, "/quota", meta.DirQuotaType, map[string]*meta.Quota{
		"/quota": {MaxSpace: 2 << 30, MaxInodes: 6},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	restartSession()
	var d1 meta.Ino
	if st := m.Mkdir(ctx, quotaDir, "d1", 0755, 0, 0, &d1, &attr); st != 0 {
		t.Fatalf("mkdir /quota/d1: %v", st)
	}
	if err := m.HandleQuota(ctx, meta.QuotaSet, "/quota/d1", meta.DirQuotaType, map[string]*meta.Quota{
		"/quota/d1": {MaxSpace: 1 << 30, MaxInodes: 5},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	restartSession()
	var f1 meta.Ino
	if st := m.Create(ctx, d1, "f1", 0644, 0, 0, &f1, &attr); st != 0 {
		t.Fatalf("create /quota/d1/f1: %v", st)
	}
	if st := m.Close(ctx, f1); st != 0 {
		t.Fatalf("close /quota/d1/f1: %v", st)
	}

	var d2 meta.Ino
	if st := m.Mkdir(ctx, quotaDir, "d2", 0755, 0, 0, &d2, &attr); st != 0 {
		t.Fatalf("mkdir /quota/d2: %v", st)
	}
	var d22 meta.Ino
	if st := m.Mkdir(ctx, d2, "d22", 0755, 0, 0, &d22, &attr); st != 0 {
		t.Fatalf("mkdir /quota/d2/d22: %v", st)
	}
	if err := m.HandleQuota(ctx, meta.QuotaSet, "/quota/d2/d22", meta.DirQuotaType, map[string]*meta.Quota{
		"/quota/d2/d22": {MaxSpace: 1 << 30, MaxInodes: 5},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	restartSession()
	var f2 meta.Ino
	if st := m.Create(ctx, d2, "f2", 0644, 0, 0, &f2, &attr); st != 0 {
		t.Fatalf("create /quota/d2/f2: %v", st)
	}
	var f22 meta.Ino
	if st := m.Create(ctx, d22, "f22", 0644, 0, 0, &f22, &attr); st != 0 {
		t.Fatalf("create /quota/d2/d22/f22: %v", st)
	}
	if st := m.Close(ctx, f2); st != 0 {
		t.Fatalf("close /quota/d2/f2: %v", st)
	}
	if st := m.Close(ctx, f22); st != 0 {
		t.Fatalf("close /quota/d2/d22/f22: %v", st)
	}
	m.FlushSession()

	waitQuota("/quota", 6*4096, 6)
	waitQuota("/quota/d1", 4096, 1)
	waitQuota("/quota/d2/d22", 4096, 1)

	if st := m.Lookup(ctx, d2, "f2", &f2, &attr, false); st != 0 {
		t.Fatalf("lookup /quota/d2/f2: %v", st)
	}
	if st := m.Open(ctx, f2, 0, &attr); st != 0 {
		t.Fatalf("open /quota/d2/f2: %v", st)
	}
	if st := m.Unlink(ctx, d2, "f2", true); st != 0 {
		t.Fatalf("unlink /quota/d2/f2: %v", st)
	}
	if st := m.Close(ctx, f2); st != 0 {
		t.Fatalf("close unlinked /quota/d2/f2: %v", st)
	}
	m.FlushSession()
	waitQuota("/quota", 5*4096, 5)

	if st := m.Lookup(ctx, d22, "f22", &f22, &attr, false); st != 0 {
		t.Fatalf("lookup /quota/d2/d22/f22: %v", st)
	}
	if st := m.Open(ctx, f22, 0, &attr); st != 0 {
		t.Fatalf("open /quota/d2/d22/f22: %v", st)
	}
	if st := m.Rename(ctx, d22, "f22", d22, "f23", 0, &f22, nil); st != 0 {
		t.Fatalf("rename /quota/d2/d22/f22 -> f23: %v", st)
	}
	if st := m.Close(ctx, f22); st != 0 {
		t.Fatalf("close renamed /quota/d2/d22/f23: %v", st)
	}
	m.FlushSession()
	waitQuota("/quota", 5*4096, 5)

	var f3 meta.Ino
	if st := m.Create(ctx, d2, "f3", 0644, 0, 0, &f3, &attr); st != 0 {
		t.Fatalf("create /quota/d2/f3: %v", st)
	}
	if st := m.Close(ctx, f3); st != 0 {
		t.Fatalf("close /quota/d2/f3: %v", st)
	}
	m.FlushSession()
	waitQuota("/quota", 6*4096, 6)

	if err := m.HandleQuota(ctx, meta.QuotaDel, "/quota/d1", meta.DirQuotaType, nil, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.HandleQuota(ctx, meta.QuotaDel, "/quota/d2", meta.DirQuotaType, nil, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.CloseSession(); err != nil {
		t.Fatal(err)
	}
	sessionOpen = false
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	sessionOpen = true

	qs := map[string]*meta.Quota{}
	if err := m.HandleQuota(ctx, meta.QuotaList, "", meta.AllQuotaType, qs, false, false, false); err != nil {
		t.Fatal(err)
	}
	if len(qs) != 2 {
		t.Fatalf("quota list size = %d, want 2", len(qs))
	}

	if st := m.Create(ctx, d22, "f4", 0644, 0, 0, nil, &attr); st != syscall.EDQUOT {
		t.Fatalf("create /quota/d2/d22/f4 = %v, want %v", st, syscall.EDQUOT)
	}
}

func TestJuiceFSMetaCheckRepairWithDirQuotaAndDirStat(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	sessionOpen := false

	format := &meta.Format{Name: "check-quota-dirstat", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	sessionOpen = true
	defer func() {
		if sessionOpen {
			_ = m.CloseSession()
		}
	}()

	ctx := meta.Background()
	var parent meta.Ino
	var attr meta.Attr
	if st := m.Mkdir(ctx, meta.RootInode, "repairquota", 0755, 0, 0, &parent, &attr); st != 0 {
		t.Fatalf("mkdir repairquota: %v", st)
	}
	if err := m.HandleQuota(ctx, meta.QuotaSet, "/repairquota", meta.DirQuotaType, map[string]*meta.Quota{
		"/repairquota": {MaxSpace: 1 << 20, MaxInodes: 10},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.CloseSession(); err != nil {
		t.Fatal(err)
	}
	sessionOpen = false
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	sessionOpen = true

	var file meta.Ino
	if st := m.Create(ctx, parent, "f", 0644, 0, 0, &file, &attr); st != 0 {
		t.Fatalf("create repairquota/f: %v", st)
	}
	var sliceID uint64
	if st := m.NewSlice(ctx, &sliceID); st != 0 {
		t.Fatalf("new slice: %v", st)
	}
	if st := m.Write(ctx, file, 0, 0, meta.Slice{Id: sliceID, Size: 4096, Len: 4096}, time.Now()); st != 0 {
		t.Fatalf("write file: %v", st)
	}
	if st := m.Close(ctx, file); st != 0 {
		t.Fatalf("close file: %v", st)
	}
	m.FlushSession()

	quotaBefore := map[string]*meta.Quota{}
	if err := m.HandleQuota(ctx, meta.QuotaGet, "/repairquota", meta.DirQuotaType, quotaBefore, false, false, false); err != nil {
		t.Fatal(err)
	}
	before := quotaBefore["/repairquota"]
	if before == nil || before.UsedSpace != 4096 || before.UsedInodes != 1 {
		t.Fatalf("unexpected quota before repair: %+v", before)
	}

	field := parent.String()
	if err := c.HSet(ctx, "dirDataLength", field, "-1").Err(); err != nil {
		t.Fatal(err)
	}
	if err := c.HSet(ctx, "dirUsedSpace", field, "-1").Err(); err != nil {
		t.Fatal(err)
	}
	if err := c.HSet(ctx, "dirUsedInodes", field, "-1").Err(); err != nil {
		t.Fatal(err)
	}
	var dirAttr meta.Attr
	if st := m.GetAttr(ctx, parent, &dirAttr); st != 0 {
		t.Fatalf("getattr dir before corruption: %v", st)
	}
	broken := dirAttr
	broken.Full = false
	broken.Nlink = 0
	if err := c.Set(ctx, "i"+parent.String(), string(broken.Marshal()), 0).Err(); err != nil {
		t.Fatal(err)
	}

	if err := m.Check(ctx, "/repairquota", &meta.CheckOpt{
		Repair:       true,
		SyncDirStat:  true,
		ShowProgress: func(int) {},
		Slices:       map[meta.Ino][]meta.Slice{},
	}); err != nil {
		t.Fatalf("check repair sync-dir-stat: %v", err)
	}

	var repaired meta.Attr
	if st := m.GetAttr(ctx, parent, &repaired); st != 0 {
		t.Fatalf("getattr repaired dir: %v", st)
	}
	if !repaired.Full || repaired.Parent != meta.RootInode || repaired.Nlink != 2 {
		t.Fatalf("dir attr not repaired: %+v", repaired)
	}
	dataLength, err := c.HGet(ctx, "dirDataLength", field).Int64()
	if err != nil {
		t.Fatal(err)
	}
	usedSpace, err := c.HGet(ctx, "dirUsedSpace", field).Int64()
	if err != nil {
		t.Fatal(err)
	}
	usedInodes, err := c.HGet(ctx, "dirUsedInodes", field).Int64()
	if err != nil {
		t.Fatal(err)
	}
	if dataLength != 4096 || usedSpace != 4096 || usedInodes != 1 {
		t.Fatalf("dir stat not repaired: length=%d space=%d inodes=%d", dataLength, usedSpace, usedInodes)
	}

	quotaAfter := map[string]*meta.Quota{}
	if err := m.HandleQuota(ctx, meta.QuotaGet, "/repairquota", meta.DirQuotaType, quotaAfter, false, false, false); err != nil {
		t.Fatal(err)
	}
	after := quotaAfter["/repairquota"]
	if after == nil || after.UsedSpace != before.UsedSpace || after.UsedInodes != before.UsedInodes {
		t.Fatalf("quota changed unexpectedly after repair: before=%+v after=%+v", before, after)
	}
}

func TestJuiceFSMetaUserGroupQuotaOwnershipTransfer(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	sessionOpen := false

	format := &meta.Format{Name: "ugquota-transfer", UserGroupQuota: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	sessionOpen = true
	defer func() {
		if sessionOpen {
			_ = m.CloseSession()
		}
	}()

	restartSession := func() {
		t.Helper()
		if err := m.CloseSession(); err != nil {
			t.Fatal(err)
		}
		sessionOpen = false
		if err := m.NewSession(true); err != nil {
			t.Fatal(err)
		}
		sessionOpen = true
	}
	waitQuota := func(id string, qtype uint32, wantSpace, wantInodes int64) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for {
			qs := map[string]*meta.Quota{}
			if err := m.HandleQuota(meta.Background(), meta.QuotaGet, id, qtype, qs, false, false, false); err != nil {
				t.Fatal(err)
			}
			if q := qs[id]; q != nil && q.UsedSpace == wantSpace && q.UsedInodes == wantInodes {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("quota %s type %d mismatch, want=(%d,%d) got=%+v", id, qtype, wantSpace, wantInodes, qs[id])
			}
			time.Sleep(20 * time.Millisecond)
		}
	}

	ctx := meta.Background()
	owner1UID, owner1GID := uint32(1001), uint32(2001)
	owner2UID, owner2GID := uint32(1003), uint32(2003)
	operatorUID, operatorGID := uint32(1002), uint32(2002)

	for _, spec := range []struct {
		id    string
		qtype uint32
	}{
		{fmt.Sprintf("%d", owner1UID), meta.UserQuotaType},
		{fmt.Sprintf("%d", owner1GID), meta.GroupQuotaType},
		{fmt.Sprintf("%d", owner2UID), meta.UserQuotaType},
		{fmt.Sprintf("%d", owner2GID), meta.GroupQuotaType},
		{fmt.Sprintf("%d", operatorUID), meta.UserQuotaType},
		{fmt.Sprintf("%d", operatorGID), meta.GroupQuotaType},
	} {
		if err := m.HandleQuota(ctx, meta.QuotaSet, spec.id, spec.qtype, map[string]*meta.Quota{
			spec.id: {MaxSpace: 1 << 20, MaxInodes: 10},
		}, false, false, false); err != nil {
			t.Fatal(err)
		}
	}
	restartSession()

	var file meta.Ino
	var attr meta.Attr
	if st := m.Create(ctx, meta.RootInode, "owned", 0644, 0, 0, &file, &attr); st != 0 {
		t.Fatalf("create owned: %v", st)
	}
	if st := m.SetAttr(ctx, file, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: owner1UID, Gid: owner1GID}); st != 0 {
		t.Fatalf("set owner1: %v", st)
	}
	var sliceID uint64
	if st := m.NewSlice(ctx, &sliceID); st != 0 {
		t.Fatalf("new slice: %v", st)
	}
	operatorCtx := meta.NewContext(1, operatorUID, []uint32{operatorGID})
	if st := m.Write(operatorCtx, file, 0, 0, meta.Slice{Id: sliceID, Size: 1024, Len: 1024}, time.Now()); st != 0 {
		t.Fatalf("write by operator: %v", st)
	}
	if st := m.Close(ctx, file); st != 0 {
		t.Fatalf("close owned: %v", st)
	}
	m.FlushSession()

	waitQuota(fmt.Sprintf("%d", owner1UID), meta.UserQuotaType, 4096, 1)
	waitQuota(fmt.Sprintf("%d", owner1GID), meta.GroupQuotaType, 4096, 1)
	waitQuota(fmt.Sprintf("%d", operatorUID), meta.UserQuotaType, 0, 0)

	if st := m.SetAttr(ctx, file, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: owner2UID, Gid: owner2GID}); st != 0 {
		t.Fatalf("set owner2: %v", st)
	}
	m.FlushSession()

	waitQuota(fmt.Sprintf("%d", owner1UID), meta.UserQuotaType, 0, 0)
	waitQuota(fmt.Sprintf("%d", owner1GID), meta.GroupQuotaType, 0, 0)
	waitQuota(fmt.Sprintf("%d", owner2UID), meta.UserQuotaType, 4096, 1)
	waitQuota(fmt.Sprintf("%d", owner2GID), meta.GroupQuotaType, 4096, 1)
	waitQuota(fmt.Sprintf("%d", operatorUID), meta.UserQuotaType, 0, 0)
}

func TestJuiceFSMetaUserQuotaEdgeCases(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	sessionOpen := false

	format := &meta.Format{Name: "ugquota-edge", UserGroupQuota: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	sessionOpen = true
	defer func() {
		if sessionOpen {
			_ = m.CloseSession()
		}
	}()

	restartSession := func() {
		t.Helper()
		if err := m.CloseSession(); err != nil {
			t.Fatal(err)
		}
		sessionOpen = false
		if err := m.NewSession(true); err != nil {
			t.Fatal(err)
		}
		sessionOpen = true
	}

	ctx := meta.Background()
	fileOwnerUID, fileOwnerGID := uint32(1001), uint32(1001)
	operatorUID, operatorGID := uint32(1002), uint32(2002)
	operatorCtx := meta.NewContext(1, operatorUID, []uint32{operatorGID})
	ownerCtx := meta.NewContext(2, fileOwnerUID, []uint32{fileOwnerGID})

	if err := m.HandleQuota(ctx, meta.QuotaSet, fmt.Sprintf("%d", fileOwnerUID), meta.UserQuotaType, map[string]*meta.Quota{
		fmt.Sprintf("%d", fileOwnerUID): {MaxSpace: 0, MaxInodes: 1},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	restartSession()

	var fileInode meta.Ino
	var attr meta.Attr
	if st := m.Create(ownerCtx, meta.RootInode, "testfile_inodes", 0644, 0, 0, &fileInode, &attr); st != 0 {
		t.Fatalf("create testfile_inodes: %v", st)
	}
	var sliceID uint64
	if st := m.NewSlice(ctx, &sliceID); st != 0 {
		t.Fatalf("new slice inodes-only: %v", st)
	}
	if st := m.Write(operatorCtx, fileInode, 0, 0, meta.Slice{Id: sliceID, Size: 1 << 20, Len: 1 << 20}, time.Now()); st != 0 {
		t.Fatalf("write should succeed with no space limit: %v", st)
	}
	if st := m.Close(ctx, fileInode); st != 0 {
		t.Fatalf("close testfile_inodes: %v", st)
	}

	var secondFile meta.Ino
	if st := m.Create(ownerCtx, meta.RootInode, "testfile_inodes2", 0644, 0, 0, &secondFile, &attr); st != syscall.EDQUOT {
		t.Fatalf("create should fail with EDQUOT for inodes-only quota, got %v", st)
	}

	if err := m.HandleQuota(ctx, meta.QuotaSet, fmt.Sprintf("%d", fileOwnerUID), meta.UserQuotaType, map[string]*meta.Quota{
		fmt.Sprintf("%d", fileOwnerUID): {MaxSpace: 1 << 20, MaxInodes: 0},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	restartSession()

	if st := m.Create(ctx, meta.RootInode, "testfile_space", 0644, 0, 0, &fileInode, &attr); st != 0 {
		t.Fatalf("create testfile_space: %v", st)
	}
	if st := m.SetAttr(ctx, fileInode, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: fileOwnerUID, Gid: fileOwnerGID}); st != 0 {
		t.Fatalf("set owner testfile_space: %v", st)
	}
	for i := 0; i < 10; i++ {
		var ino meta.Ino
		name := fmt.Sprintf("testfile_space_%d", i)
		if st := m.Create(ctx, meta.RootInode, name, 0644, 0, 0, &ino, &attr); st != 0 {
			t.Fatalf("create %s should succeed with no inode limit: %v", name, st)
		}
		if st := m.SetAttr(ctx, ino, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: fileOwnerUID, Gid: fileOwnerGID}); st != 0 {
			t.Fatalf("set owner %s: %v", name, st)
		}
		if st := m.Close(ctx, ino); st != 0 {
			t.Fatalf("close %s: %v", name, st)
		}
	}
	var bigSliceID uint64
	if st := m.NewSlice(ctx, &bigSliceID); st != 0 {
		t.Fatalf("new slice space-only: %v", st)
	}
	if st := m.Write(operatorCtx, fileInode, 0, 0, meta.Slice{Id: bigSliceID, Size: 2 << 20, Len: 2 << 20}, time.Now()); st != syscall.EDQUOT {
		t.Fatalf("write should fail with EDQUOT for space-only quota, got %v", st)
	}

	if err := m.HandleQuota(ctx, meta.QuotaSet, fmt.Sprintf("%d", fileOwnerUID), meta.UserQuotaType, map[string]*meta.Quota{
		fmt.Sprintf("%d", fileOwnerUID): {MaxSpace: 4096, MaxInodes: 2},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	restartSession()

	var strictFile meta.Ino
	if st := m.Create(ctx, meta.RootInode, "strictfile", 0644, 0, 0, &strictFile, &attr); st != 0 {
		t.Fatalf("create strictfile: %v", st)
	}
	if st := m.SetAttr(ctx, strictFile, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: fileOwnerUID, Gid: fileOwnerGID}); st != 0 {
		t.Fatalf("set owner strictfile: %v", st)
	}
	var smallSliceID uint64
	if st := m.NewSlice(ctx, &smallSliceID); st != 0 {
		t.Fatalf("new small slice: %v", st)
	}
	if st := m.Write(operatorCtx, strictFile, 0, 0, meta.Slice{Id: smallSliceID, Size: 3072, Len: 3072}, time.Now()); st != 0 {
		t.Fatalf("small write should succeed: %v", st)
	}
	var largeSliceID uint64
	if st := m.NewSlice(ctx, &largeSliceID); st != 0 {
		t.Fatalf("new large slice: %v", st)
	}
	if st := m.Write(operatorCtx, strictFile, 0, 3072, meta.Slice{Id: largeSliceID, Size: 2048, Len: 2048}, time.Now()); st != syscall.EDQUOT {
		t.Fatalf("second write should fail with EDQUOT for strict quota, got %v", st)
	}
}

func TestJuiceFSMetaDirStatLifecycle(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "dirstat-lifecycle", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var dir meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "testDirStat", 0640, 022, 0, &dir, nil); st != 0 {
		t.Fatalf("mkdir: %v", st)
	}

	checkResult := func(inode meta.Ino, wantLength, wantSpace, wantInodes int64) {
		t.Helper()
		field := inode.String()
		deadline := time.Now().Add(3 * time.Second)
		for {
			dataLength, err1 := c.HGet(ctx, "dirDataLength", field).Int64()
			usedSpace, err2 := c.HGet(ctx, "dirUsedSpace", field).Int64()
			usedInodes, err3 := c.HGet(ctx, "dirUsedInodes", field).Int64()
			if err1 == nil && err2 == nil && err3 == nil &&
				dataLength == wantLength && usedSpace == wantSpace && usedInodes == wantInodes {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("dir stat mismatch for %d: length=%d err=%v space=%d err=%v inodes=%d err=%v want=(%d,%d,%d)", inode, dataLength, err1, usedSpace, err2, usedInodes, err3, wantLength, wantSpace, wantInodes)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	checkResult(dir, 0, 0, 0)

	var file meta.Ino
	if st := m.Create(ctx, dir, "file", 0640, 022, 0, &file, nil); st != 0 {
		t.Fatalf("create file: %v", st)
	}
	checkResult(dir, 0, 4096, 1)

	if st := m.Fallocate(ctx, file, 0, 0, 4097, nil); st != 0 {
		t.Fatalf("fallocate: %v", st)
	}
	checkResult(dir, 4097, 8192, 1)

	if st := m.Truncate(ctx, file, 0, 0, nil, false); st != 0 {
		t.Fatalf("truncate: %v", st)
	}
	checkResult(dir, 0, 4096, 1)

	if st := m.Write(ctx, file, 0, 0, meta.Slice{Id: 1, Size: 1 << 20, Off: 0, Len: 4097}, time.Now()); st != 0 {
		t.Fatalf("write: %v", st)
	}
	checkResult(dir, 4097, 8192, 1)

	if st := m.Link(ctx, file, dir, "file2", nil); st != 0 {
		t.Fatalf("link: %v", st)
	}
	checkResult(dir, 2*4097, 2*8192, 2)

	var sub meta.Ino
	if st := m.Mkdir(ctx, dir, "sub", 0640, 022, 0, &sub, nil); st != 0 {
		t.Fatalf("mkdir sub: %v", st)
	}
	checkResult(dir, 2*4097, 4096+2*8192, 3)

	if st := m.Rename(ctx, dir, "file2", sub, "file", 0, nil, nil); st != 0 {
		t.Fatalf("rename file2->sub/file: %v", st)
	}
	checkResult(dir, 4097, 4096+8192, 2)
	checkResult(sub, 4097, 8192, 1)

	if st := m.Unlink(ctx, dir, "file", true); st != 0 {
		t.Fatalf("unlink dir/file: %v", st)
	}
	if st := m.Unlink(ctx, sub, "file", true); st != 0 {
		t.Fatalf("unlink sub/file: %v", st)
	}
	checkResult(dir, 0, 4096, 1)
	checkResult(sub, 0, 0, 0)

	if st := m.Rmdir(ctx, dir, "sub"); st != 0 {
		t.Fatalf("rmdir sub: %v", st)
	}
	checkResult(dir, 0, 0, 0)
}

func TestJuiceFSMetaUserGroupQuotaOperations(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	sessionOpen := false

	format := &meta.Format{Name: "ugquota-ops", UserGroupQuota: true, DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	sessionOpen = true
	defer func() {
		if sessionOpen {
			_ = m.CloseSession()
		}
	}()

	restartSession := func() {
		t.Helper()
		if err := m.CloseSession(); err != nil {
			t.Fatal(err)
		}
		sessionOpen = false
		if err := m.NewSession(true); err != nil {
			t.Fatal(err)
		}
		sessionOpen = true
	}

	ctx := meta.Background()
	uid, gid := uint32(1001), uint32(2001)
	var parent meta.Ino
	var attr meta.Attr
	if st := m.Mkdir(ctx, meta.RootInode, "ugquota", 0755, 0, 0, &parent, &attr); st != 0 {
		t.Fatalf("mkdir ugquota: %v", st)
	}
	var path1, path2 meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "path1", 0755, 0, 0, &path1, nil); st != 0 {
		t.Fatalf("mkdir path1: %v", st)
	}
	if st := m.Mkdir(ctx, meta.RootInode, "path2", 0755, 0, 0, &path2, nil); st != 0 {
		t.Fatalf("mkdir path2: %v", st)
	}

	if err := m.HandleQuota(ctx, meta.QuotaSet, fmt.Sprintf("%d", uid), meta.UserQuotaType, map[string]*meta.Quota{
		fmt.Sprintf("%d", uid): {MaxSpace: 1 << 30, MaxInodes: 10},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.HandleQuota(ctx, meta.QuotaSet, fmt.Sprintf("%d", gid), meta.GroupQuotaType, map[string]*meta.Quota{
		fmt.Sprintf("%d", gid): {MaxSpace: 2 << 30, MaxInodes: 20},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.HandleQuota(ctx, meta.QuotaSet, "/path1", meta.DirQuotaType, map[string]*meta.Quota{
		"/path1": {MaxSpace: 100 << 20, MaxInodes: 20},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.HandleQuota(ctx, meta.QuotaSet, "/path2", meta.DirQuotaType, map[string]*meta.Quota{
		"/path2": {MaxSpace: 200 << 20, MaxInodes: 30},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	restartSession()

	qs := map[string]*meta.Quota{}
	if err := m.HandleQuota(ctx, meta.QuotaGet, fmt.Sprintf("%d", uid), meta.UserQuotaType, qs, false, false, false); err != nil {
		t.Fatal(err)
	}
	if q := qs[fmt.Sprintf("%d", uid)]; q == nil || q.MaxSpace != 1<<30 || q.MaxInodes != 10 {
		t.Fatalf("bad user quota: %+v", q)
	}
	qs = map[string]*meta.Quota{}
	if err := m.HandleQuota(ctx, meta.QuotaGet, fmt.Sprintf("%d", gid), meta.GroupQuotaType, qs, false, false, false); err != nil {
		t.Fatal(err)
	}
	if q := qs[fmt.Sprintf("%d", gid)]; q == nil || q.MaxSpace != 2<<30 || q.MaxInodes != 20 {
		t.Fatalf("bad group quota: %+v", q)
	}
	qs = map[string]*meta.Quota{}
	if err := m.HandleQuota(ctx, meta.QuotaList, "", meta.AllQuotaType, qs, false, false, false); err != nil {
		t.Fatal(err)
	}
	if len(qs) < 4 {
		t.Fatalf("quota list expected >=4, got %d", len(qs))
	}

	var userFile meta.Ino
	if st := m.Create(ctx, parent, "userfile", 0644, 0, 0, &userFile, &attr); st != 0 {
		t.Fatalf("create userfile: %v", st)
	}
	if st := m.SetAttr(ctx, userFile, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: uid, Gid: gid}); st != 0 {
		t.Fatalf("setattr userfile: %v", st)
	}
	var groupFile meta.Ino
	if st := m.Create(ctx, parent, "groupfile", 0644, 0, 0, &groupFile, &attr); st != 0 {
		t.Fatalf("create groupfile: %v", st)
	}
	if st := m.SetAttr(ctx, groupFile, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: uid, Gid: gid}); st != 0 {
		t.Fatalf("setattr groupfile: %v", st)
	}
	m.FlushSession()

	qs = map[string]*meta.Quota{}
	if err := m.HandleQuota(ctx, meta.QuotaGet, fmt.Sprintf("%d", uid), meta.UserQuotaType, qs, false, false, false); err != nil {
		t.Fatal(err)
	}
	if q := qs[fmt.Sprintf("%d", uid)]; q == nil || q.UsedInodes < 2 {
		t.Fatalf("user quota usage too small: %+v", q)
	}
	qs = map[string]*meta.Quota{}
	if err := m.HandleQuota(ctx, meta.QuotaGet, fmt.Sprintf("%d", gid), meta.GroupQuotaType, qs, false, false, false); err != nil {
		t.Fatal(err)
	}
	if q := qs[fmt.Sprintf("%d", gid)]; q == nil || q.UsedInodes < 2 {
		t.Fatalf("group quota usage too small: %+v", q)
	}

	qs = map[string]*meta.Quota{}
	if err := m.HandleQuota(ctx, meta.QuotaList, "", meta.AllQuotaType, qs, false, false, false); err != nil {
		t.Fatal(err)
	}
	if len(qs) < 4 {
		t.Fatalf("quota list after paths expected >=4, got %d", len(qs))
	}

	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			testUID := uint32(3000 + id)
			err := m.HandleQuota(ctx, meta.QuotaSet, fmt.Sprintf("%d", testUID), meta.UserQuotaType, map[string]*meta.Quota{
				fmt.Sprintf("%d", testUID): {MaxSpace: 1 << 20, MaxInodes: 5},
			}, false, false, false)
			if err != nil {
				t.Errorf("quota set uid %d: %v", testUID, err)
			}
		}(i)
	}
	wg.Wait()
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			testUID := uint32(3000 + id)
			qs := map[string]*meta.Quota{}
			err := m.HandleQuota(ctx, meta.QuotaGet, fmt.Sprintf("%d", testUID), meta.UserQuotaType, qs, false, false, false)
			if err != nil {
				t.Errorf("quota get uid %d: %v", testUID, err)
			}
		}(i)
	}
	wg.Wait()
}

func TestJuiceFSMetaTruncateDeleteAndCopyFileRange(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	m.OnMsg(meta.DeleteSlice, func(args ...interface{}) error { return nil })

	format := &meta.Format{Name: "truncate-copy", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode meta.Ino
	var attr meta.Attr
	if st := m.Truncate(ctx, meta.RootInode, 0, 4<<10, &attr, false); st != syscall.EPERM {
		t.Fatalf("truncate dir: %v", st)
	}
	if st := m.Create(ctx, meta.RootInode, "f", 0650, 022, 0, &inode, &attr); st != 0 {
		t.Fatalf("create file: %v", st)
	}
	var sliceID uint64
	if st := m.NewSlice(ctx, &sliceID); st != 0 {
		t.Fatalf("new slice: %v", st)
	}
	if st := m.Write(ctx, inode, 0, 100, meta.Slice{Id: sliceID, Size: 100, Off: 0, Len: 100}, time.Now()); st != 0 {
		t.Fatalf("write file: %v", st)
	}
	if st := m.Truncate(ctx, inode, 0, 200<<20, &attr, false); st != 0 {
		t.Fatalf("truncate file 200M: %v", st)
	}
	if st := m.Truncate(ctx, inode, 0, (300<<20)+10, &attr, false); st != 0 {
		t.Fatalf("truncate file 300M: %v", st)
	}
	slices := make(map[meta.Ino][]meta.Slice)
	m.ListSlices(ctx, slices, false, false, nil)
	totalSlices := 0
	for _, ss := range slices {
		totalSlices += len(ss)
	}
	if totalSlices != 1 {
		t.Fatalf("number of slices: %d != 1, %+v", totalSlices, slices)
	}
	if st := m.Close(ctx, inode); st != 0 {
		t.Fatalf("close file: %v", st)
	}
	if st := m.Unlink(ctx, meta.RootInode, "f", true); st != 0 {
		t.Fatalf("unlink file: %v", st)
	}

	var iin, iout meta.Ino
	if st := m.Create(ctx, meta.RootInode, "fin", 0650, 022, 0, &iin, &attr); st != 0 {
		t.Fatalf("create fin: %v", st)
	}
	if st := m.Create(ctx, meta.RootInode, "fout", 0650, 022, 0, &iout, &attr); st != 0 {
		t.Fatalf("create fout: %v", st)
	}
	var sliceIDs [4]uint64
	for i := range sliceIDs {
		if st := m.NewSlice(ctx, &sliceIDs[i]); st != 0 {
			t.Fatalf("new slice %d: %v", i, st)
		}
	}
	if st := m.Write(ctx, iin, 0, 100, meta.Slice{Id: sliceIDs[0], Size: 200, Off: 0, Len: 100}, time.Now()); st != 0 {
		t.Fatalf("write fin chunk0: %v", st)
	}
	if st := m.Write(ctx, iin, 1, 100<<10, meta.Slice{Id: sliceIDs[1], Size: 40 << 20, Off: 0, Len: 40 << 20}, time.Now()); st != 0 {
		t.Fatalf("write fin chunk1: %v", st)
	}
	if st := m.Write(ctx, iin, 3, 0, meta.Slice{Id: sliceIDs[2], Size: 63 << 20, Off: 10 << 20, Len: 30 << 20}, time.Now()); st != 0 {
		t.Fatalf("write fin chunk3: %v", st)
	}
	if st := m.Write(ctx, iout, 2, 10<<20, meta.Slice{Id: sliceIDs[3], Size: 50 << 20, Off: 10 << 20, Len: 30 << 20}, time.Now()); st != 0 {
		t.Fatalf("write fout chunk2: %v", st)
	}
	var copied uint64
	if st := m.CopyFileRange(ctx, iin, 150, iout, 30<<20, 200<<20, 0, &copied, nil); st != 0 {
		t.Fatalf("copy file range: %v", st)
	}
	if copied != 200<<20 {
		t.Fatalf("copied=%d want=%d", copied, uint64(200<<20))
	}
	for i := uint32(0); i < 4; i++ {
		var rs []meta.Slice
		if st := m.Read(ctx, iout, i, &rs); st != 0 {
			t.Fatalf("read fout chunk %d: %v", i, st)
		}
		if len(rs) == 0 {
			t.Fatalf("chunk %d should not be empty after copy", i)
		}
	}
}

func TestJuiceFSMetaUserGroupQuotaUsageStatistics(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	sessionOpen := false

	format := &meta.Format{Name: "ugquota-usage", UserGroupQuota: true, DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	sessionOpen = true
	defer func() {
		if sessionOpen {
			_ = m.CloseSession()
		}
	}()

	restartSession := func() {
		t.Helper()
		if err := m.CloseSession(); err != nil {
			t.Fatal(err)
		}
		sessionOpen = false
		if err := m.NewSession(true); err != nil {
			t.Fatal(err)
		}
		sessionOpen = true
	}

	ctx := meta.Background()
	uid, gid := uint32(1001), uint32(2001)
	var parent meta.Ino
	var attr meta.Attr
	if st := m.Mkdir(ctx, meta.RootInode, "ugquota_stats", 0755, 0, 0, &parent, &attr); st != 0 {
		t.Fatalf("mkdir ugquota_stats: %v", st)
	}

	for i := 0; i < 3; i++ {
		name := fmt.Sprintf("testfile%d", i)
		var ino meta.Ino
		if st := m.Create(ctx, parent, name, 0644, 0, 0, &ino, &attr); st != 0 {
			t.Fatalf("create %s: %v", name, st)
		}
		if st := m.SetAttr(ctx, ino, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: uid, Gid: gid}); st != 0 {
			t.Fatalf("setattr %s: %v", name, st)
		}
		if st := m.Close(ctx, ino); st != 0 {
			t.Fatalf("close %s: %v", name, st)
		}
	}
	for i := 0; i < 4; i++ {
		name := fmt.Sprintf("groupfile%d", i)
		var ino meta.Ino
		if st := m.Create(ctx, parent, name, 0644, 0, 0, &ino, &attr); st != 0 {
			t.Fatalf("create %s: %v", name, st)
		}
		if st := m.SetAttr(ctx, ino, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: uid, Gid: gid}); st != 0 {
			t.Fatalf("setattr %s: %v", name, st)
		}
		if st := m.Close(ctx, ino); st != 0 {
			t.Fatalf("close %s: %v", name, st)
		}
	}
	if st := m.SetAttr(ctx, parent, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: uid, Gid: gid}); st != 0 {
		t.Fatalf("setattr parent: %v", st)
	}

	if err := m.HandleQuota(ctx, meta.QuotaSet, fmt.Sprintf("%d", uid), meta.UserQuotaType, map[string]*meta.Quota{
		fmt.Sprintf("%d", uid): {MaxSpace: 1 << 30, MaxInodes: 20},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.HandleQuota(ctx, meta.QuotaSet, fmt.Sprintf("%d", gid), meta.GroupQuotaType, map[string]*meta.Quota{
		fmt.Sprintf("%d", gid): {MaxSpace: 2 << 30, MaxInodes: 20},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	restartSession()

	waitQuota := func(id string, qtype uint32, minInodes int64) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for {
			qs := map[string]*meta.Quota{}
			if err := m.HandleQuota(ctx, meta.QuotaGet, id, qtype, qs, false, false, false); err != nil {
				t.Fatal(err)
			}
			if q := qs[id]; q != nil && q.UsedInodes >= minInodes {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("quota %s type %d usedInodes < %d, got %+v", id, qtype, minInodes, qs[id])
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	waitQuota(fmt.Sprintf("%d", uid), meta.UserQuotaType, 8)
	waitQuota(fmt.Sprintf("%d", gid), meta.GroupQuotaType, 8)
}

func TestJuiceFSMetaCloneTree(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "clone-tree", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var cloneDir meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "cloneDir", 0777, 022, 0, &cloneDir, nil); st != 0 {
		t.Fatalf("mkdir cloneDir: %v", st)
	}
	var dir1, dir2, dir3 meta.Ino
	if st := m.Mkdir(ctx, cloneDir, "dir1", 0777, 022, 0, &dir1, nil); st != 0 {
		t.Fatalf("mkdir dir1: %v", st)
	}
	if st := m.Mkdir(ctx, dir1, "dir2", 0777, 022, 0, &dir2, nil); st != 0 {
		t.Fatalf("mkdir dir2: %v", st)
	}
	if st := m.Mkdir(ctx, dir2, "dir3", 0777, 022, 0, &dir3, nil); st != 0 {
		t.Fatalf("mkdir dir3: %v", st)
	}
	var file1, file2, file3 meta.Ino
	if st := m.Mknod(ctx, dir1, "file1", meta.TypeFile, 0777, 022, 0, "", &file1, nil); st != 0 {
		t.Fatalf("mknod file1: %v", st)
	}
	var slice1 uint64
	if st := m.NewSlice(ctx, &slice1); st != 0 {
		t.Fatalf("new slice1: %v", st)
	}
	if st := m.Write(ctx, file1, 0, 0, meta.Slice{Id: slice1, Size: 1 << 20, Off: 0, Len: 1 << 20}, time.Now()); st != 0 {
		t.Fatalf("write file1: %v", st)
	}
	if st := m.SetXattr(ctx, file1, "name", []byte("juicefs"), meta.XattrCreateOrReplace); st != 0 {
		t.Fatalf("setxattr file1: %v", st)
	}
	if st := m.SetXattr(ctx, dir1, "name", []byte("juicefs"), meta.XattrCreateOrReplace); st != 0 {
		t.Fatalf("setxattr dir1: %v", st)
	}
	if st := m.Mknod(ctx, dir2, "file2", meta.TypeFile, 0777, 022, 0, "", &file2, nil); st != 0 {
		t.Fatalf("mknod file2: %v", st)
	}
	var slice2 uint64
	if st := m.NewSlice(ctx, &slice2); st != 0 {
		t.Fatalf("new slice2: %v", st)
	}
	if st := m.Write(ctx, file2, 0, 0, meta.Slice{Id: slice2, Size: 67108863, Off: 0, Len: 67108863}, time.Now()); st != 0 {
		t.Fatalf("write file2: %v", st)
	}
	if st := m.Mknod(ctx, dir3, "file3", meta.TypeFile, 0777, 022, 0, "", &file3, nil); st != 0 {
		t.Fatalf("mknod file3: %v", st)
	}
	if st := m.Fallocate(ctx, file3, 0, 0, 67108864, nil); st != 0 {
		t.Fatalf("fallocate file3: %v", st)
	}
	var sym1 meta.Ino
	if st := m.Symlink(ctx, dir1, "file1Symlink", "file1", &sym1, nil); st != 0 {
		t.Fatalf("symlink file1Symlink: %v", st)
	}
	if st := m.Link(ctx, file2, dir2, "file2Hardlink", nil); st != 0 {
		t.Fatalf("link file2Hardlink: %v", st)
	}

	var count, total uint64
	if st := m.Clone(ctx, cloneDir, dir1, cloneDir, "cloneDir1", meta.CLONE_MODE_PRESERVE_ATTR, 022, 4, &count, &total); st != 0 {
		t.Fatalf("clone preserve: %v", st)
	}
	if count == 0 || total == 0 {
		t.Fatalf("clone counts should be non-zero: count=%d total=%d", count, total)
	}

	var clonedDir meta.Ino
	var clonedAttr meta.Attr
	if st := m.Lookup(ctx, cloneDir, "cloneDir1", &clonedDir, &clonedAttr, true); st != 0 {
		t.Fatalf("lookup cloneDir1: %v", st)
	}
	if clonedAttr.Mode != 0755 {
		t.Fatalf("cloneDir1 mode=%o want=0755", clonedAttr.Mode)
	}
	var d2 meta.Ino
	var d2Attr meta.Attr
	if st := m.Lookup(ctx, clonedDir, "dir2", &d2, &d2Attr, true); st != 0 {
		t.Fatalf("lookup cloneDir1/dir2: %v", st)
	}
	var clonedFile1 meta.Ino
	var clonedFile1Attr meta.Attr
	if st := m.Lookup(ctx, clonedDir, "file1", &clonedFile1, &clonedFile1Attr, true); st != 0 {
		t.Fatalf("lookup cloneDir1/file1: %v", st)
	}
	var val []byte
	if st := m.GetXattr(ctx, clonedFile1, "name", &val); st != 0 {
		t.Fatalf("getxattr cloned file1: %v", st)
	}
	if string(val) != "juicefs" {
		t.Fatalf("cloned file1 xattr=%q want=juicefs", val)
	}
	val = nil
	if st := m.GetXattr(ctx, clonedDir, "name", &val); st != 0 {
		t.Fatalf("getxattr cloned dir1: %v", st)
	}
	if string(val) != "juicefs" {
		t.Fatalf("cloned dir1 xattr=%q want=juicefs", val)
	}
	var clonedSym meta.Ino
	var clonedSymAttr meta.Attr
	if st := m.Lookup(ctx, clonedDir, "file1Symlink", &clonedSym, &clonedSymAttr, true); st != 0 {
		t.Fatalf("lookup cloned symlink: %v", st)
	}
	var target []byte
	if st := m.ReadLink(ctx, clonedSym, &target); st != 0 {
		t.Fatalf("readlink cloned symlink: %v", st)
	}
	if string(target) != "file1" {
		t.Fatalf("cloned symlink target=%q want=file1", target)
	}
	var clonedFile2 meta.Ino
	var clonedFile2Attr meta.Attr
	if st := m.Lookup(ctx, d2, "file2", &clonedFile2, &clonedFile2Attr, true); st != 0 {
		t.Fatalf("lookup cloneDir1/dir2/file2: %v", st)
	}
	var slices []meta.Slice
	if st := m.Read(ctx, clonedFile2, 0, &slices); st != 0 {
		t.Fatalf("read cloned file2: %v", st)
	}
	if len(slices) == 0 {
		t.Fatalf("cloned file2 has no slices")
	}
	if st := m.Clone(ctx, meta.RootInode, meta.TrashInode, cloneDir, "xxx", 0, 022, 4, &count, &total); !errors.Is(st, syscall.EPERM) {
		t.Fatalf("cloning trash should fail with EPERM, got %v", st)
	}
}

func TestJuiceFSMetaStickyBitAndAttrFlags(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "sticky-flags", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var sticky, normal, inode meta.Ino
	var attr meta.Attr
	if st := m.Mkdir(ctx, meta.RootInode, "tmp", 01777, 0, 0, &sticky, &attr); st != 0 {
		t.Fatalf("mkdir tmp: %v", st)
	}
	if st := m.Mkdir(ctx, meta.RootInode, "tmp2", 0777, 0, 0, &normal, &attr); st != 0 {
		t.Fatalf("mkdir tmp2: %v", st)
	}
	ctxA := meta.NewContext(1, 1, []uint32{1})
	ctxB := meta.NewContext(2, 2, []uint32{2})

	if st := m.Create(ctxA, sticky, "f", 0777, 0, 0, &inode, &attr); st != 0 {
		t.Fatalf("create tmp/f: %v", st)
	}
	if st := m.Create(ctxA, normal, "f", 0777, 0, 0, &inode, &attr); st != 0 {
		t.Fatalf("create tmp2/f: %v", st)
	}
	if st := m.Unlink(ctxB, sticky, "f"); st != syscall.EACCES {
		t.Fatalf("unlink sticky f = %v, want %v", st, syscall.EACCES)
	}
	if st := m.Rename(ctxB, sticky, "f", sticky, "f2", 0, &inode, &attr); st != syscall.EACCES {
		t.Fatalf("rename sticky f = %v, want %v", st, syscall.EACCES)
	}
	if st := m.Rename(ctxA, sticky, "f", sticky, "f3", 0, &inode, &attr); st != 0 {
		t.Fatalf("rename own sticky f: %v", st)
	}
	if st := m.Unlink(ctxA, sticky, "f3"); st != 0 {
		t.Fatalf("unlink own sticky f3: %v", st)
	}

	var d meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "flags", 0640, 022, 0, &d, &attr); st != 0 {
		t.Fatalf("mkdir flags: %v", st)
	}
	if st := m.Create(ctx, meta.RootInode, "flagfile", 0644, 022, 0, &inode, nil); st != 0 {
		t.Fatalf("create flagfile: %v", st)
	}
	attr.Flags = meta.FlagAppend
	if st := m.SetAttr(ctx, inode, meta.SetAttrFlag, 0, &attr); st != 0 {
		t.Fatalf("set append flag: %v", st)
	}
	if st := m.Open(ctx, inode, syscall.O_WRONLY, &attr); st != syscall.EPERM {
		t.Fatalf("open append-only without append = %v, want %v", st, syscall.EPERM)
	}
	if st := m.Open(ctx, inode, syscall.O_WRONLY|syscall.O_APPEND, &attr); st != 0 {
		t.Fatalf("open append-only with append: %v", st)
	}
	attr.Flags = meta.FlagAppend | meta.FlagImmutable
	if st := m.SetAttr(ctx, inode, meta.SetAttrFlag, 0, &attr); st != 0 {
		t.Fatalf("set append+immutable flag: %v", st)
	}
	if st := m.Open(ctx, inode, syscall.O_WRONLY|syscall.O_APPEND, &attr); st != syscall.EPERM {
		t.Fatalf("open immutable append-only = %v, want %v", st, syscall.EPERM)
	}

	attr.Flags = meta.FlagAppend
	if st := m.SetAttr(ctx, d, meta.SetAttrFlag, 0, &attr); st != 0 {
		t.Fatalf("set dir append flag: %v", st)
	}
	if st := m.Create(ctx, d, "f", 0644, 022, 0, &inode, nil); st != 0 {
		t.Fatalf("create flags/f: %v", st)
	}
	if st := m.Unlink(ctx, d, "f"); st != syscall.EPERM {
		t.Fatalf("unlink append-only dir child = %v, want %v", st, syscall.EPERM)
	}
	attr.Flags = meta.FlagAppend | meta.FlagImmutable
	if st := m.SetAttr(ctx, d, meta.SetAttrFlag, 0, &attr); st != 0 {
		t.Fatalf("set dir append+immutable flag: %v", st)
	}
	if st := m.Create(ctx, d, "f2", 0644, 022, 0, &inode, nil); st != syscall.EPERM {
		t.Fatalf("create in immutable dir = %v, want %v", st, syscall.EPERM)
	}
}

func TestJuiceFSMetaBatchLikeUnlinkWithUserGroupQuota(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	sessionOpen := false

	format := &meta.Format{Name: "batchlike-unlink-quota", UserGroupQuota: true, TrashDays: 1}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	sessionOpen = true
	defer func() {
		if sessionOpen {
			_ = m.CloseSession()
		}
	}()

	restartSession := func() {
		t.Helper()
		if err := m.CloseSession(); err != nil {
			t.Fatal(err)
		}
		sessionOpen = false
		if err := m.NewSession(true); err != nil {
			t.Fatal(err)
		}
		sessionOpen = true
	}
	waitQuota := func(id string, qtype uint32) *meta.Quota {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for {
			qs := map[string]*meta.Quota{}
			if err := m.HandleQuota(meta.Background(), meta.QuotaGet, id, qtype, qs, false, false, false); err != nil {
				t.Fatal(err)
			}
			if q := qs[id]; q != nil {
				return q
			}
			if time.Now().After(deadline) {
				t.Fatalf("quota %s type %d not ready", id, qtype)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}

	ctx := meta.Background()
	var parent meta.Ino
	var attr meta.Attr
	uid, gid := uint32(1001), uint32(2001)
	if st := m.Mkdir(ctx, meta.RootInode, "ugquota_batch", 0755, 0, 0, &parent, &attr); st != 0 {
		t.Fatalf("mkdir ugquota_batch: %v", st)
	}
	if err := m.HandleQuota(ctx, meta.QuotaSet, fmt.Sprintf("%d", uid), meta.UserQuotaType, map[string]*meta.Quota{
		fmt.Sprintf("%d", uid): {MaxSpace: 100 << 20, MaxInodes: 100},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	if err := m.HandleQuota(ctx, meta.QuotaSet, fmt.Sprintf("%d", gid), meta.GroupQuotaType, map[string]*meta.Quota{
		fmt.Sprintf("%d", gid): {MaxSpace: 100 << 20, MaxInodes: 100},
	}, false, false, false); err != nil {
		t.Fatal(err)
	}
	restartSession()

	fileNames := []string{"batch_file1", "batch_file2", "batch_file3"}
	for _, name := range fileNames {
		var ino meta.Ino
		if st := m.Create(ctx, parent, name, 0644, 0, 0, &ino, &attr); st != 0 {
			t.Fatalf("create %s: %v", name, st)
		}
		if st := m.SetAttr(ctx, ino, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: uid, Gid: gid}); st != 0 {
			t.Fatalf("setattr %s: %v", name, st)
		}
		var sliceID uint64
		if st := m.NewSlice(ctx, &sliceID); st != 0 {
			t.Fatalf("new slice %s: %v", name, st)
		}
		if st := m.Write(ctx, ino, 0, 0, meta.Slice{Id: sliceID, Size: 4096, Len: 4096}, time.Now()); st != 0 {
			t.Fatalf("write %s: %v", name, st)
		}
		if st := m.Close(ctx, ino); st != 0 {
			t.Fatalf("close %s: %v", name, st)
		}
	}
	m.FlushSession()
	before := waitQuota(fmt.Sprintf("%d", uid), meta.UserQuotaType)
	for _, name := range fileNames {
		if st := m.Unlink(ctx, parent, name); st != 0 {
			t.Fatalf("unlink %s: %v", name, st)
		}
	}
	m.FlushSession()
	after := waitQuota(fmt.Sprintf("%d", uid), meta.UserQuotaType)
	if before.UsedSpace-after.UsedSpace != 0 || before.UsedInodes-after.UsedInodes != 0 {
		t.Fatalf("quota should not decrease when files move to trash: before=%+v after=%+v", before, after)
	}

	var original meta.Ino
	if st := m.Create(ctx, parent, "hardlink_original", 0644, 0, 0, &original, &attr); st != 0 {
		t.Fatalf("create hardlink_original: %v", st)
	}
	if st := m.SetAttr(ctx, original, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: uid, Gid: gid}); st != 0 {
		t.Fatalf("setattr hardlink_original: %v", st)
	}
	var hs uint64
	if st := m.NewSlice(ctx, &hs); st != 0 {
		t.Fatalf("new slice hardlink_original: %v", st)
	}
	if st := m.Write(ctx, original, 0, 0, meta.Slice{Id: hs, Size: 8192, Len: 8192}, time.Now()); st != 0 {
		t.Fatalf("write hardlink_original: %v", st)
	}
	if st := m.Link(ctx, original, parent, "hardlink_link", &attr); st != 0 {
		t.Fatalf("link hardlink_link: %v", st)
	}
	m.FlushSession()
	beforeHardlink := waitQuota(fmt.Sprintf("%d", uid), meta.UserQuotaType)
	if st := m.Unlink(ctx, parent, "hardlink_link"); st != 0 {
		t.Fatalf("unlink hardlink_link: %v", st)
	}
	m.FlushSession()
	afterHardlink := waitQuota(fmt.Sprintf("%d", uid), meta.UserQuotaType)
	if beforeHardlink.UsedSpace-afterHardlink.UsedSpace != 0 || beforeHardlink.UsedInodes-afterHardlink.UsedInodes != 0 {
		t.Fatalf("quota should not decrease on hardlink unlink: before=%+v after=%+v", beforeHardlink, afterHardlink)
	}
	var check meta.Attr
	if st := m.GetAttr(ctx, original, &check); st != 0 || check.Nlink < 1 {
		t.Fatalf("original file should still exist after hardlink unlink: attr=%+v st=%v", check, st)
	}
}

func TestJuiceFSMetaCleanupDetachedNodes(t *testing.T) {
	_, addr := startTestServer(t)
	c := newRedisClient(addr)
	defer c.Close()
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "detached-cleanup", DirStats: true, TrashDays: 0}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var dir meta.Ino
	var dirAttr meta.Attr
	if st := m.Mkdir(ctx, meta.RootInode, "orphan", 0755, 0, 0, &dir, &dirAttr); st != 0 {
		t.Fatalf("mkdir orphan: %v", st)
	}
	var file meta.Ino
	var fileAttr meta.Attr
	if st := m.Create(ctx, dir, "child", 0644, 0, 0, &file, &fileAttr); st != 0 {
		t.Fatalf("create child: %v", st)
	}
	if st := m.Close(ctx, file); st != 0 {
		t.Fatalf("close child: %v", st)
	}

	if err := c.HDel(ctx, "d1", "orphan").Err(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ZAdd(ctx, "detachedNodes", redis.Z{Score: float64(time.Now().Add(-time.Hour).Unix()), Member: dir.String()}).Result(); err != nil {
		t.Fatal(err)
	}

	var cleaned int
	m.CleanupDetachedNodesBefore(ctx, time.Now(), func() { cleaned++ })
	if cleaned != 1 {
		t.Fatalf("expected one detached tree cleanup, got %d", cleaned)
	}
	if n, err := c.Exists(ctx, fmt.Sprintf("i%d", dir), fmt.Sprintf("i%d", file)).Result(); err != nil || n != 0 {
		t.Fatalf("expected detached dir and child inode keys removed, exists=%d err=%v", n, err)
	}
	if vals, err := c.ZRange(ctx, "detachedNodes", 0, -1).Result(); err != nil || len(vals) != 0 {
		t.Fatalf("expected detachedNodes to be drained, got %#v, %v", vals, err)
	}
}

func TestJuiceFSMetaListLocksDetailed(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	if err := m.Init(&meta.Format{Name: "list-locks"}, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode meta.Ino
	if st := m.Create(ctx, meta.RootInode, "locks-file", 0644, 0, 0, &inode, nil); st != 0 {
		t.Fatalf("create locks-file: %v", st)
	}
	defer m.Unlink(ctx, meta.RootInode, "locks-file")

	plocks, flocks, err := m.ListLocks(ctx, inode)
	if err != nil || len(plocks) != 0 || len(flocks) != 0 {
		t.Fatalf("initial list locks: plocks=%v flocks=%v err=%v", plocks, flocks, err)
	}

	o1 := uint64(0xF000000000000001)
	if st := m.Flock(ctx, inode, o1, syscall.F_WRLCK, false); st != 0 {
		t.Fatalf("flock wlock: %v", st)
	}
	plocks, flocks, err = m.ListLocks(ctx, inode)
	if err != nil || len(plocks) != 0 || len(flocks) != 1 {
		t.Fatalf("after wlock list locks: plocks=%v flocks=%v err=%v", plocks, flocks, err)
	}
	if st := m.Flock(ctx, inode, o1, syscall.F_UNLCK, false); st != 0 {
		t.Fatalf("flock unlock: %v", st)
	}
	for i := 2; i < 10; i++ {
		if st := m.Flock(ctx, inode, uint64(i), syscall.F_RDLCK, false); st != 0 {
			t.Fatalf("flock shared lock %d: %v", i, st)
		}
	}
	plocks, flocks, err = m.ListLocks(ctx, inode)
	if err != nil || len(plocks) != 0 || len(flocks) != 8 {
		t.Fatalf("after shared flocks: plocks=%v flocks=%v err=%v", plocks, flocks, err)
	}
	for i := 2; i < 10; i++ {
		if st := m.Flock(ctx, inode, uint64(i), syscall.F_UNLCK, false); st != 0 {
			t.Fatalf("flock shared unlock %d: %v", i, st)
		}
	}

	if st := m.Setlk(ctx, inode, o1, false, syscall.F_WRLCK, 0, 0xFFFF, 1); st != 0 {
		t.Fatalf("setlk wlock: %v", st)
	}
	plocks, flocks, err = m.ListLocks(ctx, inode)
	if err != nil || len(plocks) != 1 || len(flocks) != 0 {
		t.Fatalf("after one plock: plocks=%v flocks=%v err=%v", plocks, flocks, err)
	}
	if st := m.Setlk(ctx, inode, o1, false, syscall.F_UNLCK, 0, 0xFFFF, 1); st != 0 {
		t.Fatalf("setlk unlock: %v", st)
	}
	for i := 2; i < 10; i++ {
		if st := m.Setlk(ctx, inode, uint64(i), false, syscall.F_RDLCK, 0, 0xFFFF, 1); st != 0 {
			t.Fatalf("setlk shared lock %d: %v", i, st)
		}
	}
	plocks, flocks, err = m.ListLocks(ctx, inode)
	if err != nil || len(plocks) != 8 || len(flocks) != 0 {
		t.Fatalf("after shared plocks: plocks=%v flocks=%v err=%v", plocks, flocks, err)
	}
	for i := 2; i < 10; i++ {
		if st := m.Setlk(ctx, inode, uint64(i), false, syscall.F_UNLCK, 0, 0xFFFF, 1); st != 0 {
			t.Fatalf("setlk shared unlock %d: %v", i, st)
		}
	}
	plocks, flocks, err = m.ListLocks(ctx, inode)
	if err != nil || len(plocks) != 0 || len(flocks) != 0 {
		t.Fatalf("final list locks: plocks=%v flocks=%v err=%v", plocks, flocks, err)
	}
}

func TestJuiceFSMetaRemoveAndPaths(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	if err := m.Init(&meta.Format{Name: "remove-paths"}, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode, parent meta.Ino
	attr := &meta.Attr{}
	if st := m.Create(ctx, meta.RootInode, "f", 0644, 0, 0, &inode, attr); st != 0 {
		t.Fatalf("create f: %v", st)
	}
	if st := m.Remove(ctx, meta.RootInode, "f", false, meta.RmrDefaultThreads, nil); st != 0 {
		t.Fatalf("remove f: %v", st)
	}
	if st := m.Mkdir(ctx, meta.RootInode, "d", 0755, 0, 0, &parent, attr); st != 0 {
		t.Fatalf("mkdir d: %v", st)
	}
	if st := m.Mkdir(ctx, parent, "d2", 0755, 0, 0, &inode, attr); st != 0 {
		t.Fatalf("mkdir d/d2: %v", st)
	}
	if st := m.Create(ctx, parent, "f", 0644, 0, 0, &inode, attr); st != 0 {
		t.Fatalf("create d/f: %v", st)
	}
	if paths := m.GetPaths(ctx, parent); len(paths) == 0 || paths[0] != "/d" {
		t.Fatalf("getpaths /d = %v", paths)
	}
	if paths := m.GetPaths(ctx, inode); len(paths) == 0 || paths[0] != "/d/f" {
		t.Fatalf("getpaths /d/f = %v", paths)
	}
	for i := 0; i < 1024; i++ {
		name := fmt.Sprintf("f%d", i)
		if st := m.Create(ctx, meta.RootInode, name, 0644, 0, 0, &inode, attr); st != 0 {
			t.Fatalf("create %s: %v", name, st)
		}
	}
	var entries []*meta.Entry
	if st := m.Readdir(ctx, meta.RootInode, 1, &entries); st != 0 {
		t.Fatalf("readdir root: %v", st)
	}
	if len(entries) != 1027 {
		t.Fatalf("root entry count=%d want=1027", len(entries))
	}
	if st := m.Remove(ctx, meta.RootInode, "d", false, meta.RmrDefaultThreads, nil); st != 0 {
		t.Fatalf("remove d: %v", st)
	}
	var removedAttr meta.Attr
	if st := m.GetAttr(ctx, parent, &removedAttr); st != syscall.ENOENT {
		t.Fatalf("removed dir should disappear, got %v attr=%+v", st, removedAttr)
	}
}

func TestJuiceFSMetaTrashSemantics(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "trash-semantics", TrashDays: 1}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	trashCount := func() int {
		t.Helper()
		var entries []*meta.Entry
		if st := m.Readdir(ctx, meta.TrashInode+1, 0, &entries); st != 0 {
			if st == syscall.ENOENT {
				return 0
			}
			t.Fatalf("readdir trash: %v", st)
		}
		return len(entries)
	}

	initialTrash := trashCount()
	var inode, parent meta.Ino
	attr := &meta.Attr{}
	if st := m.Create(ctx, meta.RootInode, "f1", 0644, 022, 0, &inode, attr); st != 0 {
		t.Fatalf("create f1: %v", st)
	}
	if st := m.Mkdir(ctx, meta.RootInode, "d", 0755, 022, 0, &parent, attr); st != 0 {
		t.Fatalf("mkdir d: %v", st)
	}
	if st := m.Create(ctx, parent, "f", 0644, 022, 0, &inode, attr); st != 0 {
		t.Fatalf("create d/f: %v", st)
	}
	if st := m.Unlink(ctx, parent, "f"); st != 0 {
		t.Fatalf("unlink d/f: %v", st)
	}
	if st := m.GetAttr(ctx, inode, attr); st != 0 || attr.Parent != meta.TrashInode+1 {
		t.Fatalf("trashed file attr: st=%v attr=%+v", st, attr)
	}
	if st := m.Truncate(ctx, inode, 0, 1<<20, attr, false); st != syscall.EPERM {
		t.Fatalf("truncate trashed file = %v, want %v", st, syscall.EPERM)
	}
	if st := m.Open(ctx, inode, syscall.O_RDWR, attr); st != syscall.EPERM {
		t.Fatalf("open trashed file = %v, want %v", st, syscall.EPERM)
	}
	if st := m.SetAttr(ctx, inode, meta.SetAttrMode, 0, &meta.Attr{Mode: 0}); st != syscall.EPERM {
		t.Fatalf("setattr trashed file = %v, want %v", st, syscall.EPERM)
	}

	var trashDir meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "d2", 0755, 022, 0, &trashDir, attr); st != 0 {
		t.Fatalf("mkdir d2: %v", st)
	}
	if st := m.Rmdir(ctx, meta.RootInode, "d2"); st != 0 {
		t.Fatalf("rmdir d2: %v", st)
	}
	if st := m.GetAttr(ctx, trashDir, attr); st != 0 || attr.Parent != meta.TrashInode+1 {
		t.Fatalf("trashed dir attr: st=%v attr=%+v", st, attr)
	}
	var child meta.Ino
	if st := m.Mkdir(ctx, trashDir, "x", 0755, 022, 0, &child, attr); st != syscall.ENOENT {
		t.Fatalf("mkdir inside trash = %v, want %v", st, syscall.ENOENT)
	}
	if st := m.Create(ctx, trashDir, "x", 0644, 022, 0, &child, attr); st != syscall.ENOENT {
		t.Fatalf("create inside trash = %v, want %v", st, syscall.ENOENT)
	}
	if st := m.Rename(ctx, meta.RootInode, "f1", meta.TrashInode, "bad", 0, &inode, attr); st != syscall.EPERM {
		t.Fatalf("rename into TrashInode = %v, want %v", st, syscall.EPERM)
	}
	if st := m.Rename(ctx, meta.RootInode, "f1", meta.TrashInode+1, "bad", 0, &inode, attr); st != syscall.EPERM {
		t.Fatalf("rename into trash subdir = %v, want %v", st, syscall.EPERM)
	}

	var tree meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "tree", 0755, 022, 0, &tree, attr); st != 0 {
		t.Fatalf("mkdir tree: %v", st)
	}
	var treeFile meta.Ino
	if st := m.Create(ctx, tree, "leaf", 0644, 022, 0, &treeFile, attr); st != 0 {
		t.Fatalf("create tree/leaf: %v", st)
	}
	if st := m.Remove(ctx, meta.RootInode, "tree", false, meta.RmrDefaultThreads, nil); st != 0 {
		t.Fatalf("remove tree via trash: %v", st)
	}
	if st := m.GetAttr(ctx, tree, attr); st != 0 || attr.Parent != meta.TrashInode+1 {
		t.Fatalf("tree should move to trash: st=%v attr=%+v", st, attr)
	}

	var tree2 meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "tree2", 0755, 022, 0, &tree2, attr); st != 0 {
		t.Fatalf("mkdir tree2: %v", st)
	}
	if st := m.Create(ctx, tree2, "leaf", 0644, 022, 0, &treeFile, attr); st != 0 {
		t.Fatalf("create tree2/leaf: %v", st)
	}
	if st := m.Remove(ctx, meta.RootInode, "tree2", true, meta.RmrDefaultThreads, nil); st != 0 {
		t.Fatalf("remove tree2 skip trash: %v", st)
	}
	if st := m.GetAttr(ctx, tree2, attr); st != syscall.ENOENT {
		t.Fatalf("tree2 should be removed directly, got %v attr=%+v", st, attr)
	}

	var skipTrashDir meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "secrmd", 0755, 022, 0, &skipTrashDir, attr); st != 0 {
		t.Fatalf("mkdir secrmd: %v", st)
	}
	if st := m.SetAttr(ctx, skipTrashDir, meta.SetAttrFlag, 0, &meta.Attr{Flags: meta.FlagSkipTrash}); st != 0 {
		t.Fatalf("set skip trash flag: %v", st)
	}
	var skipFile meta.Ino
	if st := m.Create(ctx, skipTrashDir, "f", 0644, 022, 0, &skipFile, attr); st != 0 {
		t.Fatalf("create secrmd/f: %v", st)
	}
	if st := m.GetAttr(ctx, skipFile, attr); st != 0 || (attr.Flags&meta.FlagSkipTrash) == 0 {
		t.Fatalf("skip-trash attr inheritance: st=%v attr=%+v", st, attr)
	}
	if st := m.Close(ctx, skipFile); st != 0 {
		t.Fatalf("close secrmd/f: %v", st)
	}
	beforeSkipDelete := trashCount()
	if st := m.Unlink(ctx, skipTrashDir, "f"); st != 0 {
		t.Fatalf("unlink secrmd/f: %v", st)
	}
	if st := m.GetAttr(ctx, skipFile, attr); st != syscall.ENOENT {
		t.Fatalf("skip-trash file should be removed directly, got %v attr=%+v", st, attr)
	}
	afterSkipDelete := trashCount()
	if beforeSkipDelete != afterSkipDelete {
		t.Fatalf("skip-trash delete should not grow trash: before=%d after=%d", beforeSkipDelete, afterSkipDelete)
	}
	if initialTrash >= trashCount() {
		t.Fatalf("trash should contain more entries after moves: initial=%d now=%d", initialTrash, trashCount())
	}
}

func TestJuiceFSMetaParentsExtended(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	if err := m.Init(&meta.Format{Name: "parents-extended"}, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode, parent meta.Ino
	attr := &meta.Attr{}
	if st := m.Create(ctx, meta.RootInode, "f", 0644, 022, 0, &inode, attr); st != 0 {
		t.Fatalf("create f: %v", st)
	}
	checkParents := func(ino meta.Ino, expect map[meta.Ino]int) {
		t.Helper()
		if got := m.GetParents(ctx, ino); got == nil {
			t.Fatalf("get parents of inode %d returns nil", ino)
		} else if !reflect.DeepEqual(got, expect) {
			t.Fatalf("parents of %d = %v want %v", ino, got, expect)
		}
	}
	checkParents(inode, map[meta.Ino]int{meta.RootInode: 1})
	if st := m.Link(ctx, inode, meta.RootInode, "l1", attr); st != 0 {
		t.Fatalf("link l1: %v", st)
	}
	checkParents(inode, map[meta.Ino]int{meta.RootInode: 2})
	if st := m.Mkdir(ctx, meta.RootInode, "d", 0755, 022, 0, &parent, attr); st != 0 {
		t.Fatalf("mkdir d: %v", st)
	}
	if st := m.Link(ctx, inode, parent, "l2", attr); st != 0 {
		t.Fatalf("link l2: %v", st)
	}
	if st := m.Link(ctx, inode, parent, "l3", attr); st != 0 {
		t.Fatalf("link l3: %v", st)
	}
	checkParents(inode, map[meta.Ino]int{meta.RootInode: 2, parent: 2})
	if st := m.Unlink(ctx, meta.RootInode, "f"); st != 0 {
		t.Fatalf("unlink f: %v", st)
	}
	var inode2 meta.Ino
	if st := m.Create(ctx, meta.RootInode, "f2", 0644, 022, 0, &inode2, attr); st != 0 {
		t.Fatalf("create f2: %v", st)
	}
	if st := m.Rename(ctx, meta.RootInode, "f2", meta.RootInode, "l1", 0, &inode2, attr); st != 0 {
		t.Fatalf("rename f2 -> l1: %v", st)
	}
	if st := m.Lookup(ctx, parent, "l2", &inode, attr, true); st != 0 {
		t.Fatalf("lookup d/l2: %v", st)
	}
	if st := m.Unlink(ctx, parent, "l2"); st != 0 {
		t.Fatalf("unlink d/l2: %v", st)
	}
	checkParents(inode, map[meta.Ino]int{parent: 1})
}

func TestJuiceFSMetaOpenCache(t *testing.T) {
	_, addr := startTestServer(t)
	conf := meta.DefaultConf()
	conf.OpenCache = time.Minute
	m := meta.NewClient("redis://"+addr, conf)
	defer m.Shutdown()

	if err := m.Init(&meta.Format{Name: "open-cache"}, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode meta.Ino
	attr := &meta.Attr{}
	if st := m.Create(ctx, meta.RootInode, "f", 0644, 022, 0, &inode, attr); st != 0 {
		t.Fatalf("create f: %v", st)
	}
	defer m.Unlink(ctx, meta.RootInode, "f")
	if st := m.Open(ctx, inode, syscall.O_RDWR, attr); st != 0 {
		t.Fatalf("open f: %v", st)
	}
	defer m.Close(ctx, inode)

	attr2 := &meta.Attr{}
	if st := m.GetAttr(ctx, inode, attr2); st != 0 {
		t.Fatalf("getattr f: %v", st)
	}
	if *attr != *attr2 {
		t.Fatalf("attrs not equal: attr=%+v attr2=%+v", *attr, *attr2)
	}
	attr2.Uid = 1
	if st := m.SetAttr(ctx, inode, meta.SetAttrUID, 0, attr2); st != 0 {
		t.Fatalf("setattr uid: %v", st)
	}
	if st := m.GetAttr(ctx, inode, attr); st != 0 {
		t.Fatalf("getattr after setattr: %v", st)
	}
	if attr.Uid != 1 {
		t.Fatalf("uid after setattr=%d want=1", attr.Uid)
	}
}

func TestJuiceFSMetaMetaClientBasics(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()
	m.OnMsg(meta.DeleteSlice, func(args ...interface{}) error { return nil })

	ctx := meta.Background()
	attr := &meta.Attr{}
	if st := m.GetAttr(ctx, meta.RootInode, attr); st != 0 || attr.Mode != 0777 {
		t.Fatalf("getattr root: st=%v attr=%+v", st, attr)
	}
	if err := m.Init(&meta.Format{Name: "meta-client"}, true); err != nil {
		t.Fatal(err)
	}
	if err := m.Init(&meta.Format{Name: "meta-client-2"}, false); err == nil {
		t.Fatal("init with different name without force should fail")
	}
	format, err := m.Load(true)
	if err != nil {
		t.Fatal(err)
	}
	if format.Name != "meta-client" {
		t.Fatalf("format name=%q want=meta-client", format.Name)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()
	sessions, err := m.ListSessions()
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 {
		t.Fatalf("session count=%d want=1", len(sessions))
	}

	var parent, inode meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "d", 0640, 022, 0, &parent, attr); st != 0 {
		t.Fatalf("mkdir d: %v", st)
	}
	if st := m.Unlink(ctx, meta.RootInode, "d"); st != syscall.EPERM {
		t.Fatalf("unlink dir as file = %v, want %v", st, syscall.EPERM)
	}
	if st := m.Rmdir(ctx, parent, "."); st != syscall.EINVAL {
		t.Fatalf("rmdir . = %v, want %v", st, syscall.EINVAL)
	}
	if st := m.Rmdir(ctx, parent, ".."); st != syscall.ENOTEMPTY {
		t.Fatalf("rmdir .. = %v, want %v", st, syscall.ENOTEMPTY)
	}
	if st := m.Lookup(ctx, meta.RootInode, "d", &parent, attr, true); st != 0 {
		t.Fatalf("lookup d: %v", st)
	}
	if st := m.Lookup(ctx, meta.RootInode, "d", &parent, nil, true); st != syscall.EINVAL {
		t.Fatalf("lookup d with nil attr = %v, want %v", st, syscall.EINVAL)
	}
	if st := m.Lookup(ctx, meta.RootInode, "..", &inode, attr, true); st != 0 || inode != meta.RootInode {
		t.Fatalf("lookup root/.. = %v inode=%d", st, inode)
	}
	if st := m.Lookup(ctx, parent, ".", &inode, attr, true); st != 0 || inode != parent {
		t.Fatalf("lookup d/. = %v inode=%d want=%d", st, inode, parent)
	}
	if st := m.Lookup(ctx, parent, "..", &inode, attr, true); st != 0 || inode != meta.RootInode {
		t.Fatalf("lookup d/.. = %v inode=%d", st, inode)
	}
	if st := m.Access(ctx, parent, meta.MODE_MASK_R, attr); st != 0 {
		t.Fatalf("access d read: %v", st)
	}
	if st := m.Create(ctx, parent, "f", 0650, 022, 0, &inode, attr); st != 0 {
		t.Fatalf("create d/f: %v", st)
	}
	if st := m.Close(ctx, inode); st != 0 {
		t.Fatalf("close d/f: %v", st)
	}
	var tino meta.Ino
	if st := m.Lookup(ctx, inode, ".", &tino, attr, true); st != 0 {
		t.Fatalf("lookup /d/f/. = %v", st)
	}
	if st := m.Lookup(ctx, inode, "..", &tino, attr, true); st != syscall.ENOTDIR {
		t.Fatalf("lookup /d/f/.. = %v, want %v", st, syscall.ENOTDIR)
	}
	if st := m.Rmdir(ctx, parent, "f"); st != syscall.ENOTDIR {
		t.Fatalf("rmdir file = %v, want %v", st, syscall.ENOTDIR)
	}
	if st := m.Resolve(ctx, meta.RootInode, "d/f", &inode, attr, false); st != 0 && st != syscall.ENOTSUP {
		t.Fatalf("resolve d/f = %v", st)
	}
}

func TestJuiceFSMetaReadOnlyClient(t *testing.T) {
	_, addr := startTestServer(t)
	rw := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer rw.Shutdown()

	if err := rw.Init(&meta.Format{Name: "readonly"}, true); err != nil {
		t.Fatal(err)
	}

	conf := meta.DefaultConf()
	conf.ReadOnly = true
	ro := meta.NewClient("redis://"+addr, conf)
	defer ro.Shutdown()

	ctx := meta.Background()
	if _, err := ro.Load(false); err != nil {
		t.Fatalf("readonly load format: %v", err)
	}
	if err := ro.NewSession(true); err != nil {
		t.Fatalf("readonly new session: %v", err)
	}
	defer ro.CloseSession()

	var inode meta.Ino
	attr := &meta.Attr{}
	if st := ro.GetAttr(ctx, meta.RootInode, attr); st != 0 {
		t.Fatalf("readonly getattr root: %v", st)
	}
	if st := ro.Mkdir(ctx, meta.RootInode, "d", 0640, 022, 0, &inode, attr); st != syscall.EROFS {
		t.Fatalf("readonly mkdir = %v, want %v", st, syscall.EROFS)
	}
	if st := ro.Create(ctx, meta.RootInode, "f", 0644, 022, 0, &inode, attr); st != syscall.EROFS {
		t.Fatalf("readonly create = %v, want %v", st, syscall.EROFS)
	}
	if st := ro.Open(ctx, inode, syscall.O_RDWR, attr); st != syscall.EROFS {
		t.Fatalf("readonly open = %v, want %v", st, syscall.EROFS)
	}
	if plocks, flocks, err := ro.ListLocks(ctx, meta.RootInode); err != nil || len(plocks) != 0 || len(flocks) != 0 {
		t.Fatalf("readonly list locks: plocks=%v flocks=%v err=%v", plocks, flocks, err)
	}
}

func TestJuiceFSMetaConcurrentDir(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "concurrent-dir", Capacity: 0, Inodes: 0}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	runStage := func(n int, fn func(int) error) {
		t.Helper()
		errCh := make(chan error, n)
		var wg sync.WaitGroup
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				if err := fn(i); err != nil {
					errCh <- err
				}
			}(i)
		}
		wg.Wait()
		close(errCh)
		for err := range errCh {
			t.Fatal(err)
		}
	}

	runStage(100, func(i int) error {
		var d1, d2 meta.Ino
		var attr meta.Attr
		if st := m.Mkdir(ctx, meta.RootInode, "d1", 0640, 022, 0, &d1, &attr); st != 0 && st != syscall.EEXIST {
			return fmt.Errorf("mkdir d1: %w", st)
		} else if st == syscall.EEXIST {
			if st = m.Lookup(ctx, meta.RootInode, "d1", &d1, &attr, true); st != 0 {
				return fmt.Errorf("lookup d1: %w", st)
			}
		}
		if st := m.Mkdir(ctx, meta.RootInode, "d2", 0640, 022, 0, &d2, &attr); st != 0 && st != syscall.EEXIST {
			return fmt.Errorf("mkdir d2: %w", st)
		} else if st == syscall.EEXIST {
			if st = m.Lookup(ctx, meta.RootInode, "d2", &d2, &attr, true); st != 0 {
				return fmt.Errorf("lookup d2: %w", st)
			}
		}
		name := fmt.Sprintf("file%d", i)
		var ino meta.Ino
		if st := m.Create(ctx, d1, name, 0664, 0, 0, &ino, &attr); st != 0 {
			return fmt.Errorf("create d1/%s: %w", name, st)
		}
		if st := m.Rename(ctx, d1, name, d2, name, 0, &ino, &attr); st != 0 {
			return fmt.Errorf("rename d1/%s -> d2/%s: %w", name, name, st)
		}
		return nil
	})

	runStage(100, func(i int) error {
		var d2 meta.Ino
		var attr meta.Attr
		if st := m.Lookup(ctx, meta.RootInode, "d2", &d2, &attr, true); st != 0 {
			return fmt.Errorf("lookup d2: %w", st)
		}
		name := fmt.Sprintf("file%d", i)
		if st := m.Unlink(ctx, d2, name); st != 0 {
			return fmt.Errorf("unlink d2/%s: %w", name, st)
		}
		if st := m.Rmdir(ctx, meta.RootInode, "d1"); st != 0 && st != syscall.ENOTEMPTY && st != syscall.ENOENT {
			return fmt.Errorf("rmdir d1: %w", st)
		}
		if st := m.Rmdir(ctx, meta.RootInode, "d2"); st != 0 && st != syscall.ENOTEMPTY && st != syscall.ENOENT {
			return fmt.Errorf("rmdir d2: %w", st)
		}
		return nil
	})
}

func TestJuiceFSMetaAccessACLResolution(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "acl-access", EnableACL: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode meta.Ino
	if st := m.Create(ctx, meta.RootInode, "aclfile", 0541, 0, 0, &inode, nil); st != 0 {
		t.Fatalf("create aclfile: %v", st)
	}
	rule := &aclAPI.Rule{
		Owner: 5,
		Group: 4,
		Mask:  2,
		Other: 1,
		NamedUsers: aclAPI.Entries{
			{Id: 1, Perm: 6},
		},
		NamedGroups: aclAPI.Entries{
			{Id: 2, Perm: 6},
		},
	}
	if st := m.SetFacl(ctx, inode, aclAPI.TypeAccess, rule); st != 0 {
		t.Fatalf("setfacl aclfile: %v", st)
	}

	attr := &meta.Attr{}
	if st := m.GetAttr(ctx, inode, attr); st != 0 {
		t.Fatalf("getattr aclfile: %v", st)
	}
	if attr.AccessACL == aclAPI.None {
		t.Fatal("access ACL id should be set")
	}
	if st := m.Access(meta.NewContext(1, 1, []uint32{2}), inode, meta.MODE_MASK_R|meta.MODE_MASK_W, attr); st != syscall.EACCES {
		t.Fatalf("named user access = %v, want %v", st, syscall.EACCES)
	}
	if st := m.Access(meta.NewContext(1, 2, []uint32{2}), inode, meta.MODE_MASK_R|meta.MODE_MASK_W, attr); st != syscall.EACCES {
		t.Fatalf("masked named group access = %v, want %v", st, syscall.EACCES)
	}

	rule.Mask = 7
	if st := m.SetFacl(ctx, inode, aclAPI.TypeAccess, rule); st != 0 {
		t.Fatalf("update setfacl aclfile: %v", st)
	}
	attr = &meta.Attr{}
	if st := m.GetAttr(ctx, inode, attr); st != 0 {
		t.Fatalf("getattr after acl update: %v", st)
	}
	if st := m.Access(meta.NewContext(1, 2, []uint32{2}), inode, meta.MODE_MASK_R|meta.MODE_MASK_W, attr); st != 0 {
		t.Fatalf("named group access after mask update = %v, want 0", st)
	}
}

func TestJuiceFSMetaACLLifecycle(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "acl-lifecycle", EnableACL: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var dir meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "acl_dir", 0644, 0, 0, &dir, nil); st != 0 {
		t.Fatalf("mkdir acl_dir: %v", st)
	}

	rule := &aclAPI.Rule{
		Owner: 7,
		Group: 7,
		Mask:  7,
		Other: 7,
		NamedUsers: []aclAPI.Entry{
			{Id: 1001, Perm: 4},
		},
	}
	if st := m.SetFacl(ctx, dir, aclAPI.TypeAccess, rule); st != 0 {
		t.Fatalf("setfacl access: %v", st)
	}
	got := &aclAPI.Rule{}
	if st := m.GetFacl(ctx, dir, aclAPI.TypeAccess, got); st != 0 {
		t.Fatalf("getfacl access: %v", st)
	}
	if !rule.IsEqual(got) {
		t.Fatalf("access acl mismatch: got=%+v want=%+v", got, rule)
	}
	attr := &meta.Attr{}
	if st := m.GetAttr(ctx, dir, attr); st != 0 {
		t.Fatalf("getattr acl_dir: %v", st)
	}
	if attr.Mode != 0777 {
		t.Fatalf("mode after access acl=%#o want=0777", attr.Mode)
	}

	if st := m.SetAttr(ctx, dir, meta.SetAttrMode, 0, &meta.Attr{Mode: 0555}); st != 0 {
		t.Fatalf("setattr mode 0555: %v", st)
	}
	got2 := &aclAPI.Rule{}
	if st := m.GetFacl(ctx, dir, aclAPI.TypeAccess, got2); st != 0 {
		t.Fatalf("getfacl access after chmod: %v", st)
	}
	expectAfterChmod := *rule
	expectAfterChmod.Owner = 5
	expectAfterChmod.Mask = 5
	expectAfterChmod.Other = 5
	if !got2.IsEqual(&expectAfterChmod) {
		t.Fatalf("access acl after chmod mismatch: got=%+v want=%+v", got2, &expectAfterChmod)
	}

	removeRule := *got2
	removeRule.Mask = 0xFFFF
	removeRule.NamedUsers = nil
	removeRule.NamedGroups = nil
	if st := m.SetFacl(ctx, dir, aclAPI.TypeAccess, &removeRule); st != 0 {
		t.Fatalf("remove access acl via setfacl: %v", st)
	}
	if st := m.GetFacl(ctx, dir, aclAPI.TypeAccess, &aclAPI.Rule{}); st != meta.ENOATTR {
		t.Fatalf("getfacl removed access acl = %v, want %v", st, meta.ENOATTR)
	}
	attr = &meta.Attr{}
	if st := m.GetAttr(ctx, dir, attr); st != 0 {
		t.Fatalf("getattr acl_dir after access acl removal: %v", st)
	}
	if attr.Mode != 0575 {
		t.Fatalf("mode after access acl removal=%#o want=0575", attr.Mode)
	}

	defaultRule := &aclAPI.Rule{
		Owner: 7,
		Group: 7,
		Mask:  7,
		Other: 7,
		NamedUsers: []aclAPI.Entry{
			{Id: 1001, Perm: 4},
		},
	}
	if st := m.SetFacl(ctx, dir, aclAPI.TypeDefault, defaultRule); st != 0 {
		t.Fatalf("setfacl default: %v", st)
	}
	gotDefault := &aclAPI.Rule{}
	if st := m.GetFacl(ctx, dir, aclAPI.TypeDefault, gotDefault); st != 0 {
		t.Fatalf("getfacl default: %v", st)
	}
	if !gotDefault.IsEqual(defaultRule) {
		t.Fatalf("default acl mismatch: got=%+v want=%+v", gotDefault, defaultRule)
	}

	var subdir meta.Ino
	subAttr := &meta.Attr{}
	mode := uint16(0222)
	if st := m.Mkdir(ctx, dir, "subdir", mode, 0022, 0, &subdir, subAttr); st != 0 {
		t.Fatalf("mkdir subdir: %v", st)
	}
	subDefault := &aclAPI.Rule{}
	if st := m.GetFacl(ctx, subdir, aclAPI.TypeDefault, subDefault); st != 0 {
		t.Fatalf("getfacl subdir default: %v", st)
	}
	if !subDefault.IsEqual(defaultRule) {
		t.Fatalf("subdir default acl mismatch: got=%+v want=%+v", subDefault, defaultRule)
	}
	subAccess := &aclAPI.Rule{}
	if st := m.GetFacl(ctx, subdir, aclAPI.TypeAccess, subAccess); st != 0 {
		t.Fatalf("getfacl subdir access: %v", st)
	}
	expectSubAccess := *defaultRule
	expectSubAccess.Owner &= (mode >> 6) & 7
	expectSubAccess.Mask &= (mode >> 3) & 7
	expectSubAccess.Other &= mode & 7
	if !subAccess.IsEqual(&expectSubAccess) {
		t.Fatalf("subdir access acl mismatch: got=%+v want=%+v", subAccess, &expectSubAccess)
	}

	minimalDefault := &aclAPI.Rule{
		Owner:  5,
		Group:  5,
		Mask:   0xFFFF,
		Other:  5,
	}
	if st := m.SetFacl(ctx, dir, aclAPI.TypeDefault, minimalDefault); st != 0 {
		t.Fatalf("setfacl minimal default: %v", st)
	}
	gotDefault = &aclAPI.Rule{}
	if st := m.GetFacl(ctx, dir, aclAPI.TypeDefault, gotDefault); st != 0 {
		t.Fatalf("getfacl minimal default: %v", st)
	}
	if !gotDefault.IsEqual(minimalDefault) {
		t.Fatalf("minimal default acl mismatch: got=%+v want=%+v", gotDefault, minimalDefault)
	}

	var subdir2 meta.Ino
	subAttr = &meta.Attr{}
	if st := m.Mkdir(ctx, dir, "subdir2", mode, 0022, 0, &subdir2, subAttr); st != 0 {
		t.Fatalf("mkdir subdir2: %v", st)
	}
	if subAttr.Mode != 0 {
		t.Fatalf("subdir2 mode=%#o want=0", subAttr.Mode)
	}
	subDefault2 := &aclAPI.Rule{}
	if st := m.GetFacl(ctx, subdir2, aclAPI.TypeDefault, subDefault2); st != 0 {
		t.Fatalf("getfacl subdir2 default: %v", st)
	}
	if !subDefault2.IsEqual(minimalDefault) {
		t.Fatalf("subdir2 default acl mismatch: got=%+v want=%+v", subDefault2, minimalDefault)
	}
	if st := m.GetFacl(ctx, subdir2, aclAPI.TypeAccess, &aclAPI.Rule{}); st != meta.ENOATTR {
		t.Fatalf("subdir2 access acl = %v, want %v", st, meta.ENOATTR)
	}
}

func TestJuiceFSMetaCaseInsensitiveCreateLookupRename(t *testing.T) {
	_, addr := startTestServer(t)
	conf := meta.DefaultConf()
	conf.CaseInsensi = true
	m := meta.NewClient("redis://"+addr, conf)
	defer m.Shutdown()

	if err := m.Init(&meta.Format{Name: "case-basic"}, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode meta.Ino
	attr := &meta.Attr{}
	if st := m.Create(ctx, meta.RootInode, "foo", 0755, 0, 0, &inode, attr); st != 0 {
		t.Fatalf("create foo: %v", st)
	}
	if st := m.Create(ctx, meta.RootInode, "Foo", 0755, 0, 0, &inode, attr); st != 0 {
		t.Fatalf("create Foo: %v", st)
	}
	if st := m.Create(ctx, meta.RootInode, "Foo", 0755, 0, syscall.O_EXCL, &inode, attr); st != syscall.EEXIST {
		t.Fatalf("create Foo O_EXCL = %v, want %v", st, syscall.EEXIST)
	}
	if st := m.Lookup(ctx, meta.RootInode, "Foo", &inode, attr, true); st != 0 {
		t.Fatalf("lookup Foo: %v", st)
	}
	if st := m.Rename(ctx, meta.RootInode, "Foo", meta.RootInode, "bar", 0, &inode, attr); st != 0 {
		t.Fatalf("rename Foo -> bar: %v", st)
	}
	if st := m.Create(ctx, meta.RootInode, "Foo", 0755, 0, 0, &inode, attr); st != 0 {
		t.Fatalf("recreate Foo: %v", st)
	}
	if st := m.Resolve(ctx, meta.RootInode, "/Foo", &inode, attr, false); st != syscall.ENOTSUP {
		t.Fatalf("resolve /Foo = %v, want %v", st, syscall.ENOTSUP)
	}
	if st := m.Lookup(ctx, meta.RootInode, "Bar", &inode, attr, true); st != 0 {
		t.Fatalf("lookup Bar: %v", st)
	}
	if st := m.Link(ctx, inode, meta.RootInode, "foo", attr); st != syscall.EEXIST {
		t.Fatalf("link bar inode to foo = %v, want %v", st, syscall.EEXIST)
	}
	if st := m.Unlink(ctx, meta.RootInode, "Bar"); st != 0 {
		t.Fatalf("unlink Bar: %v", st)
	}
	if st := m.Unlink(ctx, meta.RootInode, "foo"); st != 0 {
		t.Fatalf("unlink foo: %v", st)
	}
	if st := m.Mkdir(ctx, meta.RootInode, "Foo", 0755, 0, 0, &inode, attr); st != 0 {
		t.Fatalf("mkdir Foo: %v", st)
	}
	if st := m.Rmdir(ctx, meta.RootInode, "foo"); st != 0 {
		t.Fatalf("rmdir foo: %v", st)
	}
}

func TestJuiceFSMetaCaseInsensitiveRenameVariants(t *testing.T) {
	_, addr := startTestServer(t)
	conf := meta.DefaultConf()
	conf.CaseInsensi = true
	m := meta.NewClient("redis://"+addr, conf)
	defer m.Shutdown()

	if err := m.Init(&meta.Format{Name: "case-rename"}, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode meta.Ino
	attr := &meta.Attr{}
	if st := m.Create(ctx, meta.RootInode, "aaa", 0755, 0, 0, &inode, attr); st != 0 {
		t.Fatalf("create aaa: %v", st)
	}
	if st := m.Create(ctx, meta.RootInode, "AAA", 0755, 0, syscall.O_EXCL, &inode, attr); st == 0 {
		t.Fatal("create AAA O_EXCL should fail")
	}
	if st := m.Create(ctx, meta.RootInode, "bbb", 0755, 0, 0, &inode, attr); st != 0 {
		t.Fatalf("create bbb: %v", st)
	}
	if st := m.Rename(ctx, meta.RootInode, "aaa", meta.RootInode, "AAA", 0, &inode, attr); st != 0 {
		t.Fatalf("rename aaa -> AAA: %v", st)
	}
	if st := m.Rename(ctx, meta.RootInode, "aaa", meta.RootInode, "AAA", 0, &inode, attr); st != 0 {
		t.Fatalf("rename aaa -> AAA again: %v", st)
	}
	if st := m.Rename(ctx, meta.RootInode, "aaa", meta.RootInode, "BBB", meta.RenameNoReplace, &inode, attr); st == 0 {
		t.Fatal("rename aaa -> BBB with RenameNoReplace should fail")
	}
	if st := m.Rename(ctx, meta.RootInode, "aaa", meta.RootInode, "BBB", 0, &inode, attr); st != 0 {
		t.Fatalf("rename aaa -> BBB: %v", st)
	}
	if st := m.Create(ctx, meta.RootInode, "aaa", 0755, 0, 0, &inode, attr); st != 0 {
		t.Fatalf("recreate aaa: %v", st)
	}
	if st := m.Rename(ctx, meta.RootInode, "aaa", meta.RootInode, "Aaa", 0, &inode, attr); st != 0 {
		t.Fatalf("rename aaa -> Aaa: %v", st)
	}
	var dirInode meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "case_insensi_dir", 0755, 0, 0, &dirInode, attr); st != 0 {
		t.Fatalf("mkdir case_insensi_dir: %v", st)
	}
	if st := m.Create(ctx, dirInode, "AAA", 0755, 0, 0, &inode, attr); st != 0 {
		t.Fatalf("create case_insensi_dir/AAA: %v", st)
	}
	if st := m.Rename(ctx, meta.RootInode, "aaa", dirInode, "aaa", meta.RenameNoReplace, &inode, attr); st == 0 {
		t.Fatal("rename into case-equivalent existing entry should fail with RenameNoReplace")
	}
	if st := m.Rename(ctx, meta.RootInode, "aaa", dirInode, "aaa", 0, &inode, attr); st != 0 {
		t.Fatalf("rename Aaa -> case_insensi_dir/aaa: %v", st)
	}
}

func TestJuiceFSMetaCaseInsensitiveHardlinkRename(t *testing.T) {
	_, addr := startTestServer(t)
	conf := meta.DefaultConf()
	conf.CaseInsensi = true
	m := meta.NewClient("redis://"+addr, conf)
	defer m.Shutdown()

	if err := m.Init(&meta.Format{Name: "case-hardlink"}, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var inode meta.Ino
	attr := &meta.Attr{}
	if st := m.Create(ctx, meta.RootInode, "ccc", 0755, 0, 0, &inode, attr); st != 0 {
		t.Fatalf("create ccc: %v", st)
	}
	if st := m.Link(ctx, inode, meta.RootInode, "CCC", attr); st == 0 {
		t.Fatal("link CCC should fail")
	}
	if st := m.Link(ctx, inode, meta.RootInode, "ddd", attr); st != 0 {
		t.Fatalf("link ddd: %v", st)
	}
	if st := m.Rename(ctx, meta.RootInode, "ccc", meta.RootInode, "CCC", 0, &inode, attr); st != 0 {
		t.Fatalf("rename ccc -> CCC: %v", st)
	}
	if st := m.Rename(ctx, meta.RootInode, "ccc", meta.RootInode, "DDD", meta.RenameNoReplace, &inode, attr); st != syscall.EEXIST {
		t.Fatalf("rename ccc -> DDD no-replace = %v, want %v", st, syscall.EEXIST)
	}
	if st := m.Rename(ctx, meta.RootInode, "ccc", meta.RootInode, "DDD", 0, &inode, attr); st != 0 {
		t.Fatalf("rename ccc -> DDD: %v", st)
	}
	if st := m.Lookup(ctx, meta.RootInode, "ccc", &inode, attr, false); st != 0 {
		t.Fatalf("lookup ccc: %v", st)
	}
	if st := m.Lookup(ctx, meta.RootInode, "ddd", &inode, attr, false); st != 0 {
		t.Fatalf("lookup ddd: %v", st)
	}
	var dirInode meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "case_insensi_hark_dir", 0755, 0, 0, &dirInode, attr); st != 0 {
		t.Fatalf("mkdir case_insensi_hark_dir: %v", st)
	}
	if st := m.Link(ctx, inode, dirInode, "DDD", attr); st != 0 {
		t.Fatalf("link case_insensi_hark_dir/DDD: %v", st)
	}
	if st := m.Rename(ctx, meta.RootInode, "ccc", dirInode, "ddd", meta.RenameNoReplace, &inode, attr); st != syscall.EEXIST {
		t.Fatalf("rename ccc -> case_insensi_hark_dir/ddd no-replace = %v, want %v", st, syscall.EEXIST)
	}
	if st := m.Rename(ctx, meta.RootInode, "ccc", dirInode, "ddd", 0, &inode, attr); st != 0 {
		t.Fatalf("rename ccc -> case_insensi_hark_dir/ddd: %v", st)
	}
	if st := m.Lookup(ctx, meta.RootInode, "ccc", &inode, attr, false); st != 0 {
		t.Fatalf("lookup ccc after cross-dir rename: %v", st)
	}
	if st := m.Rename(ctx, meta.RootInode, "ddd", dirInode, "ddd", 0, &inode, attr); st != 0 {
		t.Fatalf("rename ddd -> case_insensi_hark_dir/ddd: %v", st)
	}
	if st := m.Lookup(ctx, meta.RootInode, "ddd", &inode, attr, false); st != 0 {
		t.Fatalf("lookup ddd after move: %v", st)
	}
}

func TestJuiceFSMetaCloneVariants(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "clone-variants", DirStats: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var srcDir meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "clone_src", 0777, 022, 0, &srcDir, nil); st != 0 {
		t.Fatalf("mkdir clone_src: %v", st)
	}
	if st := m.SetAttr(ctx, srcDir, meta.SetAttrMtime, 0, &meta.Attr{Mtime: 1}); st != 0 {
		t.Fatalf("setattr clone_src mtime: %v", st)
	}
	var file1, file2, sym1 meta.Ino
	if st := m.Mknod(ctx, srcDir, "file1", meta.TypeFile, 0777, 022, 0, "", &file1, nil); st != 0 {
		t.Fatalf("mknod file1: %v", st)
	}
	if st := m.Mknod(ctx, srcDir, "file2", meta.TypeFile, 0644, 022, 0, "", &file2, nil); st != 0 {
		t.Fatalf("mknod file2: %v", st)
	}
	var sliceID uint64
	if st := m.NewSlice(ctx, &sliceID); st != 0 {
		t.Fatalf("new slice: %v", st)
	}
	if st := m.Write(ctx, file1, 0, 0, meta.Slice{Id: sliceID, Size: 4096, Off: 0, Len: 4096}, time.Now()); st != 0 {
		t.Fatalf("write file1: %v", st)
	}
	if st := m.SetXattr(ctx, file1, "user.tag", []byte("hello"), meta.XattrCreateOrReplace); st != 0 {
		t.Fatalf("setxattr file1: %v", st)
	}
	if st := m.Symlink(ctx, srcDir, "sym1", "/tmp/target", &sym1, nil); st != 0 {
		t.Fatalf("symlink sym1: %v", st)
	}
	var dstRoot meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "clone_dst", 0777, 022, 0, &dstRoot, nil); st != 0 {
		t.Fatalf("mkdir clone_dst: %v", st)
	}

	var count, total uint64
	if st := m.Clone(ctx, meta.RootInode, srcDir, dstRoot, "preserve", meta.CLONE_MODE_PRESERVE_ATTR, 022, 4, &count, &total); st != 0 {
		t.Fatalf("clone preserve: %v", st)
	}
	if count == 0 || total == 0 {
		t.Fatalf("clone preserve counts should be non-zero: count=%d total=%d", count, total)
	}
	var preserveIno meta.Ino
	var preserveAttr meta.Attr
	if st := m.Lookup(ctx, dstRoot, "preserve", &preserveIno, &preserveAttr, true); st != 0 {
		t.Fatalf("lookup preserve: %v", st)
	}
	var clonedFile meta.Ino
	var clonedFileAttr meta.Attr
	if st := m.Lookup(ctx, preserveIno, "file1", &clonedFile, &clonedFileAttr, true); st != 0 {
		t.Fatalf("lookup preserve/file1: %v", st)
	}
	var xval []byte
	if st := m.GetXattr(ctx, clonedFile, "user.tag", &xval); st != 0 {
		t.Fatalf("getxattr preserve/file1: %v", st)
	}
	if string(xval) != "hello" {
		t.Fatalf("xattr preserve/file1=%q want=hello", xval)
	}
	var slices []meta.Slice
	if st := m.Read(ctx, clonedFile, 0, &slices); st != 0 {
		t.Fatalf("read preserve/file1: %v", st)
	}
	if len(slices) == 0 {
		t.Fatal("preserve/file1 has no slices")
	}
	var clonedSym meta.Ino
	if st := m.Lookup(ctx, preserveIno, "sym1", &clonedSym, &clonedFileAttr, true); st != 0 {
		t.Fatalf("lookup preserve/sym1: %v", st)
	}
	var target []byte
	if st := m.ReadLink(ctx, clonedSym, &target); st != 0 {
		t.Fatalf("readlink preserve/sym1: %v", st)
	}
	if string(target) != "/tmp/target" {
		t.Fatalf("symlink target=%q want=/tmp/target", target)
	}

	if st := m.Clone(ctx, meta.RootInode, srcDir, dstRoot, "preserve", 0, 022, 4, &count, &total); st != syscall.EEXIST {
		t.Fatalf("clone duplicate dst = %v, want %v", st, syscall.EEXIST)
	}
	if st := m.Clone(ctx, meta.RootInode, srcDir, meta.Ino(999999), "missing", 0, 022, 4, &count, &total); st != syscall.ENOENT {
		t.Fatalf("clone into missing parent = %v, want %v", st, syscall.ENOENT)
	}
	if st := m.Clone(ctx, meta.RootInode, srcDir, file1, "badparent", 0, 022, 4, &count, &total); st != syscall.ENOTDIR {
		t.Fatalf("clone into file parent = %v, want %v", st, syscall.ENOTDIR)
	}

	var immDir meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "clone_imm", 0777, 022, 0, &immDir, nil); st != 0 {
		t.Fatalf("mkdir clone_imm: %v", st)
	}
	if st := m.SetAttr(ctx, immDir, meta.SetAttrFlag, 0, &meta.Attr{Flags: meta.FlagImmutable}); st != 0 {
		t.Fatalf("set immutable clone_imm: %v", st)
	}
	if st := m.Clone(ctx, meta.RootInode, srcDir, immDir, "blocked", 0, 022, 4, &count, &total); st != syscall.EPERM {
		t.Fatalf("clone into immutable parent = %v, want %v", st, syscall.EPERM)
	}

	if st := m.Clone(ctx, meta.RootInode, srcDir, dstRoot, "plain", 0, 022, 4, &count, &total); st != 0 {
		t.Fatalf("clone plain: %v", st)
	}
	var plainIno meta.Ino
	var plainAttr meta.Attr
	if st := m.Lookup(ctx, dstRoot, "plain", &plainIno, &plainAttr, true); st != 0 {
		t.Fatalf("lookup plain: %v", st)
	}
	srcAttr := &meta.Attr{}
	if st := m.GetAttr(ctx, srcDir, srcAttr); st != 0 {
		t.Fatalf("getattr clone_src: %v", st)
	}
	if plainAttr.Mtime == srcAttr.Mtime && plainAttr.Mtimensec == srcAttr.Mtimensec {
		t.Fatalf("plain clone should not preserve mtime")
	}
}

func TestJuiceFSMetaCloneQuotaOwnershipEdge(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "clone-quota-owner", UserGroupQuota: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var parent meta.Ino
	var attr meta.Attr
	if st := m.Mkdir(ctx, meta.RootInode, "clonequota", 0777, 0, 0, &parent, &attr); st != 0 {
		t.Fatalf("mkdir clonequota: %v", st)
	}

	fileOwnerUID, fileOwnerGID := uint32(2001), uint32(3001)
	operatorUID, operatorGID := uint32(2002), uint32(3002)

	for _, spec := range []struct {
		id    string
		qtype uint32
		max   *meta.Quota
	}{
		{fmt.Sprintf("%d", fileOwnerUID), meta.UserQuotaType, &meta.Quota{MaxSpace: 1 << 20, MaxInodes: 10}},
		{fmt.Sprintf("%d", fileOwnerGID), meta.GroupQuotaType, &meta.Quota{MaxSpace: 1 << 20, MaxInodes: 10}},
		{fmt.Sprintf("%d", operatorUID), meta.UserQuotaType, &meta.Quota{MaxSpace: 1 << 20, MaxInodes: 10}},
		{fmt.Sprintf("%d", operatorGID), meta.GroupQuotaType, &meta.Quota{MaxSpace: 1 << 20, MaxInodes: 10}},
	} {
		if err := m.HandleQuota(ctx, meta.QuotaSet, spec.id, spec.qtype, map[string]*meta.Quota{spec.id: spec.max}, false, false, false); err != nil {
			t.Fatalf("set quota %s type %d: %v", spec.id, spec.qtype, err)
		}
	}

	restartSession := func() {
		t.Helper()
		if err := m.CloseSession(); err != nil {
			t.Fatal(err)
		}
		if err := m.NewSession(true); err != nil {
			t.Fatal(err)
		}
	}
	restartSession()

	waitQuota := func(id string, qtype uint32, wantSpace, wantInodes int64) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for {
			qs := map[string]*meta.Quota{}
			if err := m.HandleQuota(ctx, meta.QuotaGet, id, qtype, qs, false, false, false); err != nil {
				t.Fatal(err)
			}
			if q := qs[id]; q != nil && q.UsedSpace == wantSpace && q.UsedInodes == wantInodes {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("quota %s type %d not at want space=%d inodes=%d, got %+v", id, qtype, wantSpace, wantInodes, qs[id])
			}
			time.Sleep(20 * time.Millisecond)
		}
	}

	var srcInode meta.Ino
	if st := m.Create(ctx, parent, "srcfile", 0644, 0, 0, &srcInode, &attr); st != 0 {
		t.Fatalf("create srcfile: %v", st)
	}
	if st := m.SetAttr(ctx, srcInode, meta.SetAttrUID|meta.SetAttrGID, 0, &meta.Attr{Uid: fileOwnerUID, Gid: fileOwnerGID}); st != 0 {
		t.Fatalf("setattr srcfile owner: %v", st)
	}
	var sliceID uint64
	if st := m.NewSlice(ctx, &sliceID); st != 0 {
		t.Fatalf("new slice: %v", st)
	}
	if st := m.Write(ctx, srcInode, 0, 0, meta.Slice{Id: sliceID, Size: 1024, Len: 1024}, time.Now()); st != 0 {
		t.Fatalf("write srcfile: %v", st)
	}
	if st := m.Close(ctx, srcInode); st != 0 {
		t.Fatalf("close srcfile: %v", st)
	}
	m.FlushSession()

	waitQuota(fmt.Sprintf("%d", fileOwnerUID), meta.UserQuotaType, 4096, 1)
	waitQuota(fmt.Sprintf("%d", fileOwnerGID), meta.GroupQuotaType, 4096, 1)
	waitQuota(fmt.Sprintf("%d", operatorUID), meta.UserQuotaType, 0, 0)
	waitQuota(fmt.Sprintf("%d", operatorGID), meta.GroupQuotaType, 0, 0)

	operatorCtx := meta.NewContext(1, operatorUID, []uint32{operatorGID})
	var count, total uint64
	if st := m.Clone(operatorCtx, parent, srcInode, parent, "clonefile", 0, 0, 4, &count, &total); st != 0 {
		t.Fatalf("clone by operator: %v", st)
	}
	m.FlushSession()
	var cloneInode meta.Ino
	var cloneAttr meta.Attr
	if st := m.Lookup(ctx, parent, "clonefile", &cloneInode, &cloneAttr, false); st != 0 {
		t.Fatalf("lookup clonefile: %v", st)
	}
	if cloneAttr.Uid != operatorUID || cloneAttr.Gid != operatorGID {
		t.Fatalf("clone owner=(%d,%d) want=(%d,%d)", cloneAttr.Uid, cloneAttr.Gid, operatorUID, operatorGID)
	}
	waitQuota(fmt.Sprintf("%d", fileOwnerUID), meta.UserQuotaType, 4096, 1)
	waitQuota(fmt.Sprintf("%d", fileOwnerGID), meta.GroupQuotaType, 4096, 1)
	waitQuota(fmt.Sprintf("%d", operatorUID), meta.UserQuotaType, 4096, 1)
	waitQuota(fmt.Sprintf("%d", operatorGID), meta.GroupQuotaType, 4096, 1)
}

func TestJuiceFSMetaClonePreserveACL(t *testing.T) {
	_, addr := startTestServer(t)
	m := meta.NewClient("redis://"+addr, meta.DefaultConf())
	defer m.Shutdown()

	format := &meta.Format{Name: "clone-acl", EnableACL: true}
	if err := m.Init(format, true); err != nil {
		t.Fatal(err)
	}
	if err := m.NewSession(true); err != nil {
		t.Fatal(err)
	}
	defer m.CloseSession()

	ctx := meta.Background()
	var srcDir meta.Ino
	if st := m.Mkdir(ctx, meta.RootInode, "acl_clone_src", 0755, 0, 0, &srcDir, nil); st != 0 {
		t.Fatalf("mkdir acl_clone_src: %v", st)
	}
	defaultRule := &aclAPI.Rule{
		Owner: 7,
		Group: 7,
		Mask:  7,
		Other: 7,
		NamedUsers: []aclAPI.Entry{
			{Id: 1001, Perm: 4},
		},
	}
	if st := m.SetFacl(ctx, srcDir, aclAPI.TypeDefault, defaultRule); st != 0 {
		t.Fatalf("set default acl on src dir: %v", st)
	}
	var srcFile meta.Ino
	if st := m.Create(ctx, srcDir, "file", 0644, 0, 0, &srcFile, nil); st != 0 {
		t.Fatalf("create src file: %v", st)
	}
	accessRule := &aclAPI.Rule{
		Owner: 6,
		Group: 4,
		Mask:  4,
		Other: 0,
		NamedUsers: []aclAPI.Entry{
			{Id: 1002, Perm: 4},
		},
	}
	if st := m.SetFacl(ctx, srcFile, aclAPI.TypeAccess, accessRule); st != 0 {
		t.Fatalf("set access acl on src file: %v", st)
	}

	var count, total uint64
	if st := m.Clone(ctx, meta.RootInode, srcDir, meta.RootInode, "acl_clone_dst", meta.CLONE_MODE_PRESERVE_ATTR, 0, 4, &count, &total); st != 0 {
		t.Fatalf("clone preserve acl dir: %v", st)
	}
	var dstDir meta.Ino
	var dstAttr meta.Attr
	if st := m.Lookup(ctx, meta.RootInode, "acl_clone_dst", &dstDir, &dstAttr, true); st != 0 {
		t.Fatalf("lookup acl_clone_dst: %v", st)
	}
	gotDefault := &aclAPI.Rule{}
	if st := m.GetFacl(ctx, dstDir, aclAPI.TypeDefault, gotDefault); st != 0 {
		t.Fatalf("get default acl from cloned dir: %v", st)
	}
	if !gotDefault.IsEqual(defaultRule) {
		t.Fatalf("cloned dir default acl mismatch: got=%+v want=%+v", gotDefault, defaultRule)
	}

	var dstFile meta.Ino
	if st := m.Lookup(ctx, dstDir, "file", &dstFile, &dstAttr, true); st != 0 {
		t.Fatalf("lookup cloned file: %v", st)
	}
	gotAccess := &aclAPI.Rule{}
	if st := m.GetFacl(ctx, dstFile, aclAPI.TypeAccess, gotAccess); st != 0 {
		t.Fatalf("get access acl from cloned file: %v", st)
	}
	if !gotAccess.IsEqual(accessRule) {
		t.Fatalf("cloned file access acl mismatch: got=%+v want=%+v", gotAccess, accessRule)
	}
}

func scriptsByName() map[string]string {
	out := map[string]string{}
	for _, script := range scripts {
		out[script.name] = script.body
	}
	return out
}

func packEntry(typ uint8, ino meta.Ino) []byte {
	buf := make([]byte, 9)
	buf[0] = typ
	buf[1] = byte(ino >> 56)
	buf[2] = byte(ino >> 48)
	buf[3] = byte(ino >> 40)
	buf[4] = byte(ino >> 32)
	buf[5] = byte(ino >> 24)
	buf[6] = byte(ino >> 16)
	buf[7] = byte(ino >> 8)
	buf[8] = byte(ino)
	return buf
}
