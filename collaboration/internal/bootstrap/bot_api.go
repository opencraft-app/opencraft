package bootstrap

import (
	"crypto/rand"
	"errors"
	"net/http"
	"time"

	accountauthadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/accountauth"
	authnadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/authn"
	botimadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/botim"
	externalhumanadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/externalhuman"
	tokenadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/token"
	"git.woa.com/wisp/mono2/collaboration/internal/api/openapi"
	appauthn "git.woa.com/wisp/mono2/collaboration/internal/app/authn"
	appbotagent "git.woa.com/wisp/mono2/collaboration/internal/app/botagent"
	appexternalhuman "git.woa.com/wisp/mono2/collaboration/internal/app/externalhuman"
	appimgroup "git.woa.com/wisp/mono2/collaboration/internal/app/imgroup"
	"git.woa.com/wisp/mono2/collaboration/internal/database"
	authnport "git.woa.com/wisp/mono2/collaboration/internal/ports/authn"
	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
	clockport "git.woa.com/wisp/mono2/collaboration/internal/ports/clock"
	idport "git.woa.com/wisp/mono2/collaboration/internal/ports/id"
	tencentimport "git.woa.com/wisp/mono2/collaboration/internal/ports/tencentim"
	httptransport "git.woa.com/wisp/mono2/collaboration/internal/transport/http"
)

// BotIMAPIConfig 配置 LightVela Bot IM 身份、平台群与 Bot Runtime 入口。
type BotIMAPIConfig struct {
	Database                       *database.Handle
	AccessTokenKey                 []byte
	GatewayHumanToken              []byte
	ExternalHumanProvisioningEpoch string
	SDKAppID                       int
	AccessTTL                      time.Duration
	UserSigTTL                     time.Duration
	UserSigIssuer                  tencentimport.UserSigIssuer
	Identities                     appbotagent.IdentityManager
	Deriver                        appbotagent.IdentityDeriver
	Host                           botimport.Host
	TencentGroups                  botimport.TencentGroups
	BotRuntimeAPIBaseURL           string
	RequestTimeout                 time.Duration
	MaxBodyBytes                   int64
}

// BotIMAPI 暴露 HTTP 入口与群服务；群服务同时供腾讯回调对账使用。
type BotIMAPI struct {
	Handler http.Handler
	Groups  *appimgroup.Service
}

// NewBotIMAPI 组装 Bot IM 的认证、应用服务与 Ent 纵向闭环。
func NewBotIMAPI(config BotIMAPIConfig) (*BotIMAPI, error) {
	if config.Database == nil || len(config.AccessTokenKey) == 0 || config.SDKAppID <= 0 ||
		config.AccessTTL <= 0 || config.UserSigTTL <= 0 || config.UserSigIssuer == nil ||
		config.Identities == nil || config.Deriver == nil || config.Host == nil ||
		config.TencentGroups == nil || config.RequestTimeout <= 0 || config.MaxBodyBytes <= 0 {
		return nil, errors.New("Bot IM API 配置无效")
	}
	clock := clockport.System{}
	tokens, err := tokenadapter.NewHMACJWT(config.AccessTokenKey, clock)
	if err != nil {
		return nil, err
	}
	repository, err := botimadapter.NewEntRepository(config.Database, idport.UUIDv7{})
	if err != nil {
		return nil, err
	}
	accounts, err := accountauthadapter.NewEntRepository(config.Database)
	if err != nil {
		return nil, err
	}
	humanAuthenticator, err := authnadapter.NewHumanAuthenticator(tokens, accounts, clock)
	if err != nil {
		return nil, err
	}
	botCredentialAuthenticator, err := authnadapter.NewBotCredentialAuthenticator(repository)
	if err != nil {
		return nil, err
	}
	botRuntimeAuthenticator, err := authnadapter.NewBotRuntimeBearerAuthenticator(tokens, repository)
	if err != nil {
		return nil, err
	}
	authenticators := map[authnport.CandidateKind]authnport.Authenticator{
		authnport.CandidateHumanBearer:      humanAuthenticator,
		authnport.CandidateBotCredential:    botCredentialAuthenticator,
		authnport.CandidateBotRuntimeBearer: botRuntimeAuthenticator,
	}
	if len(config.GatewayHumanToken) > 0 {
		externalRepository, err := externalhumanadapter.NewEntRepository(config.Database)
		if err != nil {
			return nil, err
		}
		externalHumans, err := appexternalhuman.NewService(
			externalRepository, idport.UUIDv7{}, clock,
			appexternalhuman.Config{ProvisioningEpoch: config.ExternalHumanProvisioningEpoch},
		)
		if err != nil {
			return nil, err
		}
		gatewayAuthenticator, err := authnadapter.NewGatewayHumanAuthenticator(
			config.GatewayHumanToken, externalHumans,
		)
		if err != nil {
			return nil, err
		}
		authenticators[authnport.CandidateGatewayHuman] = gatewayAuthenticator
	}
	composite, err := authnadapter.NewCompositeAuthenticator(authenticators)
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

	bots, err := appbotagent.NewService(
		repository, config.Deriver, config.Identities, config.Host, tokens, config.UserSigIssuer,
		idport.UUIDv7{}, clock, rand.Reader,
		appbotagent.Config{
			SDKAppID: config.SDKAppID, APIBaseURL: config.BotRuntimeAPIBaseURL,
			AccessTTL: config.AccessTTL, UserSigTTL: config.UserSigTTL,
		},
	)
	if err != nil {
		return nil, err
	}
	groups, err := appimgroup.NewService(repository, config.TencentGroups, clock)
	if err != nil {
		return nil, err
	}

	encoder := httptransport.NewErrorEncoder(idport.UUIDv7{})
	routes, err := httptransport.NewBotIMRoutes(bots, groups, encoder)
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
		httptransport.BotIMImplementedRoutes(), encoder,
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
	return &BotIMAPI{Handler: handler, Groups: groups}, nil
}
