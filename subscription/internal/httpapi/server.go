package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/subscription/internal/api"
	"git.woa.com/wisp/mono/subscription/internal/service"
)

const userIDHeader = "X-Lightclaw-User-ID"

type ServerConfig struct {
	AllowedOrigins []string
	AdminToken     string
}

type Handler struct {
	subscriptions *service.Service
	adminToken    string
}

func NewRouter(subscriptions *service.Service, cfg ServerConfig) *gin.Engine {
	router := gin.New()
	router.Use(gin.Recovery(), corsMiddleware(cfg.AllowedOrigins))
	router.GET("/healthz", func(ctx *gin.Context) {
		ctx.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	handler := &Handler{
		subscriptions: subscriptions,
		adminToken:    strings.TrimSpace(cfg.AdminToken),
	}
	admin := router.Group("/admin")
	admin.Use(adminAuthMiddleware(handler.adminToken))
	registerAdminRoutes(admin, handler)
	api.RegisterHandlers(router, api.NewStrictHandler(handler, nil))
	return router
}

func (h *Handler) GetCurrentSubscription(ctx context.Context, _ api.GetCurrentSubscriptionRequestObject) (api.GetCurrentSubscriptionResponseObject, error) {
	externalUserID := externalUserIDFromContext(ctx)
	if externalUserID == "" {
		return api.GetCurrentSubscription401JSONResponse{
			ErrorResponseJSONResponse: api.ErrorResponseJSONResponse{Error: "missing_user_identity"},
		}, nil
	}
	subscription, err := h.subscriptions.GetCurrent(ctx, externalUserID)
	if err != nil {
		return api.GetCurrentSubscription401JSONResponse{
			ErrorResponseJSONResponse: api.ErrorResponseJSONResponse{Error: "load_subscription_failed"},
		}, nil
	}
	if subscription == nil || subscription.Status != service.SubscriptionStatusActive {
		return api.GetCurrentSubscription200JSONResponse{
			HasSubscription: false,
		}, nil
	}
	return api.GetCurrentSubscription200JSONResponse{
		HasSubscription: true,
		Subscription:    toAPISubscription(subscription),
	}, nil
}

func (h *Handler) CheckoutSubscription(ctx context.Context, request api.CheckoutSubscriptionRequestObject) (api.CheckoutSubscriptionResponseObject, error) {
	externalUserID := externalUserIDFromContext(ctx)
	if externalUserID == "" {
		return api.CheckoutSubscription401JSONResponse{
			Error: "missing_user_identity",
		}, nil
	}
	if request.Body == nil {
		return api.CheckoutSubscription400JSONResponse{
			ErrorResponseJSONResponse: api.ErrorResponseJSONResponse{Error: "missing_body"},
		}, nil
	}
	result, err := h.subscriptions.Checkout(ctx, externalUserID, string(request.Body.Code))
	if err != nil {
		return api.CheckoutSubscription400JSONResponse{
			ErrorResponseJSONResponse: api.ErrorResponseJSONResponse{Error: err.Error()},
		}, nil
	}
	response := api.CheckoutResponse{
		Code: result.Code,
		Mode: api.CheckoutResponseMode(result.Mode),
	}
	if result.Subscription != nil {
		response.Subscription = toAPISubscription(result.Subscription)
	}
	if result.Order != nil {
		response.Order = toAPIOrder(result.Order)
	}
	return api.CheckoutSubscription200JSONResponse(response), nil
}

func (h *Handler) ApplyPaymentToSubscription(ctx context.Context, request api.ApplyPaymentToSubscriptionRequestObject) (api.ApplyPaymentToSubscriptionResponseObject, error) {
	if request.Body == nil {
		return api.ApplyPaymentToSubscription400JSONResponse{
			ErrorResponseJSONResponse: api.ErrorResponseJSONResponse{Error: "missing_body"},
		}, nil
	}
	subscription, err := h.subscriptions.ApplyPayment(
		ctx,
		request.Body.OrderId,
		request.Body.ExternalUserId,
		request.Body.Code,
		stringValue(request.Body.ProviderOrderId),
	)
	if err != nil {
		return api.ApplyPaymentToSubscription400JSONResponse{
			ErrorResponseJSONResponse: api.ErrorResponseJSONResponse{Error: err.Error()},
		}, nil
	}
	return api.ApplyPaymentToSubscription200JSONResponse(*toAPISubscription(subscription)), nil
}

func externalUserIDFromContext(ctx context.Context) string {
	ginCtx, ok := ctx.(*gin.Context)
	if !ok {
		return ""
	}
	return strings.TrimSpace(ginCtx.GetHeader(userIDHeader))
}

func adminAuthMiddleware(token string) gin.HandlerFunc {
	expected := "Bearer " + strings.TrimSpace(token)
	return func(ctx *gin.Context) {
		if expected == "Bearer " {
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		raw := strings.TrimSpace(ctx.GetHeader("Authorization"))
		if raw != expected {
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		ctx.Next()
	}
}

func toAPISubscription(record *service.Subscription) *api.SubscriptionRecord {
	if record == nil {
		return nil
	}
	return &api.SubscriptionRecord{
		AiGatewayPlanId:         optionalString(record.AIGatewayPlanID),
		AiGatewaySubscriptionId: optionalString(record.AIGatewaySubscriptionID),
		Code:                    record.Code,
		CreatedAt:               record.CreatedAt,
		CurrentPeriodEnd:        record.CurrentPeriodEnd,
		CurrentPeriodStart:      record.CurrentPeriodStart,
		ExternalUserId:          record.ExternalUserID,
		Id:                      record.ID,
		SourceOrderId:           optionalString(record.SourceOrderID),
		Status:                  api.SubscriptionRecordStatus(record.Status),
		UpdatedAt:               record.UpdatedAt,
	}
}

func toAPIOrder(order *service.PaymentOrder) *api.PaymentOrder {
	if order == nil {
		return nil
	}
	return &api.PaymentOrder{
		CheckoutUrl:     optionalString(order.CheckoutURL),
		Code:            order.Code,
		CreatedAt:       order.CreatedAt,
		ExternalUserId:  order.ExternalUserID,
		Id:              order.ID,
		Provider:        order.Provider,
		ProviderOrderId: optionalString(order.ProviderOrderID),
		Status:          api.PaymentOrderStatus(order.Status),
		UpdatedAt:       order.UpdatedAt,
	}
}

func optionalString(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	trimmed := strings.TrimSpace(value)
	return &trimmed
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func corsMiddleware(allowedOrigins []string) gin.HandlerFunc {
	allowed := make(map[string]struct{}, len(allowedOrigins))
	for _, origin := range allowedOrigins {
		if trimmed := strings.TrimSpace(origin); trimmed != "" {
			allowed[trimmed] = struct{}{}
		}
	}
	return func(ctx *gin.Context) {
		if origin := strings.TrimSpace(ctx.GetHeader("Origin")); origin != "" {
			if _, ok := allowed[origin]; ok {
				ctx.Header("Access-Control-Allow-Origin", origin)
				ctx.Header("Access-Control-Allow-Credentials", "true")
				ctx.Header("Access-Control-Allow-Headers", "Authorization, Content-Type")
				ctx.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				ctx.Header("Vary", "Origin")
			}
		}
		if ctx.Request.Method == http.MethodOptions {
			ctx.AbortWithStatus(http.StatusNoContent)
			return
		}
		ctx.Next()
	}
}
