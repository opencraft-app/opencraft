package redisstore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	miniredis "github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"git.woa.com/wisp/mono/vibebase/internal/store"
)

func newTestStore(t *testing.T, maxKeys int) *Store {
	t.Helper()
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	s := NewStore(client, maxKeys)
	base := time.Date(2026, 5, 20, 9, 0, 0, 0, time.UTC)
	var tick int64
	s.now = func() time.Time {
		tick++
		return base.Add(time.Duration(tick) * time.Microsecond)
	}
	return s
}

func TestPutGetOverwriteAndDelete(t *testing.T) {
	s := newTestStore(t, 5000)
	ctx := context.Background()

	entry, created, err := s.Put(ctx, "user-a", "prefs", "theme", []byte("dark"))
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if !created || entry.Size != 4 {
		t.Fatalf("unexpected create result: created=%v entry=%+v", created, entry)
	}

	entry, err = s.Get(ctx, "user-a", "prefs", "theme")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if entry.Value != "dark" {
		t.Fatalf("unexpected value %q", entry.Value)
	}

	_, created, err = s.Put(ctx, "user-a", "prefs", "theme", []byte("light"))
	if err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	if created {
		t.Fatalf("overwrite must not consume quota as a new key")
	}
	entry, err = s.Get(ctx, "user-a", "prefs", "theme")
	if err != nil || entry.Value != "light" {
		t.Fatalf("unexpected overwritten entry=%+v err=%v", entry, err)
	}

	deleted, err := s.Delete(ctx, "user-a", "prefs", "theme")
	if err != nil || !deleted {
		t.Fatalf("delete=%v err=%v", deleted, err)
	}
	_, err = s.Get(ctx, "user-a", "prefs", "theme")
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expected not found, got %v", err)
	}
}

func TestPerUserQuotaAndIsolation(t *testing.T) {
	s := newTestStore(t, 1)
	ctx := context.Background()
	if _, _, err := s.Put(ctx, "user-a", "prefs", "a", []byte("1")); err != nil {
		t.Fatalf("first put: %v", err)
	}
	if _, _, err := s.Put(ctx, "user-a", "prefs", "b", []byte("2")); !errors.Is(err, store.ErrQuotaExceeded) {
		t.Fatalf("expected quota exceeded, got %v", err)
	}
	if _, _, err := s.Put(ctx, "user-b", "prefs", "b", []byte("2")); err != nil {
		t.Fatalf("second user must have independent quota: %v", err)
	}
	if _, err := s.Get(ctx, "user-b", "prefs", "a"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-user read must not see user-a key, got %v", err)
	}
}

func TestRedisKeysAreReadableAndKeepUserSlotStable(t *testing.T) {
	keys := redisKeys("user:a/b}", "drafts space", "theme/dark")

	if keys.global != "vibebase:user:{uid:user%3Aa%2Fb%7D}:keys" {
		t.Fatalf("unexpected global key: %s", keys.global)
	}
	if keys.namespace != "vibebase:user:{uid:user%3Aa%2Fb%7D}:ns:drafts%20space:keys" {
		t.Fatalf("unexpected namespace key: %s", keys.namespace)
	}
	if keys.item != "vibebase:item:{uid:user%3Aa%2Fb%7D}:ns:drafts%20space:key:theme%2Fdark" {
		t.Fatalf("unexpected item key: %s", keys.item)
	}
	if keys.member != "drafts space\x00theme/dark" {
		t.Fatalf("unexpected member: %q", keys.member)
	}
}

func TestListReturnsMetadataWithCursor(t *testing.T) {
	s := newTestStore(t, 5000)
	ctx := context.Background()
	for _, key := range []string{"a", "b", "c"} {
		if _, _, err := s.Put(ctx, "user-a", "drafts", key, []byte("value-"+key)); err != nil {
			t.Fatalf("put %s: %v", key, err)
		}
	}

	page, err := s.List(ctx, "user-a", "drafts", "", 2)
	if err != nil {
		t.Fatalf("list page 1: %v", err)
	}
	if len(page.Entries) != 2 || page.NextCursor == "" {
		t.Fatalf("unexpected page 1: %+v", page)
	}
	if page.Entries[0].Value != "" || page.Entries[1].Value != "" {
		t.Fatalf("list must not return values: %+v", page.Entries)
	}

	page2, err := s.List(ctx, "user-a", "drafts", page.NextCursor, 2)
	if err != nil {
		t.Fatalf("list page 2: %v", err)
	}
	if len(page2.Entries) != 1 || page2.Entries[0].Key != "c" || page2.NextCursor != "" {
		t.Fatalf("unexpected page 2: %+v", page2)
	}
}

func TestListTieBreaksByNamespaceAndKey(t *testing.T) {
	s := newTestStore(t, 5000)
	sameTime := time.Date(2026, 5, 20, 9, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return sameTime }
	ctx := context.Background()
	for _, key := range []string{"b", "a", "c"} {
		if _, _, err := s.Put(ctx, "user-a", "drafts", key, []byte("value-"+key)); err != nil {
			t.Fatalf("put %s: %v", key, err)
		}
	}

	page, err := s.List(ctx, "user-a", "drafts", "", 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var keys []string
	for _, entry := range page.Entries {
		keys = append(keys, entry.Key)
	}
	if got := strings.Join(keys, ","); got != "a,b,c" {
		t.Fatalf("expected key tie-break order a,b,c, got %s", got)
	}
}

func TestListCursorDoesNotDropLargeSameTimestampBuckets(t *testing.T) {
	s := newTestStore(t, 5000)
	sameTime := time.Date(2026, 5, 20, 9, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return sameTime }
	ctx := context.Background()
	for i := range 30 {
		key := strings.ReplaceAll(fmt.Sprintf("key-%02d", 29-i), " ", "")
		if _, _, err := s.Put(ctx, "user-a", "drafts", key, []byte("value")); err != nil {
			t.Fatalf("put %s: %v", key, err)
		}
	}

	var got []string
	cursor := ""
	for {
		page, err := s.List(ctx, "user-a", "drafts", cursor, 2)
		if err != nil {
			t.Fatalf("list with cursor %q: %v", cursor, err)
		}
		for _, entry := range page.Entries {
			got = append(got, entry.Key)
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}

	if len(got) != 30 {
		t.Fatalf("expected all 30 same-timestamp keys, got %d: %v", len(got), got)
	}
	for i, key := range got {
		want := fmt.Sprintf("key-%02d", i)
		if key != want {
			t.Fatalf("expected sorted key %s at index %d, got %s; all=%v", want, i, key, got)
		}
	}
}
