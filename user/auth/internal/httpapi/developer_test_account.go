package httpapi

import (
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/api"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

const defaultDeveloperTestAccountLeaseTTL = 8 * time.Hour

type developerTestAccountLeaseHandler struct {
	service     *service.Service
	userIDs     []string
	namespace   string
	sourceCIDRs []netip.Prefix
}

type developerTestAccountLeaseRequest struct {
	TargetIP   string `json:"targetIp"`
	TTLSeconds int    `json:"ttlSeconds"`
}

type developerTestAccountLeaseResponse struct {
	UserID         string `json:"userId"`
	SessionToken   string `json:"sessionToken"`
	SessionExpires string `json:"sessionExpiresAt"`
	LeaseExpires   string `json:"leaseExpiresAt"`
	LeaseVersion   int64  `json:"leaseVersion"`
}

type developerTestAccountReleaseResponse struct {
	UserID       string `json:"userId"`
	Released     bool   `json:"released"`
	LeaseVersion int64  `json:"leaseVersion"`
}

func registerDeveloperTestAccountLeaseRoutes(router gin.IRoutes, authService *service.Service, config ServerConfig) {
	if !config.DeveloperTestAccountLeaseEnabled || authService == nil || len(config.DeveloperTestAccountPoolUserIDs) == 0 || len(config.DeveloperTestAccountSourceCIDRs) == 0 {
		return
	}
	handler := &developerTestAccountLeaseHandler{
		service:     authService,
		userIDs:     append([]string(nil), config.DeveloperTestAccountPoolUserIDs...),
		namespace:   strings.TrimSpace(config.DeveloperTestAccountLeaseNamespace),
		sourceCIDRs: append([]netip.Prefix(nil), config.DeveloperTestAccountSourceCIDRs...),
	}
	router.POST("/auth/dev-environments/account-lease", handler.acquire)
	router.DELETE("/auth/dev-environments/account-lease", handler.release)
}

func (h *developerTestAccountLeaseHandler) acquire(ctx *gin.Context) {
	setDeveloperRouteNoStore(ctx)
	sourceIP, ok := h.trustedSourceIP(ctx)
	if !ok {
		ctx.JSON(http.StatusForbidden, api.ErrorResponse{Code: "developer_test_account_source_forbidden", Message: "testing account leases are only available from an approved DevCloud network"})
		return
	}
	var request developerTestAccountLeaseRequest
	if err := ctx.ShouldBindJSON(&request); err != nil {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_request", Message: "targetIp or ttlSeconds is invalid"})
		return
	}
	targetIP, ok := developerTestAccountTargetIP(request.TargetIP)
	if !ok {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_target_ip", Message: "targetIp must be an IPv4 address in a supported DevCloud network"})
		return
	}
	ttl := defaultDeveloperTestAccountLeaseTTL
	if request.TTLSeconds != 0 {
		ttl = time.Duration(request.TTLSeconds) * time.Second
	}
	leaseOwner := h.namespace + ":" + targetIP
	lease, session, err := h.service.AcquireDeveloperTestAccount(ctx.Request.Context(), h.userIDs, leaseOwner, targetIP, ttl, tokenFromContext(ctx))
	if err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}
	requestLogger(ctx, nil).Info("developer test account lease acquired",
		"user_id", lease.UserID,
		"source_ip", sourceIP,
		"target_ip", lease.TargetIP,
		"lease_until", lease.LeaseUntil.UTC().Format(timeRFC3339Milli),
		"lease_version", lease.LeaseVersion,
	)
	ctx.JSON(http.StatusOK, developerTestAccountLeaseResponse{
		UserID:         lease.UserID,
		SessionToken:   session.Token,
		SessionExpires: session.ExpiresAt.UTC().Format(timeRFC3339Milli),
		LeaseExpires:   lease.LeaseUntil.UTC().Format(timeRFC3339Milli),
		LeaseVersion:   lease.LeaseVersion,
	})
}

func (h *developerTestAccountLeaseHandler) release(ctx *gin.Context) {
	setDeveloperRouteNoStore(ctx)
	sourceIP, ok := h.trustedSourceIP(ctx)
	if !ok {
		ctx.JSON(http.StatusForbidden, api.ErrorResponse{Code: "developer_test_account_source_forbidden", Message: "testing account leases are only available from an approved DevCloud network"})
		return
	}
	var request developerTestAccountLeaseRequest
	if err := ctx.ShouldBindJSON(&request); err != nil {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_request", Message: "targetIp is invalid"})
		return
	}
	targetIP, ok := developerTestAccountTargetIP(request.TargetIP)
	if !ok {
		ctx.JSON(http.StatusBadRequest, api.ErrorResponse{Code: "invalid_target_ip", Message: "targetIp must be an IPv4 address in a supported DevCloud network"})
		return
	}
	leaseOwner := h.namespace + ":" + targetIP
	lease, err := h.service.ReleaseDeveloperTestAccount(ctx.Request.Context(), tokenFromContext(ctx), leaseOwner)
	if err != nil {
		body, status := toErrorBody(err)
		ctx.JSON(status, body)
		return
	}
	requestLogger(ctx, nil).Info("developer test account lease released",
		"user_id", lease.UserID,
		"source_ip", sourceIP,
		"target_ip", targetIP,
		"lease_version", lease.LeaseVersion,
	)
	ctx.JSON(http.StatusOK, developerTestAccountReleaseResponse{UserID: lease.UserID, Released: true, LeaseVersion: lease.LeaseVersion})
}

func (h *developerTestAccountLeaseHandler) trustedSourceIP(ctx *gin.Context) (string, bool) {
	if h == nil || ctx == nil {
		return "", false
	}
	address, err := netip.ParseAddr(strings.TrimSpace(ctx.GetHeader("X-Lightclaw-Client-IP")))
	if err != nil || !address.Is4() || address.Zone() != "" {
		return "", false
	}
	address = address.Unmap()
	for _, prefix := range h.sourceCIDRs {
		if prefix.Contains(address) {
			return address.String(), true
		}
	}
	return "", false
}

func developerTestAccountTargetIP(raw string) (string, bool) {
	address, err := netip.ParseAddr(strings.TrimSpace(raw))
	if err != nil || !address.Is4() || !personalDeveloperRouteTargetAllowed(address) {
		return "", false
	}
	return address.Unmap().String(), true
}
