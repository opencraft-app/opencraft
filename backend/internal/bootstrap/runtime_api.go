package bootstrap

import (
	"errors"
	"net/http"
	"time"

	authnadapter "chatserver/internal/adapters/authn"
	reminderoccurrenceadapter "chatserver/internal/adapters/reminderoccurrence"
	runtimeauthadapter "chatserver/internal/adapters/runtimeauth"
	runtimedirectoryadapter "chatserver/internal/adapters/runtimedirectory"
	runtimesessionadapter "chatserver/internal/adapters/runtimesession"
	tokenadapter "chatserver/internal/adapters/token"
	workadapter "chatserver/internal/adapters/work"
	"chatserver/internal/api/openapi"
	appauthn "chatserver/internal/app/authn"
	appreminderoccurrence "chatserver/internal/app/reminderoccurrence"
	appruntimedirectory "chatserver/internal/app/runtimedirectory"
	appruntimesession "chatserver/internal/app/runtimesession"
	appruntimework "chatserver/internal/app/runtimework"
	"chatserver/internal/database"
	authnport "chatserver/internal/ports/authn"
	clockport "chatserver/internal/ports/clock"
	idport "chatserver/internal/ports/id"
	tencentimport "chatserver/internal/ports/tencentim"
	httptransport "chatserver/internal/transport/http"
)

// RuntimeAPIConfig 配置 Agent credential 换取 Runtime Session 的独立入口。
type RuntimeAPIConfig struct {
	Database       *database.Handle
	AccessTokenKey []byte
	AccessTTL      time.Duration
	SDKAppID       int
	UserSigTTL     time.Duration
	UserSigIssuer  tencentimport.UserSigIssuer
	RequestTimeout time.Duration
	MaxBodyBytes   int64
}

// NewRuntimeAPIHandler 组装 Runtime credential、Token、UserSig 与 Ent 纵向闭环。
func NewRuntimeAPIHandler(config RuntimeAPIConfig) (http.Handler, error) {
	if config.Database == nil ||
		len(config.AccessTokenKey) == 0 ||
		config.AccessTTL <= 0 ||
		config.SDKAppID <= 0 ||
		config.UserSigTTL <= 0 ||
		config.UserSigIssuer == nil ||
		config.RequestTimeout <= 0 ||
		config.MaxBodyBytes <= 0 {
		return nil, errors.New("Runtime API 配置无效")
	}
	clock := clockport.System{}
	tokens, err := tokenadapter.NewHMACJWT(config.AccessTokenKey, clock)
	if err != nil {
		return nil, err
	}
	currentness, err := runtimeauthadapter.NewEntRepository(config.Database)
	if err != nil {
		return nil, err
	}
	runtimeBearerAuthenticator, err :=
		authnadapter.NewRuntimeBearerAuthenticator(tokens, currentness)
	if err != nil {
		return nil, err
	}
	composite, err := authnadapter.NewCompositeAuthenticator(
		map[authnport.CandidateKind]authnport.Authenticator{
			authnport.CandidateRuntimeBearer: runtimeBearerAuthenticator,
		},
	)
	if err != nil {
		return nil, err
	}
	authenticationService, err := appauthn.NewService(composite)
	if err != nil {
		return nil, err
	}
	authenticationHook, err := httptransport.NewAuthenticationHook(
		authenticationService,
	)
	if err != nil {
		return nil, err
	}

	sessionRepository, err := runtimesessionadapter.NewEntRepository(
		config.Database,
	)
	if err != nil {
		return nil, err
	}
	sessionService, err := appruntimesession.NewService(
		sessionRepository,
		tokens,
		config.UserSigIssuer,
		clock,
		appruntimesession.Config{
			SDKAppID:   config.SDKAppID,
			AccessTTL:  config.AccessTTL,
			UserSigTTL: config.UserSigTTL,
			AllowedRuntime: []string{
				"codex",
				"hermes-acp",
				"hermes-gateway",
			},
		},
	)
	if err != nil {
		return nil, err
	}
	occurrenceRepository, err := reminderoccurrenceadapter.NewEntRepository(
		config.Database,
		idport.UUIDv7{},
	)
	if err != nil {
		return nil, err
	}
	occurrenceService, err := appreminderoccurrence.NewService(
		occurrenceRepository,
		clock,
	)
	if err != nil {
		return nil, err
	}
	workRepository, err := workadapter.NewEntRepository(config.Database)
	if err != nil {
		return nil, err
	}
	runtimeTaskService, err := appruntimework.NewService(
		workRepository,
		clock,
		idport.UUIDv7{},
	)
	if err != nil {
		return nil, err
	}
	directoryRepository, err := runtimedirectoryadapter.NewEntRepository(config.Database)
	if err != nil {
		return nil, err
	}
	directoryService, err := appruntimedirectory.NewService(
		directoryRepository,
		clock,
		2*time.Minute,
	)
	if err != nil {
		return nil, err
	}
	encoder := httptransport.NewErrorEncoder(idport.UUIDv7{})
	routes, err := httptransport.NewRuntimeRoutes(
		sessionService,
		occurrenceService,
		runtimeTaskService,
		directoryService,
		encoder,
	)
	if err != nil {
		return nil, err
	}
	spec, err := openapi.GetSwagger()
	if err != nil {
		return nil, err
	}
	validator, err := httptransport.NewValidator(
		spec,
		encoder,
		authenticationHook,
	)
	if err != nil {
		return nil, err
	}
	contentType, err := httptransport.JSONContentTypeMiddleware(spec, encoder)
	if err != nil {
		return nil, err
	}
	sensitiveResponses, err := httptransport.SensitiveResponseHeadersMiddleware(
		spec,
	)
	if err != nil {
		return nil, err
	}
	implemented, err := httptransport.ImplementedRoutesMiddleware(
		[]httptransport.ImplementedRoute{
			{Method: http.MethodGet, Path: "/v1/runtime/me"},
			{Method: http.MethodGet, Path: "/v1/runtime/directory"},
			{Method: http.MethodGet, Path: "/v1/runtime/directory-v2"},
			{
				Method: http.MethodGet,
				Path:   "/v1/runtime/channels/{channelId}/members",
			},
			{Method: http.MethodPost, Path: "/v1/runtime/threads:resolve"},
			{
				Method: http.MethodPost,
				Path:   "/v1/runtime/threads/{threadId}/replies",
			},
			{
				Method: http.MethodGet,
				Path:   "/v1/runtime/reminder-occurrences",
			},
			{
				Method: http.MethodPost,
				Path:   "/v1/runtime/reminder-occurrences/{occurrenceId}/ack",
			},
			{Method: http.MethodGet, Path: "/v1/runtime/tasks"},
			{Method: http.MethodGet, Path: "/v1/runtime/tasks/{taskId}"},
			{Method: http.MethodPatch, Path: "/v1/runtime/tasks/{taskId}"},
			{Method: http.MethodPost, Path: "/v1/runtime/tasks/{taskId}/claim"},
			{Method: http.MethodGet, Path: "/v1/runtime/reminders"},
			{Method: http.MethodPost, Path: "/v1/runtime/reminders"},
			{
				Method: http.MethodPatch,
				Path:   "/v1/runtime/reminders/{reminderId}",
			},
			{
				Method: http.MethodDelete,
				Path:   "/v1/runtime/reminders/{reminderId}",
			},
			{
				Method: http.MethodPost,
				Path:   "/v1/runtime/reminders/{reminderId}/snooze",
			},
			{
				Method: http.MethodGet,
				Path:   "/v1/runtime/reminders/{reminderId}/log",
			},
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
