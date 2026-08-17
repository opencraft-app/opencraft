package websiteauth

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func redisClusterHashTag(key string) string {
	start := strings.IndexByte(key, '{')
	if start < 0 {
		return key
	}
	end := strings.IndexByte(key[start+1:], '}')
	if end <= 0 {
		return key
	}
	return key[start+1 : start+1+end]
}

func TestCredentialKeysShareRedisClusterSlot(t *testing.T) {
	credentialKey := credentialKeyPrefix + "key-id"
	instanceIndexKey := instanceIndexPrefix + "instance-id"
	if got, want := redisClusterHashTag(credentialKey), redisClusterHashTag(instanceIndexKey); got != want {
		t.Fatalf("credential hash tag = %q, instance index hash tag = %q; transaction would cross Redis Cluster slots", got, want)
	}
	if got := redisClusterHashTag(credentialKey); got != "website-instance-keys" {
		t.Fatalf("credential hash tag = %q, want website-instance-keys", got)
	}
}

func newTestStore(t *testing.T) (Store, *redis.Client, *miniredis.Miniredis) {
	t.Helper()

	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("start miniredis: %v", err)
	}
	t.Cleanup(mr.Close)

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })

	return New(client), client, mr
}

func TestStoreIssueAndValidate(t *testing.T) {
	store, _, _ := newTestStore(t)
	ctx := context.Background()

	token, issued, err := store.Issue(ctx, "user-1", "ins-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if !strings.HasPrefix(token, "vik_") {
		t.Fatalf("token = %q, want vik_ prefix", token)
	}
	if issued.KeyID == "" || issued.UserID != "user-1" || issued.InstanceID != "ins-1" || issued.CreatedAt.IsZero() {
		t.Fatalf("issued binding = %+v", issued)
	}

	validated, err := store.Validate(ctx, token)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if *validated != issued {
		t.Fatalf("validated binding = %+v, want %+v", *validated, issued)
	}
}

func TestStoreDoesNotPersistPlaintextAndDoesNotExpire(t *testing.T) {
	store, client, mr := newTestStore(t)
	ctx := context.Background()

	token, binding, err := store.Issue(ctx, "user-1", "ins-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	secretOffset := len(tokenPrefix) + 1 + base64.RawURLEncoding.EncodedLen(keyIDBytes) + 1
	secret := token[secretOffset:]
	key := credentialKeyPrefix + binding.KeyID

	fields, err := client.HGetAll(ctx, key).Result()
	if err != nil {
		t.Fatalf("HGetAll: %v", err)
	}
	if fields["salt"] == "" || fields["secret_hash"] == "" {
		t.Fatalf("stored fields missing salt/hash: %+v", fields)
	}
	for field, value := range fields {
		if strings.Contains(value, token) || strings.Contains(value, secret) {
			t.Fatalf("Redis field %q contains plaintext credential", field)
		}
	}
	if ttl := mr.TTL(key); ttl != 0 {
		t.Fatalf("credential TTL = %s, want no expiry", ttl)
	}
	members, err := client.SMembers(ctx, instanceIndexPrefix+"ins-1").Result()
	if err != nil {
		t.Fatalf("SMembers: %v", err)
	}
	if len(members) != 1 || members[0] != binding.KeyID {
		t.Fatalf("instance index = %v, want [%s]", members, binding.KeyID)
	}
}

func TestStoreRejectsMalformedAndWrongSecret(t *testing.T) {
	store, _, _ := newTestStore(t)
	ctx := context.Background()

	_, binding, err := store.Issue(ctx, "user-1", "ins-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	cases := []string{
		"",
		"Bearer abc",
		"vik_too_few",
		"vik_***_***",
		"vik_" + binding.KeyID + "_" + strings.Repeat("A", base64.RawURLEncoding.EncodedLen(secretBytes)),
	}
	for _, candidate := range cases {
		if _, err := store.Validate(ctx, candidate); !errors.Is(err, ErrInvalidCredential) {
			t.Errorf("Validate(%q) error = %v, want ErrInvalidCredential", candidate, err)
		}
	}
}

func TestStoreRevoke(t *testing.T) {
	store, client, _ := newTestStore(t)
	ctx := context.Background()

	token, binding, err := store.Issue(ctx, "user-1", "ins-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if err := store.Revoke(ctx, "ins-1", binding.KeyID); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if _, err := store.Validate(ctx, token); !errors.Is(err, ErrInvalidCredential) {
		t.Fatalf("Validate after revoke error = %v, want ErrInvalidCredential", err)
	}
	if count, err := client.SCard(ctx, instanceIndexPrefix+"ins-1").Result(); err != nil || count != 0 {
		t.Fatalf("instance index count = %d, err = %v, want 0", count, err)
	}
}

func TestStoreRevokeRejectsKeyFromAnotherInstance(t *testing.T) {
	store, _, _ := newTestStore(t)
	ctx := context.Background()

	token, binding, err := store.Issue(ctx, "user-1", "ins-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	if err := store.Revoke(ctx, "ins-2", binding.KeyID); !errors.Is(err, ErrInvalidCredential) {
		t.Fatalf("Revoke with wrong instance error = %v, want ErrInvalidCredential", err)
	}
	if _, err := store.Validate(ctx, token); err != nil {
		t.Fatalf("credential must remain valid after rejected cross-instance revoke: %v", err)
	}
}

func TestStoreRevokePreservesRedisInfrastructureError(t *testing.T) {
	store, _, mr := newTestStore(t)
	ctx := context.Background()

	_, binding, err := store.Issue(ctx, "user-1", "ins-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	mr.Close()

	err = store.Revoke(ctx, "ins-1", binding.KeyID)
	if err == nil {
		t.Fatal("Revoke succeeded after Redis shutdown")
	}
	if errors.Is(err, ErrInvalidCredential) {
		t.Fatalf("Revoke error = %v, infrastructure failures must not look like invalid credentials", err)
	}
}

func TestStoreRevokeInstance(t *testing.T) {
	store, _, _ := newTestStore(t)
	ctx := context.Background()

	token1, _, err := store.Issue(ctx, "user-1", "ins-1")
	if err != nil {
		t.Fatalf("Issue first: %v", err)
	}
	token2, _, err := store.Issue(ctx, "user-1", "ins-1")
	if err != nil {
		t.Fatalf("Issue second: %v", err)
	}
	otherToken, _, err := store.Issue(ctx, "user-1", "ins-2")
	if err != nil {
		t.Fatalf("Issue other instance: %v", err)
	}

	if err := store.RevokeInstance(ctx, "ins-1"); err != nil {
		t.Fatalf("RevokeInstance: %v", err)
	}
	for _, token := range []string{token1, token2} {
		if _, err := store.Validate(ctx, token); !errors.Is(err, ErrInvalidCredential) {
			t.Errorf("Validate revoked token error = %v, want ErrInvalidCredential", err)
		}
	}
	if _, err := store.Validate(ctx, otherToken); err != nil {
		t.Fatalf("Validate other instance token: %v", err)
	}
}

func TestStoreIssueRejectsMissingBinding(t *testing.T) {
	store, _, _ := newTestStore(t)
	ctx := context.Background()

	for _, input := range []struct {
		userID     string
		instanceID string
	}{
		{userID: "", instanceID: "ins-1"},
		{userID: "user-1", instanceID: ""},
	} {
		if _, _, err := store.Issue(ctx, input.userID, input.instanceID); err == nil {
			t.Fatalf("Issue(%q, %q) succeeded, want error", input.userID, input.instanceID)
		}
	}
}
