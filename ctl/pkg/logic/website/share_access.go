package website

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"ctl/pkg/errcode"
	modelwebsite "ctl/pkg/model/website"
	"ctl/pkg/resource"

	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
)

const (
	shareCodeAlphabet     = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	shareCodeLength       = 6
	shareGenerationBytes  = 16
	shareAttemptWindow    = 10 * time.Minute
	shareMetadataTimeout  = 200 * time.Millisecond
	shareSiteAttemptLimit = 50
	shareIPAttemptLimit   = 5
	shareAccessKeyPrefix  = "website:share:access:"
)

var shareDurationByDays = map[int]time.Duration{
	1:  24 * time.Hour,
	7:  7 * 24 * time.Hour,
	30: 30 * 24 * time.Hour,
}

type shareAccessState struct {
	CodeHash   string    `json:"code_hash"`
	Generation string    `json:"generation"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type ShareAccessResult struct {
	Mode      string    `json:"mode"`
	Code      string    `json:"code,omitempty"`
	ExpiresAt time.Time `json:"expires_at,omitzero"`
}

type ShareVerifyResult struct {
	Verified   bool      `json:"verified"`
	Generation string    `json:"share_generation"`
	ExpiresAt  time.Time `json:"share_expires_at"`
}

func shareAccessKey(siteID string) string {
	return shareAccessKeyPrefix + strings.TrimSpace(siteID)
}

func generateShareCode() (string, error) {
	bytes := make([]byte, shareCodeLength)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate website share code: %w", err)
	}
	// 字符集正好是 32 个字符，取低 5 bit 不会产生模偏差。
	for index := range bytes {
		bytes[index] = shareCodeAlphabet[int(bytes[index]&31)]
	}
	return string(bytes), nil
}

func generateShareGeneration() (string, error) {
	bytes := make([]byte, shareGenerationBytes)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate website share generation: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}

func newShareAccessState(ttl time.Duration) (shareAccessState, string, error) {
	plaintext, err := generateShareCode()
	if err != nil {
		return shareAccessState{}, "", err
	}
	hashed, err := bcrypt.GenerateFromPassword([]byte(plaintext), bcrypt.DefaultCost)
	if err != nil {
		return shareAccessState{}, "", fmt.Errorf("hash website share code: %w", err)
	}
	generation, err := generateShareGeneration()
	if err != nil {
		return shareAccessState{}, "", err
	}
	return shareAccessState{
		CodeHash:   string(hashed),
		Generation: generation,
		ExpiresAt:  time.Now().UTC().Add(ttl),
	}, plaintext, nil
}

func loadShareAccessState(ctx context.Context, siteID string) (*shareAccessState, time.Duration, error) {
	return loadShareAccessStateWithClient(ctx, resource.RedisMainClient, siteID)
}

func loadShareAccessStateWithClient(ctx context.Context, client *redis.Client, siteID string) (*shareAccessState, time.Duration, error) {
	if client == nil {
		return nil, 0, errcode.ErrWebsiteShareUnavailable
	}
	key := shareAccessKey(siteID)
	raw, err := client.Get(ctx, key).Result()
	if err != nil {
		if err == redis.Nil {
			return nil, 0, nil
		}
		return nil, 0, errcode.Wrap(errcode.ErrWebsiteShareUnavailable, "load share state")
	}

	var state shareAccessState
	if err := json.Unmarshal([]byte(raw), &state); err != nil ||
		state.CodeHash == "" || state.Generation == "" || !state.ExpiresAt.After(time.Now().UTC()) {
		return nil, 0, nil
	}
	ttl, err := client.TTL(ctx, key).Result()
	if err != nil {
		return nil, 0, errcode.Wrap(errcode.ErrWebsiteShareUnavailable, "load share ttl")
	}
	if ttl <= 0 {
		return nil, 0, nil
	}
	if untilExpiry := time.Until(state.ExpiresAt); untilExpiry <= 0 {
		return nil, 0, nil
	} else if untilExpiry < ttl {
		ttl = untilExpiry
	}
	return &state, ttl, nil
}

func loadShareAccessMetadata(siteID string) *shareAccessState {
	if resource.RedisMainClient == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), shareMetadataTimeout)
	defer cancel()
	metadataClient := resource.RedisMainClient.WithTimeout(shareMetadataTimeout)
	state, _, err := loadShareAccessStateWithClient(ctx, metadataClient, siteID)
	if err != nil {
		return nil
	}
	return state
}

func storeShareAccessState(ctx context.Context, siteID string, state shareAccessState, ttl time.Duration) error {
	if resource.RedisMainClient == nil || ttl <= 0 {
		return errcode.ErrWebsiteShareUnavailable
	}
	raw, err := json.Marshal(state)
	if err != nil {
		return errcode.Wrap(errcode.ErrWebsiteShareUnavailable, "encode share state")
	}
	if err := resource.RedisMainClient.Set(ctx, shareAccessKey(siteID), raw, ttl).Err(); err != nil {
		return errcode.Wrap(errcode.ErrWebsiteShareUnavailable, "store share state")
	}
	return nil
}

func replaceShareAccessStateIfGenerationMatches(
	ctx context.Context,
	siteID string,
	expectedGeneration string,
	replacement shareAccessState,
) (bool, error) {
	if resource.RedisMainClient == nil {
		return false, errcode.ErrWebsiteShareUnavailable
	}
	key := shareAccessKey(siteID)
	replaced := false
	err := resource.RedisMainClient.Watch(ctx, func(tx *redis.Tx) error {
		raw, err := tx.Get(ctx, key).Result()
		if err != nil {
			if errors.Is(err, redis.Nil) {
				return nil
			}
			return err
		}
		var current shareAccessState
		if err := json.Unmarshal([]byte(raw), &current); err != nil ||
			current.Generation != expectedGeneration || !current.ExpiresAt.After(time.Now().UTC()) {
			return nil
		}
		ttl, err := tx.PTTL(ctx, key).Result()
		if err != nil || ttl <= 0 {
			return err
		}
		replacement.ExpiresAt = current.ExpiresAt
		replacementRaw, err := json.Marshal(replacement)
		if err != nil {
			return err
		}
		_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			pipe.Set(ctx, key, replacementRaw, ttl)
			return nil
		})
		if err == nil {
			replaced = true
		}
		return err
	}, key)
	if errors.Is(err, redis.TxFailedErr) {
		return false, nil
	}
	if err != nil {
		return false, errcode.Wrap(errcode.ErrWebsiteShareUnavailable, "rotate share state")
	}
	return replaced, nil
}

func (l *logic) SetAccessPolicy(userID, siteID, mode string, durationDays int) (*ShareAccessResult, error) {
	if mode != modelwebsite.SiteAccessModeOwnerOnly && mode != modelwebsite.SiteAccessModeShareCode {
		return nil, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "unsupported access mode")
	}
	if _, err := l.requireOwnedSite(userID, siteID); err != nil {
		return nil, err
	}

	if mode == modelwebsite.SiteAccessModeOwnerOnly {
		if resource.RedisMainClient == nil {
			return nil, errcode.ErrWebsiteShareUnavailable
		}
		if err := resource.RedisMainClient.Del(context.Background(), shareAccessKey(siteID)).Err(); err != nil {
			return nil, errcode.Wrap(errcode.ErrWebsiteShareUnavailable, "disable share access")
		}
		return &ShareAccessResult{Mode: modelwebsite.SiteAccessModeOwnerOnly}, nil
	}

	ttl, ok := shareDurationByDays[durationDays]
	if !ok {
		return nil, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "duration_days must be 1, 7, or 30")
	}
	state, plaintext, err := newShareAccessState(ttl)
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrWebsiteShareUnavailable, "%s", err.Error())
	}
	if err := storeShareAccessState(context.Background(), siteID, state, ttl); err != nil {
		return nil, err
	}
	return &ShareAccessResult{
		Mode: modelwebsite.SiteAccessModeShareCode, Code: plaintext, ExpiresAt: state.ExpiresAt,
	}, nil
}

func (l *logic) ResetShareCode(userID, siteID string) (*ShareAccessResult, error) {
	if _, err := l.requireOwnedSite(userID, siteID); err != nil {
		return nil, err
	}
	current, ttl, err := loadShareAccessState(context.Background(), siteID)
	if err != nil {
		return nil, err
	}
	if current == nil || ttl <= 0 {
		return nil, errcode.ErrWebsiteShareCodeInvalid
	}
	rotated, plaintext, err := newShareAccessState(ttl)
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrWebsiteShareUnavailable, "%s", err.Error())
	}
	rotated.ExpiresAt = current.ExpiresAt
	replaced, err := replaceShareAccessStateIfGenerationMatches(
		context.Background(), siteID, current.Generation, rotated,
	)
	if err != nil {
		return nil, err
	}
	if !replaced {
		return nil, errcode.ErrWebsiteShareCodeInvalid
	}
	return &ShareAccessResult{
		Mode: modelwebsite.SiteAccessModeShareCode, Code: plaintext, ExpiresAt: rotated.ExpiresAt,
	}, nil
}

func (l *logic) requireOwnedSite(userID, siteID string) (*modelwebsite.SiteEntity, error) {
	site, err := l.siteDao.GetBySiteIDForUser(userID, siteID)
	if err != nil {
		return nil, fmt.Errorf("load website share access: %w", err)
	}
	if site == nil || site.DeletedTime != nil {
		return nil, errcode.ErrWebsiteNotFound
	}
	return site, nil
}

func (l *logic) VerifyShareCode(siteID, code, clientIP string) (*ShareVerifyResult, error) {
	keys, err := reserveShareAttempt(context.Background(), siteID, clientIP)
	if err != nil {
		return nil, err
	}
	state, _, err := loadShareAccessState(context.Background(), siteID)
	if err != nil {
		return nil, err
	}
	if state == nil {
		return nil, errcode.ErrWebsiteShareCodeInvalid
	}

	normalizedCode := strings.ToUpper(strings.TrimSpace(code))
	if len(normalizedCode) != shareCodeLength ||
		bcrypt.CompareHashAndPassword([]byte(state.CodeHash), []byte(normalizedCode)) != nil {
		return nil, errcode.ErrWebsiteShareCodeInvalid
	}

	if err := resource.RedisMainClient.Del(context.Background(), keys...).Err(); err != nil {
		return nil, errcode.Wrap(errcode.ErrWebsiteShareUnavailable, "clear share attempt limits")
	}
	return &ShareVerifyResult{
		Verified: true, Generation: state.Generation, ExpiresAt: state.ExpiresAt,
	}, nil
}

func (l *logic) hydrateShareAccess(site *modelwebsite.SiteEntity) {
	if site == nil {
		return
	}
	site.AccessMode = modelwebsite.SiteAccessModeOwnerOnly
	site.ShareExpiresAt = nil
	state := loadShareAccessMetadata(site.SiteID)
	if state == nil {
		return
	}
	site.AccessMode = modelwebsite.SiteAccessModeShareCode
	expiresAt := state.ExpiresAt
	site.ShareExpiresAt = &expiresAt
}

var reserveShareAttemptScript = `
local site_count = redis.call('INCR', KEYS[1])
if site_count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
if site_count > tonumber(ARGV[1]) then
  return {0, redis.call('TTL', KEYS[1])}
end
if #KEYS > 1 then
  local ip_count = redis.call('INCR', KEYS[2])
  if ip_count == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
  if ip_count > tonumber(ARGV[2]) then
    return {0, redis.call('TTL', KEYS[2])}
  end
end
return {1, 0}
`

func reserveShareAttempt(ctx context.Context, siteID, clientIP string) ([]string, error) {
	if resource.RedisMainClient == nil {
		return nil, errcode.ErrWebsiteShareUnavailable
	}
	// The limiter script and the success cleanup both operate on the site and
	// site+IP keys together. Keep the site ID in a Redis Cluster hash tag so
	// those multi-key operations stay in one slot.
	keys := []string{"website:share:attempts:site:{" + siteID + "}"}
	if normalizedIP := strings.TrimSpace(clientIP); normalizedIP != "" {
		hash := sha256.Sum256([]byte(normalizedIP))
		keys = append(keys, keys[0]+":ip:"+hex.EncodeToString(hash[:]))
	}
	result, err := resource.RedisMainClient.Eval(ctx, reserveShareAttemptScript, keys,
		shareSiteAttemptLimit, shareIPAttemptLimit, int(shareAttemptWindow.Seconds())).Slice()
	if err != nil || len(result) != 2 {
		return nil, errcode.Wrap(errcode.ErrWebsiteShareUnavailable, "reserve share attempt")
	}
	allowed, ok := result[0].(int64)
	if !ok {
		return nil, errcode.Wrap(errcode.ErrWebsiteShareUnavailable, "invalid share limiter response")
	}
	if allowed != 1 {
		return nil, errcode.ErrWebsiteShareRateLimited
	}
	return keys, nil
}
