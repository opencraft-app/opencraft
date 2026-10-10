// Package bootstrap 负责把外层 adapter 与内层应用服务组装为可运行入口。
package bootstrap

import (
	"crypto/rand"
	"errors"
	"net/http"
	"time"

	accountauthadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/accountauth"
	agentadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/agent"
	authnadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/authn"
	channeladapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/channel"
	channelmembershipadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/channelmembership"
	computeradapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/computer"
	computerv2adapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/computerv2"
	credentialsadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/credentials"
	directconversationadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/directconversation"
	externalhumanadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/externalhuman"
	humanaccountadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/humanaccount"
	membermutationadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/membermutation"
	operationadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/operation"
	ratelimitadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/ratelimit"
	serverinviteadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/serverinvite"
	servermemberadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/servermember"
	tencentimadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/tencentim"
	tokenadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/token"
	workadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/work"
	"git.woa.com/wisp/mono2/collaboration/internal/api/openapi"
	appaccountauth "git.woa.com/wisp/mono2/collaboration/internal/app/accountauth"
	appagent "git.woa.com/wisp/mono2/collaboration/internal/app/agentmanagement"
	appauthn "git.woa.com/wisp/mono2/collaboration/internal/app/authn"
	appchannel "git.woa.com/wisp/mono2/collaboration/internal/app/channelmanagement"
	appchannelmembership "git.woa.com/wisp/mono2/collaboration/internal/app/channelmembership"
	appcomputer "git.woa.com/wisp/mono2/collaboration/internal/app/computermanagement"
	appcomputerv2 "git.woa.com/wisp/mono2/collaboration/internal/app/computerv2"
	appdirectconversation "git.woa.com/wisp/mono2/collaboration/internal/app/directconversation"
	appexternalhuman "git.woa.com/wisp/mono2/collaboration/internal/app/externalhuman"
	apphumanaccount "git.woa.com/wisp/mono2/collaboration/internal/app/humanaccount"
	appmembermutation "git.woa.com/wisp/mono2/collaboration/internal/app/membermutation"
	appoperationquery "git.woa.com/wisp/mono2/collaboration/internal/app/operationquery"
	appserverinvite "git.woa.com/wisp/mono2/collaboration/internal/app/serverinvite"
	appservermember "git.woa.com/wisp/mono2/collaboration/internal/app/servermember"
	appwork "git.woa.com/wisp/mono2/collaboration/internal/app/workmanagement"
	"git.woa.com/wisp/mono2/collaboration/internal/database"
	authnport "git.woa.com/wisp/mono2/collaboration/internal/ports/authn"
	clockport "git.woa.com/wisp/mono2/collaboration/internal/ports/clock"
	computerport "git.woa.com/wisp/mono2/collaboration/internal/ports/computer"
	computerv2port "git.woa.com/wisp/mono2/collaboration/internal/ports/computerv2"
	idport "git.woa.com/wisp/mono2/collaboration/internal/ports/id"
	ratelimitport "git.woa.com/wisp/mono2/collaboration/internal/ports/ratelimit"
	tencentimport "git.woa.com/wisp/mono2/collaboration/internal/ports/tencentim"
	tencenttatport "git.woa.com/wisp/mono2/collaboration/internal/ports/tencenttat"
	httptransport "git.woa.com/wisp/mono2/collaboration/internal/transport/http"
)

// AuthAPIConfig 是四个认证 operation 的装配配置。
type AuthAPIConfig struct {
	Database                       *database.Handle
	AccessTokenKey                 []byte
	GatewayHumanToken              []byte
	ExternalHumanProvisioningEpoch string
	Password                       credentialsadapter.Argon2idConfig
	AccessTTL                      time.Duration
	RefreshTTL                     time.Duration
	RequestTimeout                 time.Duration
	MaxBodyBytes                   int64
	AllowedOrigins                 []string
}

// HumanAPIConfig 在认证 API 上增加 /me 与 Human IM Session。
type HumanAPIConfig struct {
	Auth          AuthAPIConfig
	SDKAppID      int
	UserSigTTL    time.Duration
	UserSigIssuer tencentimport.UserSigIssuer
}

// PlatformAPIConfig 在 Human API 上增加首组 Server/Member 管理面。
type PlatformAPIConfig struct {
	Human              HumanAPIConfig
	IMResourceKey      []byte
	ServerCreationWait time.Duration
	TATRegistrar       tencenttatport.Registrar
	TerminalIssuer     tencenttatport.TerminalSessionIssuer
	ManagedTATRegion   string
	ComputerEnrollment *ComputerEnrollmentAPIConfig
	// ComputerV2Instances is the LightVela-owned instance directory supplied by
	// the same trusted gateway/control-plane integration that resolved the Human.
	ComputerV2Instances computerv2port.InstanceDirectory
}

// ComputerEnrollmentAPIConfig 固定一个已签名 release，并为私有对象提供短期 URL。
type ComputerEnrollmentAPIConfig struct {
	Release           computerport.ReleaseBinding
	PlatformBaseURL   string
	AllowInsecureHTTP bool
	TokenTTL          time.Duration
	CredentialTTL     time.Duration
	ArtifactURLTTL    time.Duration
	ArtifactSigner    computerport.ArtifactURLSigner
}

// NewAuthAPIHandler 组装真实 SQLite/Ent 认证闭环和安全 middleware。
func NewAuthAPIHandler(config AuthAPIConfig) (http.Handler, error) {
	return newAuthAndMeAPIHandler(
		config, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
	)
}

// NewHumanAPIHandler 组装 Auth、/me 与 Human IM Session。
func NewHumanAPIHandler(config HumanAPIConfig) (http.Handler, error) {
	if config.SDKAppID <= 0 ||
		config.UserSigTTL <= 0 ||
		config.UserSigIssuer == nil ||
		config.Auth.Database == nil {
		return nil, errors.New("Human API 配置无效")
	}
	repository, err := humanaccountadapter.NewEntRepository(
		config.Auth.Database,
	)
	if err != nil {
		return nil, err
	}
	service, err := apphumanaccount.NewService(
		repository,
		config.UserSigIssuer,
		apphumanaccount.Config{
			SDKAppID:   config.SDKAppID,
			UserSigTTL: config.UserSigTTL,
		},
	)
	if err != nil {
		return nil, err
	}
	return newAuthAndMeAPIHandler(
		config.Auth, service, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
	)
}

// NewPlatformAPIHandler 组装 Auth、Me、Server 创建/查询和 Member 查询。
func NewPlatformAPIHandler(config PlatformAPIConfig) (http.Handler, error) {
	if config.Human.Auth.Database == nil ||
		len(config.IMResourceKey) < 32 ||
		config.ServerCreationWait <= 0 ||
		(config.TATRegistrar == nil) != (config.TerminalIssuer == nil) ||
		(config.ComputerEnrollment != nil && config.TATRegistrar == nil) {
		return nil, errors.New("Platform API 配置无效")
	}
	humanRepository, err := humanaccountadapter.NewEntRepository(
		config.Human.Auth.Database,
	)
	if err != nil {
		return nil, err
	}
	meService, err := apphumanaccount.NewService(
		humanRepository,
		config.Human.UserSigIssuer,
		apphumanaccount.Config{
			SDKAppID:   config.Human.SDKAppID,
			UserSigTTL: config.Human.UserSigTTL,
		},
	)
	if err != nil {
		return nil, err
	}
	serverRepository, err := servermemberadapter.NewEntRepository(
		config.Human.Auth.Database,
	)
	if err != nil {
		return nil, err
	}
	observer, err := servermemberadapter.NewCreationObserver(
		config.Human.Auth.Database,
		25*time.Millisecond,
	)
	if err != nil {
		return nil, err
	}
	resources, err := tencentimadapter.NewResourceDeriver(
		config.IMResourceKey,
	)
	if err != nil {
		return nil, err
	}
	serverService, err := appservermember.NewService(
		serverRepository,
		observer,
		resources,
		idport.UUIDv7{},
		clockport.System{},
		appservermember.Config{CreationWait: config.ServerCreationWait},
	)
	if err != nil {
		return nil, err
	}
	queryService, err := appservermember.NewQueryService(serverRepository)
	if err != nil {
		return nil, err
	}
	inviteRepository, err := serverinviteadapter.NewEntRepository(
		config.Human.Auth.Database,
	)
	if err != nil {
		return nil, err
	}
	inviteService, err := appserverinvite.NewService(
		inviteRepository,
		idport.UUIDv7{},
		clockport.System{},
		rand.Reader,
	)
	if err != nil {
		return nil, err
	}
	memberMutationRepository, err := membermutationadapter.NewEntRepository(
		config.Human.Auth.Database,
	)
	if err != nil {
		return nil, err
	}
	memberMutationService, err := appmembermutation.NewService(
		memberMutationRepository,
		idport.UUIDv7{},
		clockport.System{},
	)
	if err != nil {
		return nil, err
	}
	var computerRepository *computeradapter.EntRepository
	var computerService *appcomputer.Service
	var computerCredentialService *appcomputer.CredentialService
	if config.TATRegistrar != nil {
		computerRepository, err = computeradapter.NewEntRepository(
			config.Human.Auth.Database,
		)
		if err != nil {
			return nil, err
		}
		computerService, err = appcomputer.NewService(
			computerRepository,
			config.TATRegistrar,
			config.TerminalIssuer,
			idport.UUIDv7{},
			clockport.System{},
			appcomputer.Config{ManagedTATRegion: managedTATRegion(config.ManagedTATRegion)},
		)
		if err != nil {
			return nil, err
		}
		computerCredentialService, err = appcomputer.NewCredentialService(
			computerRepository,
			idport.UUIDv7{},
			clockport.System{},
			appcomputer.CredentialConfig{
				DerivationKey: config.Human.Auth.AccessTokenKey,
				CredentialTTL: 365 * 24 * time.Hour,
				HandoffTTL:    time.Hour,
			},
		)
		if err != nil {
			return nil, err
		}
	}
	var computerV2Service *appcomputerv2.Service
	if config.ComputerV2Instances != nil {
		computerV2Repository, err := computerv2adapter.NewEntRepository(config.Human.Auth.Database)
		if err != nil {
			return nil, err
		}
		computerV2Service, err = appcomputerv2.NewService(
			computerV2Repository,
			config.ComputerV2Instances,
			idport.UUIDv7{},
			clockport.System{},
		)
		if err != nil {
			return nil, err
		}
	}
	var computerEnrollmentService *appcomputer.EnrollmentService
	var computerArtifactService *appcomputer.ArtifactService
	if config.ComputerEnrollment != nil {
		enrollmentConfig := config.ComputerEnrollment
		computerEnrollmentService, err = appcomputer.NewEnrollmentService(
			computerRepository,
			idport.UUIDv7{},
			clockport.System{},
			appcomputer.EnrollmentConfig{
				Release:           enrollmentConfig.Release,
				PlatformBaseURL:   enrollmentConfig.PlatformBaseURL,
				AllowInsecureHTTP: enrollmentConfig.AllowInsecureHTTP,
				TokenTTL:          enrollmentConfig.TokenTTL,
				CredentialTTL:     enrollmentConfig.CredentialTTL,
				Random:            rand.Reader,
			},
		)
		if err != nil {
			return nil, err
		}
		computerArtifactService, err = appcomputer.NewArtifactService(
			computerRepository,
			enrollmentConfig.ArtifactSigner,
			clockport.System{},
			enrollmentConfig.ArtifactURLTTL,
		)
		if err != nil {
			return nil, err
		}
	}
	channelRepository, err := channeladapter.NewEntRepository(
		config.Human.Auth.Database,
	)
	if err != nil {
		return nil, err
	}
	channelService, err := appchannel.NewService(
		channelRepository,
		resources,
		idport.UUIDv7{},
		clockport.System{},
	)
	if err != nil {
		return nil, err
	}
	directConversationRepository, err := directconversationadapter.NewEntRepository(
		config.Human.Auth.Database,
	)
	if err != nil {
		return nil, err
	}
	directConversationService, err := appdirectconversation.NewService(
		directConversationRepository,
		resources,
		idport.UUIDv7{},
		clockport.System{},
	)
	if err != nil {
		return nil, err
	}
	channelMembershipRepository, err :=
		channelmembershipadapter.NewEntRepository(
			config.Human.Auth.Database,
		)
	if err != nil {
		return nil, err
	}
	channelMembershipService, err := appchannelmembership.NewService(
		channelMembershipRepository,
		idport.UUIDv7{},
		clockport.System{},
	)
	if err != nil {
		return nil, err
	}
	agentRepository, err := agentadapter.NewEntRepository(
		config.Human.Auth.Database,
	)
	if err != nil {
		return nil, err
	}
	identities, err := tencentimadapter.NewIdentityDeriver(
		config.IMResourceKey,
	)
	if err != nil {
		return nil, err
	}
	agentService, err := appagent.NewService(
		agentRepository,
		identities,
		idport.UUIDv7{},
		clockport.System{},
		rand.Reader,
	)
	if err != nil {
		return nil, err
	}
	operationRepository, err := operationadapter.NewEntRepository(
		config.Human.Auth.Database,
	)
	if err != nil {
		return nil, err
	}
	operationService, err := appoperationquery.NewService(operationRepository)
	if err != nil {
		return nil, err
	}
	workRepository, err := workadapter.NewEntRepository(
		config.Human.Auth.Database,
	)
	if err != nil {
		return nil, err
	}
	workService, err := appwork.NewService(
		workRepository,
		idport.UUIDv7{},
		clockport.System{},
	)
	if err != nil {
		return nil, err
	}
	return newAuthAndMeAPIHandler(
		config.Human.Auth,
		meService,
		serverService,
		queryService,
		inviteService,
		memberMutationService,
		computerService,
		computerV2Service,
		computerCredentialService,
		computerEnrollmentService,
		computerArtifactService,
		channelService,
		directConversationService,
		channelMembershipService,
		agentService,
		operationService,
		workService,
	)
}

func managedTATRegion(value string) string {
	if value == "" {
		return appcomputer.DefaultManagedTATRegion
	}
	return value
}

func newAuthAndMeAPIHandler(
	config AuthAPIConfig,
	meService *apphumanaccount.Service,
	serverCreator *appservermember.Service,
	serverQueries *appservermember.QueryService,
	invites *appserverinvite.Service,
	memberMutations *appmembermutation.Service,
	computers *appcomputer.Service,
	computersV2 *appcomputerv2.Service,
	computerCredentials *appcomputer.CredentialService,
	computerEnrollments *appcomputer.EnrollmentService,
	computerArtifacts *appcomputer.ArtifactService,
	channels *appchannel.Service,
	directConversations *appdirectconversation.Service,
	channelMemberships *appchannelmembership.Service,
	agents *appagent.Service,
	operations *appoperationquery.Service,
	work *appwork.Service,
) (http.Handler, error) {
	if config.Database == nil ||
		config.AccessTTL <= 0 ||
		config.RefreshTTL <= 0 ||
		config.RequestTimeout <= 0 ||
		config.MaxBodyBytes <= 0 {
		return nil, errors.New("Auth API 配置无效")
	}
	repository, err := accountauthadapter.NewEntRepository(config.Database)
	if err != nil {
		return nil, err
	}
	passwords, err := credentialsadapter.NewArgon2id(config.Password)
	if err != nil {
		return nil, err
	}
	refreshTokens, err := credentialsadapter.NewRefreshTokens(rand.Reader)
	if err != nil {
		return nil, err
	}
	clock := clockport.System{}
	accessTokens, err := tokenadapter.NewHMACJWT(config.AccessTokenKey, clock)
	if err != nil {
		return nil, err
	}
	accountService, err := appaccountauth.NewService(
		repository,
		passwords,
		refreshTokens,
		accessTokens,
		idport.UUIDv7{},
		clock,
		appaccountauth.Config{
			AccessTTL:  config.AccessTTL,
			RefreshTTL: config.RefreshTTL,
		},
	)
	if err != nil {
		return nil, err
	}
	humanAuthenticator, err := authnadapter.NewHumanAuthenticator(
		accessTokens,
		repository,
		clock,
	)
	if err != nil {
		return nil, err
	}
	authenticators := map[authnport.CandidateKind]authnport.Authenticator{
		authnport.CandidateHumanBearer: humanAuthenticator,
	}
	if len(config.GatewayHumanToken) > 0 {
		externalRepository, err := externalhumanadapter.NewEntRepository(config.Database)
		if err != nil {
			return nil, err
		}
		externalHumans, err := appexternalhuman.NewService(
			externalRepository,
			idport.UUIDv7{},
			clock,
			appexternalhuman.Config{
				ProvisioningEpoch: config.ExternalHumanProvisioningEpoch,
			},
		)
		if err != nil {
			return nil, err
		}
		gatewayAuthenticator, err := authnadapter.NewGatewayHumanAuthenticator(
			config.GatewayHumanToken,
			externalHumans,
		)
		if err != nil {
			return nil, err
		}
		authenticators[authnport.CandidateGatewayHuman] = gatewayAuthenticator
	}
	compositeAuthenticator, err := authnadapter.NewCompositeAuthenticator(authenticators)
	if err != nil {
		return nil, err
	}
	authenticationService, err := appauthn.NewService(compositeAuthenticator)
	if err != nil {
		return nil, err
	}
	authenticationHook, err := httptransport.NewAuthenticationHook(
		authenticationService,
	)
	if err != nil {
		return nil, err
	}
	encoder := httptransport.NewErrorEncoder(idport.UUIDv7{})
	var routes http.Handler
	if meService == nil {
		routes, err = httptransport.NewAuthOnlyRoutes(
			accountService,
			encoder,
		)
	} else if serverCreator == nil && serverQueries == nil {
		routes, err = httptransport.NewHumanRoutes(
			accountService,
			meService,
			encoder,
		)
	} else {
		routes, err = httptransport.NewHumanPlatformRoutes(
			accountService,
			meService,
			serverCreator,
			serverQueries,
			invites,
			memberMutations,
			computers,
			computersV2,
			computerCredentials,
			computerEnrollments,
			computerArtifacts,
			channels,
			directConversations,
			channelMemberships,
			agents,
			operations,
			work,
			encoder,
		)
	}
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
	sensitiveResponses, err := httptransport.SensitiveResponseHeadersMiddleware(spec)
	if err != nil {
		return nil, err
	}
	implementedRoutes := make([]httptransport.ImplementedRoute, 0, 64)
	if len(config.GatewayHumanToken) == 0 {
		implementedRoutes = append(
			implementedRoutes,
			httptransport.ImplementedRoute{Method: http.MethodPost, Path: "/v1/auth/register"},
			httptransport.ImplementedRoute{Method: http.MethodPost, Path: "/v1/auth/login"},
			httptransport.ImplementedRoute{Method: http.MethodPost, Path: "/v1/auth/refresh"},
			httptransport.ImplementedRoute{Method: http.MethodPost, Path: "/v1/auth/logout"},
		)
	}
	if meService != nil {
		implementedRoutes = append(
			implementedRoutes,
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/me",
			},
			httptransport.ImplementedRoute{Method: http.MethodGet, Path: "/v1/me/profile"},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/me/im/session",
			},
		)
	}
	if serverCreator != nil && serverQueries != nil {
		implementedRoutes = append(
			implementedRoutes,
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/servers",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/members",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/members/{memberId}",
			},
		)
	}
	if invites != nil {
		implementedRoutes = append(
			implementedRoutes,
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/join-links/accept",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/invites/accept",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/invites",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/servers/{serverId}/invites",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodDelete,
				Path: "/v1/servers/{serverId}/invites/" +
					"{inviteId}",
			},
		)
	}
	if memberMutations != nil {
		implementedRoutes = append(
			implementedRoutes,
			httptransport.ImplementedRoute{
				Method: http.MethodPatch,
				Path:   "/v1/servers/{serverId}/members/{memberId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodDelete,
				Path:   "/v1/servers/{serverId}/members/{memberId}",
			},
		)
	}
	if computers != nil {
		implementedRoutes = append(
			implementedRoutes,
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/computers",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/servers/{serverId}/computers",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/computers/{computerId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodDelete,
				Path:   "/v1/servers/{serverId}/computers/{computerId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/servers/{serverId}/computers/{computerId}/refresh",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path: "/v1/servers/{serverId}/computers/" +
					"{computerId}/runtime-credentials",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path: "/v1/servers/{serverId}/computers/" +
					"{computerId}/terminal-sessions",
			},
		)
	}
	if computersV2 != nil {
		implementedRoutes = append(
			implementedRoutes,
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/computers-v2",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/servers/{serverId}/computers-v2",
			},
		)
	}
	if computerEnrollments != nil && computerArtifacts != nil {
		implementedRoutes = append(
			implementedRoutes,
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/computer-installation-options",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path: "/v1/servers/{serverId}/computers/" +
					"{computerId}/setup-commands",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/computer/enrollments:claim",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/computer/setup-codes:redeem",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/computer-artifacts/{version}/{target}/{file}",
			},
		)
	}
	if channels != nil {
		implementedRoutes = append(
			implementedRoutes,
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/channels",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/servers/{serverId}/channels",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/channels/{channelId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPatch,
				Path:   "/v1/servers/{serverId}/channels/{channelId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path: "/v1/servers/{serverId}/channels/" +
					"{channelId}/members",
			},
		)
	}
	if directConversations != nil {
		implementedRoutes = append(
			implementedRoutes,
			httptransport.ImplementedRoute{Method: http.MethodGet, Path: "/v1/servers/{serverId}/direct-conversations"},
			httptransport.ImplementedRoute{Method: http.MethodPost, Path: "/v1/servers/{serverId}/direct-conversations"},
			httptransport.ImplementedRoute{Method: http.MethodGet, Path: "/v1/servers/{serverId}/direct-conversations/{directConversationId}"},
			httptransport.ImplementedRoute{Method: http.MethodPost, Path: "/v1/servers/{serverId}/direct-conversations/{directConversationId}/retry"},
		)
	}
	if channelMemberships != nil {
		implementedRoutes = append(
			implementedRoutes,
			httptransport.ImplementedRoute{
				Method: http.MethodPut,
				Path: "/v1/servers/{serverId}/channels/{channelId}/" +
					"members/{memberId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodDelete,
				Path: "/v1/servers/{serverId}/channels/{channelId}/" +
					"members/{memberId}",
			},
		)
	}
	if agents != nil {
		implementedRoutes = append(
			implementedRoutes,
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/agents",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/servers/{serverId}/agents",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/agents/{agentId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPatch,
				Path:   "/v1/servers/{serverId}/agents/{agentId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodDelete,
				Path:   "/v1/servers/{serverId}/agents/{agentId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/servers/{serverId}/agents/{agentId}/deploy",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/servers/{serverId}/agents/{agentId}/start",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/servers/{serverId}/agents/{agentId}/stop",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/servers/{serverId}/agents/{agentId}/restart",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path: "/v1/servers/{serverId}/agents/{agentId}/" +
					"credentials/rotate",
			},
		)
	}
	if operations != nil {
		implementedRoutes = append(
			implementedRoutes,
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path: "/v1/servers/{serverId}/operations/" +
					"{operationId}",
			},
		)
	}
	if work != nil {
		implementedRoutes = append(
			implementedRoutes,
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path: "/v1/servers/{serverId}/channels/{channelId}/" +
					"threads",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path: "/v1/servers/{serverId}/channels/{channelId}/" +
					"threads/{threadId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path: "/v1/servers/{serverId}/channels/{channelId}/" +
					"threads/{threadId}/replies",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path: "/v1/servers/{serverId}/channels/{channelId}/" +
					"threads/{threadId}/replies",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPut,
				Path: "/v1/servers/{serverId}/channels/{channelId}/" +
					"threads/{threadId}/read",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/tasks",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/servers/{serverId}/tasks",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/tasks/{taskId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPatch,
				Path:   "/v1/servers/{serverId}/tasks/{taskId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/reminders",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPost,
				Path:   "/v1/servers/{serverId}/reminders",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/reminders/{reminderId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodPatch,
				Path:   "/v1/servers/{serverId}/reminders/{reminderId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodDelete,
				Path:   "/v1/servers/{serverId}/reminders/{reminderId}",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/inbox",
			},
			httptransport.ImplementedRoute{
				Method: http.MethodGet,
				Path:   "/v1/servers/{serverId}/activity",
			},
		)
	}
	implemented, err := httptransport.ImplementedRoutesMiddleware(
		implementedRoutes,
		encoder,
	)
	if err != nil {
		return nil, err
	}
	limiter, err := ratelimitadapter.NewMemory(
		clock,
		ratelimitadapter.Config{
			Rules: []ratelimitadapter.Rule{
				{
					SubjectKind:    ratelimitport.SubjectIP,
					OperationClass: "auth_register",
					Limit:          10,
					Window:         time.Hour,
				},
				{
					SubjectKind:    ratelimitport.SubjectLoginHash,
					OperationClass: "auth_register",
					Limit:          3,
					Window:         time.Hour,
				},
				{
					SubjectKind:    ratelimitport.SubjectIP,
					OperationClass: "auth_login",
					Limit:          30,
					Window:         5 * time.Minute,
				},
				{
					SubjectKind:    ratelimitport.SubjectLoginHash,
					OperationClass: "auth_login",
					Limit:          10,
					Window:         5 * time.Minute,
				},
				{
					SubjectKind:    ratelimitport.SubjectIP,
					OperationClass: "auth_refresh",
					Limit:          120,
					Window:         time.Minute,
				},
				{
					SubjectKind:    ratelimitport.SubjectAccountID,
					OperationClass: "auth_refresh",
					Limit:          60,
					Window:         time.Minute,
				},
				{
					SubjectKind:    ratelimitport.SubjectIP,
					OperationClass: "auth_logout",
					Limit:          60,
					Window:         time.Minute,
				},
				{
					SubjectKind:    ratelimitport.SubjectIP,
					OperationClass: "human_im_session",
					Limit:          30,
					Window:         time.Minute,
				},
			},
			MaxBuckets: 100_000,
		},
	)
	if err != nil {
		return nil, err
	}
	authRateLimit, err := httptransport.AuthRateLimitMiddleware(
		limiter,
		encoder,
	)
	if err != nil {
		return nil, err
	}

	var handler http.Handler = routes
	handler = validator(handler)
	handler = httptransport.WithAuthState(handler)
	handler = contentType(handler)
	handler = authRateLimit(handler)
	handler = httptransport.BodyLimitMiddleware(config.MaxBodyBytes, encoder)(handler)
	handler = sensitiveResponses(handler)
	handler = httptransport.RequestTimeoutMiddleware(config.RequestTimeout)(handler)
	handler = implemented(handler)
	if len(config.AllowedOrigins) > 0 {
		cors, err := httptransport.CORSMiddleware(
			httptransport.CORSConfig{
				AllowedOrigins:   config.AllowedOrigins,
				AllowedMethods:   platformCORSMethods(),
				AllowedHeaders:   platformCORSHeaders(),
				AllowCredentials: true,
				MaxAge:           10 * time.Minute,
			},
			encoder,
		)
		if err != nil {
			return nil, err
		}
		handler = cors(handler)
	}
	handler = httptransport.ClientIPMiddleware(nil)(handler)
	handler = httptransport.RecoveryMiddleware(encoder, nil)(handler)
	handler = httptransport.RequestIDMiddleware(idport.UUIDv7{})(handler)
	return handler, nil
}

func platformCORSMethods() []string {
	return []string{
		http.MethodGet,
		http.MethodPost,
		http.MethodPut,
		http.MethodPatch,
		http.MethodDelete,
		http.MethodOptions,
	}
}

func platformCORSHeaders() []string {
	return []string{
		"Authorization",
		"Content-Type",
		"Idempotency-Key",
		"X-Resource-Revision",
		"X-Request-ID",
	}
}
