package server

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	gatewayv1 "github.com/openclaw/openclaw/mono/cloudladdergateway/gen/cloudladdergateway/v1"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/proxy"
)

type ConnectService struct {
	engine        *proxy.Engine
	authenticator *auth.Authenticator
}

func NewConnectService(engine *proxy.Engine, authenticator *auth.Authenticator) *ConnectService {
	return &ConnectService{engine: engine, authenticator: authenticator}
}

func (s *ConnectService) Invoke(ctx context.Context, req *connect.Request[gatewayv1.ProxyRequest]) (*connect.Response[gatewayv1.ProxyResponse], error) {
	proxyReq := proxyRequestFromProto(req.Msg)
	if err := s.authenticator.Verify(auth.Request{
		Caller:    proxyReq.Caller,
		RouteID:   proxyReq.RouteID,
		Method:    proxyReq.Method,
		Path:      proxyReq.Path,
		Query:     proxyReq.Query,
		Body:      proxyReq.Body,
		Timestamp: req.Msg.GetTimestamp(),
		Signature: req.Msg.GetSignature(),
	}); err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, err)
	}
	resp, err := s.engine.Invoke(ctx, proxyReq)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return connect.NewResponse(proxyResponseToProto(resp)), nil
}

func (s *ConnectService) CheckRoute(ctx context.Context, req *connect.Request[gatewayv1.RouteCheckRequest]) (*connect.Response[gatewayv1.RouteCheckResponse], error) {
	if req.Msg.GetRequest() == nil {
		return connect.NewResponse(&gatewayv1.RouteCheckResponse{Matched: false, Error: "request is required"}), nil
	}
	proxyReq := proxyRequestFromProto(req.Msg.GetRequest())
	if err := s.authenticator.Verify(auth.Request{
		Caller:    proxyReq.Caller,
		RouteID:   proxyReq.RouteID,
		Method:    proxyReq.Method,
		Path:      proxyReq.Path,
		Query:     proxyReq.Query,
		Body:      proxyReq.Body,
		Timestamp: req.Msg.GetRequest().GetTimestamp(),
		Signature: req.Msg.GetRequest().GetSignature(),
	}); err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, err)
	}
	route, err := s.engine.Match(ctx, proxyReq)
	if err != nil {
		if errors.Is(err, proxy.ErrNoRoute) {
			return connect.NewResponse(&gatewayv1.RouteCheckResponse{Matched: false, Error: err.Error()}), nil
		}
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return connect.NewResponse(&gatewayv1.RouteCheckResponse{Matched: true, RouteId: route.ID}), nil
}

func proxyRequestFromProto(req *gatewayv1.ProxyRequest) proxy.Request {
	headers := headersFromProto(req.GetHeaders())
	return proxy.Request{
		RequestID:  req.GetRequestId(),
		Caller:     req.GetCaller(),
		RouteID:    req.GetRouteId(),
		Method:     req.GetMethod(),
		Path:       req.GetPath(),
		Query:      req.GetQuery(),
		Headers:    headers,
		Body:       req.GetBody(),
		Attributes: req.GetAttributes(),
	}
}

func proxyResponseToProto(resp proxy.Response) *gatewayv1.ProxyResponse {
	deliveries := make([]*gatewayv1.WebhookDelivery, 0, len(resp.WebhookDeliveries))
	for _, delivery := range resp.WebhookDeliveries {
		deliveries = append(deliveries, &gatewayv1.WebhookDelivery{
			Id:         delivery.ID,
			Mode:       delivery.Mode,
			Status:     delivery.Status,
			StatusCode: int32(delivery.StatusCode),
			Error:      delivery.Error,
			TargetUrl:  delivery.TargetURL,
		})
	}
	return &gatewayv1.ProxyResponse{
		StatusCode:        int32(resp.StatusCode),
		Headers:           headersToProto(resp.Headers),
		Body:              resp.Body,
		UpstreamUrl:       resp.UpstreamURL,
		WebhookDeliveries: deliveries,
	}
}
