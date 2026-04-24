package service

import (
	"encoding/json"
	"log/slog"
	"sync"

	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
)

const cacheConfigKey = "cache"

// CacheScopeMode 缓存隔离模式。
type CacheScopeMode string

const (
	CacheScopeUser         CacheScopeMode = "user"          // 按 user_id 隔离（默认）
	CacheScopeSystemPrompt CacheScopeMode = "system_prompt" // 按 system_prompt_hash 隔离
	CacheScopeGlobal       CacheScopeMode = "global"        // 全局共享
)

// CacheConfig 语义缓存配置。
type CacheConfig struct {
	Enabled             bool           `json:"enabled"`               // 默认 true
	TTLSeconds          int            `json:"ttl_seconds"`           // 默认 3600
	SimilarityThreshold float64        `json:"similarity_threshold"`  // 默认 0.95
	MaxResponseBytes    int            `json:"max_response_bytes"`    // 默认 524288 (512KB)
	ScopeMode           CacheScopeMode `json:"scope_mode"`            // 默认 "user"
	MaxCacheEntries     int            `json:"max_cache_entries"`     // 默认 100000
	// Embedding 提供商独立配置
	EmbeddingModel   string `json:"embedding_model"`    // 默认 "text-embedding-3-small"
	EmbeddingBaseURL string `json:"embedding_base_url"` // 如 "https://api.openai.com"
	EmbeddingAPIKey  string `json:"embedding_api_key"`  // 独立 API key
}

// DefaultCacheConfig 返回默认的缓存配置。
func DefaultCacheConfig() CacheConfig {
	return CacheConfig{
		Enabled:             true,
		TTLSeconds:          3600,
		SimilarityThreshold: 0.95,
		MaxResponseBytes:    524288,
		ScopeMode:           CacheScopeUser,
		MaxCacheEntries:     100000,
		EmbeddingModel:      "text-embedding-3-small",
		EmbeddingBaseURL:    "",
		EmbeddingAPIKey:     "",
	}
}

// CacheConfigStore 缓存配置存储，支持内存缓存 + DB 持久化。
type CacheConfigStore struct {
	mu     sync.RWMutex
	config CacheConfig
	repo   repository.RuntimeConfigRepo
}

// NewCacheConfigStore 创建 CacheConfigStore，先使用默认值，再从 DB 加载覆盖。
func NewCacheConfigStore(repo repository.RuntimeConfigRepo) *CacheConfigStore {
	s := &CacheConfigStore{
		config: DefaultCacheConfig(),
		repo:   repo,
	}
	s.loadFromDB()
	return s
}

// loadFromDB 从数据库加载缓存配置，失败时保持默认值。
func (s *CacheConfigStore) loadFromDB() {
	rc, err := s.repo.Get(cacheConfigKey)
	if err != nil {
		slog.Warn("加载缓存配置失败，使用默认值", "error", err)
		return
	}
	if rc == nil {
		return
	}
	var cfg CacheConfig
	if err := json.Unmarshal(rc.Value, &cfg); err != nil {
		slog.Warn("解析缓存配置失败，使用默认值", "error", err)
		return
	}
	// 补充默认值
	if cfg.EmbeddingModel == "" {
		cfg.EmbeddingModel = "text-embedding-3-small"
	}
	if cfg.ScopeMode == "" {
		cfg.ScopeMode = CacheScopeUser
	}
	if cfg.TTLSeconds == 0 {
		cfg.TTLSeconds = 3600
	}
	if cfg.SimilarityThreshold == 0 {
		cfg.SimilarityThreshold = 0.95
	}
	if cfg.MaxResponseBytes == 0 {
		cfg.MaxResponseBytes = 524288
	}
	if cfg.MaxCacheEntries == 0 {
		cfg.MaxCacheEntries = 100000
	}
	s.mu.Lock()
	s.config = cfg
	s.mu.Unlock()
	slog.Info("从数据库加载缓存配置", "enabled", cfg.Enabled, "scope_mode", cfg.ScopeMode)
}

// Get 获取当前缓存配置（线程安全）。
func (s *CacheConfigStore) Get() CacheConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.config
}

// Update 更新缓存配置到 DB 和内存。
func (s *CacheConfigStore) Update(cfg CacheConfig) error {
	data, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	if err := s.repo.Upsert(cacheConfigKey, data); err != nil {
		return err
	}
	s.mu.Lock()
	s.config = cfg
	s.mu.Unlock()
	slog.Info("缓存配置已更新", "enabled", cfg.Enabled, "scope_mode", cfg.ScopeMode)
	return nil
}
