package httptransport

import (
	"context"
	"errors"
	"net/http"

	bootstrapapi "chatserver/internal/api/computerbootstrap"
	appbootstrap "chatserver/internal/app/computerbootstrap"
	computerauthport "chatserver/internal/ports/computerauth"

	"github.com/google/uuid"
)

type providerBootstrapService interface {
	GetOrCreate(context.Context, computerauthport.Route) (appbootstrap.Result, error)
}

type ComputerBootstrapHandler struct {
	bootstrapapi.StrictServerInterface
	service providerBootstrapService
}

func NewComputerBootstrapHandler(
	service providerBootstrapService,
) (*ComputerBootstrapHandler, error) {
	if service == nil {
		return nil, errors.New("Computer bootstrap 应用服务不能为空")
	}
	return &ComputerBootstrapHandler{service: service}, nil
}

func (handler *ComputerBootstrapHandler) GetOrCreateProviderRegistration(
	ctx context.Context,
	_ bootstrapapi.GetOrCreateProviderRegistrationRequestObject,
) (bootstrapapi.GetOrCreateProviderRegistrationResponseObject, error) {
	principal, ok := CurrentComputerPrincipal(ctx)
	if !ok {
		return nil, errors.New("Computer bootstrap principal 缺失")
	}
	result, err := handler.service.GetOrCreate(ctx, computerauthport.Route{
		ServerID: principal.ServerID(), ComputerID: principal.ComputerID(),
		Version: principal.CredentialVersion(),
	})
	if err != nil {
		return nil, err
	}
	operationID, err := uuid.Parse(result.OperationID)
	if err != nil || operationID == uuid.Nil {
		return nil, errors.New("Computer bootstrap operation ID 无效")
	}
	if !result.Ready {
		state := bootstrapapi.ProviderRegistrationPendingState(result.State)
		if !state.Valid() || result.RetryAfterSeconds < 1 || result.RetryAfterSeconds > 30 {
			return nil, errors.New("Computer bootstrap pending 数据无效")
		}
		return bootstrapapi.GetOrCreateProviderRegistration202JSONResponse{
			Body: bootstrapapi.ProviderRegistrationPending{
				OperationId: operationID, State: state,
				RetryAfterSeconds: result.RetryAfterSeconds,
			},
			Headers: bootstrapapi.GetOrCreateProviderRegistration202ResponseHeaders{
				CacheControl: "no-store", Pragma: "no-cache",
				RetryAfter: result.RetryAfterSeconds,
			},
		}, nil
	}
	registration := result.Registration
	protocol := bootstrapapi.ProviderRegistrationProtocol(registration.Protocol)
	if !protocol.Valid() || registration.Region == "" || registration.CodeID == "" ||
		registration.CodeValue == "" || registration.ExpiresAt.IsZero() || len(registration.Tags) == 0 {
		return nil, errors.New("Computer bootstrap registration 数据无效")
	}
	tags := make([]bootstrapapi.ProviderRegistrationTag, 0, len(registration.Tags))
	for _, tag := range registration.Tags {
		if tag.Key == "" || tag.Value == "" {
			return nil, errors.New("Computer bootstrap registration tag 无效")
		}
		tags = append(tags, bootstrapapi.ProviderRegistrationTag{Key: tag.Key, Value: tag.Value})
	}
	return bootstrapapi.GetOrCreateProviderRegistration200JSONResponse{
		Body: bootstrapapi.ProviderRegistration{
			OperationId: operationID, State: bootstrapapi.Ready, Protocol: protocol,
			Region: registration.Region, RegisterCodeId: registration.CodeID,
			RegisterCodeValue: registration.CodeValue, Tags: tags,
			ExpiresAt: registration.ExpiresAt.UTC(),
		},
		Headers: bootstrapapi.GetOrCreateProviderRegistration200ResponseHeaders{
			CacheControl: "no-store", Pragma: "no-cache",
		},
	}, nil
}

func NewComputerBootstrapRoutes(
	service providerBootstrapService,
	encoder *ErrorEncoder,
) (http.Handler, error) {
	if encoder == nil {
		return nil, ErrValidatorEncoderRequired
	}
	handler, err := NewComputerBootstrapHandler(service)
	if err != nil {
		return nil, err
	}
	strict := bootstrapapi.NewStrictHandlerWithOptions(
		handler,
		nil,
		bootstrapapi.StrictHTTPServerOptions{
			RequestErrorHandlerFunc: func(writer http.ResponseWriter, request *http.Request, err error) {
				encoder.WriteCode(writer, requestIDFromRequest(request), "invalid_request", err)
			},
			ResponseErrorHandlerFunc: func(writer http.ResponseWriter, request *http.Request, err error) {
				encoder.Write(writer, requestIDFromRequest(request), err)
			},
		},
	)
	wrapper := &bootstrapapi.ServerInterfaceWrapper{
		Handler: strict,
		ErrorHandlerFunc: func(writer http.ResponseWriter, request *http.Request, err error) {
			encoder.WriteCode(writer, requestIDFromRequest(request), "invalid_request", err)
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc(
		"POST /v1/bootstrap/provider-registration",
		wrapper.GetOrCreateProviderRegistration,
	)
	return mux, nil
}
