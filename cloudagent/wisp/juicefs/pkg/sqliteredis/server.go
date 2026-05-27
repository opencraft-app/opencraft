package sqliteredis

import (
	"bufio"
	"crypto/sha1"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"

	"github.com/juicedata/juicefs/pkg/meta"
	_ "github.com/mattn/go-sqlite3"
)

type Server struct {
	db       *sql.DB
	store    *store
	listener net.Listener
	wg       sync.WaitGroup
	closed   chan struct{}
}

type Options struct {
	Path string
}

func New(opts Options) (*Server, error) {
	if opts.Path == "" {
		return nil, fmt.Errorf("sqlite path is required")
	}
	db, err := sql.Open("sqlite3", opts.Path+"?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=ON")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	s := &Server{
		db:     db,
		store:  newStore(db),
		closed: make(chan struct{}),
	}
	if err := s.store.init(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Server) Serve(l net.Listener) error {
	s.listener = l
	for {
		conn, err := l.Accept()
		if err != nil {
			select {
			case <-s.closed:
				return nil
			default:
				return err
			}
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			_ = s.serveConn(conn)
		}()
	}
}

func (s *Server) Close() error {
	select {
	case <-s.closed:
	default:
		close(s.closed)
	}
	if s.listener != nil {
		_ = s.listener.Close()
	}
	s.wg.Wait()
	return s.db.Close()
}

func (s *Server) Addr() net.Addr {
	if s.listener == nil {
		return nil
	}
	return s.listener.Addr()
}

type connState struct {
	watched map[string]int64
	inMulti bool
	queue   [][]string
}

func (s *Server) serveConn(conn net.Conn) error {
	defer conn.Close()
	br := bufio.NewReader(conn)
	bw := bufio.NewWriter(conn)
	st := &connState{watched: make(map[string]int64)}
	for {
		args, err := readCommand(br)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			_ = writeError(bw, "ERR "+err.Error())
			_ = bw.Flush()
			return err
		}
		if len(args) == 0 {
			continue
		}
		resp, err := s.exec(st, args)
		if err != nil {
			_ = writeError(bw, "ERR "+err.Error())
		} else {
			_ = writeResp(bw, resp)
		}
		if err = bw.Flush(); err != nil {
			return err
		}
	}
}

func (s *Server) exec(st *connState, args []string) (any, error) {
	cmd := strings.ToUpper(args[0])
	if st.inMulti && cmd != "EXEC" && cmd != "DISCARD" {
		switch cmd {
		case "WATCH":
			return nil, fmt.Errorf("WATCH inside MULTI is not allowed")
		default:
			st.queue = append(st.queue, append([]string(nil), args...))
			return simpleString("QUEUED"), nil
		}
	}
	switch cmd {
	case "PING":
		if len(args) > 1 {
			return bulkString(args[1]), nil
		}
		return simpleString("PONG"), nil
	case "HELLO":
		return nil, redisErr("ERR unknown command 'HELLO'")
	case "CLIENT":
		if len(args) >= 2 && strings.ToUpper(args[1]) == "SETINFO" {
			return simpleString("OK"), nil
		}
		if len(args) >= 2 && strings.ToUpper(args[1]) == "SETNAME" {
			return simpleString("OK"), nil
		}
		return nil, redisErr("ERR unknown subcommand")
	case "SELECT":
		if len(args) == 2 && args[1] == "0" {
			return simpleString("OK"), nil
		}
		return nil, redisErr("ERR DB index is out of range")
	case "INFO":
		return bulkString(s.store.info()), nil
	case "CONFIG":
		return s.execConfig(args)
	case "FLUSHDB":
		return simpleString("OK"), s.store.flush()
	case "SCAN":
		return s.execScan(args)
	case "WATCH":
		return simpleString("OK"), s.execWatch(st, args[1:])
	case "MULTI":
		st.inMulti = true
		st.queue = nil
		return simpleString("OK"), nil
	case "DISCARD":
		st.inMulti = false
		st.queue = nil
		st.watched = make(map[string]int64)
		return simpleString("OK"), nil
	case "EXEC":
		return s.execExec(st)
	case "SCRIPT":
		return s.execScript(args)
	case "EVALSHA":
		return s.execEvalSha(args)
	case "GET", "SET", "SETNX", "MGET", "MSET", "DEL", "EXISTS", "INCR", "INCRBY", "DECR", "DECRBY":
		return s.execStringCmd(args)
	case "HGET", "HSET", "HSETNX", "HGETALL", "HDEL", "HEXISTS", "HINCRBY", "HKEYS", "HMGET", "HMSET", "HSCAN", "HLEN":
		return s.execHashCmd(args)
	case "LPUSH", "RPUSH", "RPUSHX", "LRANGE", "LTRIM", "LLEN":
		return s.execListCmd(args)
	case "SADD", "SREM", "SMEMBERS":
		return s.execSetCmd(args)
	case "ZADD", "ZREM", "ZRANGE", "ZRANGEBYSCORE", "ZSCORE", "ZRANGEWITHSCORES":
		return s.execZSetCmd(args)
	default:
		return nil, redisErr(fmt.Sprintf("ERR unknown command '%s'", args[0]))
	}
}

func (s *Server) execConfig(args []string) (any, error) {
	if len(args) < 3 {
		return nil, redisErr("ERR wrong number of arguments for 'config' command")
	}
	switch strings.ToUpper(args[1]) {
	case "GET":
		val := s.store.getConfig(args[2])
		if val == "" {
			return array{}, nil
		}
		return array{bulkString(args[2]), bulkString(val)}, nil
	case "SET":
		if len(args) != 4 {
			return nil, redisErr("ERR wrong number of arguments for 'config set' command")
		}
		s.store.setConfig(args[2], args[3])
		return simpleString("OK"), nil
	default:
		return nil, redisErr("ERR unsupported CONFIG subcommand")
	}
}

func (s *Server) execWatch(st *connState, keys []string) error {
	for _, key := range keys {
		rev, err := s.store.getRevision(key)
		if err != nil {
			return err
		}
		st.watched[key] = rev
	}
	return nil
}

func (s *Server) execExec(st *connState) (any, error) {
	if !st.inMulti {
		return nil, redisErr("ERR EXEC without MULTI")
	}
	res, err := s.store.execQueued(st.watched, st.queue)
	st.inMulti = false
	st.queue = nil
	st.watched = make(map[string]int64)
	if errors.Is(err, errWatchConflict) {
		return nullArray{}, nil
	}
	return res, err
}

func (s *Server) execScan(args []string) (any, error) {
	cursor := int64(0)
	match := "*"
	count := 10
	if len(args) >= 2 {
		v, err := strconv.ParseInt(args[1], 10, 64)
		if err != nil {
			return nil, redisErr("ERR invalid cursor")
		}
		cursor = v
	}
	for i := 2; i < len(args); i++ {
		switch strings.ToUpper(args[i]) {
		case "MATCH":
			i++
			if i < len(args) {
				match = args[i]
			}
		case "COUNT":
			i++
			if i < len(args) {
				if v, err := strconv.Atoi(args[i]); err == nil && v > 0 {
					count = v
				}
			}
		}
	}
	next, vals, err := s.store.scanKeys(cursor, match, count)
	if err != nil {
		return nil, err
	}
	items := make(array, 0, len(vals))
	for _, v := range vals {
		items = append(items, bulkString(v))
	}
	return array{bulkString(strconv.FormatInt(next, 10)), items}, nil
}

func (s *Server) execScript(args []string) (any, error) {
	if len(args) < 2 {
		return nil, redisErr("ERR wrong number of arguments for 'script' command")
	}
	switch strings.ToUpper(args[1]) {
	case "LOAD":
		if len(args) != 3 {
			return nil, redisErr("ERR wrong number of arguments for 'script load' command")
		}
		sha, ok := whitelistScript(args[2])
		if !ok {
			return nil, redisErr("ERR unsupported script body")
		}
		return bulkString(sha), nil
	default:
		return nil, redisErr("ERR unsupported SCRIPT subcommand")
	}
}

func (s *Server) execEvalSha(args []string) (any, error) {
	if len(args) < 3 {
		return nil, redisErr("ERR wrong number of arguments for 'evalsha' command")
	}
	sha := args[1]
	nkeys, err := strconv.Atoi(args[2])
	if err != nil || nkeys < 0 || len(args) < 3+nkeys {
		return nil, redisErr("ERR invalid number of keys")
	}
	keys := args[3 : 3+nkeys]
	argv := args[3+nkeys:]
	switch whitelistName(sha) {
	case "lookup":
		if len(keys) != 2 {
			return nil, redisErr("ERR lookup requires 2 KEYS")
		}
		return s.evalLookup(keys[0], keys[1])
	case "resolve":
		if len(keys) != 3 {
			return nil, redisErr("ERR resolve requires 3 KEYS")
		}
		return s.evalResolve(keys[0], keys[1], keys[2], argv)
	default:
		return nil, redisErr("NOSCRIPT No matching script. Please use EVAL.")
	}
}

func (s *Server) evalLookup(entryKey, name string) (any, error) {
	buf, err := s.store.hget(entryKey, []byte(name))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, redisErr("ENOENT")
		}
		return nil, err
	}
	if len(buf) != 9 {
		return nil, redisErr("ENOTSUP")
	}
	ino := binary.BigEndian.Uint64(buf[1:])
	if ino > 4503599627370495 {
		return nil, redisErr("ENOTSUP")
	}
	attr, err := s.store.getString("i" + strconv.FormatUint(ino, 10))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, redisErr("ENOENT")
		}
		return nil, err
	}
	return array{int64(ino), bulkBytes(attr)}, nil
}

func (s *Server) evalResolve(parentKey, pth, uidStr string, gids []string) (any, error) {
	parent, err := strconv.ParseUint(parentKey, 10, 64)
	if err != nil {
		return nil, redisErr("ENOTSUP")
	}
	uid, _ := strconv.ParseUint(uidStr, 10, 32)
	curType := uint8(meta.TypeDirectory)
	segments := strings.FieldsFunc(pth, func(r rune) bool { return r == '/' })
	for _, name := range segments {
		if curType == meta.TypeSymlink || parent > 4503599627370495 {
			return nil, redisErr("ENOTSUP")
		}
		if curType != meta.TypeDirectory {
			return nil, redisErr("ENOTDIR")
		}
		if parent > 1 {
			attrBlob, err := s.store.getString("i" + strconv.FormatUint(parent, 10))
			if err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return nil, redisErr("ENOENT")
				}
				return nil, err
			}
			var attr meta.Attr
			attr.Unmarshal(attrBlob)
			if uid != 0 && !canExec(attr, uint32(uid), gids) {
				return nil, redisErr("EACCESS")
			}
		}
		entry, err := s.store.hget("d"+strconv.FormatUint(parent, 10), []byte(name))
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, redisErr("ENOENT")
			}
			return nil, err
		}
		if len(entry) != 9 {
			return nil, redisErr("ENOTSUP")
		}
		curType = entry[0]
		parent = binary.BigEndian.Uint64(entry[1:])
	}
	if parent > 4503599627370495 {
		return nil, redisErr("ENOTSUP")
	}
	attr, err := s.store.getString("i" + strconv.FormatUint(parent, 10))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, redisErr("ENOENT")
		}
		return nil, err
	}
	return array{int64(parent), bulkBytes(attr)}, nil
}

func canExec(attr meta.Attr, uid uint32, gids []string) bool {
	if attr.Uid == uid {
		return ((attr.Mode >> 6) & 1) == 1
	}
	for _, gid := range gids {
		if strconv.FormatUint(uint64(attr.Gid), 10) == gid {
			return ((attr.Mode >> 3) & 1) == 1
		}
	}
	return (attr.Mode & 1) == 1
}

type redisErr string

func (e redisErr) Error() string { return string(e) }

var errWatchConflict = errors.New("watch conflict")

type store struct {
	db      *sql.DB
	mu      sync.Mutex
	configs sync.Map
}

func newStore(db *sql.DB) *store {
	s := &store{db: db}
	s.configs.Store("maxmemory-policy", "noeviction")
	return s
}

func (s *store) init() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS setting (name TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS counter (name TEXT PRIMARY KEY, value INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS inode (
			inode INTEGER PRIMARY KEY,
			type INTEGER NOT NULL,
			flags INTEGER NOT NULL,
			mode INTEGER NOT NULL,
			uid INTEGER NOT NULL,
			gid INTEGER NOT NULL,
			atime INTEGER NOT NULL,
			mtime INTEGER NOT NULL,
			ctime INTEGER NOT NULL,
			atimensec INTEGER NOT NULL,
			mtimensec INTEGER NOT NULL,
			ctimensec INTEGER NOT NULL,
			nlink INTEGER NOT NULL,
			length INTEGER NOT NULL,
			rdev INTEGER NOT NULL DEFAULT 0,
			parent INTEGER NOT NULL DEFAULT 0,
			access_acl_id INTEGER NOT NULL DEFAULT 0,
			default_acl_id INTEGER NOT NULL DEFAULT 0,
			tier INTEGER NOT NULL DEFAULT 0,
			attr_blob BLOB NOT NULL,
			revision INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS dentry (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			parent INTEGER NOT NULL,
			name BLOB NOT NULL,
			inode INTEGER NOT NULL,
			type INTEGER NOT NULL,
			entry_blob BLOB NOT NULL,
			revision INTEGER NOT NULL,
			UNIQUE(parent, name)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_dentry_inode ON dentry(inode)`,
		`CREATE INDEX IF NOT EXISTS idx_dentry_parent_name ON dentry(parent, name)`,
		`CREATE TABLE IF NOT EXISTS parent_link (
			inode INTEGER NOT NULL,
			parent INTEGER NOT NULL,
			cnt INTEGER NOT NULL,
			revision INTEGER NOT NULL,
			PRIMARY KEY (inode, parent)
		)`,
		`CREATE TABLE IF NOT EXISTS symlink (
			inode INTEGER PRIMARY KEY,
			target BLOB NOT NULL,
			revision INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS xattr (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			inode INTEGER NOT NULL,
			name TEXT NOT NULL,
			value BLOB NOT NULL,
			revision INTEGER NOT NULL,
			UNIQUE(inode, name)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_xattr_inode ON xattr(inode)`,
		`CREATE TABLE IF NOT EXISTS chunk (
			inode INTEGER NOT NULL,
			indx INTEGER NOT NULL,
			slices_blob BLOB NOT NULL,
			revision INTEGER NOT NULL,
			PRIMARY KEY (inode, indx)
		)`,
		`CREATE TABLE IF NOT EXISTS slice_ref (
			slice_id INTEGER NOT NULL,
			size INTEGER NOT NULL,
			refs INTEGER NOT NULL,
			revision INTEGER NOT NULL,
			PRIMARY KEY (slice_id, size)
		)`,
		`CREATE TABLE IF NOT EXISTS del_slice (
			field_text TEXT PRIMARY KEY,
			slice_id INTEGER NOT NULL,
			deleted_at INTEGER NOT NULL,
			slices_blob BLOB NOT NULL,
			revision INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS session (
			sid INTEGER PRIMARY KEY,
			expire_at INTEGER NOT NULL,
			info_blob BLOB,
			revision INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire_at)`,
		`CREATE TABLE IF NOT EXISTS legacy_session (
			sid INTEGER PRIMARY KEY,
			expire_at INTEGER NOT NULL,
			revision INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_legacy_session_expire ON legacy_session(expire_at)`,
		`CREATE TABLE IF NOT EXISTS session_sustained_inode (
			sid INTEGER NOT NULL,
			inode INTEGER NOT NULL,
			revision INTEGER NOT NULL,
			PRIMARY KEY (sid, inode)
		)`,
		`CREATE TABLE IF NOT EXISTS session_locked (
			sid INTEGER NOT NULL,
			lock_kind TEXT NOT NULL,
			inode INTEGER NOT NULL,
			owner INTEGER NOT NULL,
			revision INTEGER NOT NULL,
			PRIMARY KEY (sid, lock_kind, inode, owner)
		)`,
		`CREATE TABLE IF NOT EXISTS flock (
			inode INTEGER NOT NULL,
			sid INTEGER NOT NULL,
			owner INTEGER NOT NULL,
			ltype INTEGER NOT NULL,
			revision INTEGER NOT NULL,
			PRIMARY KEY (inode, sid, owner)
		)`,
		`CREATE TABLE IF NOT EXISTS plock (
			inode INTEGER NOT NULL,
			sid INTEGER NOT NULL,
			owner INTEGER NOT NULL,
			records_blob BLOB NOT NULL,
			revision INTEGER NOT NULL,
			PRIMARY KEY (inode, sid, owner)
		)`,
		`CREATE TABLE IF NOT EXISTS deleted_file_queue (
			member_text TEXT PRIMARY KEY,
			inode INTEGER NOT NULL,
			length INTEGER NOT NULL,
			expire_at INTEGER NOT NULL,
			revision INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS detached_node (
			inode INTEGER PRIMARY KEY,
			added_at INTEGER NOT NULL,
			revision INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS dir_stat (
			inode INTEGER PRIMARY KEY,
			data_length INTEGER NOT NULL,
			used_space INTEGER NOT NULL,
			used_inodes INTEGER NOT NULL,
			revision INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS dir_quota (
			inode INTEGER PRIMARY KEY,
			max_space INTEGER NOT NULL,
			max_inodes INTEGER NOT NULL,
			used_space INTEGER NOT NULL,
			used_inodes INTEGER NOT NULL,
			revision INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS user_quota (
			uid INTEGER PRIMARY KEY,
			max_space INTEGER NOT NULL,
			max_inodes INTEGER NOT NULL,
			used_space INTEGER NOT NULL,
			used_inodes INTEGER NOT NULL,
			revision INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS group_quota (
			gid INTEGER PRIMARY KEY,
			max_space INTEGER NOT NULL,
			max_inodes INTEGER NOT NULL,
			used_space INTEGER NOT NULL,
			used_inodes INTEGER NOT NULL,
			revision INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS acl (
			id TEXT PRIMARY KEY,
			rule BLOB NOT NULL,
			revision INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS krb_token (
			id TEXT PRIMARY KEY,
			token BLOB NOT NULL,
			revision INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS key_revision (rkey TEXT PRIMARY KEY, revision INTEGER NOT NULL)`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.Exec(stmt); err != nil {
			return err
		}
	}
	return nil
}

func (s *store) info() string {
	return strings.Join([]string{
		"# Server",
		"redis_version:6.2.0",
		"# Persistence",
		"aof_enabled:1",
		"# Memory",
		"maxmemory_policy:noeviction",
	}, "\r\n") + "\r\n"
}

func (s *store) getConfig(key string) string {
	if v, ok := s.configs.Load(strings.ToLower(key)); ok {
		return v.(string)
	}
	return ""
}

func (s *store) setConfig(key, value string) {
	s.configs.Store(strings.ToLower(key), value)
}

func (s *store) flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range []string{
		"setting", "counter", "inode", "dentry", "parent_link", "symlink", "xattr", "chunk",
		"slice_ref", "del_slice", "session", "legacy_session", "session_sustained_inode", "session_locked",
		"flock", "plock", "deleted_file_queue", "detached_node", "dir_stat", "dir_quota",
		"user_quota", "group_quota", "acl", "krb_token", "key_revision",
	} {
		if _, err := tx.Exec("DELETE FROM " + table); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *store) getRevision(key string) (int64, error) {
	var rev int64
	err := s.db.QueryRow(`SELECT revision FROM key_revision WHERE rkey=?`, key).Scan(&rev)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return rev, err
}

func (s *store) bumpRevisions(tx *sql.Tx, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(keys))
	var cur int64
	err := tx.QueryRow(`SELECT value FROM counter WHERE name='txn_revision'`).Scan(&cur)
	if errors.Is(err, sql.ErrNoRows) {
		cur = 0
	} else if err != nil {
		return err
	}
	next := cur + 1
	if _, err := tx.Exec(`INSERT INTO counter(name,value,updated_at) VALUES('txn_revision',?,strftime('%s','now')) ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, next); err != nil {
		return err
	}
	for _, key := range keys {
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		if _, err := tx.Exec(`INSERT INTO key_revision(rkey,revision) VALUES(?,?) ON CONFLICT(rkey) DO UPDATE SET revision=excluded.revision`, key, next); err != nil {
			return err
		}
	}
	return nil
}

func (s *store) execQueued(watched map[string]int64, queued [][]string) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	for k, rev := range watched {
		var cur int64
		err = tx.QueryRow(`SELECT revision FROM key_revision WHERE rkey=?`, k).Scan(&cur)
		if errors.Is(err, sql.ErrNoRows) {
			cur = 0
		} else if err != nil {
			return nil, err
		}
		if cur != rev {
			return nil, errWatchConflict
		}
	}
	res := make(array, 0, len(queued))
	var touched []string
	for _, cmd := range queued {
		reply, keys, err := s.execTxCommand(tx, cmd)
		if err != nil {
			return nil, err
		}
		touched = append(touched, keys...)
		res = append(res, reply)
	}
	if err := s.bumpRevisions(tx, touched); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return res, nil
}

func (s *store) execTxCommand(tx *sql.Tx, args []string) (any, []string, error) {
	cmd := strings.ToUpper(args[0])
	switch cmd {
	case "GET", "MGET", "EXISTS":
		return s.execStringReadTx(tx, args)
	case "SET", "SETNX", "MSET", "DEL", "INCR", "INCRBY", "DECR", "DECRBY":
		return s.execStringTx(tx, args)
	case "HGET", "HGETALL", "HEXISTS", "HKEYS", "HMGET", "HLEN":
		return s.execHashReadTx(tx, args)
	case "HSET", "HSETNX", "HDEL", "HINCRBY", "HMSET":
		return s.execHashTx(tx, args)
	case "LRANGE", "LLEN":
		return s.execListReadTx(tx, args)
	case "LPUSH", "RPUSH", "RPUSHX", "LTRIM":
		return s.execListTx(tx, args)
	case "SMEMBERS":
		return s.execSetReadTx(tx, args)
	case "SADD", "SREM":
		return s.execSetTx(tx, args)
	case "ZRANGE", "ZRANGEBYSCORE", "ZSCORE", "ZRANGEWITHSCORES":
		return s.execZSetReadTx(tx, args)
	case "ZADD", "ZREM":
		return s.execZSetTx(tx, args)
	default:
		return nil, nil, redisErr("ERR unsupported command inside MULTI")
	}
}

func whitelistScript(body string) (string, bool) {
	for sha, script := range scripts {
		if script.body == body {
			return sha, true
		}
	}
	return "", false
}

func whitelistName(sha string) string {
	if script, ok := scripts[sha]; ok {
		return script.name
	}
	return ""
}

type scriptDef struct {
	name string
	body string
}

var scripts = func() map[string]scriptDef {
	lookup := `
local buf = redis.call('HGET', KEYS[1], KEYS[2])
if not buf then
    error("ENOENT")
end
local ino = struct.unpack(">I8", string.sub(buf, 2))
-- double float has 52 significant bits
if ino > 4503599627370495 then
    error("ENOTSUP")
end
return {ino, redis.call('GET', "i" .. string.format("%.f", ino))}
`
	resolve := `
local function unpack_attr(buf)
    local x = {}
    x.flags, x.mode, x.uid, x.gid = struct.unpack(">BHI4I4", string.sub(buf, 0, 11))
    x.type = math.floor(x.mode / 4096) % 8
    x.mode = x.mode % 4096
    return x
end

local function get_attr(ino)
    local encoded_attr = redis.call('GET', "i" .. string.format("%.f", ino))
    if not encoded_attr then
        error("ENOENT")
    end
    return unpack_attr(encoded_attr)
end

local function lookup(parent, name)
    local buf = redis.call('HGET', "d" .. string.format("%.f", parent), name)
    if not buf then
        error("ENOENT")
    end
    return struct.unpack(">BI8", buf)
end

local function has_value(tab, val)
    for index, value in ipairs(tab) do
        if value == val then
            return true
        end
    end
    return false
end

local function can_access(ino, uid, gids)
    if uid == 0 then
        return true
    end

    local attr = get_attr(ino)
    local mode = 0
    if attr.uid == uid then
        mode = math.floor(attr.mode / 64) % 8
    elseif has_value(gids, tostring(attr.gid)) then
        mode = math.floor(attr.mode / 8) % 8
    else
        mode = attr.mode % 8
    end
    return mode % 2 == 1
end

local function resolve(parent, path, uid, gids)
    local _maxIno = 4503599627370495
    local _type = 2
    for name in string.gmatch(path, "[^/]+") do
        if _type == 3 or parent > _maxIno then
            error("ENOTSUP")
        elseif _type ~= 2 then
            error("ENOTDIR")
        elseif parent > 1 and not can_access(parent, uid, gids) then 
            error("EACCESS")
        end
        _type, parent = lookup(parent, name)
    end
    if parent > _maxIno then
        error("ENOTSUP")
    end
    return {parent, redis.call('GET', "i" .. string.format("%.f", parent))}
end

return resolve(tonumber(KEYS[1]), KEYS[2], tonumber(KEYS[3]), ARGV)
`
	make := func(name, body string) (string, scriptDef) {
		sum := sha1.Sum([]byte(body))
		return hex.EncodeToString(sum[:]), scriptDef{name: name, body: body}
	}
	ls, ld := make("lookup", lookup)
	rs, rd := make("resolve", resolve)
	return map[string]scriptDef{ls: ld, rs: rd}
}()

// RESP helpers.
type simpleString string
type bulkString string
type bulkBytes []byte
type array []any
type nullBulk struct{}
type nullArray struct{}

func writeResp(w *bufio.Writer, v any) error {
	switch vv := v.(type) {
	case nil:
		_, err := w.WriteString("$-1\r\n")
		return err
	case simpleString:
		_, err := w.WriteString("+" + string(vv) + "\r\n")
		return err
	case bulkString:
		return writeBulk(w, []byte(vv))
	case bulkBytes:
		return writeBulk(w, []byte(vv))
	case string:
		return writeBulk(w, []byte(vv))
	case []byte:
		return writeBulk(w, vv)
	case int:
		_, err := w.WriteString(":" + strconv.Itoa(vv) + "\r\n")
		return err
	case int64:
		_, err := w.WriteString(":" + strconv.FormatInt(vv, 10) + "\r\n")
		return err
	case nullBulk:
		_, err := w.WriteString("$-1\r\n")
		return err
	case nullArray:
		_, err := w.WriteString("*-1\r\n")
		return err
	case array:
		if _, err := w.WriteString("*" + strconv.Itoa(len(vv)) + "\r\n"); err != nil {
			return err
		}
		for _, item := range vv {
			if err := writeResp(w, item); err != nil {
				return err
			}
		}
		return nil
	case []any:
		return writeResp(w, array(vv))
	default:
		return fmt.Errorf("unsupported resp type %T", v)
	}
}

func writeBulk(w *bufio.Writer, b []byte) error {
	if _, err := w.WriteString("$" + strconv.Itoa(len(b)) + "\r\n"); err != nil {
		return err
	}
	if _, err := w.Write(b); err != nil {
		return err
	}
	_, err := w.WriteString("\r\n")
	return err
}

func writeError(w *bufio.Writer, msg string) error {
	_, err := w.WriteString("-" + msg + "\r\n")
	return err
}

func readCommand(r *bufio.Reader) ([]string, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
	if line == "" {
		return nil, io.EOF
	}
	if line[0] != '*' {
		return nil, fmt.Errorf("unsupported inline protocol")
	}
	n, err := strconv.Atoi(line[1:])
	if err != nil {
		return nil, err
	}
	args := make([]string, 0, n)
	for i := 0; i < n; i++ {
		h, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		h = strings.TrimSuffix(strings.TrimSuffix(h, "\n"), "\r")
		if len(h) == 0 || h[0] != '$' {
			return nil, fmt.Errorf("expected bulk string")
		}
		l, err := strconv.Atoi(h[1:])
		if err != nil {
			return nil, err
		}
		buf := make([]byte, l+2)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		args = append(args, string(buf[:l]))
	}
	return args, nil
}
