package sqliteredis

import (
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/juicedata/juicefs/pkg/meta"
)

const encodedSliceBytes = 24

var (
	reInode     = regexp.MustCompile(`^(.*)i([0-9]+)$`)
	reSymlink   = regexp.MustCompile(`^(.*)s([0-9]+)$`)
	reDentry    = regexp.MustCompile(`^(.*)d([0-9]+)$`)
	reParent    = regexp.MustCompile(`^(.*)p([0-9]+)$`)
	reXAttr     = regexp.MustCompile(`^(.*)x([0-9]+)$`)
	reChunk     = regexp.MustCompile(`^(.*)c([0-9]+)_([0-9]+)$`)
	reSustained = regexp.MustCompile(`^(.*)session([0-9]+)$`)
	reLocked    = regexp.MustCompile(`^(.*)locked([0-9]+)$`)
	reFlock     = regexp.MustCompile(`^(.*)lockf([0-9]+)$`)
	rePlock     = regexp.MustCompile(`^(.*)lockp([0-9]+)$`)
)

type statField int

const (
	statDataLength statField = iota
	statUsedSpace
	statUsedInodes
)

type quotaField int

const (
	quotaConfig quotaField = iota
	quotaUsedSpace
	quotaUsedInodes
)

type quotaTarget int

const (
	targetDirQuota quotaTarget = iota
	targetUserQuota
	targetGroupQuota
)

func (s *Server) execStringCmd(args []string) (any, error) {
	cmd := strings.ToUpper(args[0])
	switch cmd {
	case "GET":
		if len(args) != 2 {
			return nil, redisErr("ERR wrong number of arguments for 'get'")
		}
		v, err := s.store.getString(args[1])
		if errors.Is(err, sql.ErrNoRows) {
			return nullBulk{}, nil
		}
		return bulkBytes(v), err
	case "SET":
		if len(args) < 3 {
			return nil, redisErr("ERR wrong number of arguments for 'set'")
		}
		return simpleString("OK"), s.store.withWrite(func(tx *sql.Tx) error {
			_, touched, err := s.store.setStringTx(tx, args[1], []byte(args[2]), false)
			if err != nil {
				return err
			}
			return s.store.bumpRevisions(tx, touched)
		})
	case "SETNX":
		if len(args) != 3 {
			return nil, redisErr("ERR wrong number of arguments for 'setnx'")
		}
		var changed int64
		err := s.store.withWrite(func(tx *sql.Tx) error {
			reply, touched, err := s.store.setStringTx(tx, args[1], []byte(args[2]), true)
			if err != nil {
				return err
			}
			changed = reply.(int64)
			if changed > 0 {
				return s.store.bumpRevisions(tx, touched)
			}
			return nil
		})
		return changed, err
	case "MGET":
		if len(args) < 2 {
			return nil, redisErr("ERR wrong number of arguments for 'mget'")
		}
		out := make(array, 0, len(args)-1)
		for _, key := range args[1:] {
			v, err := s.store.getString(key)
			if errors.Is(err, sql.ErrNoRows) {
				out = append(out, nullBulk{})
				continue
			}
			if err != nil {
				return nil, err
			}
			out = append(out, bulkBytes(v))
		}
		return out, nil
	case "MSET":
		if len(args) < 3 || len(args)%2 != 1 {
			return nil, redisErr("ERR wrong number of arguments for 'mset'")
		}
		err := s.store.withWrite(func(tx *sql.Tx) error {
			var touched []string
			for i := 1; i < len(args); i += 2 {
				_, keys, err := s.store.setStringTx(tx, args[i], []byte(args[i+1]), false)
				if err != nil {
					return err
				}
				touched = append(touched, keys...)
			}
			return s.store.bumpRevisions(tx, touched)
		})
		return simpleString("OK"), err
	case "DEL":
		if len(args) < 2 {
			return nil, redisErr("ERR wrong number of arguments for 'del'")
		}
		var total int64
		err := s.store.withWrite(func(tx *sql.Tx) error {
			var touched []string
			for _, key := range args[1:] {
				n, keys, err := s.store.deleteKeyTx(tx, key)
				if err != nil {
					return err
				}
				if n > 0 {
					total++
				}
				touched = append(touched, keys...)
			}
			return s.store.bumpRevisions(tx, touched)
		})
		return total, err
	case "EXISTS":
		if len(args) < 2 {
			return nil, redisErr("ERR wrong number of arguments for 'exists'")
		}
		var cnt int64
		for _, key := range args[1:] {
			ok, err := s.store.keyExists(key)
			if err != nil {
				return nil, err
			}
			if ok {
				cnt++
			}
		}
		return cnt, nil
	case "INCR", "INCRBY", "DECR", "DECRBY":
		key := args[1]
		delta := int64(1)
		switch cmd {
		case "INCRBY":
			v, err := strconv.ParseInt(args[2], 10, 64)
			if err != nil {
				return nil, redisErr("ERR value is not an integer")
			}
			delta = v
		case "DECR":
			delta = -1
		case "DECRBY":
			v, err := strconv.ParseInt(args[2], 10, 64)
			if err != nil {
				return nil, redisErr("ERR value is not an integer")
			}
			delta = -v
		}
		var out int64
		err := s.store.withWrite(func(tx *sql.Tx) error {
			cur, err := s.store.getCounterTx(tx, key)
			if err != nil {
				return err
			}
			out = cur + delta
			_, touched, err := s.store.setCounterTx(tx, key, out)
			if err != nil {
				return err
			}
			return s.store.bumpRevisions(tx, touched)
		})
		return out, err
	default:
		return nil, redisErr("ERR unsupported string command")
	}
}

func (s *Server) execStringTx(tx *sql.Tx, args []string) (any, []string, error) {
	cmd := strings.ToUpper(args[0])
	switch cmd {
	case "SET":
		_, touched, err := s.store.setStringTx(tx, args[1], []byte(args[2]), false)
		return simpleString("OK"), touched, err
	case "SETNX":
		reply, touched, err := s.store.setStringTx(tx, args[1], []byte(args[2]), true)
		return reply, touched, err
	case "MSET":
		var touched []string
		for i := 1; i < len(args); i += 2 {
			_, keys, err := s.store.setStringTx(tx, args[i], []byte(args[i+1]), false)
			if err != nil {
				return nil, nil, err
			}
			touched = append(touched, keys...)
		}
		return simpleString("OK"), touched, nil
	case "DEL":
		var total int64
		var touched []string
		for _, key := range args[1:] {
			n, keys, err := s.store.deleteKeyTx(tx, key)
			if err != nil {
				return nil, nil, err
			}
			if n > 0 {
				total++
			}
			touched = append(touched, keys...)
		}
		return total, touched, nil
	case "INCR", "INCRBY", "DECR", "DECRBY":
		key := args[1]
		delta := int64(1)
		switch cmd {
		case "INCRBY":
			delta, _ = strconv.ParseInt(args[2], 10, 64)
		case "DECR":
			delta = -1
		case "DECRBY":
			v, _ := strconv.ParseInt(args[2], 10, 64)
			delta = -v
		}
		cur, err := s.store.getCounterTx(tx, key)
		if err != nil {
			return nil, nil, err
		}
		cur += delta
		_, touched, err := s.store.setCounterTx(tx, key, cur)
		return cur, touched, err
	default:
		return nil, nil, redisErr("ERR unsupported command in tx")
	}
}

func (s *store) execStringTx(tx *sql.Tx, args []string) (any, []string, error) {
	switch strings.ToUpper(args[0]) {
	case "SET":
		_, touched, err := s.setStringTx(tx, args[1], []byte(args[2]), false)
		return simpleString("OK"), touched, err
	case "SETNX":
		return s.setStringTx(tx, args[1], []byte(args[2]), true)
	case "MSET":
		var touched []string
		for i := 1; i < len(args); i += 2 {
			_, keys, err := s.setStringTx(tx, args[i], []byte(args[i+1]), false)
			if err != nil {
				return nil, nil, err
			}
			touched = append(touched, keys...)
		}
		return simpleString("OK"), touched, nil
	case "DEL":
		var total int64
		var touched []string
		for _, key := range args[1:] {
			n, keys, err := s.deleteKeyTx(tx, key)
			if err != nil {
				return nil, nil, err
			}
			if n > 0 {
				total++
			}
			touched = append(touched, keys...)
		}
		return total, touched, nil
	case "INCR", "INCRBY", "DECR", "DECRBY":
		key := args[1]
		delta := int64(1)
		switch strings.ToUpper(args[0]) {
		case "INCRBY":
			delta, _ = strconv.ParseInt(args[2], 10, 64)
		case "DECR":
			delta = -1
		case "DECRBY":
			v, _ := strconv.ParseInt(args[2], 10, 64)
			delta = -v
		}
		cur, err := s.getCounterTx(tx, key)
		if err != nil {
			return nil, nil, err
		}
		cur += delta
		_, touched, err := s.setCounterTx(tx, key, cur)
		return cur, touched, err
	default:
		return nil, nil, redisErr("ERR unsupported command in tx")
	}
}

func (s *store) execStringReadTx(tx *sql.Tx, args []string) (any, []string, error) {
	switch strings.ToUpper(args[0]) {
	case "GET":
		v, err := s.getStringTx(tx, args[1])
		if errors.Is(err, sql.ErrNoRows) {
			return nullBulk{}, nil, nil
		}
		return bulkBytes(v), nil, err
	case "MGET":
		out := make(array, 0, len(args)-1)
		for _, key := range args[1:] {
			v, err := s.getStringTx(tx, key)
			if errors.Is(err, sql.ErrNoRows) {
				out = append(out, nullBulk{})
				continue
			}
			if err != nil {
				return nil, nil, err
			}
			out = append(out, bulkBytes(v))
		}
		return out, nil, nil
	case "EXISTS":
		var cnt int64
		for _, key := range args[1:] {
			ok, err := s.keyExistsTx(tx, key)
			if err != nil {
				return nil, nil, err
			}
			if ok {
				cnt++
			}
		}
		return cnt, nil, nil
	default:
		return nil, nil, redisErr("ERR unsupported string read command")
	}
}

func (s *Server) execHashCmd(args []string) (any, error) {
	cmd := strings.ToUpper(args[0])
	switch cmd {
	case "HGET":
		if len(args) != 3 {
			return nil, redisErr("ERR wrong number of arguments for 'hget'")
		}
		v, err := s.store.hget(args[1], []byte(args[2]))
		if errors.Is(err, sql.ErrNoRows) {
			return nullBulk{}, nil
		}
		return bulkBytes(v), err
	case "HSET":
		if len(args) < 4 || len(args)%2 != 0 {
			return nil, redisErr("ERR wrong number of arguments for 'hset'")
		}
		var added int64
		err := s.store.withWrite(func(tx *sql.Tx) error {
			var touched []string
			for i := 2; i < len(args); i += 2 {
				n, keys, err := s.store.hsetFieldTx(tx, args[1], []byte(args[i]), []byte(args[i+1]), false)
				if err != nil {
					return err
				}
				added += n
				touched = append(touched, keys...)
			}
			return s.store.bumpRevisions(tx, touched)
		})
		return added, err
	case "HSETNX":
		if len(args) != 4 {
			return nil, redisErr("ERR wrong number of arguments for 'hsetnx'")
		}
		var n int64
		err := s.store.withWrite(func(tx *sql.Tx) error {
			var touched []string
			var err error
			n, touched, err = s.store.hsetFieldTx(tx, args[1], []byte(args[2]), []byte(args[3]), true)
			if err != nil {
				return err
			}
			if n > 0 {
				return s.store.bumpRevisions(tx, touched)
			}
			return nil
		})
		return n, err
	case "HGETALL":
		pairs, err := s.store.hgetall(args[1])
		if err != nil {
			return nil, err
		}
		out := array{}
		for _, p := range pairs {
			out = append(out, bulkBytes(p[0]), bulkBytes(p[1]))
		}
		return out, nil
	case "HDEL":
		if len(args) < 3 {
			return nil, redisErr("ERR wrong number of arguments for 'hdel'")
		}
		var total int64
		err := s.store.withWrite(func(tx *sql.Tx) error {
			var touched []string
			for _, field := range args[2:] {
				n, keys, err := s.store.hdelFieldTx(tx, args[1], []byte(field))
				if err != nil {
					return err
				}
				total += n
				touched = append(touched, keys...)
			}
			return s.store.bumpRevisions(tx, touched)
		})
		return total, err
	case "HEXISTS":
		ok, err := s.store.hexists(args[1], []byte(args[2]))
		if err != nil {
			return nil, err
		}
		if ok {
			return int64(1), nil
		}
		return int64(0), nil
	case "HINCRBY":
		if len(args) != 4 {
			return nil, redisErr("ERR wrong number of arguments for 'hincrby'")
		}
		delta, err := strconv.ParseInt(args[3], 10, 64)
		if err != nil {
			return nil, redisErr("ERR value is not an integer")
		}
		var out int64
		err = s.store.withWrite(func(tx *sql.Tx) error {
			var touched []string
			out, touched, err = s.store.hincrbyTx(tx, args[1], []byte(args[2]), delta)
			if err != nil {
				return err
			}
			return s.store.bumpRevisions(tx, touched)
		})
		return out, err
	case "HKEYS":
		keys, err := s.store.hkeys(args[1])
		if err != nil {
			return nil, err
		}
		out := array{}
		for _, k := range keys {
			out = append(out, bulkBytes(k))
		}
		return out, nil
	case "HMGET":
		out := make(array, 0, len(args)-2)
		for _, field := range args[2:] {
			v, err := s.store.hget(args[1], []byte(field))
			if errors.Is(err, sql.ErrNoRows) {
				out = append(out, nullBulk{})
				continue
			}
			if err != nil {
				return nil, err
			}
			out = append(out, bulkBytes(v))
		}
		return out, nil
	case "HMSET":
		if len(args) < 4 || len(args)%2 != 0 {
			return nil, redisErr("ERR wrong number of arguments for 'hmset'")
		}
		err := s.store.withWrite(func(tx *sql.Tx) error {
			var touched []string
			for i := 2; i < len(args); i += 2 {
				_, keys, err := s.store.hsetFieldTx(tx, args[1], []byte(args[i]), []byte(args[i+1]), false)
				if err != nil {
					return err
				}
				touched = append(touched, keys...)
			}
			return s.store.bumpRevisions(tx, touched)
		})
		return simpleString("OK"), err
	case "HSCAN":
		cursor := int64(0)
		if len(args) >= 3 {
			cursor, _ = strconv.ParseInt(args[2], 10, 64)
		}
		match := "*"
		count := 10
		for i := 3; i < len(args); i++ {
			switch strings.ToUpper(args[i]) {
			case "MATCH":
				i++
				if i < len(args) {
					match = args[i]
				}
			case "COUNT":
				i++
				if i < len(args) {
					count, _ = strconv.Atoi(args[i])
				}
			}
		}
		next, pairs, err := s.store.hscan(args[1], cursor, match, count)
		if err != nil {
			return nil, err
		}
		out := array{}
		for _, p := range pairs {
			out = append(out, bulkBytes(p[0]), bulkBytes(p[1]))
		}
		return array{bulkString(strconv.FormatInt(next, 10)), out}, nil
	case "HLEN":
		n, err := s.store.hlen(args[1])
		return n, err
	default:
		return nil, redisErr("ERR unsupported hash command")
	}
}

func (s *Server) execHashTx(tx *sql.Tx, args []string) (any, []string, error) {
	switch strings.ToUpper(args[0]) {
	case "HSET":
		var added int64
		var touched []string
		for i := 2; i < len(args); i += 2 {
			n, keys, err := s.store.hsetFieldTx(tx, args[1], []byte(args[i]), []byte(args[i+1]), false)
			if err != nil {
				return nil, nil, err
			}
			added += n
			touched = append(touched, keys...)
		}
		return added, touched, nil
	case "HSETNX":
		return s.store.hsetFieldTx(tx, args[1], []byte(args[2]), []byte(args[3]), true)
	case "HDEL":
		var total int64
		var touched []string
		for _, field := range args[2:] {
			n, keys, err := s.store.hdelFieldTx(tx, args[1], []byte(field))
			if err != nil {
				return nil, nil, err
			}
			total += n
			touched = append(touched, keys...)
		}
		return total, touched, nil
	case "HINCRBY":
		return s.store.hincrbyTx(tx, args[1], []byte(args[2]), mustParseInt64(args[3]))
	case "HMSET":
		var touched []string
		for i := 2; i < len(args); i += 2 {
			_, keys, err := s.store.hsetFieldTx(tx, args[1], []byte(args[i]), []byte(args[i+1]), false)
			if err != nil {
				return nil, nil, err
			}
			touched = append(touched, keys...)
		}
		return simpleString("OK"), touched, nil
	default:
		return nil, nil, redisErr("ERR unsupported command in tx")
	}
}

func (s *store) execHashTx(tx *sql.Tx, args []string) (any, []string, error) {
	switch strings.ToUpper(args[0]) {
	case "HSET":
		var added int64
		var touched []string
		for i := 2; i < len(args); i += 2 {
			n, keys, err := s.hsetFieldTx(tx, args[1], []byte(args[i]), []byte(args[i+1]), false)
			if err != nil {
				return nil, nil, err
			}
			added += n
			touched = append(touched, keys...)
		}
		return added, touched, nil
	case "HSETNX":
		return s.hsetFieldTx(tx, args[1], []byte(args[2]), []byte(args[3]), true)
	case "HDEL":
		var total int64
		var touched []string
		for _, field := range args[2:] {
			n, keys, err := s.hdelFieldTx(tx, args[1], []byte(field))
			if err != nil {
				return nil, nil, err
			}
			total += n
			touched = append(touched, keys...)
		}
		return total, touched, nil
	case "HINCRBY":
		return s.hincrbyTx(tx, args[1], []byte(args[2]), mustParseInt64(args[3]))
	case "HMSET":
		var touched []string
		for i := 2; i < len(args); i += 2 {
			_, keys, err := s.hsetFieldTx(tx, args[1], []byte(args[i]), []byte(args[i+1]), false)
			if err != nil {
				return nil, nil, err
			}
			touched = append(touched, keys...)
		}
		return simpleString("OK"), touched, nil
	default:
		return nil, nil, redisErr("ERR unsupported command in tx")
	}
}

func (s *store) execHashReadTx(tx *sql.Tx, args []string) (any, []string, error) {
	switch strings.ToUpper(args[0]) {
	case "HGET":
		v, err := s.hgetTx(tx, args[1], []byte(args[2]))
		if errors.Is(err, sql.ErrNoRows) {
			return nullBulk{}, nil, nil
		}
		return bulkBytes(v), nil, err
	case "HGETALL":
		pairs, err := s.hgetallTx(tx, args[1])
		if err != nil {
			return nil, nil, err
		}
		out := array{}
		for _, p := range pairs {
			out = append(out, bulkBytes(p[0]), bulkBytes(p[1]))
		}
		return out, nil, nil
	case "HEXISTS":
		ok, err := s.hexistsTx(tx, args[1], []byte(args[2]))
		if err != nil {
			return nil, nil, err
		}
		if ok {
			return int64(1), nil, nil
		}
		return int64(0), nil, nil
	case "HKEYS":
		keys, err := s.hkeysTx(tx, args[1])
		if err != nil {
			return nil, nil, err
		}
		out := array{}
		for _, k := range keys {
			out = append(out, bulkBytes(k))
		}
		return out, nil, nil
	case "HMGET":
		out := make(array, 0, len(args)-2)
		for _, field := range args[2:] {
			v, err := s.hgetTx(tx, args[1], []byte(field))
			if errors.Is(err, sql.ErrNoRows) {
				out = append(out, nullBulk{})
				continue
			}
			if err != nil {
				return nil, nil, err
			}
			out = append(out, bulkBytes(v))
		}
		return out, nil, nil
	case "HLEN":
		n, err := s.hlenTx(tx, args[1])
		return n, nil, err
	default:
		return nil, nil, redisErr("ERR unsupported hash read command")
	}
}

func (s *Server) execListCmd(args []string) (any, error) {
	switch strings.ToUpper(args[0]) {
	case "RPUSH", "LPUSH", "RPUSHX":
		reply, _, err := s.store.withWriteList(args)
		return reply, err
	case "LRANGE":
		start, _ := strconv.Atoi(args[2])
		stop, _ := strconv.Atoi(args[3])
		vals, err := s.store.lrange(args[1], start, stop)
		if err != nil {
			return nil, err
		}
		out := make(array, 0, len(vals))
		for _, v := range vals {
			out = append(out, bulkBytes(v))
		}
		return out, nil
	case "LTRIM":
		reply, _, err := s.store.withWriteList(args)
		return reply, err
	case "LLEN":
		n, err := s.store.llen(args[1])
		return n, err
	default:
		return nil, redisErr("ERR unsupported list command")
	}
}

func (s *store) withWriteList(args []string) (any, []string, error) {
	var reply any
	var touched []string
	err := s.withWrite(func(tx *sql.Tx) error {
		var err error
		reply, touched, err = s.execListTx(tx, args)
		if err != nil {
			return err
		}
		return s.bumpRevisions(tx, touched)
	})
	return reply, touched, err
}

func (s *store) execListTx(tx *sql.Tx, args []string) (any, []string, error) {
	prefix, ino, idx, ok := parseChunkKey(args[1])
	if !ok {
		return nil, nil, redisErr("ERR unsupported list key")
	}
	_ = prefix
	items, exists, err := s.chunkSlicesTx(tx, ino, idx)
	if err != nil {
		return nil, nil, err
	}
	switch strings.ToUpper(args[0]) {
	case "RPUSH", "RPUSHX":
		if strings.ToUpper(args[0]) == "RPUSHX" && !exists {
			return int64(0), nil, nil
		}
		for _, item := range args[2:] {
			b := []byte(item)
			if len(b) != encodedSliceBytes {
				return nil, nil, redisErr("ERR invalid chunk slice length")
			}
			items = append(items, append([]byte(nil), b...))
		}
	case "LPUSH":
		for i := len(args) - 1; i >= 2; i-- {
			b := []byte(args[i])
			if len(b) != encodedSliceBytes {
				return nil, nil, redisErr("ERR invalid chunk slice length")
			}
			items = append([][]byte{append([]byte(nil), b...)}, items...)
		}
	case "LTRIM":
		start, _ := strconv.Atoi(args[2])
		stop, _ := strconv.Atoi(args[3])
		rng := sliceRange(len(items), start, stop)
		trimmed := make([][]byte, 0, len(rng))
		for _, i := range rng {
			trimmed = append(trimmed, items[i])
		}
		items = trimmed
	default:
		return nil, nil, redisErr("ERR unsupported list command")
	}
	if len(items) == 0 {
		if _, err := tx.Exec(`DELETE FROM chunk WHERE inode=? AND indx=?`, ino, idx); err != nil {
			return nil, nil, err
		}
	} else if err := s.putChunkTx(tx, ino, idx, items); err != nil {
		return nil, nil, err
	}
	switch strings.ToUpper(args[0]) {
	case "LTRIM":
		return simpleString("OK"), []string{args[1]}, nil
	default:
		return int64(len(items)), []string{args[1]}, nil
	}
}

func (s *Server) execSetCmd(args []string) (any, error) {
	switch strings.ToUpper(args[0]) {
	case "SADD":
		var added int64
		err := s.store.withWrite(func(tx *sql.Tx) error {
			var touched []string
			for _, member := range args[2:] {
				n, keys, err := s.store.saddTx(tx, args[1], []byte(member))
				if err != nil {
					return err
				}
				added += n
				touched = append(touched, keys...)
			}
			return s.store.bumpRevisions(tx, touched)
		})
		return added, err
	case "SREM":
		var total int64
		err := s.store.withWrite(func(tx *sql.Tx) error {
			var touched []string
			for _, member := range args[2:] {
				n, keys, err := s.store.sremTx(tx, args[1], []byte(member))
				if err != nil {
					return err
				}
				total += n
				touched = append(touched, keys...)
			}
			return s.store.bumpRevisions(tx, touched)
		})
		return total, err
	case "SMEMBERS":
		members, err := s.store.smembers(args[1])
		if err != nil {
			return nil, err
		}
		out := array{}
		for _, m := range members {
			out = append(out, bulkBytes(m))
		}
		return out, nil
	default:
		return nil, redisErr("ERR unsupported set command")
	}
}

func (s *Server) execSetTx(tx *sql.Tx, args []string) (any, []string, error) {
	switch strings.ToUpper(args[0]) {
	case "SADD":
		var added int64
		var touched []string
		for _, member := range args[2:] {
			n, keys, err := s.store.saddTx(tx, args[1], []byte(member))
			if err != nil {
				return nil, nil, err
			}
			added += n
			touched = append(touched, keys...)
		}
		return added, touched, nil
	case "SREM":
		var total int64
		var touched []string
		for _, member := range args[2:] {
			n, keys, err := s.store.sremTx(tx, args[1], []byte(member))
			if err != nil {
				return nil, nil, err
			}
			total += n
			touched = append(touched, keys...)
		}
		return total, touched, nil
	default:
		return nil, nil, redisErr("ERR unsupported set command")
	}
}

func (s *store) execSetTx(tx *sql.Tx, args []string) (any, []string, error) {
	switch strings.ToUpper(args[0]) {
	case "SADD":
		var added int64
		var touched []string
		for _, member := range args[2:] {
			n, keys, err := s.saddTx(tx, args[1], []byte(member))
			if err != nil {
				return nil, nil, err
			}
			added += n
			touched = append(touched, keys...)
		}
		return added, touched, nil
	case "SREM":
		var total int64
		var touched []string
		for _, member := range args[2:] {
			n, keys, err := s.sremTx(tx, args[1], []byte(member))
			if err != nil {
				return nil, nil, err
			}
			total += n
			touched = append(touched, keys...)
		}
		return total, touched, nil
	default:
		return nil, nil, redisErr("ERR unsupported set command")
	}
}

func (s *store) execSetReadTx(tx *sql.Tx, args []string) (any, []string, error) {
	members, err := s.smembersTx(tx, args[1])
	if err != nil {
		return nil, nil, err
	}
	out := array{}
	for _, m := range members {
		out = append(out, bulkBytes(m))
	}
	return out, nil, nil
}

func (s *Server) execZSetCmd(args []string) (any, error) {
	switch strings.ToUpper(args[0]) {
	case "ZADD":
		if len(args) < 4 || len(args)%2 != 0 {
			return nil, redisErr("ERR wrong number of arguments for 'zadd'")
		}
		var added int64
		err := s.store.withWrite(func(tx *sql.Tx) error {
			var touched []string
			for i := 2; i < len(args); i += 2 {
				score, err := strconv.ParseFloat(args[i], 64)
				if err != nil {
					return redisErr("ERR score is not a float")
				}
				n, keys, err := s.store.zaddTx(tx, args[1], args[i+1], score)
				if err != nil {
					return err
				}
				added += n
				touched = append(touched, keys...)
			}
			return s.store.bumpRevisions(tx, touched)
		})
		return added, err
	case "ZREM":
		var total int64
		err := s.store.withWrite(func(tx *sql.Tx) error {
			var touched []string
			for _, member := range args[2:] {
				n, keys, err := s.store.zremTx(tx, args[1], member)
				if err != nil {
					return err
				}
				total += n
				touched = append(touched, keys...)
			}
			return s.store.bumpRevisions(tx, touched)
		})
		return total, err
	case "ZRANGE":
		withScores := len(args) >= 5 && strings.ToUpper(args[4]) == "WITHSCORES"
		start, _ := strconv.Atoi(args[2])
		stop, _ := strconv.Atoi(args[3])
		return s.store.zrange(args[1], start, stop, withScores)
	case "ZRANGEBYSCORE":
		return s.store.zrangeByScore(args[1], args[2], args[3])
	case "ZSCORE":
		score, ok, err := s.store.zscore(args[1], args[2])
		if err != nil {
			return nil, err
		}
		if !ok {
			return nullBulk{}, nil
		}
		return bulkString(trimFloat(score)), nil
	case "ZRANGEWITHSCORES":
		return s.store.zrange(args[1], 0, -1, true)
	default:
		return nil, redisErr("ERR unsupported zset command")
	}
}

func (s *Server) execZSetTx(tx *sql.Tx, args []string) (any, []string, error) {
	switch strings.ToUpper(args[0]) {
	case "ZADD":
		var added int64
		var touched []string
		for i := 2; i < len(args); i += 2 {
			score, _ := strconv.ParseFloat(args[i], 64)
			n, keys, err := s.store.zaddTx(tx, args[1], args[i+1], score)
			if err != nil {
				return nil, nil, err
			}
			added += n
			touched = append(touched, keys...)
		}
		return added, touched, nil
	case "ZREM":
		var total int64
		var touched []string
		for _, member := range args[2:] {
			n, keys, err := s.store.zremTx(tx, args[1], member)
			if err != nil {
				return nil, nil, err
			}
			total += n
			touched = append(touched, keys...)
		}
		return total, touched, nil
	default:
		return nil, nil, redisErr("ERR unsupported zset command")
	}
}

func (s *store) execZSetTx(tx *sql.Tx, args []string) (any, []string, error) {
	switch strings.ToUpper(args[0]) {
	case "ZADD":
		var added int64
		var touched []string
		for i := 2; i < len(args); i += 2 {
			score, _ := strconv.ParseFloat(args[i], 64)
			n, keys, err := s.zaddTx(tx, args[1], args[i+1], score)
			if err != nil {
				return nil, nil, err
			}
			added += n
			touched = append(touched, keys...)
		}
		return added, touched, nil
	case "ZREM":
		var total int64
		var touched []string
		for _, member := range args[2:] {
			n, keys, err := s.zremTx(tx, args[1], member)
			if err != nil {
				return nil, nil, err
			}
			total += n
			touched = append(touched, keys...)
		}
		return total, touched, nil
	default:
		return nil, nil, redisErr("ERR unsupported zset command")
	}
}

func (s *store) execZSetReadTx(tx *sql.Tx, args []string) (any, []string, error) {
	switch strings.ToUpper(args[0]) {
	case "ZRANGE":
		withScores := len(args) >= 5 && strings.ToUpper(args[4]) == "WITHSCORES"
		start, _ := strconv.Atoi(args[2])
		stop, _ := strconv.Atoi(args[3])
		vals, err := s.zrangeTx(tx, args[1], start, stop, withScores)
		return vals, nil, err
	case "ZRANGEBYSCORE":
		vals, err := s.zrangeByScoreTx(tx, args[1], args[2], args[3])
		return vals, nil, err
	case "ZSCORE":
		score, ok, err := s.zscoreTx(tx, args[1], args[2])
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			return nullBulk{}, nil, nil
		}
		return bulkString(trimFloat(score)), nil, nil
	case "ZRANGEWITHSCORES":
		vals, err := s.zrangeTx(tx, args[1], 0, -1, true)
		return vals, nil, err
	default:
		return nil, nil, redisErr("ERR unsupported zset read command")
	}
}

func (s *store) execListReadTx(tx *sql.Tx, args []string) (any, []string, error) {
	switch strings.ToUpper(args[0]) {
	case "LRANGE":
		start, _ := strconv.Atoi(args[2])
		stop, _ := strconv.Atoi(args[3])
		vals, err := s.lrangeTx(tx, args[1], start, stop)
		if err != nil {
			return nil, nil, err
		}
		out := make(array, 0, len(vals))
		for _, v := range vals {
			out = append(out, bulkBytes(v))
		}
		return out, nil, nil
	case "LLEN":
		n, err := s.llenTx(tx, args[1])
		return n, nil, err
	default:
		return nil, nil, redisErr("ERR unsupported list read command")
	}
}

func (s *store) withWrite(fn func(tx *sql.Tx) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *store) getString(key string) ([]byte, error) {
	if _, ok := parseSettingKey(key); ok {
		var v []byte
		err := s.db.QueryRow(`SELECT value FROM setting WHERE name='format'`).Scan(&v)
		return v, err
	}
	if _, ino, ok := parseInodeKey(key); ok {
		var v []byte
		err := s.db.QueryRow(`SELECT attr_blob FROM inode WHERE inode=?`, ino).Scan(&v)
		return v, err
	}
	if _, ino, ok := parseSymlinkKey(key); ok {
		var v []byte
		err := s.db.QueryRow(`SELECT target FROM symlink WHERE inode=?`, ino).Scan(&v)
		return v, err
	}
	if name, ok := parseCounterKey(key); ok {
		var v int64
		err := s.db.QueryRow(`SELECT value FROM counter WHERE name=?`, name).Scan(&v)
		if err != nil {
			return nil, err
		}
		return []byte(strconv.FormatInt(v, 10)), nil
	}
	return nil, sql.ErrNoRows
}

func (s *store) getStringTx(tx *sql.Tx, key string) ([]byte, error) {
	if _, ok := parseSettingKey(key); ok {
		var v []byte
		err := tx.QueryRow(`SELECT value FROM setting WHERE name='format'`).Scan(&v)
		return v, err
	}
	if _, ino, ok := parseInodeKey(key); ok {
		var v []byte
		err := tx.QueryRow(`SELECT attr_blob FROM inode WHERE inode=?`, ino).Scan(&v)
		return v, err
	}
	if _, ino, ok := parseSymlinkKey(key); ok {
		var v []byte
		err := tx.QueryRow(`SELECT target FROM symlink WHERE inode=?`, ino).Scan(&v)
		return v, err
	}
	if name, ok := parseCounterKey(key); ok {
		var v int64
		err := tx.QueryRow(`SELECT value FROM counter WHERE name=?`, name).Scan(&v)
		if err != nil {
			return nil, err
		}
		return []byte(strconv.FormatInt(v, 10)), nil
	}
	return nil, sql.ErrNoRows
}

func (s *store) setStringTx(tx *sql.Tx, key string, value []byte, nx bool) (any, []string, error) {
	if _, ok := parseSettingKey(key); ok {
		if nx {
			var exists int
			err := tx.QueryRow(`SELECT 1 FROM setting WHERE name='format'`).Scan(&exists)
			if err == nil {
				return int64(0), nil, nil
			}
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, nil, err
			}
		}
		if _, err := tx.Exec(`INSERT INTO setting(name,value,updated_at) VALUES('format',?,strftime('%s','now')) ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, value); err != nil {
			return nil, nil, err
		}
		if nx {
			return int64(1), []string{key}, nil
		}
		return simpleString("OK"), []string{key}, nil
	}
	if _, ino, ok := parseInodeKey(key); ok {
		if nx {
			var exists int
			err := tx.QueryRow(`SELECT 1 FROM inode WHERE inode=?`, ino).Scan(&exists)
			if err == nil {
				return int64(0), nil, nil
			}
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, nil, err
			}
		}
		attr := meta.Attr{}
		attr.Unmarshal(value)
		rev, err := s.nextRevisionTx(tx)
		if err != nil {
			return nil, nil, err
		}
		if _, err := tx.Exec(`INSERT INTO inode(
			inode,type,flags,mode,uid,gid,atime,mtime,ctime,atimensec,mtimensec,ctimensec,nlink,length,rdev,parent,access_acl_id,default_acl_id,tier,attr_blob,revision
		) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(inode) DO UPDATE SET
			type=excluded.type, flags=excluded.flags, mode=excluded.mode, uid=excluded.uid, gid=excluded.gid,
			atime=excluded.atime, mtime=excluded.mtime, ctime=excluded.ctime,
			atimensec=excluded.atimensec, mtimensec=excluded.mtimensec, ctimensec=excluded.ctimensec,
			nlink=excluded.nlink, length=excluded.length, rdev=excluded.rdev, parent=excluded.parent,
			access_acl_id=excluded.access_acl_id, default_acl_id=excluded.default_acl_id, tier=excluded.tier,
			attr_blob=excluded.attr_blob, revision=excluded.revision`,
			ino, attr.Typ, attr.Flags, attr.Mode, attr.Uid, attr.Gid, attr.Atime, attr.Mtime, attr.Ctime,
			attr.Atimensec, attr.Mtimensec, attr.Ctimensec, attr.Nlink, attr.Length, attr.Rdev, attr.Parent,
			attr.AccessACL, attr.DefaultACL, attr.Tier, value, rev,
		); err != nil {
			return nil, nil, err
		}
		if nx {
			return int64(1), []string{key}, nil
		}
		return simpleString("OK"), []string{key}, nil
	}
	if _, ino, ok := parseSymlinkKey(key); ok {
		if nx {
			var exists int
			err := tx.QueryRow(`SELECT 1 FROM symlink WHERE inode=?`, ino).Scan(&exists)
			if err == nil {
				return int64(0), nil, nil
			}
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, nil, err
			}
		}
		rev, err := s.nextRevisionTx(tx)
		if err != nil {
			return nil, nil, err
		}
		if _, err := tx.Exec(`INSERT INTO symlink(inode,target,revision) VALUES(?,?,?) ON CONFLICT(inode) DO UPDATE SET target=excluded.target, revision=excluded.revision`, ino, value, rev); err != nil {
			return nil, nil, err
		}
		if nx {
			return int64(1), []string{key}, nil
		}
		return simpleString("OK"), []string{key}, nil
	}
	if name, ok := parseCounterKey(key); ok {
		n, err := strconv.ParseInt(string(value), 10, 64)
		if err != nil {
			return nil, nil, redisErr("ERR value is not an integer")
		}
		return s.setCounterNameTx(tx, key, name, n, nx)
	}
	return nil, nil, redisErr("ERR unsupported string key")
}

func (s *store) setCounterTx(tx *sql.Tx, key string, value int64) (any, []string, error) {
	name, ok := parseCounterKey(key)
	if !ok {
		return nil, nil, redisErr("ERR unsupported counter key")
	}
	return s.setCounterNameTx(tx, key, name, value, false)
}

func (s *store) setCounterNameTx(tx *sql.Tx, fullKey, name string, value int64, nx bool) (any, []string, error) {
	if nx {
		var exists int
		err := tx.QueryRow(`SELECT 1 FROM counter WHERE name=?`, name).Scan(&exists)
		if err == nil {
			return int64(0), nil, nil
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, nil, err
		}
	}
	if _, err := tx.Exec(`INSERT INTO counter(name,value,updated_at) VALUES(?,?,strftime('%s','now')) ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, name, value); err != nil {
		return nil, nil, err
	}
	if nx {
		return int64(1), []string{fullKey}, nil
	}
	return simpleString("OK"), []string{fullKey}, nil
}

func (s *store) getCounterTx(tx *sql.Tx, key string) (int64, error) {
	name, ok := parseCounterKey(key)
	if !ok {
		return 0, redisErr("ERR unsupported counter key")
	}
	var v int64
	err := tx.QueryRow(`SELECT value FROM counter WHERE name=?`, name).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return v, err
}

func (s *store) hget(key string, field []byte) ([]byte, error) {
	switch {
	case isDentryKey(key):
		_, parent, _ := parseDentryKey(key)
		var v []byte
		err := s.db.QueryRow(`SELECT entry_blob FROM dentry WHERE parent=? AND name=?`, parent, field).Scan(&v)
		return v, err
	case isXAttrKey(key):
		_, ino, _ := parseXAttrKey(key)
		var v []byte
		err := s.db.QueryRow(`SELECT value FROM xattr WHERE inode=? AND name=?`, ino, string(field)).Scan(&v)
		return v, err
	case isFlockKey(key):
		_, ino, _ := parseFlockKey(key)
		sid, owner, err := parseSidOwnerField(string(field))
		if err != nil {
			return nil, err
		}
		var ltype string
		err = s.db.QueryRow(`SELECT ltype FROM flock WHERE inode=? AND sid=? AND owner=?`, ino, sid, owner).Scan(&ltype)
		if err != nil {
			return nil, err
		}
		return []byte(ltype), nil
	case isPlockKey(key):
		_, ino, _ := parsePlockKey(key)
		sid, owner, err := parseSidOwnerField(string(field))
		if err != nil {
			return nil, err
		}
		var v []byte
		err = s.db.QueryRow(`SELECT records_blob FROM plock WHERE inode=? AND sid=? AND owner=?`, ino, sid, owner).Scan(&v)
		return v, err
	case isParentKey(key):
		_, ino, _ := parseParentKey(key)
		var cnt int64
		err := s.db.QueryRow(`SELECT cnt FROM parent_link WHERE inode=? AND parent=?`, ino, mustParseInt64(string(field))).Scan(&cnt)
		if err != nil {
			return nil, err
		}
		return []byte(strconv.FormatInt(cnt, 10)), nil
	case isSliceRefKey(key):
		id, size, err := parseSliceRefField(string(field))
		if err != nil {
			return nil, err
		}
		var refs int64
		err = s.db.QueryRow(`SELECT refs FROM slice_ref WHERE slice_id=? AND size=?`, id, size).Scan(&refs)
		if err != nil {
			return nil, err
		}
		return []byte(strconv.FormatInt(refs, 10)), nil
	case isSessionInfosKey(key):
		sid, err := strconv.ParseInt(string(field), 10, 64)
		if err != nil {
			return nil, err
		}
		var v []byte
		err = s.db.QueryRow(`SELECT info_blob FROM session WHERE sid=? AND info_blob IS NOT NULL`, sid).Scan(&v)
		return v, err
	case statFieldForKey(key) >= 0:
		sf := statFieldForKey(key)
		ino, err := strconv.ParseInt(string(field), 10, 64)
		if err != nil {
			return nil, err
		}
		var v int64
		query := `SELECT data_length FROM dir_stat WHERE inode=?`
		if sf == statUsedSpace {
			query = `SELECT used_space FROM dir_stat WHERE inode=?`
		} else if sf == statUsedInodes {
			query = `SELECT used_inodes FROM dir_stat WHERE inode=?`
		}
		err = s.db.QueryRow(query, ino).Scan(&v)
		if err != nil {
			return nil, err
		}
		return []byte(strconv.FormatInt(v, 10)), nil
	case isACLKey(key):
		var v []byte
		err := s.db.QueryRow(`SELECT rule FROM acl WHERE id=?`, string(field)).Scan(&v)
		return v, err
	case isKrbTokenKey(key):
		var v []byte
		err := s.db.QueryRow(`SELECT token FROM krb_token WHERE id=?`, string(field)).Scan(&v)
		return v, err
	case isDelSlicesKey(key):
		var v []byte
		err := s.db.QueryRow(`SELECT slices_blob FROM del_slice WHERE field_text=?`, string(field)).Scan(&v)
		return v, err
	default:
		if target, qfield, ok := quotaKeyInfo(key); ok {
			return s.getQuotaField(target, qfield, string(field))
		}
		return nil, sql.ErrNoRows
	}
}

func (s *store) hgetTx(tx *sql.Tx, key string, field []byte) ([]byte, error) {
	switch {
	case isDentryKey(key):
		_, parent, _ := parseDentryKey(key)
		var v []byte
		err := tx.QueryRow(`SELECT entry_blob FROM dentry WHERE parent=? AND name=?`, parent, field).Scan(&v)
		return v, err
	case isXAttrKey(key):
		_, ino, _ := parseXAttrKey(key)
		var v []byte
		err := tx.QueryRow(`SELECT value FROM xattr WHERE inode=? AND name=?`, ino, string(field)).Scan(&v)
		return v, err
	case isFlockKey(key):
		_, ino, _ := parseFlockKey(key)
		sid, owner, err := parseSidOwnerField(string(field))
		if err != nil {
			return nil, err
		}
		var ltype string
		err = tx.QueryRow(`SELECT ltype FROM flock WHERE inode=? AND sid=? AND owner=?`, ino, sid, owner).Scan(&ltype)
		if err != nil {
			return nil, err
		}
		return []byte(ltype), nil
	case isPlockKey(key):
		_, ino, _ := parsePlockKey(key)
		sid, owner, err := parseSidOwnerField(string(field))
		if err != nil {
			return nil, err
		}
		var v []byte
		err = tx.QueryRow(`SELECT records_blob FROM plock WHERE inode=? AND sid=? AND owner=?`, ino, sid, owner).Scan(&v)
		return v, err
	case isParentKey(key):
		_, ino, _ := parseParentKey(key)
		var cnt int64
		err := tx.QueryRow(`SELECT cnt FROM parent_link WHERE inode=? AND parent=?`, ino, mustParseInt64(string(field))).Scan(&cnt)
		if err != nil {
			return nil, err
		}
		return []byte(strconv.FormatInt(cnt, 10)), nil
	case isSliceRefKey(key):
		id, size, err := parseSliceRefField(string(field))
		if err != nil {
			return nil, err
		}
		var refs int64
		err = tx.QueryRow(`SELECT refs FROM slice_ref WHERE slice_id=? AND size=?`, id, size).Scan(&refs)
		if err != nil {
			return nil, err
		}
		return []byte(strconv.FormatInt(refs, 10)), nil
	case isSessionInfosKey(key):
		sid, err := strconv.ParseInt(string(field), 10, 64)
		if err != nil {
			return nil, err
		}
		var v []byte
		err = tx.QueryRow(`SELECT info_blob FROM session WHERE sid=? AND info_blob IS NOT NULL`, sid).Scan(&v)
		return v, err
	case statFieldForKey(key) >= 0:
		sf := statFieldForKey(key)
		ino, err := strconv.ParseInt(string(field), 10, 64)
		if err != nil {
			return nil, err
		}
		var v int64
		query := `SELECT data_length FROM dir_stat WHERE inode=?`
		if sf == statUsedSpace {
			query = `SELECT used_space FROM dir_stat WHERE inode=?`
		} else if sf == statUsedInodes {
			query = `SELECT used_inodes FROM dir_stat WHERE inode=?`
		}
		err = tx.QueryRow(query, ino).Scan(&v)
		if err != nil {
			return nil, err
		}
		return []byte(strconv.FormatInt(v, 10)), nil
	case isACLKey(key):
		var v []byte
		err := tx.QueryRow(`SELECT rule FROM acl WHERE id=?`, string(field)).Scan(&v)
		return v, err
	case isKrbTokenKey(key):
		var v []byte
		err := tx.QueryRow(`SELECT token FROM krb_token WHERE id=?`, string(field)).Scan(&v)
		return v, err
	case isDelSlicesKey(key):
		var v []byte
		err := tx.QueryRow(`SELECT slices_blob FROM del_slice WHERE field_text=?`, string(field)).Scan(&v)
		return v, err
	default:
		if target, qfield, ok := quotaKeyInfo(key); ok {
			return s.getQuotaFieldTx(tx, target, qfield, string(field))
		}
		return nil, sql.ErrNoRows
	}
}

func (s *store) hexists(key string, field []byte) (bool, error) {
	_, err := s.hget(key, field)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *store) hexistsTx(tx *sql.Tx, key string, field []byte) (bool, error) {
	_, err := s.hgetTx(tx, key, field)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *store) hsetFieldTx(tx *sql.Tx, key string, field, value []byte, nx bool) (int64, []string, error) {
	rev, err := s.nextRevisionTx(tx)
	if err != nil {
		return 0, nil, err
	}
	switch {
	case isDentryKey(key):
		_, parent, _ := parseDentryKey(key)
		typ, ino, err := decodeEntryBlob(value)
		if err != nil {
			return 0, nil, err
		}
		var oldIno sql.NullInt64
		err = tx.QueryRow(`SELECT inode FROM dentry WHERE parent=? AND name=?`, parent, field).Scan(&oldIno)
		exists := err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return 0, nil, err
		}
		if nx && exists {
			return 0, nil, nil
		}
		if _, err := tx.Exec(`INSERT INTO dentry(parent,name,inode,type,entry_blob,revision) VALUES(?,?,?,?,?,?)
			ON CONFLICT(parent,name) DO UPDATE SET inode=excluded.inode, type=excluded.type, entry_blob=excluded.entry_blob, revision=excluded.revision`,
			parent, field, ino, typ, value, rev); err != nil {
			return 0, nil, err
		}
		if !exists {
			return 1, []string{key}, nil
		}
		if oldIno.Valid && oldIno.Int64 != ino {
			return 0, []string{key}, nil
		}
		return 0, []string{key}, nil
	case isXAttrKey(key):
		_, ino, _ := parseXAttrKey(key)
		exists, err := rowExistsTx(tx, `SELECT 1 FROM xattr WHERE inode=? AND name=?`, ino, string(field))
		if err != nil {
			return 0, nil, err
		}
		if nx && exists {
			return 0, nil, nil
		}
		if _, err := tx.Exec(`INSERT INTO xattr(inode,name,value,revision) VALUES(?,?,?,?)
			ON CONFLICT(inode,name) DO UPDATE SET value=excluded.value, revision=excluded.revision`, ino, string(field), value, rev); err != nil {
			return 0, nil, err
		}
		if exists {
			return 0, []string{key}, nil
		}
		return 1, []string{key}, nil
	case isSliceRefKey(key):
		id, size, err := parseSliceRefField(string(field))
		if err != nil {
			return 0, nil, err
		}
		exists, err := rowExistsTx(tx, `SELECT 1 FROM slice_ref WHERE slice_id=? AND size=?`, id, size)
		if err != nil {
			return 0, nil, err
		}
		if nx && exists {
			return 0, nil, nil
		}
		refs := mustParseInt64(string(value))
		if _, err := tx.Exec(`INSERT INTO slice_ref(slice_id,size,refs,revision) VALUES(?,?,?,?)
			ON CONFLICT(slice_id,size) DO UPDATE SET refs=excluded.refs, revision=excluded.revision`, id, size, refs, rev); err != nil {
			return 0, nil, err
		}
		if exists {
			return 0, []string{key}, nil
		}
		return 1, []string{key}, nil
	case isFlockKey(key):
		_, ino, _ := parseFlockKey(key)
		sid, owner, err := parseSidOwnerField(string(field))
		if err != nil {
			return 0, nil, err
		}
		exists, err := rowExistsTx(tx, `SELECT 1 FROM flock WHERE inode=? AND sid=? AND owner=?`, ino, sid, owner)
		if err != nil {
			return 0, nil, err
		}
		if nx && exists {
			return 0, nil, nil
		}
		ltype := string(value)
		if ltype != "R" && ltype != "W" {
			return 0, nil, redisErr("ERR invalid flock type")
		}
		if _, err := tx.Exec(`INSERT INTO flock(inode,sid,owner,ltype,revision) VALUES(?,?,?,?,?)
			ON CONFLICT(inode,sid,owner) DO UPDATE SET ltype=excluded.ltype, revision=excluded.revision`, ino, sid, owner, ltype, rev); err != nil {
			return 0, nil, err
		}
		if _, err := tx.Exec(`INSERT INTO session_locked(sid,lock_kind,inode,owner,revision) VALUES(?,?,?,?,?)
			ON CONFLICT(sid,lock_kind,inode,owner) DO UPDATE SET revision=excluded.revision`, sid, "lockf", ino, owner, rev); err != nil {
			return 0, nil, err
		}
		if exists {
			return 0, []string{key, lockedKeyFromParsed(key, sid)}, nil
		}
		return 1, []string{key, lockedKeyFromParsed(key, sid)}, nil
	case isPlockKey(key):
		_, ino, _ := parsePlockKey(key)
		sid, owner, err := parseSidOwnerField(string(field))
		if err != nil {
			return 0, nil, err
		}
		exists, err := rowExistsTx(tx, `SELECT 1 FROM plock WHERE inode=? AND sid=? AND owner=?`, ino, sid, owner)
		if err != nil {
			return 0, nil, err
		}
		if nx && exists {
			return 0, nil, nil
		}
		if _, err := tx.Exec(`INSERT INTO plock(inode,sid,owner,records_blob,revision) VALUES(?,?,?,?,?)
			ON CONFLICT(inode,sid,owner) DO UPDATE SET records_blob=excluded.records_blob, revision=excluded.revision`, ino, sid, owner, value, rev); err != nil {
			return 0, nil, err
		}
		if _, err := tx.Exec(`INSERT INTO session_locked(sid,lock_kind,inode,owner,revision) VALUES(?,?,?,?,?)
			ON CONFLICT(sid,lock_kind,inode,owner) DO UPDATE SET revision=excluded.revision`, sid, "lockp", ino, owner, rev); err != nil {
			return 0, nil, err
		}
		if exists {
			return 0, []string{key, lockedKeyFromParsed(key, sid)}, nil
		}
		return 1, []string{key, lockedKeyFromParsed(key, sid)}, nil
	case isParentKey(key):
		_, ino, _ := parseParentKey(key)
		parent := mustParseInt64(string(field))
		exists, err := rowExistsTx(tx, `SELECT 1 FROM parent_link WHERE inode=? AND parent=?`, ino, parent)
		if err != nil {
			return 0, nil, err
		}
		if nx && exists {
			return 0, nil, nil
		}
		cnt := mustParseInt64(string(value))
		if cnt == 0 {
			if _, err := tx.Exec(`DELETE FROM parent_link WHERE inode=? AND parent=?`, ino, parent); err != nil {
				return 0, nil, err
			}
		} else if _, err := tx.Exec(`INSERT INTO parent_link(inode,parent,cnt,revision) VALUES(?,?,?,?)
			ON CONFLICT(inode,parent) DO UPDATE SET cnt=excluded.cnt, revision=excluded.revision`, ino, parent, cnt, rev); err != nil {
			return 0, nil, err
		}
		if exists {
			return 0, []string{key}, nil
		}
		return 1, []string{key}, nil
	case isSessionInfosKey(key):
		sid := mustParseInt64(string(field))
		exists, err := rowExistsTx(tx, `SELECT 1 FROM session WHERE sid=? AND info_blob IS NOT NULL`, sid)
		if err != nil {
			return 0, nil, err
		}
		if nx && exists {
			return 0, nil, nil
		}
		if _, err := tx.Exec(`INSERT INTO session(sid,expire_at,info_blob,revision) VALUES(?,COALESCE((SELECT expire_at FROM session WHERE sid=?),-1),?,?)
			ON CONFLICT(sid) DO UPDATE SET info_blob=excluded.info_blob, revision=excluded.revision`, sid, sid, value, rev); err != nil {
			return 0, nil, err
		}
		if exists {
			return 0, []string{key}, nil
		}
		return 1, []string{key}, nil
	case statFieldForKey(key) >= 0:
		return s.setDirStatFieldTx(tx, key, string(field), mustParseInt64(string(value)), nx)
	case isACLKey(key):
		exists, err := rowExistsTx(tx, `SELECT 1 FROM acl WHERE id=?`, string(field))
		if err != nil {
			return 0, nil, err
		}
		if nx && exists {
			return 0, nil, nil
		}
		if _, err := tx.Exec(`INSERT INTO acl(id,rule,revision) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET rule=excluded.rule, revision=excluded.revision`, string(field), value, rev); err != nil {
			return 0, nil, err
		}
		if exists {
			return 0, []string{key}, nil
		}
		return 1, []string{key}, nil
	case isKrbTokenKey(key):
		exists, err := rowExistsTx(tx, `SELECT 1 FROM krb_token WHERE id=?`, string(field))
		if err != nil {
			return 0, nil, err
		}
		if nx && exists {
			return 0, nil, nil
		}
		if _, err := tx.Exec(`INSERT INTO krb_token(id,token,revision) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token, revision=excluded.revision`, string(field), value, rev); err != nil {
			return 0, nil, err
		}
		if exists {
			return 0, []string{key}, nil
		}
		return 1, []string{key}, nil
	case isDelSlicesKey(key):
		sliceID, deletedAt, err := parseDelayedSliceField(string(field))
		if err != nil {
			return 0, nil, err
		}
		exists, err := rowExistsTx(tx, `SELECT 1 FROM del_slice WHERE field_text=?`, string(field))
		if err != nil {
			return 0, nil, err
		}
		if nx && exists {
			return 0, nil, nil
		}
		if _, err := tx.Exec(`INSERT INTO del_slice(field_text,slice_id,deleted_at,slices_blob,revision) VALUES(?,?,?,?,?)
			ON CONFLICT(field_text) DO UPDATE SET slice_id=excluded.slice_id, deleted_at=excluded.deleted_at, slices_blob=excluded.slices_blob, revision=excluded.revision`,
			string(field), sliceID, deletedAt, value, rev); err != nil {
			return 0, nil, err
		}
		if exists {
			return 0, []string{key}, nil
		}
		return 1, []string{key}, nil
	default:
		if target, qfield, ok := quotaKeyInfo(key); ok {
			return s.setQuotaFieldTx(tx, key, target, qfield, string(field), value, nx)
		}
		return 0, nil, redisErr("ERR unsupported hash key")
	}
}

func (s *store) hdelFieldTx(tx *sql.Tx, key string, field []byte) (int64, []string, error) {
	switch {
	case isDentryKey(key):
		_, parent, _ := parseDentryKey(key)
		var ino int64
		err := tx.QueryRow(`SELECT inode FROM dentry WHERE parent=? AND name=?`, parent, field).Scan(&ino)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil, nil
		}
		if err != nil {
			return 0, nil, err
		}
		if _, err := tx.Exec(`DELETE FROM dentry WHERE parent=? AND name=?`, parent, field); err != nil {
			return 0, nil, err
		}
		_ = ino
		return 1, []string{key}, nil
	case isXAttrKey(key):
		_, ino, _ := parseXAttrKey(key)
		res, err := tx.Exec(`DELETE FROM xattr WHERE inode=? AND name=?`, ino, string(field))
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return 0, nil, nil
		}
		return n, []string{key}, nil
	case isSliceRefKey(key):
		id, size, err := parseSliceRefField(string(field))
		if err != nil {
			return 0, nil, err
		}
		res, err := tx.Exec(`DELETE FROM slice_ref WHERE slice_id=? AND size=?`, id, size)
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return 0, nil, nil
		}
		return n, []string{key}, nil
	case isFlockKey(key):
		_, ino, _ := parseFlockKey(key)
		sid, owner, err := parseSidOwnerField(string(field))
		if err != nil {
			return 0, nil, err
		}
		res, err := tx.Exec(`DELETE FROM flock WHERE inode=? AND sid=? AND owner=?`, ino, sid, owner)
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return 0, nil, nil
		}
		if _, err := tx.Exec(`DELETE FROM session_locked WHERE sid=? AND lock_kind='lockf' AND inode=? AND owner=?`, sid, ino, owner); err != nil {
			return 0, nil, err
		}
		return n, []string{key, lockedKeyFromParsed(key, sid)}, nil
	case isPlockKey(key):
		_, ino, _ := parsePlockKey(key)
		sid, owner, err := parseSidOwnerField(string(field))
		if err != nil {
			return 0, nil, err
		}
		res, err := tx.Exec(`DELETE FROM plock WHERE inode=? AND sid=? AND owner=?`, ino, sid, owner)
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return 0, nil, nil
		}
		if _, err := tx.Exec(`DELETE FROM session_locked WHERE sid=? AND lock_kind='lockp' AND inode=? AND owner=?`, sid, ino, owner); err != nil {
			return 0, nil, err
		}
		return n, []string{key, lockedKeyFromParsed(key, sid)}, nil
	case isParentKey(key):
		_, ino, _ := parseParentKey(key)
		res, err := tx.Exec(`DELETE FROM parent_link WHERE inode=? AND parent=?`, ino, mustParseInt64(string(field)))
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return 0, nil, nil
		}
		return n, []string{key}, nil
	case isSessionInfosKey(key):
		sid := mustParseInt64(string(field))
		res, err := tx.Exec(`UPDATE session SET info_blob=NULL WHERE sid=? AND info_blob IS NOT NULL`, sid)
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		return n, []string{key}, nil
	case statFieldForKey(key) >= 0:
		return s.delDirStatFieldTx(tx, key, string(field))
	case isACLKey(key):
		res, err := tx.Exec(`DELETE FROM acl WHERE id=?`, string(field))
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		return n, []string{key}, nil
	case isKrbTokenKey(key):
		res, err := tx.Exec(`DELETE FROM krb_token WHERE id=?`, string(field))
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		return n, []string{key}, nil
	case isDelSlicesKey(key):
		res, err := tx.Exec(`DELETE FROM del_slice WHERE field_text=?`, string(field))
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		return n, []string{key}, nil
	default:
		if target, qfield, ok := quotaKeyInfo(key); ok {
			return s.delQuotaFieldTx(tx, key, target, qfield, string(field))
		}
		return 0, nil, redisErr("ERR unsupported hash key")
	}
}

func (s *store) hincrbyTx(tx *sql.Tx, key string, field []byte, delta int64) (int64, []string, error) {
	rev, err := s.nextRevisionTx(tx)
	if err != nil {
		return 0, nil, err
	}
	switch {
	case isParentKey(key):
		_, ino, _ := parseParentKey(key)
		parent := mustParseInt64(string(field))
		var cur int64
		err := tx.QueryRow(`SELECT cnt FROM parent_link WHERE inode=? AND parent=?`, ino, parent).Scan(&cur)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return 0, nil, err
		}
		cur += delta
		if cur == 0 {
			if _, err := tx.Exec(`DELETE FROM parent_link WHERE inode=? AND parent=?`, ino, parent); err != nil {
				return 0, nil, err
			}
		} else if _, err := tx.Exec(`INSERT INTO parent_link(inode,parent,cnt,revision) VALUES(?,?,?,?)
			ON CONFLICT(inode,parent) DO UPDATE SET cnt=excluded.cnt, revision=excluded.revision`, ino, parent, cur, rev); err != nil {
			return 0, nil, err
		}
		return cur, []string{key}, nil
	case isSliceRefKey(key):
		id, size, err := parseSliceRefField(string(field))
		if err != nil {
			return 0, nil, err
		}
		var cur int64
		err = tx.QueryRow(`SELECT refs FROM slice_ref WHERE slice_id=? AND size=?`, id, size).Scan(&cur)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return 0, nil, err
		}
		cur += delta
		if _, err := tx.Exec(`INSERT INTO slice_ref(slice_id,size,refs,revision) VALUES(?,?,?,?)
			ON CONFLICT(slice_id,size) DO UPDATE SET refs=excluded.refs, revision=excluded.revision`, id, size, cur, rev); err != nil {
			return 0, nil, err
		}
		return cur, []string{key}, nil
	case statFieldForKey(key) >= 0:
		return s.incrDirStatFieldTx(tx, key, string(field), delta)
	default:
		if target, qfield, ok := quotaKeyInfo(key); ok && qfield != quotaConfig {
			return s.incrQuotaFieldTx(tx, key, target, qfield, string(field), delta)
		}
		return 0, nil, redisErr("ERR unsupported hash key")
	}
}

func (s *store) hgetall(key string) ([][2][]byte, error) {
	switch {
	case isDentryKey(key):
		_, parent, _ := parseDentryKey(key)
		rows, err := s.db.Query(`SELECT name,entry_blob FROM dentry WHERE parent=? ORDER BY name`, parent)
		return scanPairRows(rows, err)
	case isXAttrKey(key):
		_, ino, _ := parseXAttrKey(key)
		rows, err := s.db.Query(`SELECT name,value FROM xattr WHERE inode=? ORDER BY name`, ino)
		return scanStringBlobRows(rows, err)
	case isSliceRefKey(key):
		rows, err := s.db.Query(`SELECT slice_id,size,refs FROM slice_ref ORDER BY slice_id,size`)
		return scanSliceRefRows(rows, err)
	case isFlockKey(key):
		_, ino, _ := parseFlockKey(key)
		rows, err := s.db.Query(`SELECT sid,owner,ltype FROM flock WHERE inode=? ORDER BY sid,owner`, ino)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out [][2][]byte
		for rows.Next() {
			var sid int64
			var owner int64
			var ltype string
			if err := rows.Scan(&sid, &owner, &ltype); err != nil {
				return nil, err
			}
			field := fmt.Sprintf("%d_%016X", sid, uint64(owner))
			out = append(out, [2][]byte{[]byte(field), []byte(ltype)})
		}
		return out, rows.Err()
	case isPlockKey(key):
		_, ino, _ := parsePlockKey(key)
		rows, err := s.db.Query(`SELECT sid,owner,records_blob FROM plock WHERE inode=? ORDER BY sid,owner`, ino)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out [][2][]byte
		for rows.Next() {
			var sid int64
			var owner int64
			var blob []byte
			if err := rows.Scan(&sid, &owner, &blob); err != nil {
				return nil, err
			}
			field := fmt.Sprintf("%d_%016X", sid, uint64(owner))
			out = append(out, [2][]byte{[]byte(field), blob})
		}
		return out, rows.Err()
	case isParentKey(key):
		_, ino, _ := parseParentKey(key)
		rows, err := s.db.Query(`SELECT parent,cnt FROM parent_link WHERE inode=? ORDER BY parent`, ino)
		return scanIntPairs(rows, err)
	case isSessionInfosKey(key):
		rows, err := s.db.Query(`SELECT sid,info_blob FROM session WHERE info_blob IS NOT NULL ORDER BY sid`)
		return scanIntBlobRows(rows, err)
	case statFieldForKey(key) >= 0:
		sf := statFieldForKey(key)
		col := "data_length"
		if sf == statUsedSpace {
			col = "used_space"
		} else if sf == statUsedInodes {
			col = "used_inodes"
		}
		rows, err := s.db.Query(fmt.Sprintf(`SELECT inode,%s FROM dir_stat ORDER BY inode`, col))
		return scanIntPairs(rows, err)
	case isACLKey(key):
		rows, err := s.db.Query(`SELECT id,rule FROM acl ORDER BY id`)
		return scanStringBlobRows(rows, err)
	case isKrbTokenKey(key):
		rows, err := s.db.Query(`SELECT id,token FROM krb_token ORDER BY id`)
		return scanStringBlobRows(rows, err)
	case isDelSlicesKey(key):
		rows, err := s.db.Query(`SELECT field_text,slices_blob FROM del_slice ORDER BY field_text`)
		return scanStringBlobRows(rows, err)
	default:
		if target, qfield, ok := quotaKeyInfo(key); ok {
			return s.getAllQuota(target, qfield)
		}
		return nil, redisErr("ERR unsupported hash key")
	}
}

func (s *store) hgetallTx(tx *sql.Tx, key string) ([][2][]byte, error) {
	switch {
	case isDentryKey(key):
		_, parent, _ := parseDentryKey(key)
		rows, err := tx.Query(`SELECT name,entry_blob FROM dentry WHERE parent=? ORDER BY name`, parent)
		return scanPairRows(rows, err)
	case isXAttrKey(key):
		_, ino, _ := parseXAttrKey(key)
		rows, err := tx.Query(`SELECT name,value FROM xattr WHERE inode=? ORDER BY name`, ino)
		return scanStringBlobRows(rows, err)
	case isSliceRefKey(key):
		rows, err := tx.Query(`SELECT slice_id,size,refs FROM slice_ref ORDER BY slice_id,size`)
		return scanSliceRefRows(rows, err)
	case isFlockKey(key):
		_, ino, _ := parseFlockKey(key)
		rows, err := tx.Query(`SELECT sid,owner,ltype FROM flock WHERE inode=? ORDER BY sid,owner`, ino)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out [][2][]byte
		for rows.Next() {
			var sid int64
			var owner int64
			var ltype string
			if err := rows.Scan(&sid, &owner, &ltype); err != nil {
				return nil, err
			}
			field := fmt.Sprintf("%d_%016X", sid, uint64(owner))
			out = append(out, [2][]byte{[]byte(field), []byte(ltype)})
		}
		return out, rows.Err()
	case isPlockKey(key):
		_, ino, _ := parsePlockKey(key)
		rows, err := tx.Query(`SELECT sid,owner,records_blob FROM plock WHERE inode=? ORDER BY sid,owner`, ino)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out [][2][]byte
		for rows.Next() {
			var sid int64
			var owner int64
			var blob []byte
			if err := rows.Scan(&sid, &owner, &blob); err != nil {
				return nil, err
			}
			field := fmt.Sprintf("%d_%016X", sid, uint64(owner))
			out = append(out, [2][]byte{[]byte(field), blob})
		}
		return out, rows.Err()
	case isParentKey(key):
		_, ino, _ := parseParentKey(key)
		rows, err := tx.Query(`SELECT parent,cnt FROM parent_link WHERE inode=? ORDER BY parent`, ino)
		return scanIntPairs(rows, err)
	case isSessionInfosKey(key):
		rows, err := tx.Query(`SELECT sid,info_blob FROM session WHERE info_blob IS NOT NULL ORDER BY sid`)
		return scanIntBlobRows(rows, err)
	case statFieldForKey(key) >= 0:
		sf := statFieldForKey(key)
		col := "data_length"
		if sf == statUsedSpace {
			col = "used_space"
		} else if sf == statUsedInodes {
			col = "used_inodes"
		}
		rows, err := tx.Query(fmt.Sprintf(`SELECT inode,%s FROM dir_stat ORDER BY inode`, col))
		return scanIntPairs(rows, err)
	case isACLKey(key):
		rows, err := tx.Query(`SELECT id,rule FROM acl ORDER BY id`)
		return scanStringBlobRows(rows, err)
	case isKrbTokenKey(key):
		rows, err := tx.Query(`SELECT id,token FROM krb_token ORDER BY id`)
		return scanStringBlobRows(rows, err)
	case isDelSlicesKey(key):
		rows, err := tx.Query(`SELECT field_text,slices_blob FROM del_slice ORDER BY field_text`)
		return scanStringBlobRows(rows, err)
	default:
		if target, qfield, ok := quotaKeyInfo(key); ok {
			return s.getAllQuotaTx(tx, target, qfield)
		}
		return nil, redisErr("ERR unsupported hash key")
	}
}

func (s *store) hkeys(key string) ([][]byte, error) {
	pairs, err := s.hgetall(key)
	if err != nil {
		return nil, err
	}
	out := make([][]byte, 0, len(pairs))
	for _, p := range pairs {
		out = append(out, p[0])
	}
	return out, nil
}

func (s *store) hkeysTx(tx *sql.Tx, key string) ([][]byte, error) {
	pairs, err := s.hgetallTx(tx, key)
	if err != nil {
		return nil, err
	}
	out := make([][]byte, 0, len(pairs))
	for _, p := range pairs {
		out = append(out, p[0])
	}
	return out, nil
}

func (s *store) hscan(key string, cursor int64, match string, count int) (int64, [][2][]byte, error) {
	pairs, err := s.hgetall(key)
	if err != nil {
		return 0, nil, err
	}
	filtered := make([][2][]byte, 0, len(pairs))
	for _, p := range pairs {
		ok, _ := path.Match(match, string(p[0]))
		if ok {
			filtered = append(filtered, p)
		}
	}
	if cursor >= int64(len(filtered)) {
		return 0, nil, nil
	}
	end := int(cursor) + count
	if end > len(filtered) {
		end = len(filtered)
	}
	next := int64(0)
	if end < len(filtered) {
		next = int64(end)
	}
	return next, filtered[cursor:end], nil
}

func (s *store) hlen(key string) (int64, error) {
	pairs, err := s.hgetall(key)
	if err != nil {
		return 0, err
	}
	return int64(len(pairs)), nil
}

func (s *store) hlenTx(tx *sql.Tx, key string) (int64, error) {
	pairs, err := s.hgetallTx(tx, key)
	if err != nil {
		return 0, err
	}
	return int64(len(pairs)), nil
}

func (s *store) lrange(key string, start, stop int) ([][]byte, error) {
	_, ino, idx, ok := parseChunkKey(key)
	if !ok {
		return nil, redisErr("ERR unsupported list key")
	}
	items, _, err := s.chunkSlices(ino, idx)
	if err != nil {
		return nil, err
	}
	rng := sliceRange(len(items), start, stop)
	out := make([][]byte, 0, len(rng))
	for _, i := range rng {
		out = append(out, items[i])
	}
	return out, nil
}

func (s *store) lrangeTx(tx *sql.Tx, key string, start, stop int) ([][]byte, error) {
	_, ino, idx, ok := parseChunkKey(key)
	if !ok {
		return nil, redisErr("ERR unsupported list key")
	}
	items, _, err := s.chunkSlicesTx(tx, ino, idx)
	if err != nil {
		return nil, err
	}
	rng := sliceRange(len(items), start, stop)
	out := make([][]byte, 0, len(rng))
	for _, i := range rng {
		out = append(out, items[i])
	}
	return out, nil
}

func (s *store) llen(key string) (int64, error) {
	_, ino, idx, ok := parseChunkKey(key)
	if !ok {
		return 0, redisErr("ERR unsupported list key")
	}
	items, _, err := s.chunkSlices(ino, idx)
	if err != nil {
		return 0, err
	}
	return int64(len(items)), nil
}

func (s *store) llenTx(tx *sql.Tx, key string) (int64, error) {
	_, ino, idx, ok := parseChunkKey(key)
	if !ok {
		return 0, redisErr("ERR unsupported list key")
	}
	items, _, err := s.chunkSlicesTx(tx, ino, idx)
	if err != nil {
		return 0, err
	}
	return int64(len(items)), nil
}

func (s *store) saddTx(tx *sql.Tx, key string, member []byte) (int64, []string, error) {
	rev, err := s.nextRevisionTx(tx)
	if err != nil {
		return 0, nil, err
	}
	switch {
	case isSustainedKey(key):
		_, sid, _ := parseSustainedKey(key)
		ino := mustParseInt64(string(member))
		res, err := tx.Exec(`INSERT OR IGNORE INTO session_sustained_inode(sid,inode,revision) VALUES(?,?,?)`, sid, ino, rev)
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return 0, nil, nil
		}
		return n, []string{key}, nil
	case isLockedSetKey(key):
		prefix, sid, _ := parseLockedKey(key)
		lockKind, inode, err := parseLockMember(prefix, string(member))
		if err != nil {
			return 0, nil, err
		}
		res, err := tx.Exec(`INSERT OR IGNORE INTO session_locked(sid,lock_kind,inode,owner,revision) VALUES(?,?,?,?,?)`, sid, lockKind, inode, 0, rev)
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return 0, nil, nil
		}
		return n, []string{key}, nil
	default:
		return 0, nil, redisErr("ERR unsupported set key")
	}
}

func (s *store) sremTx(tx *sql.Tx, key string, member []byte) (int64, []string, error) {
	switch {
	case isSustainedKey(key):
		_, sid, _ := parseSustainedKey(key)
		res, err := tx.Exec(`DELETE FROM session_sustained_inode WHERE sid=? AND inode=?`, sid, mustParseInt64(string(member)))
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return 0, nil, nil
		}
		return n, []string{key}, nil
	case isLockedSetKey(key):
		prefix, sid, _ := parseLockedKey(key)
		lockKind, inode, err := parseLockMember(prefix, string(member))
		if err != nil {
			return 0, nil, err
		}
		res, err := tx.Exec(`DELETE FROM session_locked WHERE sid=? AND lock_kind=? AND inode=?`, sid, lockKind, inode)
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return 0, nil, nil
		}
		return n, []string{key}, nil
	default:
		return 0, nil, redisErr("ERR unsupported set key")
	}
}

func (s *store) smembers(key string) ([][]byte, error) {
	switch {
	case isSustainedKey(key):
		_, sid, _ := parseSustainedKey(key)
		rows, err := s.db.Query(`SELECT inode FROM session_sustained_inode WHERE sid=? ORDER BY inode`, sid)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out [][]byte
		for rows.Next() {
			var ino int64
			if err := rows.Scan(&ino); err != nil {
				return nil, err
			}
			out = append(out, []byte(strconv.FormatInt(ino, 10)))
		}
		return out, rows.Err()
	case isLockedSetKey(key):
		prefix, sid, _ := parseLockedKey(key)
		rows, err := s.db.Query(`SELECT DISTINCT lock_kind,inode FROM session_locked WHERE sid=? ORDER BY lock_kind,inode`, sid)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out [][]byte
		for rows.Next() {
			var kind string
			var ino int64
			if err := rows.Scan(&kind, &ino); err != nil {
				return nil, err
			}
			name := "lockf"
			if kind == "lockp" {
				name = "lockp"
			}
			out = append(out, []byte(prefix+name+strconv.FormatInt(ino, 10)))
		}
		return out, rows.Err()
	default:
		return nil, redisErr("ERR unsupported set key")
	}
}

func (s *store) smembersTx(tx *sql.Tx, key string) ([][]byte, error) {
	switch {
	case isSustainedKey(key):
		_, sid, _ := parseSustainedKey(key)
		rows, err := tx.Query(`SELECT inode FROM session_sustained_inode WHERE sid=? ORDER BY inode`, sid)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out [][]byte
		for rows.Next() {
			var ino int64
			if err := rows.Scan(&ino); err != nil {
				return nil, err
			}
			out = append(out, []byte(strconv.FormatInt(ino, 10)))
		}
		return out, rows.Err()
	case isLockedSetKey(key):
		prefix, sid, _ := parseLockedKey(key)
		rows, err := tx.Query(`SELECT DISTINCT lock_kind,inode FROM session_locked WHERE sid=? ORDER BY lock_kind,inode`, sid)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out [][]byte
		for rows.Next() {
			var kind string
			var ino int64
			if err := rows.Scan(&kind, &ino); err != nil {
				return nil, err
			}
			name := "lockf"
			if kind == "lockp" {
				name = "lockp"
			}
			out = append(out, []byte(prefix+name+strconv.FormatInt(ino, 10)))
		}
		return out, rows.Err()
	default:
		return nil, redisErr("ERR unsupported set key")
	}
}

func (s *store) zaddTx(tx *sql.Tx, key, member string, score float64) (int64, []string, error) {
	rev, err := s.nextRevisionTx(tx)
	if err != nil {
		return 0, nil, err
	}
	switch {
	case isAllSessionsKey(key):
		sid, err := strconv.ParseInt(member, 10, 64)
		if err != nil {
			return 0, nil, err
		}
		exists, err := rowExistsTx(tx, `SELECT 1 FROM session WHERE sid=? AND expire_at>=0`, sid)
		if err != nil {
			return 0, nil, err
		}
		if _, err := tx.Exec(`INSERT INTO session(sid,expire_at,info_blob,revision) VALUES(?,?,(SELECT info_blob FROM session WHERE sid=?),?)
			ON CONFLICT(sid) DO UPDATE SET expire_at=excluded.expire_at, revision=excluded.revision`, sid, int64(score), sid, rev); err != nil {
			return 0, nil, err
		}
		if exists {
			return 0, []string{key}, nil
		}
		return 1, []string{key}, nil
	case isLegacySessionsKey(key):
		sid, err := strconv.ParseInt(member, 10, 64)
		if err != nil {
			return 0, nil, err
		}
		exists, err := rowExistsTx(tx, `SELECT 1 FROM legacy_session WHERE sid=?`, sid)
		if err != nil {
			return 0, nil, err
		}
		if _, err := tx.Exec(`INSERT INTO legacy_session(sid,expire_at,revision) VALUES(?,?,?)
			ON CONFLICT(sid) DO UPDATE SET expire_at=excluded.expire_at, revision=excluded.revision`, sid, int64(score), rev); err != nil {
			return 0, nil, err
		}
		if exists {
			return 0, []string{key}, nil
		}
		return 1, []string{key}, nil
	case isDelfilesKey(key):
		inode, length, err := parseDeleteMember(member)
		if err != nil {
			return 0, nil, err
		}
		exists, err := rowExistsTx(tx, `SELECT 1 FROM deleted_file_queue WHERE member_text=?`, member)
		if err != nil {
			return 0, nil, err
		}
		if _, err := tx.Exec(`INSERT INTO deleted_file_queue(member_text,inode,length,expire_at,revision) VALUES(?,?,?,?,?)
			ON CONFLICT(member_text) DO UPDATE SET inode=excluded.inode, length=excluded.length, expire_at=excluded.expire_at, revision=excluded.revision`,
			member, inode, length, int64(score), rev); err != nil {
			return 0, nil, err
		}
		if exists {
			return 0, []string{key}, nil
		}
		return 1, []string{key}, nil
	case isDetachedNodesKey(key):
		inode, err := strconv.ParseInt(member, 10, 64)
		if err != nil {
			return 0, nil, err
		}
		exists, err := rowExistsTx(tx, `SELECT 1 FROM detached_node WHERE inode=?`, inode)
		if err != nil {
			return 0, nil, err
		}
		if _, err := tx.Exec(`INSERT INTO detached_node(inode,added_at,revision) VALUES(?,?,?)
			ON CONFLICT(inode) DO UPDATE SET added_at=excluded.added_at, revision=excluded.revision`, inode, int64(score), rev); err != nil {
			return 0, nil, err
		}
		if exists {
			return 0, []string{key}, nil
		}
		return 1, []string{key}, nil
	default:
		return 0, nil, redisErr("ERR unsupported zset key")
	}
}

func (s *store) zremTx(tx *sql.Tx, key, member string) (int64, []string, error) {
	switch {
	case isAllSessionsKey(key):
		sid, err := strconv.ParseInt(member, 10, 64)
		if err != nil {
			return 0, nil, err
		}
		res, err := tx.Exec(`UPDATE session SET expire_at=-1 WHERE sid=? AND expire_at>=0`, sid)
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		return n, []string{key}, nil
	case isLegacySessionsKey(key):
		sid, err := strconv.ParseInt(member, 10, 64)
		if err != nil {
			return 0, nil, err
		}
		res, err := tx.Exec(`DELETE FROM legacy_session WHERE sid=?`, sid)
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		return n, []string{key}, nil
	case isDelfilesKey(key):
		res, err := tx.Exec(`DELETE FROM deleted_file_queue WHERE member_text=?`, member)
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		return n, []string{key}, nil
	case isDetachedNodesKey(key):
		inode, err := strconv.ParseInt(member, 10, 64)
		if err != nil {
			return 0, nil, err
		}
		res, err := tx.Exec(`DELETE FROM detached_node WHERE inode=?`, inode)
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		return n, []string{key}, nil
	default:
		return 0, nil, redisErr("ERR unsupported zset key")
	}
}

func (s *store) zrange(key string, start, stop int, withScores bool) (any, error) {
	type item struct {
		member string
		score  float64
	}
	var vals []item
	switch {
	case isAllSessionsKey(key):
		rows, err := s.db.Query(`SELECT sid,expire_at FROM session WHERE expire_at>=0 ORDER BY expire_at, sid`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var sid, exp int64
			if err := rows.Scan(&sid, &exp); err != nil {
				return nil, err
			}
			vals = append(vals, item{member: strconv.FormatInt(sid, 10), score: float64(exp)})
		}
	case isLegacySessionsKey(key):
		rows, err := s.db.Query(`SELECT sid,expire_at FROM legacy_session ORDER BY expire_at, sid`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var sid, exp int64
			if err := rows.Scan(&sid, &exp); err != nil {
				return nil, err
			}
			vals = append(vals, item{member: strconv.FormatInt(sid, 10), score: float64(exp)})
		}
	case isDelfilesKey(key):
		rows, err := s.db.Query(`SELECT member_text,expire_at FROM deleted_file_queue ORDER BY expire_at, member_text`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var member string
			var exp int64
			if err := rows.Scan(&member, &exp); err != nil {
				return nil, err
			}
			vals = append(vals, item{member: member, score: float64(exp)})
		}
	case isDetachedNodesKey(key):
		rows, err := s.db.Query(`SELECT inode,added_at FROM detached_node ORDER BY added_at, inode`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var inode, added int64
			if err := rows.Scan(&inode, &added); err != nil {
				return nil, err
			}
			vals = append(vals, item{member: strconv.FormatInt(inode, 10), score: float64(added)})
		}
	default:
		return nil, redisErr("ERR unsupported zset key")
	}
	out := array{}
	for _, i := range sliceRange(len(vals), start, stop) {
		out = append(out, bulkString(vals[i].member))
		if withScores {
			out = append(out, bulkString(trimFloat(vals[i].score)))
		}
	}
	return out, nil
}

func (s *store) zrangeTx(tx *sql.Tx, key string, start, stop int, withScores bool) (any, error) {
	type item struct {
		member string
		score  float64
	}
	var vals []item
	switch {
	case isAllSessionsKey(key):
		rows, err := tx.Query(`SELECT sid,expire_at FROM session WHERE expire_at>=0 ORDER BY expire_at, sid`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var sid, exp int64
			if err := rows.Scan(&sid, &exp); err != nil {
				return nil, err
			}
			vals = append(vals, item{member: strconv.FormatInt(sid, 10), score: float64(exp)})
		}
	case isLegacySessionsKey(key):
		rows, err := tx.Query(`SELECT sid,expire_at FROM legacy_session ORDER BY expire_at, sid`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var sid, exp int64
			if err := rows.Scan(&sid, &exp); err != nil {
				return nil, err
			}
			vals = append(vals, item{member: strconv.FormatInt(sid, 10), score: float64(exp)})
		}
	case isDelfilesKey(key):
		rows, err := tx.Query(`SELECT member_text,expire_at FROM deleted_file_queue ORDER BY expire_at, member_text`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var member string
			var exp int64
			if err := rows.Scan(&member, &exp); err != nil {
				return nil, err
			}
			vals = append(vals, item{member: member, score: float64(exp)})
		}
	case isDetachedNodesKey(key):
		rows, err := tx.Query(`SELECT inode,added_at FROM detached_node ORDER BY added_at, inode`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var inode, added int64
			if err := rows.Scan(&inode, &added); err != nil {
				return nil, err
			}
			vals = append(vals, item{member: strconv.FormatInt(inode, 10), score: float64(added)})
		}
	default:
		return nil, redisErr("ERR unsupported zset key")
	}
	out := array{}
	for _, i := range sliceRange(len(vals), start, stop) {
		out = append(out, bulkString(vals[i].member))
		if withScores {
			out = append(out, bulkString(trimFloat(vals[i].score)))
		}
	}
	return out, nil
}

func (s *store) zrangeByScore(key, min, max string) (any, error) {
	minf, err := parseScore(min, false)
	if err != nil {
		return nil, err
	}
	maxf, err := parseScore(max, true)
	if err != nil {
		return nil, err
	}
	vals, err := s.zrange(key, 0, -1, true)
	if err != nil {
		return nil, err
	}
	in := vals.(array)
	out := array{}
	for i := 0; i < len(in); i += 2 {
		member := in[i].(bulkString)
		score, _ := strconv.ParseFloat(string(in[i+1].(bulkString)), 64)
		if score >= minf && score <= maxf {
			out = append(out, member)
		}
	}
	return out, nil
}

func (s *store) zrangeByScoreTx(tx *sql.Tx, key, min, max string) (any, error) {
	minf, err := parseScore(min, false)
	if err != nil {
		return nil, err
	}
	maxf, err := parseScore(max, true)
	if err != nil {
		return nil, err
	}
	vals, err := s.zrangeTx(tx, key, 0, -1, true)
	if err != nil {
		return nil, err
	}
	in := vals.(array)
	out := array{}
	for i := 0; i < len(in); i += 2 {
		member := in[i].(bulkString)
		score, _ := strconv.ParseFloat(string(in[i+1].(bulkString)), 64)
		if score >= minf && score <= maxf {
			out = append(out, member)
		}
	}
	return out, nil
}

func (s *store) zscore(key, member string) (float64, bool, error) {
	switch {
	case isAllSessionsKey(key):
		var exp int64
		err := s.db.QueryRow(`SELECT expire_at FROM session WHERE sid=? AND expire_at>=0`, mustParseInt64(member)).Scan(&exp)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, false, nil
		}
		return float64(exp), err == nil, err
	case isLegacySessionsKey(key):
		var exp int64
		err := s.db.QueryRow(`SELECT expire_at FROM legacy_session WHERE sid=?`, mustParseInt64(member)).Scan(&exp)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, false, nil
		}
		return float64(exp), err == nil, err
	case isDelfilesKey(key):
		var exp int64
		err := s.db.QueryRow(`SELECT expire_at FROM deleted_file_queue WHERE member_text=?`, member).Scan(&exp)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, false, nil
		}
		return float64(exp), err == nil, err
	case isDetachedNodesKey(key):
		var added int64
		err := s.db.QueryRow(`SELECT added_at FROM detached_node WHERE inode=?`, mustParseInt64(member)).Scan(&added)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, false, nil
		}
		return float64(added), err == nil, err
	default:
		return 0, false, redisErr("ERR unsupported zset key")
	}
}

func (s *store) zscoreTx(tx *sql.Tx, key, member string) (float64, bool, error) {
	switch {
	case isAllSessionsKey(key):
		var exp int64
		err := tx.QueryRow(`SELECT expire_at FROM session WHERE sid=? AND expire_at>=0`, mustParseInt64(member)).Scan(&exp)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, false, nil
		}
		return float64(exp), err == nil, err
	case isLegacySessionsKey(key):
		var exp int64
		err := tx.QueryRow(`SELECT expire_at FROM legacy_session WHERE sid=?`, mustParseInt64(member)).Scan(&exp)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, false, nil
		}
		return float64(exp), err == nil, err
	case isDelfilesKey(key):
		var exp int64
		err := tx.QueryRow(`SELECT expire_at FROM deleted_file_queue WHERE member_text=?`, member).Scan(&exp)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, false, nil
		}
		return float64(exp), err == nil, err
	case isDetachedNodesKey(key):
		var added int64
		err := tx.QueryRow(`SELECT added_at FROM detached_node WHERE inode=?`, mustParseInt64(member)).Scan(&added)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, false, nil
		}
		return float64(added), err == nil, err
	default:
		return 0, false, redisErr("ERR unsupported zset key")
	}
}

func (s *store) scanKeys(cursor int64, match string, count int) (int64, []string, error) {
	rows, err := s.db.Query(`SELECT rkey FROM key_revision ORDER BY rkey`)
	if err != nil {
		return 0, nil, err
	}
	var keys []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return 0, nil, err
		}
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, nil, err
	}
	rows.Close()
	var all []string
	for _, key := range keys {
		ok, _ := path.Match(match, key)
		if !ok {
			continue
		}
		exists, err := s.keyExists(key)
		if err != nil {
			return 0, nil, err
		}
		if exists {
			all = append(all, key)
		}
	}
	if cursor >= int64(len(all)) {
		return 0, nil, nil
	}
	end := int(cursor) + count
	if end > len(all) {
		end = len(all)
	}
	next := int64(0)
	if end < len(all) {
		next = int64(end)
	}
	return next, all[cursor:end], nil
}

func (s *store) keyExists(key string) (bool, error) {
	switch {
	case isSettingKey(key):
		return rowExists(s.db, `SELECT 1 FROM setting WHERE name='format'`)
	case isInodeKey(key):
		_, ino, _ := parseInodeKey(key)
		return rowExists(s.db, `SELECT 1 FROM inode WHERE inode=?`, ino)
	case isSymlinkKey(key):
		_, ino, _ := parseSymlinkKey(key)
		return rowExists(s.db, `SELECT 1 FROM symlink WHERE inode=?`, ino)
	case isCounterStringKey(key):
		name, _ := parseCounterKey(key)
		return rowExists(s.db, `SELECT 1 FROM counter WHERE name=?`, name)
	case isDentryKey(key):
		_, parent, _ := parseDentryKey(key)
		return rowExists(s.db, `SELECT 1 FROM dentry WHERE parent=? LIMIT 1`, parent)
	case isXAttrKey(key):
		_, ino, _ := parseXAttrKey(key)
		return rowExists(s.db, `SELECT 1 FROM xattr WHERE inode=? LIMIT 1`, ino)
	case isParentKey(key):
		_, ino, _ := parseParentKey(key)
		return rowExists(s.db, `SELECT 1 FROM parent_link WHERE inode=? LIMIT 1`, ino)
	case isChunkKey(key):
		_, ino, idx, _ := parseChunkKey(key)
		return rowExists(s.db, `SELECT 1 FROM chunk WHERE inode=? AND indx=?`, ino, idx)
	case isSustainedKey(key):
		_, sid, _ := parseSustainedKey(key)
		return rowExists(s.db, `SELECT 1 FROM session_sustained_inode WHERE sid=? LIMIT 1`, sid)
	case isLockedSetKey(key):
		_, sid, _ := parseLockedKey(key)
		return rowExists(s.db, `SELECT 1 FROM session_locked WHERE sid=? LIMIT 1`, sid)
	case isAllSessionsKey(key):
		return rowExists(s.db, `SELECT 1 FROM session WHERE expire_at>=0 LIMIT 1`)
	case isLegacySessionsKey(key):
		return rowExists(s.db, `SELECT 1 FROM legacy_session WHERE expire_at>=0 LIMIT 1`)
	case isSessionInfosKey(key):
		return rowExists(s.db, `SELECT 1 FROM session WHERE info_blob IS NOT NULL LIMIT 1`)
	case isSliceRefKey(key):
		return rowExists(s.db, `SELECT 1 FROM slice_ref LIMIT 1`)
	case isDelfilesKey(key):
		return rowExists(s.db, `SELECT 1 FROM deleted_file_queue LIMIT 1`)
	case isDetachedNodesKey(key):
		return rowExists(s.db, `SELECT 1 FROM detached_node LIMIT 1`)
	case statFieldForKey(key) >= 0:
		return rowExists(s.db, `SELECT 1 FROM dir_stat LIMIT 1`)
	case isACLKey(key):
		return rowExists(s.db, `SELECT 1 FROM acl LIMIT 1`)
	case isKrbTokenKey(key):
		return rowExists(s.db, `SELECT 1 FROM krb_token LIMIT 1`)
	case isDelSlicesKey(key):
		return rowExists(s.db, `SELECT 1 FROM del_slice LIMIT 1`)
	default:
		if target, _, ok := quotaKeyInfo(key); ok {
			table := quotaTable(target)
			return rowExists(s.db, fmt.Sprintf(`SELECT 1 FROM %s LIMIT 1`, table))
		}
		return false, nil
	}
}

func (s *store) keyExistsTx(tx *sql.Tx, key string) (bool, error) {
	switch {
	case isSettingKey(key):
		return rowExistsTx(tx, `SELECT 1 FROM setting WHERE name='format'`)
	case isInodeKey(key):
		_, ino, _ := parseInodeKey(key)
		return rowExistsTx(tx, `SELECT 1 FROM inode WHERE inode=?`, ino)
	case isSymlinkKey(key):
		_, ino, _ := parseSymlinkKey(key)
		return rowExistsTx(tx, `SELECT 1 FROM symlink WHERE inode=?`, ino)
	case isCounterStringKey(key):
		name, _ := parseCounterKey(key)
		return rowExistsTx(tx, `SELECT 1 FROM counter WHERE name=?`, name)
	case isDentryKey(key):
		_, parent, _ := parseDentryKey(key)
		return rowExistsTx(tx, `SELECT 1 FROM dentry WHERE parent=? LIMIT 1`, parent)
	case isXAttrKey(key):
		_, ino, _ := parseXAttrKey(key)
		return rowExistsTx(tx, `SELECT 1 FROM xattr WHERE inode=? LIMIT 1`, ino)
	case isParentKey(key):
		_, ino, _ := parseParentKey(key)
		return rowExistsTx(tx, `SELECT 1 FROM parent_link WHERE inode=? LIMIT 1`, ino)
	case isChunkKey(key):
		_, ino, idx, _ := parseChunkKey(key)
		return rowExistsTx(tx, `SELECT 1 FROM chunk WHERE inode=? AND indx=?`, ino, idx)
	case isSustainedKey(key):
		_, sid, _ := parseSustainedKey(key)
		return rowExistsTx(tx, `SELECT 1 FROM session_sustained_inode WHERE sid=? LIMIT 1`, sid)
	case isLockedSetKey(key):
		_, sid, _ := parseLockedKey(key)
		return rowExistsTx(tx, `SELECT 1 FROM session_locked WHERE sid=? LIMIT 1`, sid)
	case isAllSessionsKey(key):
		return rowExistsTx(tx, `SELECT 1 FROM session WHERE expire_at>=0 LIMIT 1`)
	case isLegacySessionsKey(key):
		return rowExistsTx(tx, `SELECT 1 FROM legacy_session WHERE expire_at>=0 LIMIT 1`)
	case isSessionInfosKey(key):
		return rowExistsTx(tx, `SELECT 1 FROM session WHERE info_blob IS NOT NULL LIMIT 1`)
	case isSliceRefKey(key):
		return rowExistsTx(tx, `SELECT 1 FROM slice_ref LIMIT 1`)
	case isDelfilesKey(key):
		return rowExistsTx(tx, `SELECT 1 FROM deleted_file_queue LIMIT 1`)
	case isDetachedNodesKey(key):
		return rowExistsTx(tx, `SELECT 1 FROM detached_node LIMIT 1`)
	case statFieldForKey(key) >= 0:
		return rowExistsTx(tx, `SELECT 1 FROM dir_stat LIMIT 1`)
	case isACLKey(key):
		return rowExistsTx(tx, `SELECT 1 FROM acl LIMIT 1`)
	case isKrbTokenKey(key):
		return rowExistsTx(tx, `SELECT 1 FROM krb_token LIMIT 1`)
	case isDelSlicesKey(key):
		return rowExistsTx(tx, `SELECT 1 FROM del_slice LIMIT 1`)
	default:
		if target, _, ok := quotaKeyInfo(key); ok {
			table := quotaTable(target)
			return rowExistsTx(tx, fmt.Sprintf(`SELECT 1 FROM %s LIMIT 1`, table))
		}
		return false, nil
	}
}

func (s *store) deleteKeyTx(tx *sql.Tx, key string) (int64, []string, error) {
	switch {
	case isSettingKey(key):
		res, err := tx.Exec(`DELETE FROM setting WHERE name='format'`)
		return deleteResult(res, err, key)
	case isInodeKey(key):
		_, ino, _ := parseInodeKey(key)
		res, err := tx.Exec(`DELETE FROM inode WHERE inode=?`, ino)
		return deleteResult(res, err, key)
	case isSymlinkKey(key):
		_, ino, _ := parseSymlinkKey(key)
		res, err := tx.Exec(`DELETE FROM symlink WHERE inode=?`, ino)
		return deleteResult(res, err, key)
	case isCounterStringKey(key):
		name, _ := parseCounterKey(key)
		res, err := tx.Exec(`DELETE FROM counter WHERE name=?`, name)
		return deleteResult(res, err, key)
	case isDentryKey(key):
		_, parent, _ := parseDentryKey(key)
		res, err := tx.Exec(`DELETE FROM dentry WHERE parent=?`, parent)
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		return n, []string{key}, nil
	case isXAttrKey(key):
		_, ino, _ := parseXAttrKey(key)
		res, err := tx.Exec(`DELETE FROM xattr WHERE inode=?`, ino)
		return deleteResult(res, err, key)
	case isParentKey(key):
		_, ino, _ := parseParentKey(key)
		res, err := tx.Exec(`DELETE FROM parent_link WHERE inode=?`, ino)
		return deleteResult(res, err, key)
	case isChunkKey(key):
		_, ino, idx, _ := parseChunkKey(key)
		res, err := tx.Exec(`DELETE FROM chunk WHERE inode=? AND indx=?`, ino, idx)
		return deleteResult(res, err, key)
	case isSustainedKey(key):
		_, sid, _ := parseSustainedKey(key)
		res, err := tx.Exec(`DELETE FROM session_sustained_inode WHERE sid=?`, sid)
		return deleteResult(res, err, key)
	case isLockedSetKey(key):
		_, sid, _ := parseLockedKey(key)
		res, err := tx.Exec(`DELETE FROM session_locked WHERE sid=?`, sid)
		return deleteResult(res, err, key)
	case isAllSessionsKey(key):
		res, err := tx.Exec(`UPDATE session SET expire_at=-1 WHERE expire_at>=0`)
		return deleteResult(res, err, key)
	case isLegacySessionsKey(key):
		res, err := tx.Exec(`DELETE FROM legacy_session`)
		return deleteResult(res, err, key)
	case isSessionInfosKey(key):
		res, err := tx.Exec(`UPDATE session SET info_blob=NULL WHERE info_blob IS NOT NULL`)
		return deleteResult(res, err, key)
	case isSliceRefKey(key):
		res, err := tx.Exec(`DELETE FROM slice_ref`)
		return deleteResult(res, err, key)
	case isDelfilesKey(key):
		res, err := tx.Exec(`DELETE FROM deleted_file_queue`)
		return deleteResult(res, err, key)
	case isDetachedNodesKey(key):
		res, err := tx.Exec(`DELETE FROM detached_node`)
		return deleteResult(res, err, key)
	case statFieldForKey(key) >= 0:
		sf := statFieldForKey(key)
		col := "data_length"
		if sf == statUsedSpace {
			col = "used_space"
		} else if sf == statUsedInodes {
			col = "used_inodes"
		}
		res, err := tx.Exec(fmt.Sprintf(`UPDATE dir_stat SET %s=0 WHERE %s!=0`, col, col))
		return deleteResult(res, err, key)
	case isACLKey(key):
		res, err := tx.Exec(`DELETE FROM acl`)
		return deleteResult(res, err, key)
	case isKrbTokenKey(key):
		res, err := tx.Exec(`DELETE FROM krb_token`)
		return deleteResult(res, err, key)
	case isDelSlicesKey(key):
		res, err := tx.Exec(`DELETE FROM del_slice`)
		return deleteResult(res, err, key)
	default:
		if target, _, ok := quotaKeyInfo(key); ok {
			res, err := tx.Exec(`DELETE FROM ` + quotaTable(target))
			return deleteResult(res, err, key)
		}
		return 0, nil, nil
	}
}

func (s *store) nextRevisionTx(tx *sql.Tx) (int64, error) {
	var cur int64
	err := tx.QueryRow(`SELECT value FROM counter WHERE name='txn_revision'`).Scan(&cur)
	if errors.Is(err, sql.ErrNoRows) {
		return 1, nil
	}
	if err != nil {
		return 0, err
	}
	return cur + 1, nil
}

func (s *store) chunkSlices(ino, idx int64) ([][]byte, bool, error) {
	var buf []byte
	err := s.db.QueryRow(`SELECT slices_blob FROM chunk WHERE inode=? AND indx=?`, ino, idx).Scan(&buf)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	items, err := decodeChunkList(buf)
	return items, true, err
}

func (s *store) chunkSlicesTx(tx *sql.Tx, ino, idx int64) ([][]byte, bool, error) {
	var buf []byte
	err := tx.QueryRow(`SELECT slices_blob FROM chunk WHERE inode=? AND indx=?`, ino, idx).Scan(&buf)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	items, err := decodeChunkList(buf)
	return items, true, err
}

func (s *store) putChunkTx(tx *sql.Tx, ino, idx int64, items [][]byte) error {
	rev, err := s.nextRevisionTx(tx)
	if err != nil {
		return err
	}
	var buf []byte
	for _, item := range items {
		buf = append(buf, item...)
	}
	_, err = tx.Exec(`INSERT INTO chunk(inode,indx,slices_blob,revision) VALUES(?,?,?,?)
		ON CONFLICT(inode,indx) DO UPDATE SET slices_blob=excluded.slices_blob, revision=excluded.revision`, ino, idx, buf, rev)
	return err
}

func (s *store) adjustParentLinkTx(tx *sql.Tx, ino, parent, delta, rev int64) error {
	var cur int64
	err := tx.QueryRow(`SELECT cnt FROM parent_link WHERE inode=? AND parent=?`, ino, parent).Scan(&cur)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	cur += delta
	if cur <= 0 {
		_, err = tx.Exec(`DELETE FROM parent_link WHERE inode=? AND parent=?`, ino, parent)
		return err
	}
	_, err = tx.Exec(`INSERT INTO parent_link(inode,parent,cnt,revision) VALUES(?,?,?,?)
		ON CONFLICT(inode,parent) DO UPDATE SET cnt=excluded.cnt, revision=excluded.revision`, ino, parent, cur, rev)
	return err
}

func (s *store) setDirStatFieldTx(tx *sql.Tx, key, field string, value int64, nx bool) (int64, []string, error) {
	rev, err := s.nextRevisionTx(tx)
	if err != nil {
		return 0, nil, err
	}
	ino := mustParseInt64(field)
	exists, err := rowExistsTx(tx, `SELECT 1 FROM dir_stat WHERE inode=?`, ino)
	if err != nil {
		return 0, nil, err
	}
	if nx && exists {
		return 0, nil, nil
	}
	dataLength, usedSpace, usedInodes := int64(0), int64(0), int64(0)
	if exists {
		if err := tx.QueryRow(`SELECT data_length,used_space,used_inodes FROM dir_stat WHERE inode=?`, ino).Scan(&dataLength, &usedSpace, &usedInodes); err != nil {
			return 0, nil, err
		}
	}
	switch statFieldForKey(key) {
	case statDataLength:
		dataLength = value
	case statUsedSpace:
		usedSpace = value
	case statUsedInodes:
		usedInodes = value
	}
	if _, err := tx.Exec(`INSERT INTO dir_stat(inode,data_length,used_space,used_inodes,revision) VALUES(?,?,?,?,?)
		ON CONFLICT(inode) DO UPDATE SET data_length=excluded.data_length, used_space=excluded.used_space, used_inodes=excluded.used_inodes, revision=excluded.revision`,
		ino, dataLength, usedSpace, usedInodes, rev); err != nil {
		return 0, nil, err
	}
	if exists {
		return 0, []string{key}, nil
	}
	return 1, []string{key}, nil
}

func (s *store) incrDirStatFieldTx(tx *sql.Tx, key, field string, delta int64) (int64, []string, error) {
	rev, err := s.nextRevisionTx(tx)
	if err != nil {
		return 0, nil, err
	}
	ino := mustParseInt64(field)
	dataLength, usedSpace, usedInodes := int64(0), int64(0), int64(0)
	_ = tx.QueryRow(`SELECT data_length,used_space,used_inodes FROM dir_stat WHERE inode=?`, ino).Scan(&dataLength, &usedSpace, &usedInodes)
	var out int64
	switch statFieldForKey(key) {
	case statDataLength:
		dataLength += delta
		out = dataLength
	case statUsedSpace:
		usedSpace += delta
		out = usedSpace
	case statUsedInodes:
		usedInodes += delta
		out = usedInodes
	}
	if _, err := tx.Exec(`INSERT INTO dir_stat(inode,data_length,used_space,used_inodes,revision) VALUES(?,?,?,?,?)
		ON CONFLICT(inode) DO UPDATE SET data_length=excluded.data_length, used_space=excluded.used_space, used_inodes=excluded.used_inodes, revision=excluded.revision`,
		ino, dataLength, usedSpace, usedInodes, rev); err != nil {
		return 0, nil, err
	}
	return out, []string{key}, nil
}

func (s *store) delDirStatFieldTx(tx *sql.Tx, key, field string) (int64, []string, error) {
	sf := statFieldForKey(key)
	col := "data_length"
	if sf == statUsedSpace {
		col = "used_space"
	} else if sf == statUsedInodes {
		col = "used_inodes"
	}
	res, err := tx.Exec(fmt.Sprintf(`UPDATE dir_stat SET %s=0 WHERE inode=? AND %s!=0`, col, col), mustParseInt64(field))
	if err != nil {
		return 0, nil, err
	}
	n, _ := res.RowsAffected()
	return n, []string{key}, nil
}

func (s *store) setQuotaFieldTx(tx *sql.Tx, key string, target quotaTarget, field quotaField, entity string, value []byte, nx bool) (int64, []string, error) {
	rev, err := s.nextRevisionTx(tx)
	if err != nil {
		return 0, nil, err
	}
	id := mustParseInt64(entity)
	table := quotaTable(target)
	idcol := quotaIDColumn(target)
	exists, err := rowExistsTx(tx, fmt.Sprintf(`SELECT 1 FROM %s WHERE %s=?`, table, idcol), id)
	if err != nil {
		return 0, nil, err
	}
	if nx && exists {
		return 0, nil, nil
	}
	maxSpace, maxInodes, usedSpace, usedInodes := int64(0), int64(0), int64(0), int64(0)
	if exists {
		if err := tx.QueryRow(fmt.Sprintf(`SELECT max_space,max_inodes,used_space,used_inodes FROM %s WHERE %s=?`, table, idcol), id).Scan(&maxSpace, &maxInodes, &usedSpace, &usedInodes); err != nil {
			return 0, nil, err
		}
	}
	switch field {
	case quotaConfig:
		maxSpace, maxInodes = decodeQuotaBlob(value)
	case quotaUsedSpace:
		usedSpace = mustParseInt64(string(value))
	case quotaUsedInodes:
		usedInodes = mustParseInt64(string(value))
	}
	if _, err := tx.Exec(fmt.Sprintf(`INSERT INTO %s(%s,max_space,max_inodes,used_space,used_inodes,revision) VALUES(?,?,?,?,?,?)
		ON CONFLICT(%s) DO UPDATE SET max_space=excluded.max_space, max_inodes=excluded.max_inodes, used_space=excluded.used_space, used_inodes=excluded.used_inodes, revision=excluded.revision`,
		table, idcol, idcol), id, maxSpace, maxInodes, usedSpace, usedInodes, rev); err != nil {
		return 0, nil, err
	}
	if exists {
		return 0, []string{key}, nil
	}
	return 1, []string{key}, nil
}

func (s *store) incrQuotaFieldTx(tx *sql.Tx, key string, target quotaTarget, field quotaField, entity string, delta int64) (int64, []string, error) {
	rev, err := s.nextRevisionTx(tx)
	if err != nil {
		return 0, nil, err
	}
	id := mustParseInt64(entity)
	table := quotaTable(target)
	idcol := quotaIDColumn(target)
	maxSpace, maxInodes, usedSpace, usedInodes := int64(0), int64(0), int64(0), int64(0)
	_ = tx.QueryRow(fmt.Sprintf(`SELECT max_space,max_inodes,used_space,used_inodes FROM %s WHERE %s=?`, table, idcol), id).Scan(&maxSpace, &maxInodes, &usedSpace, &usedInodes)
	var out int64
	if field == quotaUsedSpace {
		usedSpace += delta
		out = usedSpace
	} else {
		usedInodes += delta
		out = usedInodes
	}
	if _, err := tx.Exec(fmt.Sprintf(`INSERT INTO %s(%s,max_space,max_inodes,used_space,used_inodes,revision) VALUES(?,?,?,?,?,?)
		ON CONFLICT(%s) DO UPDATE SET max_space=excluded.max_space, max_inodes=excluded.max_inodes, used_space=excluded.used_space, used_inodes=excluded.used_inodes, revision=excluded.revision`,
		table, idcol, idcol), id, maxSpace, maxInodes, usedSpace, usedInodes, rev); err != nil {
		return 0, nil, err
	}
	return out, []string{key}, nil
}

func (s *store) delQuotaFieldTx(tx *sql.Tx, key string, target quotaTarget, field quotaField, entity string) (int64, []string, error) {
	id := mustParseInt64(entity)
	table := quotaTable(target)
	idcol := quotaIDColumn(target)
	if field == quotaConfig {
		res, err := tx.Exec(fmt.Sprintf(`DELETE FROM %s WHERE %s=?`, table, idcol), id)
		if err != nil {
			return 0, nil, err
		}
		n, _ := res.RowsAffected()
		return n, []string{key}, nil
	}
	col := "used_space"
	if field == quotaUsedInodes {
		col = "used_inodes"
	}
	res, err := tx.Exec(fmt.Sprintf(`UPDATE %s SET %s=0 WHERE %s=? AND %s!=0`, table, col, idcol, col), id)
	if err != nil {
		return 0, nil, err
	}
	n, _ := res.RowsAffected()
	return n, []string{key}, nil
}

func (s *store) getQuotaField(target quotaTarget, field quotaField, entity string) ([]byte, error) {
	id := mustParseInt64(entity)
	table := quotaTable(target)
	idcol := quotaIDColumn(target)
	switch field {
	case quotaConfig:
		var maxSpace, maxInodes int64
		err := s.db.QueryRow(fmt.Sprintf(`SELECT max_space,max_inodes FROM %s WHERE %s=?`, table, idcol), id).Scan(&maxSpace, &maxInodes)
		if err != nil {
			return nil, err
		}
		return encodeQuotaBlob(maxSpace, maxInodes), nil
	case quotaUsedSpace:
		var v int64
		err := s.db.QueryRow(fmt.Sprintf(`SELECT used_space FROM %s WHERE %s=?`, table, idcol), id).Scan(&v)
		if err != nil {
			return nil, err
		}
		return []byte(strconv.FormatInt(v, 10)), nil
	default:
		var v int64
		err := s.db.QueryRow(fmt.Sprintf(`SELECT used_inodes FROM %s WHERE %s=?`, table, idcol), id).Scan(&v)
		if err != nil {
			return nil, err
		}
		return []byte(strconv.FormatInt(v, 10)), nil
	}
}

func (s *store) getQuotaFieldTx(tx *sql.Tx, target quotaTarget, field quotaField, entity string) ([]byte, error) {
	id := mustParseInt64(entity)
	table := quotaTable(target)
	idcol := quotaIDColumn(target)
	switch field {
	case quotaConfig:
		var maxSpace, maxInodes int64
		err := tx.QueryRow(fmt.Sprintf(`SELECT max_space,max_inodes FROM %s WHERE %s=?`, table, idcol), id).Scan(&maxSpace, &maxInodes)
		if err != nil {
			return nil, err
		}
		return encodeQuotaBlob(maxSpace, maxInodes), nil
	case quotaUsedSpace:
		var v int64
		err := tx.QueryRow(fmt.Sprintf(`SELECT used_space FROM %s WHERE %s=?`, table, idcol), id).Scan(&v)
		if err != nil {
			return nil, err
		}
		return []byte(strconv.FormatInt(v, 10)), nil
	default:
		var v int64
		err := tx.QueryRow(fmt.Sprintf(`SELECT used_inodes FROM %s WHERE %s=?`, table, idcol), id).Scan(&v)
		if err != nil {
			return nil, err
		}
		return []byte(strconv.FormatInt(v, 10)), nil
	}
}

func (s *store) getAllQuota(target quotaTarget, field quotaField) ([][2][]byte, error) {
	table := quotaTable(target)
	idcol := quotaIDColumn(target)
	col := "used_space"
	if field == quotaConfig {
		rows, err := s.db.Query(fmt.Sprintf(`SELECT %s,max_space,max_inodes FROM %s ORDER BY %s`, idcol, table, idcol))
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out [][2][]byte
		for rows.Next() {
			var id, maxSpace, maxInodes int64
			if err := rows.Scan(&id, &maxSpace, &maxInodes); err != nil {
				return nil, err
			}
			out = append(out, [2][]byte{[]byte(strconv.FormatInt(id, 10)), encodeQuotaBlob(maxSpace, maxInodes)})
		}
		return out, rows.Err()
	}
	if field == quotaUsedInodes {
		col = "used_inodes"
	}
	rows, err := s.db.Query(fmt.Sprintf(`SELECT %s,%s FROM %s ORDER BY %s`, idcol, col, table, idcol))
	return scanIntPairs(rows, err)
}

func (s *store) getAllQuotaTx(tx *sql.Tx, target quotaTarget, field quotaField) ([][2][]byte, error) {
	table := quotaTable(target)
	idcol := quotaIDColumn(target)
	col := "used_space"
	if field == quotaConfig {
		rows, err := tx.Query(fmt.Sprintf(`SELECT %s,max_space,max_inodes FROM %s ORDER BY %s`, idcol, table, idcol))
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out [][2][]byte
		for rows.Next() {
			var id, maxSpace, maxInodes int64
			if err := rows.Scan(&id, &maxSpace, &maxInodes); err != nil {
				return nil, err
			}
			out = append(out, [2][]byte{[]byte(strconv.FormatInt(id, 10)), encodeQuotaBlob(maxSpace, maxInodes)})
		}
		return out, rows.Err()
	}
	if field == quotaUsedInodes {
		col = "used_inodes"
	}
	rows, err := tx.Query(fmt.Sprintf(`SELECT %s,%s FROM %s ORDER BY %s`, idcol, col, table, idcol))
	return scanIntPairs(rows, err)
}

func parseLockMember(prefix, member string) (string, int64, error) {
	if rest, ok := parseExactSuffix(strings.TrimPrefix(member, prefix), ""); ok || strings.HasPrefix(member, prefix) {
		_ = rest
	}
	if strings.HasPrefix(member, prefix+"lockf") {
		inode, err := strconv.ParseInt(strings.TrimPrefix(member, prefix+"lockf"), 10, 64)
		return "lockf", inode, err
	}
	if strings.HasPrefix(member, prefix+"lockp") {
		inode, err := strconv.ParseInt(strings.TrimPrefix(member, prefix+"lockp"), 10, 64)
		return "lockp", inode, err
	}
	return "", 0, fmt.Errorf("invalid lock member %q", member)
}

func decodeChunkList(buf []byte) ([][]byte, error) {
	if len(buf)%encodedSliceBytes != 0 {
		return nil, fmt.Errorf("invalid chunk blob length %d", len(buf))
	}
	out := make([][]byte, 0, len(buf)/encodedSliceBytes)
	for i := 0; i < len(buf); i += encodedSliceBytes {
		out = append(out, append([]byte(nil), buf[i:i+encodedSliceBytes]...))
	}
	return out, nil
}

func decodeEntryBlob(buf []byte) (uint8, int64, error) {
	if len(buf) != 9 {
		return 0, 0, redisErr("ERR invalid entry blob")
	}
	return buf[0], int64(binary.BigEndian.Uint64(buf[1:])), nil
}

func parseSliceRefField(field string) (int64, int64, error) {
	if !strings.HasPrefix(field, "k") {
		return 0, 0, fmt.Errorf("invalid sliceRef field %q", field)
	}
	parts := strings.SplitN(field[1:], "_", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid sliceRef field %q", field)
	}
	id, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, 0, err
	}
	size, err := strconv.ParseInt(parts[1], 10, 64)
	return id, size, err
}

func parseDelayedSliceField(field string) (int64, int64, error) {
	parts := strings.SplitN(field, "_", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid delSlices field %q", field)
	}
	sid, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, 0, err
	}
	ts, err := strconv.ParseInt(parts[1], 10, 64)
	return sid, ts, err
}

func parseSidOwnerField(field string) (int64, int64, error) {
	parts := strings.SplitN(field, "_", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid sid_owner field %q", field)
	}
	sid, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, 0, err
	}
	owner, err := strconv.ParseUint(parts[1], 16, 64)
	return sid, int64(owner), err
}

func parseDeleteMember(member string) (int64, int64, error) {
	parts := strings.SplitN(member, ":", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid delete member %q", member)
	}
	ino, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, 0, err
	}
	length, err := strconv.ParseInt(parts[1], 10, 64)
	return ino, length, err
}

func encodeQuotaBlob(space, inodes int64) []byte {
	buf := make([]byte, 16)
	binary.BigEndian.PutUint64(buf[:8], uint64(space))
	binary.BigEndian.PutUint64(buf[8:], uint64(inodes))
	return buf
}

func decodeQuotaBlob(buf []byte) (int64, int64) {
	if len(buf) != 16 {
		return 0, 0
	}
	return int64(binary.BigEndian.Uint64(buf[:8])), int64(binary.BigEndian.Uint64(buf[8:]))
}

func scanPairRows(rows *sql.Rows, err error) ([][2][]byte, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][2][]byte
	for rows.Next() {
		var k, v []byte
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out = append(out, [2][]byte{append([]byte(nil), k...), append([]byte(nil), v...)})
	}
	return out, rows.Err()
}

func scanStringBlobRows(rows *sql.Rows, err error) ([][2][]byte, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][2][]byte
	for rows.Next() {
		var k string
		var v []byte
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out = append(out, [2][]byte{[]byte(k), append([]byte(nil), v...)})
	}
	return out, rows.Err()
}

func scanIntBlobRows(rows *sql.Rows, err error) ([][2][]byte, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][2][]byte
	for rows.Next() {
		var k int64
		var v []byte
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out = append(out, [2][]byte{[]byte(strconv.FormatInt(k, 10)), append([]byte(nil), v...)})
	}
	return out, rows.Err()
}

func scanIntPairs(rows *sql.Rows, err error) ([][2][]byte, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][2][]byte
	for rows.Next() {
		var a, b int64
		if err := rows.Scan(&a, &b); err != nil {
			return nil, err
		}
		out = append(out, [2][]byte{[]byte(strconv.FormatInt(a, 10)), []byte(strconv.FormatInt(b, 10))})
	}
	return out, rows.Err()
}

func scanSliceRefRows(rows *sql.Rows, err error) ([][2][]byte, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][2][]byte
	for rows.Next() {
		var id, size, refs int64
		if err := rows.Scan(&id, &size, &refs); err != nil {
			return nil, err
		}
		field := fmt.Sprintf("k%d_%d", id, size)
		out = append(out, [2][]byte{[]byte(field), []byte(strconv.FormatInt(refs, 10))})
	}
	return out, rows.Err()
}

func rowExists(db interface {
	QueryRow(query string, args ...any) *sql.Row
}, query string, args ...any) (bool, error) {
	var x int
	err := db.QueryRow(query, args...).Scan(&x)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func rowExistsTx(tx *sql.Tx, query string, args ...any) (bool, error) {
	return rowExists(tx, query, args...)
}

func deleteResult(res sql.Result, err error, key string) (int64, []string, error) {
	if err != nil {
		return 0, nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return 0, nil, nil
	}
	return n, []string{key}, nil
}

func mustParseInt64(s string) int64 {
	v, _ := strconv.ParseInt(s, 10, 64)
	return v
}

func mustGetNextRevision(s *store, tx *sql.Tx) int64 {
	rev, err := s.nextRevisionTx(tx)
	if err != nil {
		return time.Now().UnixNano()
	}
	return rev
}

func parseSettingKey(key string) (string, bool) { return parseExactSuffix(key, "setting") }
func parseCounterKey(key string) (string, bool) {
	for _, name := range []string{"nextinode", "nextchunk", "nextsession", "nextTrash", "usedSpace", "totalInodes", "aclMaxId", "krbTokenMaxId"} {
		if _, ok := parseExactSuffix(key, name); ok {
			return name, true
		}
	}
	return "", false
}
func parseInodeKey(key string) (string, int64, bool)     { return parseOneInt(reInode, key) }
func parseSymlinkKey(key string) (string, int64, bool)   { return parseOneInt(reSymlink, key) }
func parseDentryKey(key string) (string, int64, bool)    { return parseOneInt(reDentry, key) }
func parseParentKey(key string) (string, int64, bool)    { return parseOneInt(reParent, key) }
func parseXAttrKey(key string) (string, int64, bool)     { return parseOneInt(reXAttr, key) }
func parseSustainedKey(key string) (string, int64, bool) { return parseOneInt(reSustained, key) }
func parseLockedKey(key string) (string, int64, bool)    { return parseOneInt(reLocked, key) }
func parseFlockKey(key string) (string, int64, bool)     { return parseOneInt(reFlock, key) }
func parsePlockKey(key string) (string, int64, bool)     { return parseOneInt(rePlock, key) }

func parseChunkKey(key string) (string, int64, int64, bool) {
	m := reChunk.FindStringSubmatch(key)
	if len(m) != 4 {
		return "", 0, 0, false
	}
	ino, _ := strconv.ParseInt(m[2], 10, 64)
	idx, _ := strconv.ParseInt(m[3], 10, 64)
	return m[1], ino, idx, true
}

func parseOneInt(re *regexp.Regexp, key string) (string, int64, bool) {
	m := re.FindStringSubmatch(key)
	if len(m) != 3 {
		return "", 0, false
	}
	v, _ := strconv.ParseInt(m[2], 10, 64)
	return m[1], v, true
}

func parseExactSuffix(key, suffix string) (string, bool) {
	if !strings.HasSuffix(key, suffix) {
		return "", false
	}
	return key[:len(key)-len(suffix)], true
}

func isSettingKey(key string) bool       { _, ok := parseSettingKey(key); return ok }
func isCounterStringKey(key string) bool { _, ok := parseCounterKey(key); return ok }
func isInodeKey(key string) bool         { _, _, ok := parseInodeKey(key); return ok }
func isSymlinkKey(key string) bool       { _, _, ok := parseSymlinkKey(key); return ok }
func isDentryKey(key string) bool        { _, _, ok := parseDentryKey(key); return ok }
func isParentKey(key string) bool        { _, _, ok := parseParentKey(key); return ok }
func isXAttrKey(key string) bool         { _, _, ok := parseXAttrKey(key); return ok }
func isChunkKey(key string) bool         { _, _, _, ok := parseChunkKey(key); return ok }
func isSustainedKey(key string) bool     { _, _, ok := parseSustainedKey(key); return ok }
func isLockedSetKey(key string) bool     { _, _, ok := parseLockedKey(key); return ok }
func isFlockKey(key string) bool         { _, _, ok := parseFlockKey(key); return ok }
func isPlockKey(key string) bool         { _, _, ok := parsePlockKey(key); return ok }
func isSliceRefKey(key string) bool      { _, ok := parseExactSuffix(key, "sliceRef"); return ok }
func isAllSessionsKey(key string) bool   { _, ok := parseExactSuffix(key, "allSessions"); return ok }
func isLegacySessionsKey(key string) bool {
	_, ok := parseExactSuffix(key, "sessions")
	return ok
}
func isSessionZSetKey(key string) bool   { return isAllSessionsKey(key) || isLegacySessionsKey(key) }
func isSessionInfosKey(key string) bool  { _, ok := parseExactSuffix(key, "sessionInfos"); return ok }
func isDelfilesKey(key string) bool      { _, ok := parseExactSuffix(key, "delfiles"); return ok }
func isDetachedNodesKey(key string) bool { _, ok := parseExactSuffix(key, "detachedNodes"); return ok }
func isACLKey(key string) bool           { _, ok := parseExactSuffix(key, "acl"); return ok }
func isKrbTokenKey(key string) bool      { _, ok := parseExactSuffix(key, "krbToken"); return ok }
func isDelSlicesKey(key string) bool     { _, ok := parseExactSuffix(key, "delSlices"); return ok }

func statFieldForKey(key string) statField {
	if _, ok := parseExactSuffix(key, "dirDataLength"); ok {
		return statDataLength
	}
	if _, ok := parseExactSuffix(key, "dirUsedSpace"); ok {
		return statUsedSpace
	}
	if _, ok := parseExactSuffix(key, "dirUsedInodes"); ok {
		return statUsedInodes
	}
	return -1
}

func quotaKeyInfo(key string) (quotaTarget, quotaField, bool) {
	switch {
	case hasExactSuffix(key, "dirQuota"):
		return targetDirQuota, quotaConfig, true
	case hasExactSuffix(key, "dirQuotaUsedSpace"):
		return targetDirQuota, quotaUsedSpace, true
	case hasExactSuffix(key, "dirQuotaUsedInodes"):
		return targetDirQuota, quotaUsedInodes, true
	case hasExactSuffix(key, "userQuota"):
		return targetUserQuota, quotaConfig, true
	case hasExactSuffix(key, "userQuotaUsedSpace"):
		return targetUserQuota, quotaUsedSpace, true
	case hasExactSuffix(key, "userQuotaUsedInodes"):
		return targetUserQuota, quotaUsedInodes, true
	case hasExactSuffix(key, "groupQuota"):
		return targetGroupQuota, quotaConfig, true
	case hasExactSuffix(key, "groupQuotaUsedSpace"):
		return targetGroupQuota, quotaUsedSpace, true
	case hasExactSuffix(key, "groupQuotaUsedInodes"):
		return targetGroupQuota, quotaUsedInodes, true
	default:
		return 0, 0, false
	}
}

func quotaTable(target quotaTarget) string {
	switch target {
	case targetDirQuota:
		return "dir_quota"
	case targetUserQuota:
		return "user_quota"
	default:
		return "group_quota"
	}
}

func quotaIDColumn(target quotaTarget) string {
	switch target {
	case targetDirQuota:
		return "inode"
	case targetUserQuota:
		return "uid"
	default:
		return "gid"
	}
}

func parentKeyFromParsed(dentryKey string, inode int64) string {
	prefix, _, _ := parseDentryKey(dentryKey)
	return prefix + "p" + strconv.FormatInt(inode, 10)
}

func lockedKeyFromParsed(lockKey string, sid int64) string {
	prefix, _, _ := parseFlockKey(lockKey)
	if prefix == "" {
		prefix, _, _ = parsePlockKey(lockKey)
	}
	return prefix + "locked" + strconv.FormatInt(sid, 10)
}

func hasExactSuffix(key, suffix string) bool {
	_, ok := parseExactSuffix(key, suffix)
	return ok
}

func sliceRange(length, start, stop int) []int {
	if length == 0 {
		return nil
	}
	if start < 0 {
		start = length + start
	}
	if stop < 0 {
		stop = length + stop
	}
	if start < 0 {
		start = 0
	}
	if stop >= length {
		stop = length - 1
	}
	if start >= length || stop < start {
		return nil
	}
	out := make([]int, 0, stop-start+1)
	for i := start; i <= stop; i++ {
		out = append(out, i)
	}
	return out
}

func parseScore(raw string, upper bool) (float64, error) {
	switch raw {
	case "-inf":
		return -1 << 62, nil
	case "+inf", "inf":
		return 1 << 62, nil
	default:
		return strconv.ParseFloat(raw, 64)
	}
}

func trimFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func init() {
	sort.Strings([]string{})
}
