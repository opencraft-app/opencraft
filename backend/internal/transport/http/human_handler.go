package httptransport

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"chatserver/internal/api/openapi"
	apphumanaccount "chatserver/internal/app/humanaccount"
	"chatserver/internal/apperror"
	humanaccountport "chatserver/internal/ports/humanaccount"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

type humanAccountService interface {
	Get(context.Context, string) (humanaccountport.Account, error)
	CreateIMSession(context.Context, string) (apphumanaccount.IMSession, error)
}

// MeHandler 实现当前 Human 账号和 IM Session strict operation。
type MeHandler struct {
	openapi.StrictServerInterface
	service humanAccountService
}

var _ openapi.StrictServerInterface = (*MeHandler)(nil)

// NewMeHandler 创建当前 Human strict handler。
func NewMeHandler(service humanAccountService) (*MeHandler, error) {
	if service == nil {
		return nil, errors.New("Human 账号应用服务不能为空")
	}
	return &MeHandler{service: service}, nil
}

// GetMe 返回当前已认证账号的最新事实。
func (handler *MeHandler) GetMe(
	ctx context.Context,
	_ openapi.GetMeRequestObject,
) (openapi.GetMeResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	account, err := handler.service.Get(ctx, principal.AccountID())
	if err != nil {
		return nil, err
	}
	body, err := humanAccountDTO(account)
	if err != nil {
		return nil, err
	}
	return openapi.GetMe200JSONResponse(body), nil
}

// CreateHumanImSession 只为当前账号持久化的 IM UserID 签发短期 UserSig。
func (handler *MeHandler) CreateHumanImSession(
	ctx context.Context,
	_ openapi.CreateHumanImSessionRequestObject,
) (openapi.CreateHumanImSessionResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	session, err := handler.service.CreateIMSession(
		ctx,
		principal.AccountID(),
	)
	if err != nil {
		return nil, err
	}
	userSig := session.UserSig
	return openapi.CreateHumanImSession200JSONResponse{
		Body: openapi.ImSession{
			SdkAppId:  session.SDKAppID,
			UserId:    session.UserID,
			UserSig:   &userSig,
			ExpiresAt: session.ExpiresAt.UTC(),
		},
		Headers: openapi.CreateHumanImSession200ResponseHeaders{
			CacheControl: "no-store",
			Pragma:       "no-cache",
		},
	}, nil
}

// NewHumanRoutes 注册已实现的四个 Auth 和两个 Me operation。
func NewHumanRoutes(
	accountAuthService accountAuthService,
	meService humanAccountService,
	encoder *ErrorEncoder,
) (http.Handler, error) {
	return newHumanRoutes(
		accountAuthService,
		meService,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		encoder,
	)
}

// NewHumanServerRoutes 在 Auth/Me 基础上注册首组 Server/Member 管理路由。
func NewHumanServerRoutes(
	accountAuthService accountAuthService,
	meService humanAccountService,
	creator serverCreator,
	queries serverQueries,
	computers computerService,
	computerCredentials computerCredentialService,
	encoder *ErrorEncoder,
) (http.Handler, error) {
	return newHumanRoutes(
		accountAuthService,
		meService,
		creator,
		queries,
		nil,
		nil,
		computers,
		computerCredentials,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		encoder,
	)
}

// NewHumanPlatformRoutes 注册当前平台已经落地的 Human 管理面。
func NewHumanPlatformRoutes(
	accountAuthService accountAuthService,
	meService humanAccountService,
	creator serverCreator,
	queries serverQueries,
	invites inviteService,
	memberMutations memberMutationService,
	computers computerService,
	computerCredentials computerCredentialService,
	computerEnrollments computerEnrollmentService,
	computerArtifacts computerArtifactService,
	channels channelService,
	directConversations directConversationService,
	channelMemberships channelMembershipService,
	agents agentService,
	operations operationService,
	work workService,
	encoder *ErrorEncoder,
) (http.Handler, error) {
	return newHumanRoutes(
		accountAuthService,
		meService,
		creator,
		queries,
		invites,
		memberMutations,
		computers,
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

func newHumanRoutes(
	accountAuthService accountAuthService,
	meService humanAccountService,
	creator serverCreator,
	queries serverQueries,
	invites inviteService,
	memberMutations memberMutationService,
	computers computerService,
	computerCredentials computerCredentialService,
	computerEnrollments computerEnrollmentService,
	computerArtifacts computerArtifactService,
	channels channelService,
	directConversations directConversationService,
	channelMemberships channelMembershipService,
	agents agentService,
	operations operationService,
	work workService,
	encoder *ErrorEncoder,
) (http.Handler, error) {
	if encoder == nil {
		return nil, ErrValidatorEncoderRequired
	}
	authHandler, err := NewAuthHandler(accountAuthService)
	if err != nil {
		return nil, err
	}
	meHandler, err := NewMeHandler(meService)
	if err != nil {
		return nil, err
	}
	options := StrictServerOptions(encoder)
	authStrict := openapi.NewStrictHandlerWithOptions(
		authHandler,
		nil,
		options,
	)
	meStrict := openapi.NewStrictHandlerWithOptions(
		meHandler,
		nil,
		options,
	)
	var serverWrapper *openapi.ServerInterfaceWrapper
	if creator != nil || queries != nil {
		serverHandler, err := NewServerMemberHandler(creator, queries)
		if err != nil {
			return nil, err
		}
		serverStrict := openapi.NewStrictHandlerWithOptions(
			serverHandler,
			nil,
			options,
		)
		serverWrapper = &openapi.ServerInterfaceWrapper{
			Handler:          serverStrict,
			ErrorHandlerFunc: StdHTTPErrorHandler(encoder),
		}
	}
	var computerWrapper *openapi.ServerInterfaceWrapper
	var memberMutationWrapper *openapi.ServerInterfaceWrapper
	if memberMutations != nil {
		memberMutationHandler, err := NewMemberMutationHandler(
			memberMutations,
			queries,
		)
		if err != nil {
			return nil, err
		}
		memberMutationStrict := openapi.NewStrictHandlerWithOptions(
			memberMutationHandler,
			nil,
			options,
		)
		memberMutationWrapper = &openapi.ServerInterfaceWrapper{
			Handler:          memberMutationStrict,
			ErrorHandlerFunc: StdHTTPErrorHandler(encoder),
		}
	}
	var inviteWrapper *openapi.ServerInterfaceWrapper
	if invites != nil {
		inviteHandler, err := NewInviteHandler(invites)
		if err != nil {
			return nil, err
		}
		inviteStrict := openapi.NewStrictHandlerWithOptions(
			inviteHandler,
			nil,
			options,
		)
		inviteWrapper = &openapi.ServerInterfaceWrapper{
			Handler:          inviteStrict,
			ErrorHandlerFunc: StdHTTPErrorHandler(encoder),
		}
	}
	if computers != nil || computerCredentials != nil {
		computerHandler, err := NewComputerHandler(computers, computerCredentials)
		if err != nil {
			return nil, err
		}
		computerStrict := openapi.NewStrictHandlerWithOptions(
			computerHandler,
			nil,
			options,
		)
		computerWrapper = &openapi.ServerInterfaceWrapper{
			Handler:          computerStrict,
			ErrorHandlerFunc: StdHTTPErrorHandler(encoder),
		}
	}
	var computerEnrollmentWrapper *openapi.ServerInterfaceWrapper
	if computerEnrollments != nil || computerArtifacts != nil {
		computerEnrollmentHandler, err := NewComputerEnrollmentHandler(
			computerEnrollments,
			computerArtifacts,
		)
		if err != nil {
			return nil, err
		}
		computerEnrollmentStrict := openapi.NewStrictHandlerWithOptions(
			computerEnrollmentHandler,
			nil,
			options,
		)
		computerEnrollmentWrapper = &openapi.ServerInterfaceWrapper{
			Handler: computerEnrollmentStrict, ErrorHandlerFunc: StdHTTPErrorHandler(encoder),
		}
	}
	var channelWrapper *openapi.ServerInterfaceWrapper
	if channels != nil {
		channelHandler, err := NewChannelHandler(channels, queries)
		if err != nil {
			return nil, err
		}
		channelStrict := openapi.NewStrictHandlerWithOptions(
			channelHandler,
			nil,
			options,
		)
		channelWrapper = &openapi.ServerInterfaceWrapper{
			Handler:          channelStrict,
			ErrorHandlerFunc: StdHTTPErrorHandler(encoder),
		}
	}
	var directConversationWrapper *openapi.ServerInterfaceWrapper
	if directConversations != nil {
		directConversationHandler, err := NewDirectConversationHandler(directConversations)
		if err != nil {
			return nil, err
		}
		directConversationStrict := openapi.NewStrictHandlerWithOptions(
			directConversationHandler,
			nil,
			options,
		)
		directConversationWrapper = &openapi.ServerInterfaceWrapper{
			Handler: directConversationStrict, ErrorHandlerFunc: StdHTTPErrorHandler(encoder),
		}
	}
	var agentWrapper *openapi.ServerInterfaceWrapper
	var channelMembershipWrapper *openapi.ServerInterfaceWrapper
	if channelMemberships != nil {
		channelMembershipHandler, err := NewChannelMembershipHandler(
			channelMemberships,
		)
		if err != nil {
			return nil, err
		}
		channelMembershipStrict := openapi.NewStrictHandlerWithOptions(
			channelMembershipHandler,
			nil,
			options,
		)
		channelMembershipWrapper = &openapi.ServerInterfaceWrapper{
			Handler:          channelMembershipStrict,
			ErrorHandlerFunc: StdHTTPErrorHandler(encoder),
		}
	}
	if agents != nil {
		agentHandler, err := NewAgentHandler(agents)
		if err != nil {
			return nil, err
		}
		agentStrict := openapi.NewStrictHandlerWithOptions(
			agentHandler,
			nil,
			options,
		)
		agentWrapper = &openapi.ServerInterfaceWrapper{
			Handler:          agentStrict,
			ErrorHandlerFunc: StdHTTPErrorHandler(encoder),
		}
	}
	var operationWrapper *openapi.ServerInterfaceWrapper
	if operations != nil {
		operationHandler, err := NewOperationHandler(operations)
		if err != nil {
			return nil, err
		}
		operationStrict := openapi.NewStrictHandlerWithOptions(
			operationHandler,
			nil,
			options,
		)
		operationWrapper = &openapi.ServerInterfaceWrapper{
			Handler:          operationStrict,
			ErrorHandlerFunc: StdHTTPErrorHandler(encoder),
		}
	}
	var workWrapper *openapi.ServerInterfaceWrapper
	if work != nil {
		workHandler, err := NewWorkHandler(work)
		if err != nil {
			return nil, err
		}
		workStrict := openapi.NewStrictHandlerWithOptions(
			workHandler,
			nil,
			options,
		)
		workWrapper = &openapi.ServerInterfaceWrapper{
			Handler:          workStrict,
			ErrorHandlerFunc: StdHTTPErrorHandler(encoder),
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/auth/register", authStrict.Register)
	mux.HandleFunc("POST /v1/auth/login", authStrict.Login)
	mux.HandleFunc("POST /v1/auth/refresh", authStrict.RefreshAuth)
	mux.HandleFunc("POST /v1/auth/logout", authStrict.Logout)
	mux.HandleFunc("GET /v1/me", meStrict.GetMe)
	mux.HandleFunc("POST /v1/me/im/session", meStrict.CreateHumanImSession)
	if serverWrapper != nil {
		mux.HandleFunc("GET /v1/servers", serverWrapper.ListServers)
		mux.HandleFunc("POST /v1/servers", serverWrapper.CreateServer)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}",
			serverWrapper.GetServer,
		)
		mux.HandleFunc(
			"PATCH /v1/servers/{serverId}",
			serverWrapper.UpdateServer,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/members",
			serverWrapper.ListMembers,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/members/{memberId}",
			serverWrapper.GetMember,
		)
	}
	if computerWrapper != nil {
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/computers",
			computerWrapper.ListComputers,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/computers",
			computerWrapper.CreateComputer,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/computers/{computerId}",
			computerWrapper.GetComputer,
		)
		mux.HandleFunc(
			"DELETE /v1/servers/{serverId}/computers/{computerId}",
			computerWrapper.RemoveComputer,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/computers/{computerId}/refresh",
			computerWrapper.RefreshComputer,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/computers/{computerId}/runtime-credentials",
			computerWrapper.CreateComputerRuntimeCredential,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/computers/{computerId}/terminal-sessions",
			computerWrapper.CreateTerminalSession,
		)
	}
	if computerEnrollmentWrapper != nil {
		mux.HandleFunc(
			"GET /v1/computer-installation-options",
			computerEnrollmentWrapper.GetComputerInstallationOptions,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/computers/{computerId}/setup-commands",
			computerEnrollmentWrapper.CreateComputerSetupCommand,
		)
		mux.HandleFunc(
			"POST /v1/computer/enrollments:claim",
			computerEnrollmentWrapper.ClaimComputerEnrollment,
		)
		mux.HandleFunc(
			"POST /v1/computer/setup-codes:redeem",
			computerEnrollmentWrapper.RedeemComputerSetupCode,
		)
		mux.HandleFunc(
			"GET /v1/computer-artifacts/{version}/{target}/{file}",
			computerEnrollmentWrapper.GetComputerArtifact,
		)
	}
	if inviteWrapper != nil {
		mux.HandleFunc(
			"POST /v1/invites/accept",
			inviteWrapper.AcceptInvite,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/invites",
			inviteWrapper.ListInvites,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/invites",
			inviteWrapper.CreateInvite,
		)
		mux.HandleFunc(
			"DELETE /v1/servers/{serverId}/invites/{inviteId}",
			inviteWrapper.RevokeInvite,
		)
	}
	if memberMutationWrapper != nil {
		mux.HandleFunc(
			"PATCH /v1/servers/{serverId}/members/{memberId}",
			memberMutationWrapper.UpdateMember,
		)
		mux.HandleFunc(
			"DELETE /v1/servers/{serverId}/members/{memberId}",
			memberMutationWrapper.RemoveMember,
		)
	}
	if channelWrapper != nil {
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/channels",
			channelWrapper.ListChannels,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/channels",
			channelWrapper.CreateChannel,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/channels/{channelId}",
			channelWrapper.GetChannel,
		)
		mux.HandleFunc(
			"PATCH /v1/servers/{serverId}/channels/{channelId}",
			channelWrapper.UpdateChannel,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/channels/{channelId}/members",
			channelWrapper.ListChannelMembers,
		)
	}
	if directConversationWrapper != nil {
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/direct-conversations",
			directConversationWrapper.ListDirectConversations,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/direct-conversations",
			directConversationWrapper.CreateDirectConversation,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/direct-conversations/{directConversationId}",
			directConversationWrapper.GetDirectConversation,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/direct-conversations/{directConversationId}/retry",
			directConversationWrapper.RetryDirectConversation,
		)
	}
	if channelMembershipWrapper != nil {
		mux.HandleFunc(
			"PUT /v1/servers/{serverId}/channels/{channelId}/members/{memberId}",
			channelMembershipWrapper.AddChannelMember,
		)
		mux.HandleFunc(
			"DELETE /v1/servers/{serverId}/channels/{channelId}/members/{memberId}",
			channelMembershipWrapper.RemoveChannelMember,
		)
	}
	if agentWrapper != nil {
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/agents",
			agentWrapper.ListAgents,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/agents",
			agentWrapper.CreateAgent,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/agents/{agentId}",
			agentWrapper.GetAgent,
		)
		mux.HandleFunc(
			"PATCH /v1/servers/{serverId}/agents/{agentId}",
			agentWrapper.UpdateAgent,
		)
		mux.HandleFunc(
			"DELETE /v1/servers/{serverId}/agents/{agentId}",
			agentWrapper.DeleteAgent,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/agents/{agentId}/deploy",
			agentWrapper.DeployAgent,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/agents/{agentId}/start",
			agentWrapper.StartAgent,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/agents/{agentId}/stop",
			agentWrapper.StopAgent,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/agents/{agentId}/restart",
			agentWrapper.RestartAgent,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/agents/{agentId}/credentials/rotate",
			agentWrapper.RotateAgentRuntimeCredential,
		)
	}
	if operationWrapper != nil {
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/operations/{operationId}",
			operationWrapper.GetOperation,
		)
	}
	if workWrapper != nil {
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/channels/{channelId}/threads",
			workWrapper.EnsureMessageThread,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/channels/{channelId}/threads/{threadId}",
			workWrapper.GetMessageThread,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/channels/{channelId}/threads/{threadId}/replies",
			workWrapper.ListMessageThreadReplies,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/channels/{channelId}/threads/{threadId}/replies",
			workWrapper.RegisterMessageThreadReply,
		)
		mux.HandleFunc(
			"PUT /v1/servers/{serverId}/channels/{channelId}/threads/{threadId}/read",
			workWrapper.MarkMessageThreadRead,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/tasks",
			workWrapper.ListTasks,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/tasks",
			workWrapper.CreateTask,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/tasks/{taskId}",
			workWrapper.GetTask,
		)
		mux.HandleFunc(
			"PATCH /v1/servers/{serverId}/tasks/{taskId}",
			workWrapper.UpdateTask,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/reminders",
			workWrapper.ListReminders,
		)
		mux.HandleFunc(
			"POST /v1/servers/{serverId}/reminders",
			workWrapper.CreateReminder,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/reminders/{reminderId}",
			workWrapper.GetReminder,
		)
		mux.HandleFunc(
			"PATCH /v1/servers/{serverId}/reminders/{reminderId}",
			workWrapper.UpdateReminder,
		)
		mux.HandleFunc(
			"DELETE /v1/servers/{serverId}/reminders/{reminderId}",
			workWrapper.CancelReminder,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/inbox",
			workWrapper.ListInbox,
		)
		mux.HandleFunc(
			"GET /v1/servers/{serverId}/activity",
			workWrapper.ListActivity,
		)
	}
	return mux, nil
}

func humanAccountDTO(
	value humanaccountport.Account,
) (openapi.Account, error) {
	id, err := uuid.Parse(value.ID)
	if err != nil || id == uuid.Nil {
		return openapi.Account{}, apperror.New(
			"internal_error",
			"账号数据无效",
			err,
		)
	}
	if value.Revision > uint64(^uint64(0)>>1) {
		return openapi.Account{}, apperror.New(
			"internal_error",
			"账号版本无效",
			nil,
		)
	}
	result := openapi.Account{
		Id:          id,
		Email:       openapi_types.Email(value.Email),
		DisplayName: value.DisplayName,
		ImState:     openapi.AccountImState(value.IMState),
		Revision:    int64(value.Revision),
	}
	if imUserID := strings.TrimSpace(value.IMUserID); imUserID != "" {
		result.ImUserId = &imUserID
	}
	return result, nil
}
