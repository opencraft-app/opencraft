package httpapi

import (
	"crypto/hmac"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/devroute"
	"github.com/openclaw/openclaw/mono/shared/cloudladdertransport"
)

const (
	developerRouteRegistryPath         = "/auth/internal/dev-environments/registration"
	developerRouteRegistryMaxBodyBytes = int64(1 << 20)
)

type developerRouteRegistryAPI struct {
	registry devroute.Registry
	secret   string
	caller   string
	routeID  string
	now      func() time.Time
	maxSkew  time.Duration
}

func registerDeveloperRouteRegistryRoutes(router gin.IRoutes, config ServerConfig) {
	if config.DeveloperRouteRegistry == nil {
		return
	}
	api := &developerRouteRegistryAPI{
		registry: config.DeveloperRouteRegistry,
		secret:   strings.TrimSpace(config.DeveloperRouteRegistrySecret),
		caller:   strings.TrimSpace(config.DeveloperRouteRegistryCaller),
		routeID:  strings.TrimSpace(config.DeveloperRouteRegistryRouteID),
		now:      time.Now,
		maxSkew:  5 * time.Minute,
	}
	if api.caller == "" {
		api.caller = "cloudladdergateway"
	}
	if api.routeID == "" {
		api.routeID = "developer-route-registry"
	}
	router.GET(developerRouteRegistryPath+"/ready", api.handleReady)
	router.GET(developerRouteRegistryPath, api.handleGet)
	router.PUT(developerRouteRegistryPath, api.handleUpsert)
	router.DELETE(developerRouteRegistryPath, api.handleDisable)
}

func (a *developerRouteRegistryAPI) handleReady(ctx *gin.Context) {
	if !a.authorized(ctx, nil) {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	if err := a.registry.Ready(ctx.Request.Context()); err != nil {
		ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "registry unavailable"})
		return
	}
	ctx.Status(http.StatusNoContent)
}

func (a *developerRouteRegistryAPI) handleGet(ctx *gin.Context) {
	if !a.authorized(ctx, nil) {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	uin := strings.TrimSpace(ctx.Query("uin"))
	if !validRegistryUIN(uin) {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid uin"})
		return
	}
	registration, err := a.registry.Get(ctx.Request.Context(), uin)
	if errors.Is(err, devroute.ErrRegistryNotFound) {
		ctx.JSON(http.StatusNotFound, gin.H{"error": "registration not found"})
		return
	}
	if err != nil {
		ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "registry unavailable"})
		return
	}
	ctx.JSON(http.StatusOK, registration)
}

func (a *developerRouteRegistryAPI) handleUpsert(ctx *gin.Context) {
	body, err := readDeveloperRouteRegistryBody(ctx.Request)
	if err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if !a.authorized(ctx, body) {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	var registration devroute.StoredRegistration
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&registration); err != nil || decoder.Decode(&struct{}{}) != io.EOF || !validStoredRegistration(registration) {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid registration"})
		return
	}
	if err := a.registry.Upsert(ctx.Request.Context(), registration); err != nil {
		ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "registry unavailable"})
		return
	}
	ctx.Status(http.StatusNoContent)
}

func (a *developerRouteRegistryAPI) handleDisable(ctx *gin.Context) {
	body, err := readDeveloperRouteRegistryBody(ctx.Request)
	if err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if !a.authorized(ctx, body) {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	uin := strings.TrimSpace(ctx.Query("uin"))
	if !validRegistryUIN(uin) {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid uin"})
		return
	}
	var request struct {
		DisabledAt time.Time `json:"disabledAt"`
	}
	if err := json.Unmarshal(body, &request); err != nil || request.DisabledAt.IsZero() {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid disabledAt"})
		return
	}
	if err := a.registry.Disable(ctx.Request.Context(), uin, request.DisabledAt.UTC()); errors.Is(err, devroute.ErrRegistryNotFound) {
		ctx.JSON(http.StatusNotFound, gin.H{"error": "registration not found"})
		return
	} else if err != nil {
		ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "registry unavailable"})
		return
	}
	ctx.Status(http.StatusNoContent)
}

func (a *developerRouteRegistryAPI) authorized(ctx *gin.Context, body []byte) bool {
	if a == nil || a.registry == nil || a.secret == "" || a.caller == "" || a.routeID == "" {
		return false
	}
	caller := strings.TrimSpace(ctx.GetHeader("X-CloudLadder-Caller"))
	timestamp := strings.TrimSpace(ctx.GetHeader("X-CloudLadder-Timestamp"))
	signature := strings.TrimSpace(ctx.GetHeader("X-CloudLadder-Signature"))
	if caller != a.caller || timestamp == "" || signature == "" {
		return false
	}
	parsed, err := time.Parse(time.RFC3339, timestamp)
	if err != nil {
		return false
	}
	now := a.now().UTC()
	if drift := now.Sub(parsed); drift > a.maxSkew || drift < -a.maxSkew {
		return false
	}
	expected := cloudladdertransport.Sign(a.secret, cloudladdertransport.Request{
		Caller: caller, RouteID: a.routeID, Method: ctx.Request.Method,
		Path: ctx.Request.URL.EscapedPath(), Query: ctx.Request.URL.RawQuery,
		Body: body, Timestamp: timestamp,
	})
	return hmac.Equal([]byte(expected), []byte(signature))
}

func readDeveloperRouteRegistryBody(request *http.Request) ([]byte, error) {
	if request == nil || request.Body == nil {
		return nil, nil
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, developerRouteRegistryMaxBodyBytes+1))
	if err != nil || int64(len(body)) > developerRouteRegistryMaxBodyBytes {
		return nil, errors.New("developer route registry request body is too large")
	}
	request.Body = io.NopCloser(strings.NewReader(string(body)))
	return body, nil
}

func validRegistryUIN(uin string) bool {
	canonical := strings.TrimSpace(uin)
	value, err := strconv.ParseInt(canonical, 10, 64)
	return err == nil && value > 0 && strconv.FormatInt(value, 10) == canonical
}

func validStoredRegistration(registration devroute.StoredRegistration) bool {
	if !validRegistryUIN(registration.UIN) || strings.TrimSpace(registration.UserID) == "" || registration.RenewedAt.IsZero() {
		return false
	}
	if net.ParseIP(strings.TrimSpace(registration.SourceIP)) == nil || registration.Port < 1 || registration.Port > 65535 {
		return false
	}
	if registration.TTLSeconds < 60 || registration.TTLSeconds > 86400 {
		return false
	}
	switch strings.TrimSpace(registration.DeliveryMode) {
	case "direct":
		return strings.TrimSpace(registration.BaseURL) != "" && registration.TunnelHost == "" && registration.TunnelTokenHash == ""
	case "devtunnel":
		digest := strings.TrimSpace(registration.TunnelTokenHash)
		decoded, err := hex.DecodeString(digest)
		return err == nil && len(decoded) == 32 && strings.TrimSpace(registration.BaseURL) != "" && strings.TrimSpace(registration.TunnelHost) != ""
	default:
		return false
	}
}
