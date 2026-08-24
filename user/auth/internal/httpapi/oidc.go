package httpapi

import (
	"context"
	"errors"
	"net/url"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/api"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/oidc"
)

func (h *Handler) oidcReady() bool {
	return h != nil && h.oidc != nil && h.oidc.Provider != nil
}

func (h *Handler) GetOpenIdJwks(ctx context.Context, _ api.GetOpenIdJwksRequestObject) (api.GetOpenIdJwksResponseObject, error) {
	if !h.oidcReady() {
		return api.GetOpenIdJwks404JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("oidc_disabled", "OIDC is not enabled."))}, nil
	}
	jwks := h.oidc.Provider.JWKS()
	keys := make([]api.OIDCJWK, 0, len(jwks.Keys))
	for _, key := range jwks.Keys {
		keys = append(keys, api.OIDCJWK{
			Alg: key.Alg,
			Crv: key.Crv,
			Kid: key.Kid,
			Kty: key.Kty,
			Use: key.Use,
			X:   key.X,
		})
	}
	return api.GetOpenIdJwks200JSONResponse(api.OIDCJWKS{Keys: keys}), nil
}

func (h *Handler) GetOpenIdConfiguration(ctx context.Context, _ api.GetOpenIdConfigurationRequestObject) (api.GetOpenIdConfigurationResponseObject, error) {
	if !h.oidcReady() {
		return api.GetOpenIdConfiguration404JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("oidc_disabled", "OIDC is not enabled."))}, nil
	}
	discovery := h.oidc.Provider.DiscoveryDocument()
	return api.GetOpenIdConfiguration200JSONResponse(api.OIDCDiscoveryDocument{
		Issuer:                            discovery.Issuer,
		AuthorizationEndpoint:             discovery.AuthorizationEndpoint,
		TokenEndpoint:                     discovery.TokenEndpoint,
		JwksUri:                           discovery.JwksURI,
		ResponseTypesSupported:            discovery.ResponseTypesSupported,
		SubjectTypesSupported:             discovery.SubjectTypesSupported,
		IdTokenSigningAlgValuesSupported:  discovery.IDTokenSigningAlgValuesSupported,
		ScopesSupported:                   discovery.ScopesSupported,
		TokenEndpointAuthMethodsSupported: discovery.TokenEndpointAuthMethodsSupport,
		GrantTypesSupported:               discovery.GrantTypesSupported,
		CodeChallengeMethodsSupported:     discovery.CodeChallengeMethodsSupported,
	}), nil
}

func (h *Handler) GetOidcAuthorize(ctx context.Context, request api.GetOidcAuthorizeRequestObject) (api.GetOidcAuthorizeResponseObject, error) {
	if !h.oidcReady() {
		return api.GetOidcAuthorize404JSONResponse(federationError("oidc_disabled", "OIDC is not enabled.")), nil
	}
	req := oidcAuthorizeRequestFromGetParams(request.Params)
	if _, err := h.oidc.Provider.ValidateAuthorizeRequest(req); err != nil {
		return oidcErrorGetAuthorizeResponse(err), nil
	}
	if gctx := ginContext(ctx); gctx != nil {
		target, _ := url.Parse(h.frontendBaseURL + "/auth/federation/authorize")
		target.RawQuery = gctx.Request.URL.RawQuery
		gctx.Header("Location", target.String())
	}
	return api.GetOidcAuthorize302Response{}, nil
}

func (h *Handler) GetOidcAuthorizeContext(ctx context.Context, request api.GetOidcAuthorizeContextRequestObject) (api.GetOidcAuthorizeContextResponseObject, error) {
	if !h.oidcReady() {
		return api.GetOidcAuthorizeContext404JSONResponse(federationError("oidc_disabled", "OIDC is not enabled.")), nil
	}
	contextValue, err := h.oidc.Provider.ValidateAuthorizeRequest(oidcAuthorizeRequestFromContextParams(request.Params))
	if err != nil {
		return api.GetOidcAuthorizeContext400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("invalid_request", "The OIDC request is invalid."))}, nil
	}
	sessionSummary := api.FederationSessionSummary{Authenticated: false}
	if token := tokenFromContext(ctx); token != "" {
		if session, sessionErr := h.service.CurrentSession(ctx, token); sessionErr == nil && !session.Impersonated {
			user := h.toAPIUser(ctx, session.User)
			sessionSummary = api.FederationSessionSummary{Authenticated: true, User: &user}
		}
	}
	return api.GetOidcAuthorizeContext200JSONResponse(api.OIDCAuthorizeContextResponse{
		Client: api.FederationClient{
			Id:          contextValue.ClientID,
			DisplayName: contextValue.ClientName,
		},
		RedirectUri:         contextValue.RedirectURI,
		State:               contextValue.State,
		ResponseType:        "code",
		Scope:               contextValue.Scope,
		CodeChallenge:       contextValue.CodeChallenge,
		CodeChallengeMethod: "S256",
		Nonce:               contextValue.Nonce,
		Session:             sessionSummary,
	}), nil
}

func (h *Handler) AuthorizeOidc(ctx context.Context, request api.AuthorizeOidcRequestObject) (api.AuthorizeOidcResponseObject, error) {
	if !h.oidcReady() {
		return api.AuthorizeOidc404JSONResponse(federationError("oidc_disabled", "OIDC is not enabled.")), nil
	}
	if request.Body == nil {
		return api.AuthorizeOidc400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("invalid_request", "The OIDC request is invalid."))}, nil
	}
	session, err := h.service.CurrentSession(ctx, tokenFromContext(ctx))
	if err != nil || session.Impersonated {
		return api.AuthorizeOidc401JSONResponse(federationError("unauthorized", "A current session is required.")), nil
	}
	result, err := h.oidc.Provider.CreateAuthorizationCode(ctx, session.User.ID, oidcAuthorizeRequestFromJSON(*request.Body))
	if err != nil {
		return oidcErrorAuthorizeResponse(err), nil
	}
	if gctx := ginContext(ctx); gctx != nil {
		gctx.Header("Location", result.RedirectTo)
	}
	return api.AuthorizeOidc200JSONResponse(api.OIDCAuthorizeResponse{
		RedirectUrl: result.RedirectTo,
		ExpiresAt:   result.ExpiresAt,
	}), nil
}

func (h *Handler) ExchangeOidcToken(ctx context.Context, request api.ExchangeOidcTokenRequestObject) (api.ExchangeOidcTokenResponseObject, error) {
	if !h.oidcReady() {
		return api.ExchangeOidcToken404JSONResponse(federationError("oidc_disabled", "OIDC is not enabled.")), nil
	}
	if request.Body == nil {
		return api.ExchangeOidcToken400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("invalid_request", "The token request is invalid."))}, nil
	}
	record, err := h.oidc.Provider.ConsumeAuthorizationCode(ctx, oidc.TokenRequest{
		GrantType:    request.Body.GrantType,
		Code:         request.Body.Code,
		ClientID:     request.Body.ClientId,
		RedirectURI:  request.Body.RedirectUri,
		CodeVerifier: request.Body.CodeVerifier,
	})
	if err != nil {
		return api.ExchangeOidcToken400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(oidcGrantOrRequestError(err))}, nil
	}
	user, err := h.service.FindUserByID(ctx, record.UserID)
	if err != nil {
		return api.ExchangeOidcToken400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("invalid_grant", "The authorization code is invalid."))}, nil
	}
	tokenResponse, err := h.oidc.Provider.BuildTokenResponse(record, oidc.TokenUser{
		ID:    user.ID,
		Name:  user.Name,
		Email: user.Email,
	})
	if err != nil {
		return api.ExchangeOidcToken400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(oidcGrantOrRequestError(err))}, nil
	}
	return api.ExchangeOidcToken200JSONResponse(api.OIDCTokenResponse{
		AccessToken: tokenResponse.AccessToken,
		TokenType:   tokenResponse.TokenType,
		ExpiresIn:   int64(tokenResponse.ExpiresIn),
		Scope:       tokenResponse.Scope,
		IdToken:     tokenResponse.IDToken,
	}), nil
}

func oidcAuthorizeRequestFromGetParams(params api.GetOidcAuthorizeParams) oidc.AuthorizeRequest {
	return oidc.AuthorizeRequest{
		ClientID:            string(params.ClientId),
		RedirectURI:         string(params.RedirectUri),
		ResponseType:        string(params.ResponseType),
		Scope:               string(params.Scope),
		State:               string(params.State),
		Nonce:               string(params.Nonce),
		CodeChallenge:       string(params.CodeChallenge),
		CodeChallengeMethod: string(params.CodeChallengeMethod),
	}
}

func oidcAuthorizeRequestFromContextParams(params api.GetOidcAuthorizeContextParams) oidc.AuthorizeRequest {
	return oidc.AuthorizeRequest{
		ClientID:            string(params.ClientId),
		RedirectURI:         string(params.RedirectUri),
		ResponseType:        string(params.ResponseType),
		Scope:               string(params.Scope),
		State:               string(params.State),
		Nonce:               string(params.Nonce),
		CodeChallenge:       string(params.CodeChallenge),
		CodeChallengeMethod: string(params.CodeChallengeMethod),
	}
}

func oidcAuthorizeRequestFromJSON(body api.OIDCAuthorizeRequest) oidc.AuthorizeRequest {
	return oidc.AuthorizeRequest{
		ClientID:            body.ClientId,
		RedirectURI:         body.RedirectUri,
		ResponseType:        body.ResponseType,
		Scope:               body.Scope,
		State:               body.State,
		Nonce:               body.Nonce,
		CodeChallenge:       body.CodeChallenge,
		CodeChallengeMethod: body.CodeChallengeMethod,
	}
}

func oidcErrorGetAuthorizeResponse(err error) api.GetOidcAuthorizeResponseObject {
	if errors.Is(err, oidc.ErrInvalidClient) {
		return api.GetOidcAuthorize400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("unauthorized_client", "The OIDC client is not allowed."))}
	}
	return api.GetOidcAuthorize400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("invalid_request", "The OIDC request is invalid."))}
}

func oidcErrorAuthorizeResponse(err error) api.AuthorizeOidcResponseObject {
	if errors.Is(err, oidc.ErrInvalidClient) {
		return api.AuthorizeOidc400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("unauthorized_client", "The OIDC client is not allowed."))}
	}
	return api.AuthorizeOidc400JSONResponse{ErrorResponseJSONResponse: api.ErrorResponseJSONResponse(federationError("invalid_request", "The OIDC request is invalid."))}
}

func oidcGrantOrRequestError(err error) api.ErrorResponse {
	if errors.Is(err, oidc.ErrInvalidGrant) {
		return federationError("invalid_grant", "The authorization code is invalid.")
	}
	return federationError("invalid_request", "The token request is invalid.")
}
