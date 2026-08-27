package website

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"ctl/pkg/errcode"
	modelwebsite "ctl/pkg/model/website"
	"ctl/pkg/resource"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
)

func newShareAccessTestLogic(t *testing.T, redisAvailable bool) (*logic, *miniredis.Miniredis) {
	t.Helper()
	newWebsiteOperationTestDB(t)
	previousRedis := resource.RedisMainClient
	resource.RedisMainClient = nil
	t.Cleanup(func() { resource.RedisMainClient = previousRedis })

	var server *miniredis.Miniredis
	if redisAvailable {
		server = miniredis.RunT(t)
		client := redis.NewClient(&redis.Options{Addr: server.Addr()})
		resource.RedisMainClient = client
		t.Cleanup(func() { _ = client.Close() })
	}
	return NewLogic().(*logic), server
}

func readStoredShareState(t *testing.T, siteID string) shareAccessState {
	t.Helper()
	raw, err := resource.RedisMainClient.Get(t.Context(), shareAccessKey(siteID)).Result()
	if err != nil {
		t.Fatalf("read stored share state: %v", err)
	}
	var state shareAccessState
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		t.Fatalf("decode stored share state: %v", err)
	}
	return state
}

func TestGenerateShareCodeUsesUnambiguousAlphabet(t *testing.T) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	seen := map[string]struct{}{}
	for range 128 {
		code, err := generateShareCode()
		if err != nil {
			t.Fatalf("generateShareCode: %v", err)
		}
		if len(code) != 6 {
			t.Fatalf("code length = %d, want 6", len(code))
		}
		for _, char := range code {
			if !strings.ContainsRune(alphabet, char) {
				t.Fatalf("code contains ambiguous character %q", char)
			}
		}
		seen[code] = struct{}{}
	}
	if len(seen) < 120 {
		t.Fatalf("generated only %d distinct codes out of 128", len(seen))
	}
}

func TestWebsiteSchemaHasNoPersistentShareColumns(t *testing.T) {
	newWebsiteOperationTestDB(t)
	type columnInfo struct {
		Name string `gorm:"column:name"`
	}
	var columns []columnInfo
	if err := resource.GormDB.Raw("PRAGMA table_info(website_sites)").Scan(&columns).Error; err != nil {
		t.Fatalf("inspect website_sites schema: %v", err)
	}
	for _, column := range columns {
		switch column.Name {
		case "access_mode", "share_code_hash", "share_revision", "share_code_updated_at":
			t.Fatalf("temporary share state must not persist in website_sites: found %s", column.Name)
		}
	}
}

func TestSetAccessPolicyStoresOnlyHashWithAllowedRedisTTLs(t *testing.T) {
	for _, durationDays := range []int{1, 7, 30} {
		t.Run((time.Duration(durationDays) * 24 * time.Hour).String(), func(t *testing.T) {
			l, server := newShareAccessTestLogic(t, true)
			siteID := "ws-ttl"
			seedSite(t, siteID, "user-1", modelwebsite.SiteStatusActive, 1)

			result, err := l.SetAccessPolicy("user-1", siteID, modelwebsite.SiteAccessModeShareCode, durationDays)
			if err != nil {
				t.Fatalf("SetAccessPolicy: %v", err)
			}
			if result.Mode != modelwebsite.SiteAccessModeShareCode || result.Code == "" || result.ExpiresAt.IsZero() {
				t.Fatalf("result = %+v", result)
			}

			state := readStoredShareState(t, siteID)
			if state.CodeHash == "" || state.CodeHash == result.Code || state.Generation == "" || !state.ExpiresAt.Equal(result.ExpiresAt) {
				t.Fatalf("stored state = %+v, result = %+v", state, result)
			}
			if err := bcrypt.CompareHashAndPassword([]byte(state.CodeHash), []byte(result.Code)); err != nil {
				t.Fatalf("stored bcrypt hash does not match returned code: %v", err)
			}
			wantTTL := time.Duration(durationDays) * 24 * time.Hour
			if gotTTL := server.TTL(shareAccessKey(siteID)); gotTTL != wantTTL {
				t.Fatalf("redis TTL = %v, want %v", gotTTL, wantTTL)
			}
		})
	}
}

func TestSetAccessPolicyRejectsInvalidDurationAndDoesNotWriteRedis(t *testing.T) {
	l, _ := newShareAccessTestLogic(t, true)
	seedSite(t, "ws-a", "user-1", modelwebsite.SiteStatusActive, 1)

	for _, durationDays := range []int{0, 2, 31} {
		if _, err := l.SetAccessPolicy("user-1", "ws-a", modelwebsite.SiteAccessModeShareCode, durationDays); !errors.Is(err, errcode.ErrWebsiteInvalidParam) {
			t.Fatalf("duration %d error = %v, want invalid param", durationDays, err)
		}
	}
	if exists := resource.RedisMainClient.Exists(t.Context(), shareAccessKey("ws-a")).Val(); exists != 0 {
		t.Fatal("invalid duration unexpectedly wrote share state")
	}
}

func TestResetRotatesGenerationWithoutExtendingExpiryAndDisableDeletesState(t *testing.T) {
	l, server := newShareAccessTestLogic(t, true)
	seedSite(t, "ws-a", "user-1", modelwebsite.SiteStatusActive, 1)

	first, err := l.SetAccessPolicy("user-1", "ws-a", modelwebsite.SiteAccessModeShareCode, 7)
	if err != nil {
		t.Fatal(err)
	}
	before := readStoredShareState(t, "ws-a")
	server.FastForward(6 * time.Hour)

	reset, err := l.ResetShareCode("user-1", "ws-a")
	if err != nil {
		t.Fatalf("ResetShareCode: %v", err)
	}
	after := readStoredShareState(t, "ws-a")
	if reset.Code == "" || reset.Code == first.Code || after.Generation == before.Generation {
		t.Fatalf("reset did not rotate credentials: before=%+v after=%+v result=%+v", before, after, reset)
	}
	if !reset.ExpiresAt.Equal(first.ExpiresAt) || !after.ExpiresAt.Equal(first.ExpiresAt) {
		t.Fatalf("reset extended expiry: first=%s reset=%s stored=%s", first.ExpiresAt, reset.ExpiresAt, after.ExpiresAt)
	}
	if gotTTL := server.TTL(shareAccessKey("ws-a")); gotTTL != 7*24*time.Hour-6*time.Hour {
		t.Fatalf("reset TTL = %v, want %v", gotTTL, 7*24*time.Hour-6*time.Hour)
	}

	disabled, err := l.SetAccessPolicy("user-1", "ws-a", modelwebsite.SiteAccessModeOwnerOnly, 0)
	if err != nil {
		t.Fatalf("disable sharing: %v", err)
	}
	if disabled.Mode != modelwebsite.SiteAccessModeOwnerOnly || !disabled.ExpiresAt.IsZero() {
		t.Fatalf("disabled result = %+v", disabled)
	}
	if exists := resource.RedisMainClient.Exists(t.Context(), shareAccessKey("ws-a")).Val(); exists != 0 {
		t.Fatal("disabled share state still exists")
	}
}

func TestReplaceShareStateDoesNotRecreateStateDeletedByConcurrentDisable(t *testing.T) {
	_, _ = newShareAccessTestLogic(t, true)
	key := shareAccessKey("ws-a")
	current := shareAccessState{
		CodeHash:   "old-hash",
		Generation: "old-generation",
		ExpiresAt:  time.Now().UTC().Add(time.Hour),
	}
	if err := storeShareAccessState(t.Context(), "ws-a", current, time.Hour); err != nil {
		t.Fatal(err)
	}
	if err := resource.RedisMainClient.Del(t.Context(), key).Err(); err != nil {
		t.Fatal(err)
	}

	replacement := shareAccessState{
		CodeHash:   "new-hash",
		Generation: "new-generation",
		ExpiresAt:  current.ExpiresAt,
	}
	replaced, err := replaceShareAccessStateIfGenerationMatches(
		t.Context(), "ws-a", current.Generation, replacement,
	)
	if err != nil {
		t.Fatalf("replace share state: %v", err)
	}
	if replaced {
		t.Fatal("replacement unexpectedly succeeded after concurrent disable")
	}
	if exists := resource.RedisMainClient.Exists(t.Context(), key).Val(); exists != 0 {
		t.Fatal("reset recreated share state after concurrent disable")
	}
}

func TestShareAccessManagementRequiresOwnershipAndValidMode(t *testing.T) {
	l, _ := newShareAccessTestLogic(t, true)
	seedSite(t, "ws-a", "user-1", modelwebsite.SiteStatusActive, 1)

	if _, err := l.SetAccessPolicy("user-2", "ws-a", modelwebsite.SiteAccessModeShareCode, 7); !errors.Is(err, errcode.ErrWebsiteNotFound) {
		t.Fatalf("non-owner SetAccessPolicy error = %v, want not found", err)
	}
	if _, err := l.ResetShareCode("user-2", "ws-a"); !errors.Is(err, errcode.ErrWebsiteNotFound) {
		t.Fatalf("non-owner ResetShareCode error = %v, want not found", err)
	}
	if _, err := l.SetAccessPolicy("user-1", "ws-a", "public", 0); !errors.Is(err, errcode.ErrWebsiteInvalidParam) {
		t.Fatalf("invalid mode error = %v, want invalid param", err)
	}
}

func TestVerifyShareCodeReturnsGenerationAndExpiryAndClearsLimits(t *testing.T) {
	l, _ := newShareAccessTestLogic(t, true)
	seedSite(t, "ws-a", "user-1", modelwebsite.SiteStatusActive, 1)
	enabled, err := l.SetAccessPolicy("user-1", "ws-a", modelwebsite.SiteAccessModeShareCode, 1)
	if err != nil {
		t.Fatal(err)
	}
	state := readStoredShareState(t, "ws-a")

	for attempt := 1; attempt <= 5; attempt++ {
		_, err = l.VerifyShareCode("ws-a", "AAAAAA", "203.0.113.7")
		if !errors.Is(err, errcode.ErrWebsiteShareCodeInvalid) {
			t.Fatalf("attempt %d error = %v, want invalid code", attempt, err)
		}
	}
	if _, err = l.VerifyShareCode("ws-a", "AAAAAA", "203.0.113.7"); !errors.Is(err, errcode.ErrWebsiteShareRateLimited) {
		t.Fatalf("sixth attempt error = %v, want rate limited", err)
	}

	verified, err := l.VerifyShareCode("ws-a", enabled.Code, "198.51.100.8")
	if err != nil {
		t.Fatalf("VerifyShareCode correct code: %v", err)
	}
	if !verified.Verified || verified.Generation != state.Generation || !verified.ExpiresAt.Equal(state.ExpiresAt) {
		t.Fatalf("verified result = %+v, state=%+v", verified, state)
	}

	keys, err := resource.RedisMainClient.Keys(t.Context(), "website:share:attempts:*").Result()
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range keys {
		if key == "website:share:attempts:site:{ws-a}" {
			t.Fatal("successful verification must clear the site-wide counter")
		}
		if strings.Contains(key, "203.0.113.7") || strings.Contains(key, "198.51.100.8") {
			t.Fatalf("redis key leaked plaintext client IP: %q", key)
		}
	}
}

func TestShareAttemptKeysUseSameRedisClusterHashTag(t *testing.T) {
	_, _ = newShareAccessTestLogic(t, true)

	keys, err := reserveShareAttempt(t.Context(), "ws-a", "203.0.113.7")
	if err != nil {
		t.Fatalf("reserveShareAttempt: %v", err)
	}
	if len(keys) != 2 {
		t.Fatalf("keys = %v, want site and site+IP keys", keys)
	}

	siteTag := redisClusterHashTag(keys[0])
	ipTag := redisClusterHashTag(keys[1])
	if siteTag != "ws-a" || ipTag != siteTag {
		t.Fatalf("keys must share the site hash tag: keys=%v tags=%q/%q", keys, siteTag, ipTag)
	}
}

func redisClusterHashTag(key string) string {
	start := strings.IndexByte(key, '{')
	if start < 0 {
		return ""
	}
	remainder := key[start+1:]
	end := strings.IndexByte(remainder, '}')
	if end <= 0 {
		return ""
	}
	return remainder[:end]
}

func TestShareStateExpiryAndCorruptionFailClosedToOwnerOnly(t *testing.T) {
	l, server := newShareAccessTestLogic(t, true)
	seedSite(t, "ws-a", "user-1", modelwebsite.SiteStatusActive, 1)
	enabled, err := l.SetAccessPolicy("user-1", "ws-a", modelwebsite.SiteAccessModeShareCode, 1)
	if err != nil {
		t.Fatal(err)
	}

	server.FastForward(24 * time.Hour)
	view, err := l.GetSiteInternal("ws-a")
	if err != nil {
		t.Fatal(err)
	}
	if view.AccessMode != modelwebsite.SiteAccessModeOwnerOnly || view.ShareGeneration != "" || view.ShareExpiresAt != nil {
		t.Fatalf("expired state did not fail closed: %+v", view)
	}
	if _, err := l.VerifyShareCode("ws-a", enabled.Code, ""); !errors.Is(err, errcode.ErrWebsiteShareCodeInvalid) {
		t.Fatalf("expired verify error = %v, want invalid code", err)
	}

	resource.RedisMainClient.Set(context.Background(), shareAccessKey("ws-a"), "not-json", time.Hour)
	view, err = l.GetSiteInternal("ws-a")
	if err != nil {
		t.Fatal(err)
	}
	if view.AccessMode != modelwebsite.SiteAccessModeOwnerOnly {
		t.Fatalf("corrupt state did not fail closed: %+v", view)
	}
}

func TestRedisUnavailableRejectsMutationAndVerifyButKeepsInternalOwnerView(t *testing.T) {
	l, _ := newShareAccessTestLogic(t, false)
	seedSite(t, "ws-a", "user-1", modelwebsite.SiteStatusActive, 1)

	if _, err := l.SetAccessPolicy("user-1", "ws-a", modelwebsite.SiteAccessModeShareCode, 7); !errors.Is(err, errcode.ErrWebsiteShareUnavailable) {
		t.Fatalf("enable without Redis error = %v, want unavailable", err)
	}
	if _, err := l.VerifyShareCode("ws-a", "AAAAAA", ""); !errors.Is(err, errcode.ErrWebsiteShareUnavailable) {
		t.Fatalf("verify without Redis error = %v, want unavailable", err)
	}
	view, err := l.GetSiteInternal("ws-a")
	if err != nil {
		t.Fatalf("owner metadata must survive Redis outage: %v", err)
	}
	if view.AccessMode != modelwebsite.SiteAccessModeOwnerOnly || view.ShareGeneration != "" || view.ShareExpiresAt != nil {
		t.Fatalf("Redis outage view = %+v", view)
	}
}

func TestInternalOwnerViewBoundsHangingRedisMetadataLookup(t *testing.T) {
	l, _ := newShareAccessTestLogic(t, false)
	seedSite(t, "ws-a", "user-1", modelwebsite.SiteStatusActive, 1)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	stopServer := make(chan struct{})
	t.Cleanup(func() {
		close(stopServer)
		_ = listener.Close()
	})
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		<-stopServer
	}()

	client := redis.NewClient(&redis.Options{
		Addr:         listener.Addr().String(),
		DialTimeout:  time.Second,
		ReadTimeout:  time.Second,
		WriteTimeout: time.Second,
		MaxRetries:   -1,
	})
	resource.RedisMainClient = client
	t.Cleanup(func() { _ = client.Close() })

	started := time.Now()
	view, err := l.GetSiteInternal("ws-a")
	elapsed := time.Since(started)
	if err != nil {
		t.Fatalf("owner metadata must survive hanging Redis: %v", err)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("hanging Redis blocked owner metadata for %s", elapsed)
	}
	if view.AccessMode != modelwebsite.SiteAccessModeOwnerOnly || view.ShareGeneration != "" || view.ShareExpiresAt != nil {
		t.Fatalf("hanging Redis view = %+v", view)
	}
}

func TestInternalSiteViewContainsGenerationButNeverCredential(t *testing.T) {
	l, _ := newShareAccessTestLogic(t, true)
	seedSite(t, "ws-a", "user-1", modelwebsite.SiteStatusActive, 1)
	enabled, err := l.SetAccessPolicy("user-1", "ws-a", modelwebsite.SiteAccessModeShareCode, 7)
	if err != nil {
		t.Fatal(err)
	}
	state := readStoredShareState(t, "ws-a")

	view, err := l.GetSiteInternal("ws-a")
	if err != nil {
		t.Fatal(err)
	}
	if view.AccessMode != modelwebsite.SiteAccessModeShareCode || view.ShareGeneration != state.Generation || view.ShareExpiresAt == nil || !view.ShareExpiresAt.Equal(enabled.ExpiresAt) {
		t.Fatalf("internal view = %+v", view)
	}
	raw, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), state.CodeHash) || strings.Contains(string(raw), enabled.Code) {
		t.Fatalf("internal view leaked share credential: %s", raw)
	}
}
