package bootstrap

import (
	"errors"
	"net/http"
	"time"

	agentadapter "chatserver/internal/adapters/agent"
	authnadapter "chatserver/internal/adapters/authn"
	computeradapter "chatserver/internal/adapters/computer"
	computerauthadapter "chatserver/internal/adapters/computerauth"
	computercontroladapter "chatserver/internal/adapters/computercontrol"
	runtimesessionadapter "chatserver/internal/adapters/runtimesession"
	tokenadapter "chatserver/internal/adapters/token"
	"chatserver/internal/api/openapi"
	appagent "chatserver/internal/app/agentmanagement"
	appauthn "chatserver/internal/app/authn"
	appcomputercontrol "chatserver/internal/app/computercontrol"
	appcomputer "chatserver/internal/app/computermanagement"
	appruntimesession "chatserver/internal/app/runtimesession"
	"chatserver/internal/database"
	authnport "chatserver/internal/ports/authn"
	clockport "chatserver/internal/ports/clock"
	idport "chatserver/internal/ports/id"
	tencentimport "chatserver/internal/ports/tencentim"
	httptransport "chatserver/internal/transport/http"
)

// ComputerAPIConfig configures the Vela daemon control-plane vertical slice.
type ComputerAPIConfig struct {
	Database       *database.Handle
	AccessTokenKey []byte
	AccessTTL      time.Duration
	SDKAppID       int
	UserSigTTL     time.Duration
	UserSigIssuer  tencentimport.UserSigIssuer
	RequestTimeout time.Duration
	MaxBodyBytes   int64
}

// NewComputerAPIHandler assembles long-credential and short-bearer auth with
// Computer control services. It intentionally does not share the human API's
// authorization pipeline.
func NewComputerAPIHandler(config ComputerAPIConfig) (http.Handler, error) {
	if config.Database == nil || len(config.AccessTokenKey) == 0 ||
		config.AccessTTL <= 0 || config.AccessTTL > time.Hour ||
		config.SDKAppID <= 0 || config.UserSigTTL <= 0 || config.UserSigIssuer == nil ||
		config.RequestTimeout <= 0 || config.MaxBodyBytes <= 0 {
		return nil, errors.New("Computer API 配置无效")
	}
	clock := clockport.System{}
	tokens, err := tokenadapter.NewHMACJWT(config.AccessTokenKey, clock)
	if err != nil {
		return nil, err
	}
	currentness, err := computerauthadapter.NewEntRepository(config.Database, clock)
	if err != nil {
		return nil, err
	}
	credentialAuthenticator, err := authnadapter.NewComputerCredentialAuthenticator(currentness)
	if err != nil {
		return nil, err
	}
	bearerAuthenticator, err := authnadapter.NewComputerBearerAuthenticator(tokens, currentness)
	if err != nil {
		return nil, err
	}
	composite, err := authnadapter.NewCompositeAuthenticator(
		map[authnport.CandidateKind]authnport.Authenticator{
			authnport.CandidateComputerCredential: credentialAuthenticator,
			authnport.CandidateComputerBearer:     bearerAuthenticator,
		},
	)
	if err != nil {
		return nil, err
	}
	authenticationService, err := appauthn.NewService(composite)
	if err != nil {
		return nil, err
	}
	authenticationHook, err := httptransport.NewAuthenticationHook(authenticationService)
	if err != nil {
		return nil, err
	}
	repository, err := computercontroladapter.NewEntRepository(config.Database)
	if err != nil {
		return nil, err
	}
	service, err := appcomputercontrol.NewService(
		repository,
		tokens,
		clock,
		appcomputercontrol.Config{AccessTTL: config.AccessTTL},
	)
	if err != nil {
		return nil, err
	}
	credentialRepository, err := computeradapter.NewEntRepository(config.Database)
	if err != nil {
		return nil, err
	}
	credentialService, err := appcomputer.NewCredentialService(
		credentialRepository,
		idport.UUIDv7{},
		clock,
		appcomputer.CredentialConfig{
			DerivationKey: config.AccessTokenKey,
			CredentialTTL: 365 * 24 * time.Hour,
			HandoffTTL:    time.Hour,
			RotationGrace: time.Hour,
		},
	)
	if err != nil {
		return nil, err
	}
	assignmentService, err := appcomputercontrol.NewAssignmentService(repository)
	if err != nil {
		return nil, err
	}
	runtimeRepository, err := runtimesessionadapter.NewEntRepository(config.Database)
	if err != nil {
		return nil, err
	}
	runtimeService, err := appruntimesession.NewService(
		runtimeRepository,
		tokens,
		config.UserSigIssuer,
		clock,
		appruntimesession.Config{
			SDKAppID:   config.SDKAppID,
			AccessTTL:  config.AccessTTL,
			UserSigTTL: config.UserSigTTL,
			AllowedRuntime: []string{
				"codex", "hermes-acp", "hermes-gateway",
			},
		},
	)
	if err != nil {
		return nil, err
	}
	agentLaunchService, err := appcomputercontrol.NewAgentLaunchService(
		repository,
		runtimeService,
		clock,
	)
	if err != nil {
		return nil, err
	}
	observationService, err := appcomputercontrol.NewObservationService(
		repository,
		clock,
		appcomputercontrol.ObservationConfig{MaximumClockSkew: 5 * time.Minute},
	)
	if err != nil {
		return nil, err
	}
	agentRepository, err := agentadapter.NewEntRepository(config.Database)
	if err != nil {
		return nil, err
	}
	profileCapabilityService, err := appagent.NewProfileCapabilityResultService(
		agentRepository,
		clock,
	)
	if err != nil {
		return nil, err
	}
	encoder := httptransport.NewErrorEncoder(idport.UUIDv7{})
	routes, err := httptransport.NewComputerControlRoutes(
		service,
		credentialService,
		assignmentService,
		agentLaunchService,
		observationService,
		encoder,
		profileCapabilityService,
	)
	if err != nil {
		return nil, err
	}
	spec, err := openapi.GetSwagger()
	if err != nil {
		return nil, err
	}
	validator, err := httptransport.NewValidator(spec, encoder, authenticationHook)
	if err != nil {
		return nil, err
	}
	contentType, err := httptransport.JSONContentTypeMiddleware(spec, encoder)
	if err != nil {
		return nil, err
	}
	sensitiveResponses, err := httptransport.SensitiveResponseHeadersMiddleware(spec)
	if err != nil {
		return nil, err
	}
	implemented, err := httptransport.ImplementedRoutesMiddleware(
		[]httptransport.ImplementedRoute{
			{Method: http.MethodPost, Path: "/v1/computer/session"},
			{Method: http.MethodPost, Path: "/v1/computer/credential:rotate"},
			{Method: http.MethodGet, Path: "/v1/computer/assignments"},
			{Method: http.MethodPost, Path: "/v1/computer/agents/{agentId}/launches"},
			{Method: http.MethodPost, Path: "/v1/computer/agents/{agentId}/launches/{launchId}/session"},
			{Method: http.MethodPut, Path: "/v1/computer/agents/{agentId}/observations/{observationId}"},
			{Method: http.MethodPost, Path: "/v1/computer/heartbeat"},
		},
		encoder,
	)
	if err != nil {
		return nil, err
	}
	var handler http.Handler = routes
	handler = validator(handler)
	handler = httptransport.WithAuthState(handler)
	handler = contentType(handler)
	handler = httptransport.BodyLimitMiddleware(config.MaxBodyBytes, encoder)(handler)
	handler = sensitiveResponses(handler)
	handler = httptransport.RequestTimeoutMiddleware(config.RequestTimeout)(handler)
	handler = implemented(handler)
	handler = httptransport.ClientIPMiddleware(nil)(handler)
	handler = httptransport.RecoveryMiddleware(encoder, nil)(handler)
	handler = httptransport.RequestIDMiddleware(idport.UUIDv7{})(handler)
	return handler, nil
}
