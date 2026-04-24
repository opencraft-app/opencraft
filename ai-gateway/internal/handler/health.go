package handler

import (
	"context"
	"net/http"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/redisclient"
	"git.woa.com/wisp/mono/ai-gateway/internal/serverstate"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// HealthHandler provides health and readiness check endpoints.
type HealthHandler struct {
	db          *gorm.DB
	redisClient *redisclient.Client
	drainState  *serverstate.DrainState
	portkeyURL  string
}

// NewHealthHandler creates a new HealthHandler (legacy).
func NewHealthHandler(db *gorm.DB, redisClient *redisclient.Client) *HealthHandler {
	return NewHealthHandlerWithDrainState(db, redisClient, serverstate.DefaultDrainState())
}

// NewHealthHandlerWithDrainState creates a new HealthHandler with an explicit drain state.
func NewHealthHandlerWithDrainState(db *gorm.DB, redisClient *redisclient.Client, drainState *serverstate.DrainState) *HealthHandler {
	return &HealthHandler{
		db:          db,
		redisClient: redisClient,
		drainState:  drainState,
	}
}

// NewHealthHandlerWithDrainStateV2 创建 HealthHandler，支持增强的 Readiness Probe。
// portkeyURL 用于 Portkey Gateway 连通性检查。
func NewHealthHandlerWithDrainStateV2(db *gorm.DB, redisClient *redisclient.Client, drainState *serverstate.DrainState, portkeyURL string) *HealthHandler {
	return &HealthHandler{
		db:          db,
		redisClient: redisClient,
		drainState:  drainState,
		portkeyURL:  portkeyURL,
	}
}

// Health always returns 200 OK.
// @Summary Health check
// @Description Returns 200 OK if the service is running. Use this for liveness probes.
// @Tags Health
// @Produce json
// @Success 200 {object} SwaggerHealthResponse "Service is healthy"
// @Router /health [get]
func (h *HealthHandler) Health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

// Ready checks DB and Redis connectivity.
// @Summary Readiness check
// @Description Checks database, Redis, and Portkey Gateway connectivity.
// @Tags Health
// @Produce json
// @Success 200 {object} SwaggerReadyResponse "All dependencies are ready"
// @Failure 503 {object} SwaggerReadyResponse "One or more dependencies are not ready"
// @Router /ready [get]
func (h *HealthHandler) Ready(c *gin.Context) {
	if h.drainState != nil && h.drainState.IsDraining() {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"status": "draining",
			"checks": gin.H{"draining": "true"},
		})
		return
	}

	checks := gin.H{}
	allOK := true

	// Check DB
	if h.db != nil {
		sqlDB, err := h.db.DB()
		if err != nil {
			checks["database"] = "error: " + err.Error()
			allOK = false
		} else if err := sqlDB.Ping(); err != nil {
			checks["database"] = "error: " + err.Error()
			allOK = false
		} else {
			checks["database"] = "ok"
		}
	} else {
		checks["database"] = "not configured"
		allOK = false
	}

	// Check Redis
	if h.redisClient != nil {
		if err := h.redisClient.Ping(context.Background()); err != nil {
			checks["redis"] = "error: " + err.Error()
			allOK = false
		} else {
			checks["redis"] = "ok"
		}
	} else {
		checks["redis"] = "not configured"
		allOK = false
	}

	// Check Portkey Gateway 连通性（10s 超时，不阻塞 readiness）
	if h.portkeyURL != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		req, err := http.NewRequestWithContext(ctx, "HEAD", h.portkeyURL+"/health", nil)
		if err != nil || req == nil {
			cancel()
			checks["portkey"] = "unreachable"
		} else {
			resp, err := http.DefaultClient.Do(req)
			cancel()
			if resp != nil {
				defer resp.Body.Close()
			}
			if err != nil || resp == nil || resp.StatusCode >= 500 {
				checks["portkey"] = "unreachable"
			} else {
				checks["portkey"] = "ok"
			}
		}
	}
	if allOK {
		c.JSON(http.StatusOK, gin.H{"status": "ready", "checks": checks})
	} else {
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not ready", "checks": checks})
	}
}
