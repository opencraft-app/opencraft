package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/api"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/federation"
)

const maxFederationStateBytes = 2048

func (h *Handler) GetFederationContext(ctx context.Context, request api.GetFederationContextRequestObject) (api.GetFederationContextResponseObject, error) {
	if !h.federationReady() {
		return api.GetFederationContext404JSONResponse(federationError("federation_disabled", "Federation is not enabled.")), nil
	}
	callback, err := h.federation.Registry.ValidateCallback(request.Params.ClientId, request.Params.RedirectUri)
	client, ok := h.federation.Registry.Client(request.Params.ClientId)
	if err != nil || !ok || !validFederationState(request.Params.State) {
		return api.GetFederationContext400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("invalid_federation_request", "The federation request is invalid."))}, nil
	}
	summary := api.FederationSessionSummary{Authenticated: false}
	if token := tokenFromContext(ctx); token != "" {
		if session, sessionErr := h.service.CurrentSession(ctx, token); sessionErr == nil && !session.Impersonated {
			user := h.toAPIUser(ctx, session.User)
			summary = api.FederationSessionSummary{Authenticated: true, User: &user}
		}
	}
	return api.GetFederationContext200JSONResponse{
		Client:      api.FederationClient{Id: client.ID, DisplayName: client.DisplayName},
		RedirectUri: callback,
		State:       request.Params.State,
		Session:     summary,
	}, nil
}

func (h *Handler) IssueFederationTicket(ctx context.Context, request api.IssueFederationTicketRequestObject) (api.IssueFederationTicketResponseObject, error) {
	if !h.federationReady() {
		return api.IssueFederationTicket404JSONResponse(federationError("federation_disabled", "Federation is not enabled.")), nil
	}
	if request.Body == nil || !validFederationState(request.Body.State) {
		return api.IssueFederationTicket400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("invalid_request", "The request body is invalid."))}, nil
	}
	callback, err := h.federation.Registry.ValidateCallback(request.Body.ClientId, request.Body.RedirectUri)
	if err != nil {
		return api.IssueFederationTicket400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("invalid_callback", "The callback is not registered."))}, nil
	}
	sourceToken := tokenFromContext(ctx)
	session, err := h.service.CurrentSession(ctx, sourceToken)
	if err != nil {
		return api.IssueFederationTicket401JSONResponse(federationError("unauthorized", "A current session is required.")), nil
	}
	if session.Impersonated {
		return api.IssueFederationTicket403JSONResponse(federationError("impersonation_forbidden", "Impersonation sessions cannot federate.")), nil
	}
	now := h.federationNow()
	expiresAt := now.Add(h.federation.HandoffTTL)
	ticket, err := h.federation.Codec.IssueHandoff(federation.HandoffClaims{
		SourceSessionToken: sourceToken,
		UserID:             session.User.ID,
		ClientID:           request.Body.ClientId,
		RedirectURI:        callback,
		IssuedAt:           now,
		ExpiresAt:          expiresAt,
	})
	if err != nil {
		return nil, err
	}
	redirect, _ := url.Parse(callback)
	query := redirect.Query()
	query.Set("ticket", ticket)
	query.Set("state", request.Body.State)
	redirect.RawQuery = query.Encode()
	return api.IssueFederationTicket200JSONResponse{RedirectUrl: redirect.String(), ExpiresAt: expiresAt}, nil
}

func validFederationState(state string) bool {
	trimmed := strings.TrimSpace(state)
	return trimmed != "" && len(state) <= maxFederationStateBytes
}

func (h *Handler) ExchangeFederationTicket(ctx context.Context, request api.ExchangeFederationTicketRequestObject) (api.ExchangeFederationTicketResponseObject, error) {
	if !h.federationReady() {
		return api.ExchangeFederationTicket404JSONResponse(federationError("federation_disabled", "Federation is not enabled.")), nil
	}
	identity, err := h.verifyFederationRequest(ctx)
	if err != nil {
		return api.ExchangeFederationTicket401JSONResponse(federationError("invalid_client_signature", "Client authentication failed.")), nil
	}
	if request.Body == nil {
		return api.ExchangeFederationTicket400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("invalid_request", "The request body is invalid."))}, nil
	}
	now := h.federationNow()
	claims, err := h.federation.Codec.ParseHandoff(request.Body.Ticket, now)
	if err != nil || claims.ClientID != identity.ClientID {
		return api.ExchangeFederationTicket401JSONResponse(federationError("invalid_ticket", "The handoff ticket is invalid or expired.")), nil
	}
	callback, err := h.federation.Registry.ValidateCallback(identity.ClientID, request.Body.RedirectUri)
	if err != nil || callback != claims.RedirectURI {
		return api.ExchangeFederationTicket401JSONResponse(federationError("invalid_ticket", "The handoff ticket does not match this callback.")), nil
	}
	session, err := h.service.CurrentSession(ctx, claims.SourceSessionToken)
	if err != nil || session.Impersonated || session.User.ID != claims.UserID {
		return api.ExchangeFederationTicket401JSONResponse(federationError("source_session_invalid", "The source session is no longer valid.")), nil
	}
	expiresAt := claims.IssuedAt.Add(h.federation.DelegatedSessionTTL)
	if session.ExpiresAt.Before(expiresAt) {
		expiresAt = session.ExpiresAt
	}
	delegated, err := h.federation.Codec.IssueDelegated(request.Body.Ticket, claims, expiresAt)
	if err != nil {
		return nil, err
	}
	return api.ExchangeFederationTicket200JSONResponse{DelegatedSession: delegated, ExpiresAt: expiresAt}, nil
}

func (h *Handler) CreateFederationTatSession(ctx context.Context, request api.CreateFederationTatSessionRequestObject) (api.CreateFederationTatSessionResponseObject, error) {
	if !h.federationReady() {
		return api.CreateFederationTatSession404JSONResponse(federationError("federation_disabled", "Federation is not enabled.")), nil
	}
	identity, err := h.verifyFederationRequest(ctx)
	if err != nil {
		return api.CreateFederationTatSession401JSONResponse(federationError("invalid_client_signature", "Client authentication failed.")), nil
	}
	if request.Body == nil || strings.TrimSpace(request.BotId) == "" || !validFederationTATRequestBody(ctx) {
		return api.CreateFederationTatSession400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("invalid_request", "The request is invalid."))}, nil
	}
	claims, err := h.federation.Codec.ParseDelegated(request.Body.DelegatedSession, h.federationNow())
	if err != nil || claims.ClientID != identity.ClientID {
		return api.CreateFederationTatSession401JSONResponse(federationError("invalid_delegated_session", "The delegated session is invalid or expired.")), nil
	}
	session, err := h.service.CurrentSession(ctx, claims.SourceSessionToken)
	if err != nil || session.Impersonated || session.User.ID != claims.UserID {
		return api.CreateFederationTatSession401JSONResponse(federationError("source_session_invalid", "The source session is no longer valid.")), nil
	}
	bootstrap, upstreamRequestID, err := h.federation.TATClient.CreateSession(ctx, request.BotId, claims.UserID, identity.RequestID)
	if err != nil {
		requestLogger(ginContext(ctx), nil).Warn("federation TAT request failed", "client_id", identity.ClientID, "key_id", identity.KeyID, "bot_id", request.BotId, "upstream_request_id", upstreamRequestID, "err", err)
		switch {
		case errors.Is(err, federation.ErrTATUnauthorized):
			return api.CreateFederationTatSession401JSONResponse(federationError("source_session_invalid", "The source session is no longer valid.")), nil
		case errors.Is(err, federation.ErrTATNotFound):
			return api.CreateFederationTatSession404JSONResponse(federationError("bot_not_found", "Bot not found.")), nil
		case errors.Is(err, federation.ErrTATConflict):
			return api.CreateFederationTatSession409JSONResponse(federationError("bot_not_connectable", "Bot is not connectable.")), nil
		case errors.Is(err, federation.ErrTATTimeout):
			return api.CreateFederationTatSession504JSONResponse(federationError("tat_timeout", "TAT session creation timed out.")), nil
		default:
			return api.CreateFederationTatSession502JSONResponse(federationError("tat_upstream_failed", "TAT session creation failed.")), nil
		}
	}
	return api.CreateFederationTatSession200JSONResponse{
		SessionId: bootstrap.SessionID, Region: bootstrap.Region, InstanceId: bootstrap.InstanceID,
		OwnerUin: bootstrap.OwnerUin, LoginUin: bootstrap.LoginUin, AppId: bootstrap.AppID, WsUrl: bootstrap.WsURL,
		Cols: bootstrap.Cols, Rows: bootstrap.Rows, TimeoutSeconds: bootstrap.TimeoutSeconds,
		Username: optionalFederationString(bootstrap.Username), WorkingDirectory: optionalFederationString(bootstrap.WorkingDirectory),
	}, nil
}

func validFederationTATRequestBody(ctx context.Context) bool {
	gctx := ginContext(ctx)
	if gctx == nil {
		return false
	}
	value, ok := gctx.Get(federationBodyContextKey)
	if !ok {
		return false
	}
	body, ok := value.([]byte)
	if !ok {
		return false
	}
	var request api.FederationTatSessionRequest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || strings.TrimSpace(request.DelegatedSession) == "" {
		return false
	}
	return decoder.Decode(&struct{}{}) == io.EOF
}

func (h *Handler) federationReady() bool {
	return h != nil && h.federation != nil && h.federation.Registry != nil && h.federation.Codec != nil && h.federation.Verifier != nil && h.federation.TATClient != nil && h.federation.HandoffTTL > 0 && h.federation.DelegatedSessionTTL > 0
}

func (h *Handler) federationNow() time.Time {
	if h.federation.Now != nil {
		return h.federation.Now().UTC()
	}
	return time.Now().UTC()
}

func (h *Handler) verifyFederationRequest(ctx context.Context) (federation.RequestIdentity, error) {
	gctx := ginContext(ctx)
	if gctx == nil {
		return federation.RequestIdentity{}, federation.ErrInvalidSignature
	}
	body, _ := gctx.Get(federationBodyContextKey)
	rawBody, _ := body.([]byte)
	return h.federation.Verifier.Verify(gctx.Request, rawBody, h.federationNow())
}

func federationError(code, message string) api.ErrorResponse {
	return api.ErrorResponse{Code: code, Message: message}
}

func optionalFederationString(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}
