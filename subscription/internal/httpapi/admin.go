package httpapi

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/subscription/internal/service"
)

const timeRFC3339Milli = "2006-01-02T15:04:05.000Z07:00"

type adminListResponse[T any] struct {
	Items []T `json:"items"`
	Total int `json:"total"`
}

type adminSubscriptionResponse struct {
	ID                      string  `json:"id"`
	ExternalUserID          string  `json:"externalUserId"`
	Code                    string  `json:"code"`
	Status                  string  `json:"status"`
	AIGatewayPlanID         *string `json:"aiGatewayPlanId,omitempty"`
	AIGatewaySubscriptionID *string `json:"aiGatewaySubscriptionId,omitempty"`
	CurrentPeriodStart      *string `json:"currentPeriodStart,omitempty"`
	CurrentPeriodEnd        *string `json:"currentPeriodEnd,omitempty"`
	SourceOrderID           *string `json:"sourceOrderId,omitempty"`
	CreatedAt               string  `json:"createdAt"`
	UpdatedAt               string  `json:"updatedAt"`
}

type adminSubscriptionEventResponse struct {
	ID             string  `json:"id"`
	SubscriptionID string  `json:"subscriptionId"`
	EventType      string  `json:"eventType"`
	Code           string  `json:"code"`
	Status         string  `json:"status"`
	SourceOrderID  *string `json:"sourceOrderId,omitempty"`
	CreatedAt      string  `json:"createdAt"`
}

type adminPlanResponse struct {
	Code        string `json:"code"`
	Description string `json:"description"`
	MaxBotCount int    `json:"maxBotCount"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

type adminSetSubscriptionRequest struct {
	Code string `json:"code"`
}

type adminUpsertPlanRequest struct {
	Description string `json:"description"`
	MaxBotCount int    `json:"maxBotCount"`
}

func registerAdminRoutes(group *gin.RouterGroup, handler *Handler) {
	group.GET("/plans", handler.listPlans)
	group.PUT("/plans/:code", handler.upsertPlan)
	group.DELETE("/plans/:code", handler.deletePlan)
	group.GET("/subscriptions", handler.listSubscriptions)
	group.GET("/subscriptions/:externalUserID/events", handler.listSubscriptionEvents)
	group.PUT("/subscriptions/:externalUserID", handler.setSubscription)
	group.POST("/subscriptions/:externalUserID/resync", handler.resyncSubscription)
	group.DELETE("/subscriptions/:externalUserID", handler.cancelSubscription)
}

func (h *Handler) listPlans(ctx *gin.Context) {
	items, err := h.subscriptions.AdminListPlans(ctx.Request.Context())
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "list_plans_failed"})
		return
	}
	resp := make([]adminPlanResponse, 0, len(items))
	for _, item := range items {
		resp = append(resp, adminPlanResponse{
			Code:        item.Code,
			Description: item.Description,
			MaxBotCount: item.MaxBotCount,
			CreatedAt:   item.CreatedAt.UTC().Format(timeRFC3339Milli),
			UpdatedAt:   item.UpdatedAt.UTC().Format(timeRFC3339Milli),
		})
	}
	ctx.JSON(http.StatusOK, adminListResponse[adminPlanResponse]{Items: resp, Total: len(resp)})
}

func (h *Handler) upsertPlan(ctx *gin.Context) {
	var req adminUpsertPlanRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return
	}
	plan, err := h.subscriptions.AdminUpsertPlan(ctx.Request.Context(), ctx.Param("code"), req.Description, req.MaxBotCount)
	if err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx.JSON(http.StatusOK, adminPlanResponse{
		Code:        plan.Code,
		Description: plan.Description,
		MaxBotCount: plan.MaxBotCount,
		CreatedAt:   plan.CreatedAt.UTC().Format(timeRFC3339Milli),
		UpdatedAt:   plan.UpdatedAt.UTC().Format(timeRFC3339Milli),
	})
}

func (h *Handler) deletePlan(ctx *gin.Context) {
	err := h.subscriptions.AdminDeletePlan(ctx.Request.Context(), ctx.Param("code"))
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		}
		ctx.JSON(status, gin.H{"error": err.Error()})
		return
	}
	ctx.Status(http.StatusNoContent)
}

func (h *Handler) listSubscriptions(ctx *gin.Context) {
	items, err := h.subscriptions.AdminList(ctx.Request.Context(), service.AdminListFilter{
		Search: strings.TrimSpace(ctx.Query("search")),
		Status: strings.TrimSpace(ctx.Query("status")),
		Code:   strings.TrimSpace(ctx.Query("code")),
		Limit:  queryLimit(ctx),
	})
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "list_subscriptions_failed"})
		return
	}
	resp := make([]adminSubscriptionResponse, 0, len(items))
	for _, item := range items {
		resp = append(resp, toAdminSubscriptionResponse(item))
	}
	ctx.JSON(http.StatusOK, adminListResponse[adminSubscriptionResponse]{Items: resp, Total: len(resp)})
}

func (h *Handler) listSubscriptionEvents(ctx *gin.Context) {
	items, err := h.subscriptions.AdminEvents(ctx.Request.Context(), ctx.Param("externalUserID"), queryLimit(ctx))
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "list_subscription_events_failed"})
		return
	}
	resp := make([]adminSubscriptionEventResponse, 0, len(items))
	for _, item := range items {
		resp = append(resp, adminSubscriptionEventResponse{
			ID:             item.ID,
			SubscriptionID: item.SubscriptionID,
			EventType:      item.EventType,
			Code:           item.Code,
			Status:         item.Status,
			SourceOrderID:  optionalString(item.SourceOrderID),
			CreatedAt:      item.CreatedAt.UTC().Format(timeRFC3339Milli),
		})
	}
	ctx.JSON(http.StatusOK, adminListResponse[adminSubscriptionEventResponse]{Items: resp, Total: len(resp)})
}

func (h *Handler) setSubscription(ctx *gin.Context) {
	var req adminSetSubscriptionRequest
	if err := ctx.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Code) == "" {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return
	}
	subscription, err := h.subscriptions.AdminSetSubscription(ctx.Request.Context(), ctx.Param("externalUserID"), req.Code)
	if err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx.JSON(http.StatusOK, toAdminSubscriptionResponse(*subscription))
}

func (h *Handler) resyncSubscription(ctx *gin.Context) {
	subscription, err := h.subscriptions.AdminResync(ctx.Request.Context(), ctx.Param("externalUserID"))
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		}
		ctx.JSON(status, gin.H{"error": err.Error()})
		return
	}
	ctx.JSON(http.StatusOK, toAdminSubscriptionResponse(*subscription))
}

func (h *Handler) cancelSubscription(ctx *gin.Context) {
	subscription, err := h.subscriptions.AdminCancel(ctx.Request.Context(), ctx.Param("externalUserID"))
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		}
		ctx.JSON(status, gin.H{"error": err.Error()})
		return
	}
	ctx.JSON(http.StatusOK, toAdminSubscriptionResponse(*subscription))
}

func toAdminSubscriptionResponse(item service.Subscription) adminSubscriptionResponse {
	return adminSubscriptionResponse{
		ID:                      item.ID,
		ExternalUserID:          item.ExternalUserID,
		Code:                    item.Code,
		Status:                  item.Status,
		AIGatewayPlanID:         optionalString(item.AIGatewayPlanID),
		AIGatewaySubscriptionID: optionalString(item.AIGatewaySubscriptionID),
		CurrentPeriodStart:      formatOptionalTime(item.CurrentPeriodStart),
		CurrentPeriodEnd:        formatOptionalTime(item.CurrentPeriodEnd),
		SourceOrderID:           optionalString(item.SourceOrderID),
		CreatedAt:               item.CreatedAt.UTC().Format(timeRFC3339Milli),
		UpdatedAt:               item.UpdatedAt.UTC().Format(timeRFC3339Milli),
	}
}

func formatOptionalTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(timeRFC3339Milli)
	return &formatted
}

func queryLimit(ctx *gin.Context) int {
	raw := strings.TrimSpace(ctx.Query("limit"))
	if raw == "" {
		return 50
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 50
	}
	return value
}
