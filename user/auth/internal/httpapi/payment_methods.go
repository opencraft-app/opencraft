package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/api"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/paymentmethod"
)

func (h *Handler) ListPaymentMethods(ctx context.Context, request api.ListPaymentMethodsRequestObject) (api.ListPaymentMethodsResponseObject, error) {
	setPaymentMethodNoStore(ctx)
	page, pageSize := 1, 20
	if request.Params.Page != nil {
		page = *request.Params.Page
	}
	if request.Params.PageSize != nil {
		pageSize = *request.Params.PageSize
	}
	clientIP, clientUA := paymentMethodClientMetadata(ctx)
	result, err := h.service.ListPaymentMethods(ctx, tokenFromContext(ctx), page, pageSize, clientIP, clientUA)
	if err != nil {
		body, status := toErrorBody(err)
		switch status {
		case http.StatusBadRequest:
			return api.ListPaymentMethods400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		case http.StatusUnauthorized:
			return api.ListPaymentMethods401JSONResponse(body), nil
		case http.StatusConflict:
			return api.ListPaymentMethods409JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.ListPaymentMethods502JSONResponse(body), nil
		case http.StatusServiceUnavailable:
			return api.ListPaymentMethods503JSONResponse(body), nil
		default:
			return nil, err
		}
	}

	items := make([]api.PaymentMethod, 0, len(result.Items))
	for _, item := range result.Items {
		items = append(items, api.PaymentMethod{
			ContractCode: item.ContractCode,
			MaskedNumber: item.MaskedNumber,
			PayerName:    item.PayerName,
			Type:         item.Type,
			IsDefault:    item.IsDefault,
		})
	}
	return api.ListPaymentMethods200JSONResponse{
		Items: items,
		Total: result.Total,
	}, nil
}

func (h *Handler) CreatePaymentMethodSignOrder(ctx context.Context, request api.CreatePaymentMethodSignOrderRequestObject) (api.CreatePaymentMethodSignOrderResponseObject, error) {
	setPaymentMethodNoStore(ctx)
	if request.Body == nil {
		return api.CreatePaymentMethodSignOrder400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{
			Code:    "invalid_request",
			Message: "请求体不能为空。",
		})}, nil
	}
	languageCode := "en"
	if request.Body.LanguageCode != nil {
		if !request.Body.LanguageCode.Valid() {
			return api.CreatePaymentMethodSignOrder400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(api.ErrorResponse{
				Code:    "invalid_payment_method_language",
				Message: "绑卡页面语言不合法。",
			})}, nil
		}
		languageCode = string(*request.Body.LanguageCode)
	}
	returnURL, err := paymentMethodCallbackURL(h.frontendBaseURL, "success")
	if err != nil {
		return api.CreatePaymentMethodSignOrder503JSONResponse(api.ErrorResponse{
			Code:    "payment_methods_unavailable",
			Message: "签约卡管理暂未开放。",
		}), nil
	}
	cancelURL, err := paymentMethodCallbackURL(h.frontendBaseURL, "cancelled")
	if err != nil {
		return api.CreatePaymentMethodSignOrder503JSONResponse(api.ErrorResponse{
			Code:    "payment_methods_unavailable",
			Message: "签约卡管理暂未开放。",
		}), nil
	}

	clientIP, clientUA := paymentMethodClientMetadata(ctx)
	result, err := h.service.CreatePaymentMethodSignOrder(ctx, tokenFromContext(ctx), paymentmethod.CreateSignOrderInput{
		ReturnURL:    returnURL,
		CancelURL:    cancelURL,
		LanguageCode: languageCode,
	}, clientIP, clientUA)
	if err != nil {
		body, status := toErrorBody(err)
		switch status {
		case http.StatusBadRequest:
			return api.CreatePaymentMethodSignOrder400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		case http.StatusUnauthorized:
			return api.CreatePaymentMethodSignOrder401JSONResponse(body), nil
		case http.StatusConflict:
			return api.CreatePaymentMethodSignOrder409JSONResponse(body), nil
		case http.StatusTooManyRequests:
			return api.CreatePaymentMethodSignOrder429JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.CreatePaymentMethodSignOrder502JSONResponse(body), nil
		case http.StatusServiceUnavailable:
			return api.CreatePaymentMethodSignOrder503JSONResponse(body), nil
		default:
			return nil, err
		}
	}
	return api.CreatePaymentMethodSignOrder200JSONResponse{
		ContractCode: result.ContractCode,
		RedirectUrl:  result.RedirectURL,
	}, nil
}

func (h *Handler) SetDefaultPaymentMethod(ctx context.Context, request api.SetDefaultPaymentMethodRequestObject) (api.SetDefaultPaymentMethodResponseObject, error) {
	setPaymentMethodNoStore(ctx)
	clientIP, clientUA := paymentMethodClientMetadata(ctx)
	if err := h.service.SetDefaultPaymentMethod(ctx, tokenFromContext(ctx), request.ContractCode, clientIP, clientUA); err != nil {
		body, status := toErrorBody(err)
		switch status {
		case http.StatusBadRequest:
			return api.SetDefaultPaymentMethod400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		case http.StatusUnauthorized:
			return api.SetDefaultPaymentMethod401JSONResponse(body), nil
		case http.StatusConflict:
			return api.SetDefaultPaymentMethod409JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.SetDefaultPaymentMethod502JSONResponse(body), nil
		case http.StatusServiceUnavailable:
			return api.SetDefaultPaymentMethod503JSONResponse(body), nil
		default:
			return nil, err
		}
	}
	return api.SetDefaultPaymentMethod204Response{}, nil
}

func (h *Handler) DeletePaymentMethod(ctx context.Context, request api.DeletePaymentMethodRequestObject) (api.DeletePaymentMethodResponseObject, error) {
	setPaymentMethodNoStore(ctx)
	clientIP, clientUA := paymentMethodClientMetadata(ctx)
	if err := h.service.DeletePaymentMethod(ctx, tokenFromContext(ctx), request.ContractCode, clientIP, clientUA); err != nil {
		body, status := toErrorBody(err)
		switch status {
		case http.StatusBadRequest:
			return api.DeletePaymentMethod400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(body)}, nil
		case http.StatusUnauthorized:
			return api.DeletePaymentMethod401JSONResponse(body), nil
		case http.StatusConflict:
			return api.DeletePaymentMethod409JSONResponse(body), nil
		case http.StatusBadGateway:
			return api.DeletePaymentMethod502JSONResponse(body), nil
		case http.StatusServiceUnavailable:
			return api.DeletePaymentMethod503JSONResponse(body), nil
		default:
			return nil, err
		}
	}
	return api.DeletePaymentMethod204Response{}, nil
}

func paymentMethodCallbackURL(frontendBaseURL, result string) (string, error) {
	base, err := url.Parse(strings.TrimSpace(frontendBaseURL))
	if err != nil || base.Scheme != "https" || base.Host == "" || base.User != nil {
		return "", errors.New("frontend base URL must be an absolute HTTPS URL")
	}
	callback := base.ResolveReference(&url.URL{Path: "/account/"})
	query := callback.Query()
	query.Set("payment-method", result)
	callback.RawQuery = query.Encode()
	return callback.String(), nil
}

func paymentMethodClientMetadata(ctx context.Context) (string, string) {
	if gctx := ginContext(ctx); gctx != nil {
		return gctx.ClientIP(), gctx.Request.UserAgent()
	}
	return "", ""
}

func setPaymentMethodNoStore(ctx context.Context) {
	if gctx := ginContext(ctx); gctx != nil {
		gctx.Header("Cache-Control", "no-store")
	}
}
