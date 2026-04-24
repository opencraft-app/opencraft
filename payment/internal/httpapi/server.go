package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/payment/internal/api"
	"git.woa.com/wisp/mono/payment/internal/service"
)

type ServerConfig struct {
	InternalServiceToken string
}

type Handler struct {
	payments            *service.Service
	internalServiceToken string
}

func NewRouter(payments *service.Service, cfg ServerConfig) *gin.Engine {
	router := gin.New()
	router.Use(gin.Recovery())
	router.GET("/healthz", func(ctx *gin.Context) {
		ctx.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	handler := &Handler{
		payments:             payments,
		internalServiceToken: strings.TrimSpace(cfg.InternalServiceToken),
	}
	api.RegisterHandlers(router, api.NewStrictHandler(handler, nil))
	return router
}

func (h *Handler) CreatePaymentOrder(ctx context.Context, request api.CreatePaymentOrderRequestObject) (api.CreatePaymentOrderResponseObject, error) {
	if !authorizedInternal(ctx, h.internalServiceToken) {
		return api.CreatePaymentOrder401JSONResponse(api.ErrorResponseJSONResponse{Error: "unauthorized"}), nil
	}
	if request.Body == nil {
		return api.CreatePaymentOrder400JSONResponse{
			ErrorResponseJSONResponse: api.ErrorResponseJSONResponse{Error: "missing_body"},
		}, nil
	}
	order, err := h.payments.CreateOrder(ctx, request.Body.ExternalUserId, string(request.Body.Code))
	if err != nil {
		return api.CreatePaymentOrder400JSONResponse{
			ErrorResponseJSONResponse: api.ErrorResponseJSONResponse{Error: err.Error()},
		}, nil
	}
	return api.CreatePaymentOrder200JSONResponse(*toAPIOrder(order)), nil
}

func (h *Handler) GetPaymentOrder(ctx context.Context, request api.GetPaymentOrderRequestObject) (api.GetPaymentOrderResponseObject, error) {
	if !authorizedInternal(ctx, h.internalServiceToken) {
		return api.GetPaymentOrder401JSONResponse{
			ErrorResponseJSONResponse: api.ErrorResponseJSONResponse{Error: "unauthorized"},
		}, nil
	}
	order, err := h.payments.GetOrder(ctx, request.OrderId)
	if err != nil {
		return api.GetPaymentOrder404JSONResponse{Error: err.Error()}, nil
	}
	if order == nil {
		return api.GetPaymentOrder404JSONResponse{Error: "order_not_found"}, nil
	}
	return api.GetPaymentOrder200JSONResponse(*toAPIOrder(order)), nil
}

func (h *Handler) MarkPaymentOrderPaid(ctx context.Context, request api.MarkPaymentOrderPaidRequestObject) (api.MarkPaymentOrderPaidResponseObject, error) {
	if !authorizedInternal(ctx, h.internalServiceToken) {
		return api.MarkPaymentOrderPaid401JSONResponse{
			ErrorResponseJSONResponse: api.ErrorResponseJSONResponse{Error: "unauthorized"},
		}, nil
	}
	order, err := h.payments.MarkPaid(ctx, request.OrderId, stringValue(request.Body))
	if err != nil {
		return api.MarkPaymentOrderPaid404JSONResponse{Error: err.Error()}, nil
	}
	return api.MarkPaymentOrderPaid200JSONResponse(*toAPIOrder(order)), nil
}

func authorizedInternal(ctx context.Context, token string) bool {
	ginCtx, ok := ctx.(*gin.Context)
	if !ok {
		return false
	}
	expected := "Bearer " + strings.TrimSpace(token)
	return expected != "Bearer " && strings.TrimSpace(ginCtx.GetHeader("Authorization")) == expected
}

func stringValue(body *api.MarkPaidRequest) string {
	if body == nil || body.ProviderOrderId == nil {
		return ""
	}
	return strings.TrimSpace(*body.ProviderOrderId)
}

func toAPIOrder(order *service.Order) *api.PaymentOrder {
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
