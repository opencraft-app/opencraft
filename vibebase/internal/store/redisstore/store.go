package redisstore

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"git.woa.com/wisp/mono/vibebase/internal/store"
)

const redisTimeLayout = time.RFC3339Nano

type Store struct {
	client         redis.UniversalClient
	maxKeysPerUser int
	now            func() time.Time
}

type Options struct {
	Addr           string
	Username       string
	Password       string
	DB             int
	MaxKeysPerUser int
	DialTimeout    time.Duration
	ReadTimeout    time.Duration
	WriteTimeout   time.Duration
}

func NewClientStore(opts Options) *Store {
	client := redis.NewClient(&redis.Options{
		Addr:         opts.Addr,
		Username:     opts.Username,
		Password:     opts.Password,
		DB:           opts.DB,
		DialTimeout:  opts.DialTimeout,
		ReadTimeout:  opts.ReadTimeout,
		WriteTimeout: opts.WriteTimeout,
	})
	return NewStore(client, opts.MaxKeysPerUser)
}

func NewStore(client redis.UniversalClient, maxKeysPerUser int) *Store {
	if maxKeysPerUser <= 0 {
		maxKeysPerUser = 5000
	}
	return &Store{client: client, maxKeysPerUser: maxKeysPerUser, now: time.Now}
}

func (s *Store) Ping(ctx context.Context) error {
	return s.client.Ping(ctx).Err()
}

func (s *Store) Put(ctx context.Context, ownerID string, namespace string, key string, value []byte) (store.Entry, bool, error) {
	updatedAt := s.now().UTC()
	updatedAtUS := updatedAt.UnixMicro()
	keys := redisKeys(ownerID, namespace, key)
	result, err := putScript.Run(ctx, s.client, []string{keys.item, keys.global, keys.namespace}, string(value), namespace, key, strconv.Itoa(len(value)), updatedAt.Format(redisTimeLayout), strconv.FormatInt(updatedAtUS, 10), keys.member, strconv.Itoa(s.maxKeysPerUser)).Result()
	if err != nil {
		return store.Entry{}, false, err
	}
	parts, ok := result.([]interface{})
	if !ok || len(parts) < 2 {
		return store.Entry{}, false, fmt.Errorf("unexpected redis put result: %T", result)
	}
	status := toString(parts[0])
	if status == "quota_exceeded" {
		return store.Entry{}, false, store.ErrQuotaExceeded
	}
	created := toInt64(parts[1]) == 1
	return store.Entry{Namespace: namespace, Key: key, Value: string(value), Size: len(value), UpdatedAt: updatedAt}, created, nil
}

func (s *Store) Get(ctx context.Context, ownerID string, namespace string, key string) (store.Entry, error) {
	keys := redisKeys(ownerID, namespace, key)
	values, err := s.client.HGetAll(ctx, keys.item).Result()
	if err != nil {
		return store.Entry{}, err
	}
	if len(values) == 0 {
		return store.Entry{}, store.ErrNotFound
	}
	return entryFromHash(values)
}

func (s *Store) Delete(ctx context.Context, ownerID string, namespace string, key string) (bool, error) {
	keys := redisKeys(ownerID, namespace, key)
	result, err := deleteScript.Run(ctx, s.client, []string{keys.item, keys.global, keys.namespace}, keys.member).Int64()
	if err != nil {
		return false, err
	}
	return result == 1, nil
}

func (s *Store) List(ctx context.Context, ownerID string, namespace string, cursor string, limit int) (store.ListPage, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	parsedCursor, err := parseCursor(cursor)
	if err != nil {
		return store.ListPage{}, err
	}
	keys := redisKeys(ownerID, namespace, "")
	min := "-inf"
	if parsedCursor.Score > 0 {
		min = strconv.FormatInt(parsedCursor.Score, 10)
	}
	entries := make([]store.Entry, 0, limit)
	var lastReturned cursorPayload
	hasMore := false
	var offset int64
	chunkSize := int64(limit*4 + 8)
	for {
		items, err := s.client.ZRangeByScoreWithScores(ctx, keys.namespace, &redis.ZRangeBy{
			Min:    min,
			Max:    "+inf",
			Offset: offset,
			Count:  chunkSize,
		}).Result()
		if err != nil {
			return store.ListPage{}, err
		}
		if len(items) == 0 {
			break
		}
		offset += int64(len(items))
		for _, item := range items {
			member, ok := item.Member.(string)
			if !ok {
				continue
			}
			score := int64(item.Score)
			if parsedCursor.Score > 0 {
				if score < parsedCursor.Score || (score == parsedCursor.Score && member <= parsedCursor.Member) {
					continue
				}
			}
			values, err := s.client.HGetAll(ctx, itemKey(ownerID, member)).Result()
			if err != nil {
				return store.ListPage{}, err
			}
			if len(values) == 0 {
				continue
			}
			entry, err := entryFromHash(values)
			if err != nil {
				return store.ListPage{}, err
			}
			if len(entries) >= limit {
				hasMore = true
				break
			}
			entry.Value = ""
			entries = append(entries, entry)
			lastReturned = cursorPayload{Score: score, Member: member}
		}
		if hasMore || int64(len(items)) < chunkSize {
			break
		}
	}

	page := store.ListPage{Entries: entries}
	if hasMore && lastReturned.Score > 0 {
		page.NextCursor = encodeCursor(lastReturned)
	}
	return page, nil
}

type redisKeySet struct {
	owner     string
	member    string
	global    string
	namespace string
	item      string
}

func redisKeys(ownerID string, namespace string, key string) redisKeySet {
	ownerTag := "uid:" + redisKeyEscape(ownerID)
	namespaceEscaped := redisKeyEscape(namespace)
	keyEscaped := redisKeyEscape(key)
	member := zsetMember(namespace, key)
	return redisKeySet{
		owner:     ownerTag,
		member:    member,
		global:    "vibebase:user:{" + ownerTag + "}:keys",
		namespace: "vibebase:user:{" + ownerTag + "}:ns:" + namespaceEscaped + ":keys",
		item:      itemKeyByOwnerTag(ownerTag, namespaceEscaped, keyEscaped),
	}
}

func itemKey(ownerID string, member string) string {
	namespace, key := namespaceAndKeyFromMember(member)
	return itemKeyByOwnerTag("uid:"+redisKeyEscape(ownerID), redisKeyEscape(namespace), redisKeyEscape(key))
}

func itemKeyByOwnerTag(ownerTag string, namespace string, key string) string {
	return "vibebase:item:{" + ownerTag + "}:ns:" + namespace + ":key:" + key
}

func zsetMember(namespace string, key string) string {
	return namespace + "\x00" + key
}

func namespaceAndKeyFromMember(member string) (string, string) {
	namespace, key, ok := strings.Cut(member, "\x00")
	if !ok {
		return "", member
	}
	return namespace, key
}

func redisKeyEscape(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		b.WriteString(fmt.Sprintf("%%%02X", c))
	}
	return b.String()
}

func entryFromHash(values map[string]string) (store.Entry, error) {
	size, err := strconv.Atoi(values["size"])
	if err != nil {
		return store.Entry{}, fmt.Errorf("decode size: %w", err)
	}
	updatedAt, err := time.Parse(redisTimeLayout, values["updated_at"])
	if err != nil {
		return store.Entry{}, fmt.Errorf("decode updated_at: %w", err)
	}
	return store.Entry{
		Namespace: values["namespace"],
		Key:       values["key"],
		Value:     values["value"],
		Size:      size,
		UpdatedAt: updatedAt,
	}, nil
}

type cursorPayload struct {
	Score  int64  `json:"score"`
	Member string `json:"member"`
}

func parseCursor(raw string) (cursorPayload, error) {
	if strings.TrimSpace(raw) == "" {
		return cursorPayload{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return cursorPayload{}, fmt.Errorf("invalid cursor")
	}
	var payload cursorPayload
	if err := json.Unmarshal(decoded, &payload); err != nil {
		return cursorPayload{}, fmt.Errorf("invalid cursor")
	}
	if payload.Score <= 0 || payload.Member == "" {
		return cursorPayload{}, fmt.Errorf("invalid cursor")
	}
	return payload, nil
}

func encodeCursor(payload cursorPayload) string {
	data, _ := json.Marshal(payload)
	return base64.RawURLEncoding.EncodeToString(data)
}

func toString(value interface{}) string {
	switch v := value.(type) {
	case string:
		return v
	case []byte:
		return string(v)
	default:
		return fmt.Sprint(v)
	}
}

func toInt64(value interface{}) int64 {
	switch v := value.(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case string:
		parsed, _ := strconv.ParseInt(v, 10, 64)
		return parsed
	default:
		return 0
	}
}

var putScript = redis.NewScript(`
local exists = redis.call('ZSCORE', KEYS[2], ARGV[7])
if not exists then
  local current = redis.call('ZCARD', KEYS[2])
  if current >= tonumber(ARGV[8]) then
    return {'quota_exceeded', 0}
  end
end
redis.call('HSET', KEYS[1], 'value', ARGV[1], 'namespace', ARGV[2], 'key', ARGV[3], 'size', ARGV[4], 'updated_at', ARGV[5], 'member', ARGV[7])
redis.call('ZADD', KEYS[2], tonumber(ARGV[6]), ARGV[7])
redis.call('ZADD', KEYS[3], tonumber(ARGV[6]), ARGV[7])
if exists then
  return {'ok', 0}
end
return {'ok', 1}
`)

var deleteScript = redis.NewScript(`
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`)
