package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/redisclient"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"github.com/google/uuid"
)

type ApiKeyService struct {
	keyRepo     repository.ApiKeyRepo
	userRepo    repository.UserRepo
	subRepo     repository.SubscriptionRepo
	planRepo    repository.PlanRepo
	redisClient *redisclient.Client
	cacheTTL    time.Duration
}

// apiKeyCacheEntry is the structure stored in Redis for validated API keys.
type apiKeyCacheEntry struct {
	Key          *model.ApiKey       `json:"key"`
	User         *model.User         `json:"user"`
	Subscription *model.Subscription `json:"subscription"`
	Plan         *model.Plan         `json:"plan"`
}

func NewApiKeyService(
	keyRepo repository.ApiKeyRepo,
	userRepo repository.UserRepo,
	subRepo repository.SubscriptionRepo,
	planRepo repository.PlanRepo,
	redisClient *redisclient.Client,
	cacheTTL time.Duration,
) *ApiKeyService {
	return &ApiKeyService{
		keyRepo:     keyRepo,
		userRepo:    userRepo,
		subRepo:     subRepo,
		planRepo:    planRepo,
		redisClient: redisClient,
		cacheTTL:    cacheTTL,
	}
}

// Generate creates a new API key for a user.
// Returns: plaintext key (sk-xxx), stored ApiKey model, error
func (s *ApiKeyService) Generate(userID uuid.UUID, name string) (string, *model.ApiKey, error) {
	// Generate 48 random hex chars
	randomBytes := make([]byte, 24)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", nil, fmt.Errorf("generate random bytes: %w", err)
	}
	plainKey := "sk-" + hex.EncodeToString(randomBytes)

	// SHA-256 hash the full key
	hash := sha256.Sum256([]byte(plainKey))
	keyHash := hex.EncodeToString(hash[:])

	// Prefix is the first 8 chars of the plaintext key
	keyPrefix := plainKey[:8]

	apiKey := &model.ApiKey{
		UserID:    userID,
		KeyHash:   keyHash,
		KeyPrefix: keyPrefix,
		Name:      name,
		IsActive:  true,
	}

	if err := s.keyRepo.Create(apiKey); err != nil {
		return "", nil, fmt.Errorf("create api key: %w", err)
	}

	return plainKey, apiKey, nil
}

// Validate checks a plaintext API key and returns the associated user context.
// Uses Redis cache (TTL configurable) to avoid DB hit on every request.
func (s *ApiKeyService) Validate(plainKey string) (*model.ApiKey, *model.User, *model.Subscription, *model.Plan, error) {
	return s.validateInternal(plainKey, false)
}

// ValidateAllowMissingSubscription authenticates the API key even when the user
// has no active subscription. This is intended for self-service endpoints that
// need to distinguish "authenticated but inactive" from "invalid API key".
func (s *ApiKeyService) ValidateAllowMissingSubscription(plainKey string) (*model.ApiKey, *model.User, *model.Subscription, *model.Plan, error) {
	return s.validateInternal(plainKey, true)
}

func (s *ApiKeyService) validateInternal(
	plainKey string,
	allowMissingSubscription bool,
) (*model.ApiKey, *model.User, *model.Subscription, *model.Plan, error) {
	// SHA-256 hash the key
	hash := sha256.Sum256([]byte(plainKey))
	keyHash := hex.EncodeToString(hash[:])

	cacheKey := fmt.Sprintf("cache:apikey:%s", keyHash)

	// Try Redis cache first
	if s.redisClient != nil {
		var cached apiKeyCacheEntry
		err := s.redisClient.GetJSON(context.Background(), cacheKey, &cached)
		if err == nil {
			return cached.Key, cached.User, cached.Subscription, cached.Plan, nil
		}
	}

	// Cache miss — query DB
	apiKey, err := s.keyRepo.GetByHash(keyHash)
	if err != nil {
		return nil, nil, nil, nil, model.ErrInvalidApiKey
	}

	user, err := s.userRepo.GetByID(apiKey.UserID)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("get user: %w", err)
	}

	sub, err := s.subRepo.GetActiveByUserID(user.ID)
	if err != nil {
		if allowMissingSubscription && err == model.ErrSubscriptionNotFound {
			return apiKey, user, nil, nil, nil
		}
		return nil, nil, nil, nil, fmt.Errorf("get subscription: %w", err)
	}

	plan, err := s.planRepo.GetByID(sub.PlanID)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("get plan: %w", err)
	}

	// Cache the result
	if s.redisClient != nil {
		entry := apiKeyCacheEntry{
			Key:          apiKey,
			User:         user,
			Subscription: sub,
			Plan:         plan,
		}
		_ = s.redisClient.SetJSON(context.Background(), cacheKey, entry, s.cacheTTL)
	}

	return apiKey, user, sub, plan, nil
}

// Revoke deactivates an API key and clears its cache.
func (s *ApiKeyService) Revoke(keyID uuid.UUID, keyHash string) error {
	if err := s.keyRepo.DeactivateByID(keyID); err != nil {
		return fmt.Errorf("deactivate key: %w", err)
	}

	// Clear Redis cache
	if s.redisClient != nil {
		cacheKey := fmt.Sprintf("cache:apikey:%s", keyHash)
		_ = s.redisClient.Del(context.Background(), cacheKey)
	}

	return nil
}

// ListByUserID returns all API keys for a user.
func (s *ApiKeyService) ListByUserID(userID uuid.UUID) ([]model.ApiKey, error) {
	return s.keyRepo.ListByUserID(userID)
}

// ListAll returns paginated API keys across all users with optional search.
func (s *ApiKeyService) ListAll(offset, limit int, search string) ([]model.ApiKey, int64, error) {
	return s.keyRepo.ListAll(offset, limit, search)
}

// ListAllWithUsers returns paginated API keys with user info (uses LEFT JOIN to avoid N+1).
func (s *ApiKeyService) ListAllWithUsers(offset, limit int, search string, status string) ([]repository.ApiKeyWithUserRow, int64, error) {
	return s.keyRepo.ListAllWithUsers(offset, limit, search, status)
}

// GetByID returns an API key by its ID.
func (s *ApiKeyService) GetByID(keyID uuid.UUID) (*model.ApiKey, error) {
	return s.keyRepo.GetByID(keyID)
}

// CountActive returns the count of active API keys.
func (s *ApiKeyService) CountActive() (int64, error) {
	return s.keyRepo.CountActive()
}

// InvalidateCacheByUserID clears all cached API key data for a user.
// Should be called when user, subscription, or plan data changes.
func (s *ApiKeyService) InvalidateCacheByUserID(userID uuid.UUID) error {
	if s.redisClient == nil {
		return nil
	}

	keys, err := s.keyRepo.ListByUserID(userID)
	if err != nil {
		return fmt.Errorf("list user API keys: %w", err)
	}

	for _, key := range keys {
		cacheKey := fmt.Sprintf("cache:apikey:%s", key.KeyHash)
		_ = s.redisClient.Del(context.Background(), cacheKey)
	}

	return nil
}
