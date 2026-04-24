package handler

import (
	"net/http"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
)

// CacheHandler 缓存管理 API 处理器。
type CacheHandler struct {
	cacheSvc     *service.CacheService
	configStore  *service.CacheConfigStore
	embeddingSvc *service.EmbeddingService
}

// NewCacheHandler 创建 CacheHandler。
func NewCacheHandler(cacheSvc *service.CacheService, configStore *service.CacheConfigStore, embeddingSvc *service.EmbeddingService) *CacheHandler {
	return &CacheHandler{
		cacheSvc:     cacheSvc,
		configStore:  configStore,
		embeddingSvc: embeddingSvc,
	}
}

// CacheConfigResponse 缓存配置响应。
type CacheConfigResponse struct {
	Enabled             bool   `json:"enabled"`
	TTLSeconds          int    `json:"ttl_seconds"`
	SimilarityThreshold float64 `json:"similarity_threshold"`
	MaxResponseBytes    int    `json:"max_response_bytes"`
	ScopeMode           string `json:"scope_mode"`
	MaxCacheEntries     int    `json:"max_cache_entries"`
	EmbeddingModel      string `json:"embedding_model"`
	EmbeddingBaseURL    string `json:"embedding_base_url"`
	EmbeddingAPIKey     string `json:"embedding_api_key"`
}

// UpdateCacheConfigRequest 更新缓存配置请求（指针字段实现 PATCH 语义）。
type UpdateCacheConfigRequest struct {
	Enabled             *bool    `json:"enabled"`
	TTLSeconds          *int     `json:"ttl_seconds"`
	SimilarityThreshold *float64 `json:"similarity_threshold"`
	MaxResponseBytes    *int     `json:"max_response_bytes"`
	ScopeMode           *string  `json:"scope_mode"`
	MaxCacheEntries     *int     `json:"max_cache_entries"`
	EmbeddingModel      *string  `json:"embedding_model"`
	EmbeddingBaseURL    *string  `json:"embedding_base_url"`
	EmbeddingAPIKey     *string  `json:"embedding_api_key"`
}

// GetCacheConfig 返回缓存配置（GET /api/admin/cache/config）。
// @Summary Get cache config
// @Description Returns the current semantic cache configuration
// @Tags Admin - Cache
// @Produce json
// @Success 200 {object} CacheConfigResponse "Current cache configuration"
// @Router /api/admin/cache/config [get]
func (h *CacheHandler) GetCacheConfig(c *gin.Context) {
	cfg := h.configStore.Get()

	// 隐藏 API key 中间部分
	maskedKey := maskAPIKey(cfg.EmbeddingAPIKey)

	c.JSON(http.StatusOK, CacheConfigResponse{
		Enabled:             cfg.Enabled,
		TTLSeconds:          cfg.TTLSeconds,
		SimilarityThreshold: cfg.SimilarityThreshold,
		MaxResponseBytes:    cfg.MaxResponseBytes,
		ScopeMode:           string(cfg.ScopeMode),
		MaxCacheEntries:     cfg.MaxCacheEntries,
		EmbeddingModel:      cfg.EmbeddingModel,
		EmbeddingBaseURL:    cfg.EmbeddingBaseURL,
		EmbeddingAPIKey:     maskedKey,
	})
}

// UpdateCacheConfig 更新缓存配置（PUT /api/admin/cache/config）。
// @Summary Update cache config
// @Description Partially update semantic cache configuration (PATCH semantics)
// @Tags Admin - Cache
// @Accept json
// @Produce json
// @Param request body UpdateCacheConfigRequest true "Update cache config request"
// @Success 200 {object} CacheConfigResponse "Updated cache configuration"
// @Router /api/admin/cache/config [put]
func (h *CacheHandler) UpdateCacheConfig(c *gin.Context) {
	var req UpdateCacheConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的请求参数: " + err.Error()})
		return
	}

	cfg := h.configStore.Get()

	// 部分更新 + 校验
	if req.Enabled != nil {
		cfg.Enabled = *req.Enabled
	}
	if req.TTLSeconds != nil {
		if *req.TTLSeconds < 60 || *req.TTLSeconds > 86400 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "ttl_seconds 取值范围: 60~86400"})
			return
		}
		cfg.TTLSeconds = *req.TTLSeconds
	}
	if req.SimilarityThreshold != nil {
		if *req.SimilarityThreshold < 0.5 || *req.SimilarityThreshold > 1.0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "similarity_threshold 取值范围: 0.5~1.0"})
			return
		}
		cfg.SimilarityThreshold = *req.SimilarityThreshold
	}
	if req.MaxResponseBytes != nil {
		if *req.MaxResponseBytes < 1024 || *req.MaxResponseBytes > 10485760 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "max_response_bytes 取值范围: 1024~10485760"})
			return
		}
		cfg.MaxResponseBytes = *req.MaxResponseBytes
	}
	if req.ScopeMode != nil {
		mode := service.CacheScopeMode(*req.ScopeMode)
		if mode != service.CacheScopeUser && mode != service.CacheScopeSystemPrompt && mode != service.CacheScopeGlobal {
			c.JSON(http.StatusBadRequest, gin.H{"error": "scope_mode 必须为 user、system_prompt 或 global"})
			return
		}
		cfg.ScopeMode = mode
	}
	if req.MaxCacheEntries != nil {
		if *req.MaxCacheEntries < 100 || *req.MaxCacheEntries > 1000000 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "max_cache_entries 取值范围: 100~1000000"})
			return
		}
		cfg.MaxCacheEntries = *req.MaxCacheEntries
	}
	if req.EmbeddingModel != nil {
		cfg.EmbeddingModel = *req.EmbeddingModel
	}
	if req.EmbeddingBaseURL != nil {
		cfg.EmbeddingBaseURL = *req.EmbeddingBaseURL
	}
	if req.EmbeddingAPIKey != nil {
		cfg.EmbeddingAPIKey = *req.EmbeddingAPIKey
	}

	if err := h.configStore.Update(cfg); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "更新缓存配置失败: " + err.Error()})
		return
	}

	maskedKey := maskAPIKey(cfg.EmbeddingAPIKey)

	c.JSON(http.StatusOK, CacheConfigResponse{
		Enabled:             cfg.Enabled,
		TTLSeconds:          cfg.TTLSeconds,
		SimilarityThreshold: cfg.SimilarityThreshold,
		MaxResponseBytes:    cfg.MaxResponseBytes,
		ScopeMode:           string(cfg.ScopeMode),
		MaxCacheEntries:     cfg.MaxCacheEntries,
		EmbeddingModel:      cfg.EmbeddingModel,
		EmbeddingBaseURL:    cfg.EmbeddingBaseURL,
		EmbeddingAPIKey:     maskedKey,
	})
}

// GetCacheStats 返回缓存统计（GET /api/admin/cache/stats）。
// @Summary Get cache stats
// @Description Returns semantic cache hit/miss statistics
// @Tags Admin - Cache
// @Produce json
// @Success 200 {object} service.CacheStats "Cache statistics"
// @Router /api/admin/cache/stats [get]
func (h *CacheHandler) GetCacheStats(c *gin.Context) {
	stats, err := h.cacheSvc.Stats(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "获取缓存统计失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, stats)
}

// ClearCache 清除全部缓存（DELETE /api/admin/cache）。
// @Summary Clear all cache
// @Description Truncates the entire response cache table
// @Tags Admin - Cache
// @Produce json
// @Success 200 {object} map[string]string "Cache cleared"
// @Router /api/admin/cache [delete]
func (h *CacheHandler) ClearCache(c *gin.Context) {
	if err := h.cacheSvc.ClearAll(c.Request.Context()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "清除缓存失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "缓存已清除"})
}

// TestEmbedding 测试 Embedding 提供商连通性（POST /api/admin/cache/test-embedding）。
// @Summary Test embedding provider
// @Description Tests the configured embedding provider by generating a test embedding
// @Tags Admin - Cache
// @Produce json
// @Success 200 {object} map[string]interface{} "Test result with latency"
// @Failure 502 {object} map[string]string "Embedding provider error"
// @Router /api/admin/cache/test-embedding [post]
func (h *CacheHandler) TestEmbedding(c *gin.Context) {
	ctx := c.Request.Context()
	start := time.Now()

	_, err := h.embeddingSvc.Embed(ctx, "embedding connectivity test")
	elapsed := time.Since(start).Milliseconds()

	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Embedding 测试失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":         true,
		"latency_ms": elapsed,
	})
}
