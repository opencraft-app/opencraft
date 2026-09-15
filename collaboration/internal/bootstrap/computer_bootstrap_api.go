package bootstrap

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	authnadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/authn"
	computerauthadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/computerauth"
	bootstrapadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/computerbootstrap"
	bootstrapapi "git.woa.com/wisp/mono2/collaboration/internal/api/computerbootstrap"
	appauthn "git.woa.com/wisp/mono2/collaboration/internal/app/authn"
	appbootstrap "git.woa.com/wisp/mono2/collaboration/internal/app/computerbootstrap"
	"git.woa.com/wisp/mono2/collaboration/internal/database"
	authnport "git.woa.com/wisp/mono2/collaboration/internal/ports/authn"
	clockport "git.woa.com/wisp/mono2/collaboration/internal/ports/clock"
	idport "git.woa.com/wisp/mono2/collaboration/internal/ports/id"
	tencenttatport "git.woa.com/wisp/mono2/collaboration/internal/ports/tencenttat"
	httptransport "git.woa.com/wisp/mono2/collaboration/internal/transport/http"
)

type ComputerBootstrapAPIConfig struct {
	Database       *database.Handle
	Registrar      tencenttatport.Registrar
	Region         string
	EncryptionKey  []byte
	Random         io.Reader
	RequestTimeout time.Duration
	MaxBodyBytes   int64
}

type ComputerBootstrapProcessor interface {
	ProcessOne(context.Context) (bool, error)
}

type ComputerBootstrapAPI struct {
	Handler   http.Handler
	Processor ComputerBootstrapProcessor
}

func NewComputerBootstrapAPI(config ComputerBootstrapAPIConfig) (*ComputerBootstrapAPI, error) {
	if config.Database == nil || config.Registrar == nil || config.Random == nil ||
		len(config.EncryptionKey) != 32 || config.RequestTimeout <= 0 || config.MaxBodyBytes <= 0 {
		return nil, errors.New("Computer bootstrap API 配置无效")
	}
	clock := clockport.System{}
	currentness, err := computerauthadapter.NewBootstrapEntRepository(config.Database, clock)
	if err != nil {
		return nil, err
	}
	credentialAuthenticator, err := authnadapter.NewComputerCredentialAuthenticator(currentness)
	if err != nil {
		return nil, err
	}
	composite, err := authnadapter.NewCompositeAuthenticator(
		map[authnport.CandidateKind]authnport.Authenticator{
			authnport.CandidateComputerCredential: credentialAuthenticator,
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
	repository, err := bootstrapadapter.NewEntRepository(config.Database)
	if err != nil {
		return nil, err
	}
	service, err := appbootstrap.NewService(
		repository, config.Registrar, idport.UUIDv7{}, clock,
		appbootstrap.Config{
			Region: config.Region, LeaseTTL: 30 * time.Second, MaterialTTL: time.Hour,
			MaxAttempts: 3, EncryptionKey: config.EncryptionKey, Random: config.Random,
		},
	)
	if err != nil {
		return nil, err
	}
	encoder := httptransport.NewErrorEncoder(idport.UUIDv7{})
	routes, err := httptransport.NewComputerBootstrapRoutes(service, encoder)
	if err != nil {
		return nil, err
	}
	spec, err := bootstrapapi.GetSwagger()
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
	sensitive, err := httptransport.SensitiveResponseHeadersMiddleware(spec)
	if err != nil {
		return nil, err
	}
	implemented, err := httptransport.ImplementedRoutesMiddleware(
		[]httptransport.ImplementedRoute{{
			Method: http.MethodPost, Path: "/v1/bootstrap/provider-registration",
		}},
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
	handler = sensitive(handler)
	handler = httptransport.RequestTimeoutMiddleware(config.RequestTimeout)(handler)
	handler = implemented(handler)
	handler = httptransport.ClientIPMiddleware(nil)(handler)
	handler = httptransport.RecoveryMiddleware(encoder, nil)(handler)
	handler = httptransport.RequestIDMiddleware(idport.UUIDv7{})(handler)
	return &ComputerBootstrapAPI{Handler: handler, Processor: service}, nil
}

func NewComputerBootstrapAPIHandler(config ComputerBootstrapAPIConfig) (http.Handler, error) {
	subsystem, err := NewComputerBootstrapAPI(config)
	if err != nil {
		return nil, err
	}
	return subsystem.Handler, nil
}
