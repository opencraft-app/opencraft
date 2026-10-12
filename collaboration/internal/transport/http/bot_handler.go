package httptransport

import (
	"context"
	"errors"
	"net/http"

	"git.woa.com/wisp/mono2/collaboration/internal/api/openapi"
	appbotagent "git.woa.com/wisp/mono2/collaboration/internal/app/botagent"
	appimgroup "git.woa.com/wisp/mono2/collaboration/internal/app/imgroup"
	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	authnport "git.woa.com/wisp/mono2/collaboration/internal/ports/authn"
	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"

	"github.com/google/uuid"
)

type botAgentService interface {
	List(context.Context, appbotagent.Human) ([]botimport.BotAgent, error)
	Provision(context.Context, appbotagent.Human, appbotagent.ProvisionInput) (botimport.BotAgent, error)
	UpdateCommandPolicy(context.Context, appbotagent.Human, string, string) (botimport.BotAgent, error)
	Delete(context.Context, appbotagent.Human, string) error
	Rotate(context.Context, appbotagent.Human, string) (botimport.BotAgent, error)
	CreateSession(context.Context, authnport.CurrentBotPrincipal) (appbotagent.Session, error)
	RuntimeIdentity(context.Context, authnport.CurrentBotPrincipal) (appbotagent.Identity, error)
	Actor(context.Context, authnport.CurrentBotPrincipal) (botimport.BotAgent, error)
}

type imGroupService interface {
	HumanActor(context.Context, string) (appimgroup.Actor, error)
	Create(context.Context, appimgroup.Actor, appimgroup.CreateInput) (appimgroup.View, error)
	Get(context.Context, appimgroup.Actor, string) (appimgroup.View, error)
	Update(context.Context, appimgroup.Actor, string, appimgroup.UpdateInput) (appimgroup.View, error)
	AddMember(context.Context, appimgroup.Actor, string, string) (appimgroup.View, error)
	RemoveMember(context.Context, appimgroup.Actor, string, string) (appimgroup.View, error)
	Dismiss(context.Context, appimgroup.Actor, string) error
	CreateInvite(context.Context, appimgroup.Actor, string) (appimgroup.Invite, error)
	AcceptInvite(context.Context, appimgroup.Actor, string) (appimgroup.View, error)
}

// BotIMHandler 实现 Bot IM 身份、平台群与 Bot Runtime strict operation。
type BotIMHandler struct {
	openapi.StrictServerInterface
	bots   botAgentService
	groups imGroupService
	admin  ImAdminService
}

var _ openapi.StrictServerInterface = (*BotIMHandler)(nil)

func NewBotIMHandler(bots botAgentService, groups imGroupService) (*BotIMHandler, error) {
	if bots == nil || groups == nil {
		return nil, errors.New("Bot IM 应用服务不能为空")
	}
	return &BotIMHandler{bots: bots, groups: groups}, nil
}

// ── Human：Bot IM 身份 ──

func (h *BotIMHandler) ListBotAgents(
	ctx context.Context,
	_ openapi.ListBotAgentsRequestObject,
) (openapi.ListBotAgentsResponseObject, error) {
	human, err := currentBotHuman(ctx)
	if err != nil {
		return nil, err
	}
	bots, err := h.bots.List(ctx, human)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.BotAgent, 0, len(bots))
	for _, bot := range bots {
		item, err := botAgentDTO(bot)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return openapi.ListBotAgents200JSONResponse{Items: items}, nil
}

func (h *BotIMHandler) ProvisionBotAgent(
	ctx context.Context,
	request openapi.ProvisionBotAgentRequestObject,
) (openapi.ProvisionBotAgentResponseObject, error) {
	human, err := currentBotHuman(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	bot, err := h.bots.Provision(ctx, human, appbotagent.ProvisionInput{
		InstanceID: request.Body.InstanceId, BotID: request.Body.BotId, DisplayName: request.Body.DisplayName,
	})
	if err != nil {
		return nil, err
	}
	body, err := botAgentDTO(bot)
	if err != nil {
		return nil, err
	}
	return openapi.ProvisionBotAgent200JSONResponse(body), nil
}

func (h *BotIMHandler) UpdateBotAgent(
	ctx context.Context,
	request openapi.UpdateBotAgentRequestObject,
) (openapi.UpdateBotAgentResponseObject, error) {
	human, err := currentBotHuman(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	bot, err := h.bots.UpdateCommandPolicy(ctx, human, request.BotAgentId.String(), string(request.Body.CommandPolicy))
	if err != nil {
		return nil, err
	}
	body, err := botAgentDTO(bot)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateBotAgent200JSONResponse(body), nil
}

func (h *BotIMHandler) DeleteBotAgent(
	ctx context.Context,
	request openapi.DeleteBotAgentRequestObject,
) (openapi.DeleteBotAgentResponseObject, error) {
	human, err := currentBotHuman(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.bots.Delete(ctx, human, request.BotAgentId.String()); err != nil {
		return nil, err
	}
	return openapi.DeleteBotAgent204Response{}, nil
}

func (h *BotIMHandler) RotateBotAgentCredential(
	ctx context.Context,
	request openapi.RotateBotAgentCredentialRequestObject,
) (openapi.RotateBotAgentCredentialResponseObject, error) {
	human, err := currentBotHuman(ctx)
	if err != nil {
		return nil, err
	}
	bot, err := h.bots.Rotate(ctx, human, request.BotAgentId.String())
	if err != nil {
		return nil, err
	}
	body, err := botAgentDTO(bot)
	if err != nil {
		return nil, err
	}
	return openapi.RotateBotAgentCredential200JSONResponse(body), nil
}

// ── Human：平台群 ──

func (h *BotIMHandler) CreateImGroup(
	ctx context.Context,
	request openapi.CreateImGroupRequestObject,
) (openapi.CreateImGroupResponseObject, error) {
	actor, err := h.humanActor(ctx)
	if err != nil {
		return nil, err
	}
	view, err := h.createGroup(ctx, actor, request.Body)
	if err != nil {
		return nil, err
	}
	return openapi.CreateImGroup200JSONResponse(view), nil
}

func (h *BotIMHandler) GetImGroup(
	ctx context.Context,
	request openapi.GetImGroupRequestObject,
) (openapi.GetImGroupResponseObject, error) {
	actor, err := h.humanActor(ctx)
	if err != nil {
		return nil, err
	}
	view, err := h.groups.Get(ctx, actor, request.GroupId.String())
	if err != nil {
		return nil, err
	}
	return openapi.GetImGroup200JSONResponse(imGroupDTO(view)), nil
}

func (h *BotIMHandler) UpdateImGroup(
	ctx context.Context,
	request openapi.UpdateImGroupRequestObject,
) (openapi.UpdateImGroupResponseObject, error) {
	actor, err := h.humanActor(ctx)
	if err != nil {
		return nil, err
	}
	view, err := h.updateGroup(ctx, actor, request.GroupId, request.Body)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateImGroup200JSONResponse(view), nil
}

func (h *BotIMHandler) DismissImGroup(
	ctx context.Context,
	request openapi.DismissImGroupRequestObject,
) (openapi.DismissImGroupResponseObject, error) {
	actor, err := h.humanActor(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.groups.Dismiss(ctx, actor, request.GroupId.String()); err != nil {
		return nil, err
	}
	return openapi.DismissImGroup204Response{}, nil
}

func (h *BotIMHandler) AddImGroupMember(
	ctx context.Context,
	request openapi.AddImGroupMemberRequestObject,
) (openapi.AddImGroupMemberResponseObject, error) {
	actor, err := h.humanActor(ctx)
	if err != nil {
		return nil, err
	}
	view, err := h.groups.AddMember(ctx, actor, request.GroupId.String(), request.UserId)
	if err != nil {
		return nil, err
	}
	return openapi.AddImGroupMember200JSONResponse(imGroupDTO(view)), nil
}

func (h *BotIMHandler) RemoveImGroupMember(
	ctx context.Context,
	request openapi.RemoveImGroupMemberRequestObject,
) (openapi.RemoveImGroupMemberResponseObject, error) {
	actor, err := h.humanActor(ctx)
	if err != nil {
		return nil, err
	}
	view, err := h.groups.RemoveMember(ctx, actor, request.GroupId.String(), request.UserId)
	if err != nil {
		return nil, err
	}
	return openapi.RemoveImGroupMember200JSONResponse(imGroupDTO(view)), nil
}

func (h *BotIMHandler) CreateImGroupInviteLink(
	ctx context.Context,
	request openapi.CreateImGroupInviteLinkRequestObject,
) (openapi.CreateImGroupInviteLinkResponseObject, error) {
	actor, err := h.humanActor(ctx)
	if err != nil {
		return nil, err
	}
	invite, err := h.groups.CreateInvite(ctx, actor, request.GroupId.String())
	if err != nil {
		return nil, err
	}
	groupID, err := uuid.Parse(invite.GroupID)
	if err != nil {
		return nil, apperror.New("internal_error", "平台群 ID 无效", err)
	}
	token := invite.Token
	return openapi.CreateImGroupInviteLink200JSONResponse{
		Body:    openapi.ImGroupInvite{GroupId: groupID, Token: &token, ExpiresAt: invite.ExpiresAt},
		Headers: openapi.CreateImGroupInviteLink200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (h *BotIMHandler) AcceptImGroupInvite(
	ctx context.Context,
	request openapi.AcceptImGroupInviteRequestObject,
) (openapi.AcceptImGroupInviteResponseObject, error) {
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "缺少邀请凭据", nil)
	}
	actor, err := h.humanActor(ctx)
	if err != nil {
		return nil, err
	}
	view, err := h.groups.AcceptInvite(ctx, actor, request.Body.Token)
	if err != nil {
		return nil, err
	}
	return openapi.AcceptImGroupInvite200JSONResponse(imGroupDTO(view)), nil
}

// ── Bot Runtime ──

func (h *BotIMHandler) CreateBotSession(
	ctx context.Context,
	_ openapi.CreateBotSessionRequestObject,
) (openapi.CreateBotSessionResponseObject, error) {
	principal, ok := CurrentBotPrincipal(ctx, authnport.PrincipalBotCredential)
	if !ok {
		return nil, apperror.New("runtime_credential_invalid", "Bot 凭据无效", nil)
	}
	session, err := h.bots.CreateSession(ctx, principal)
	if err != nil {
		return nil, err
	}
	identity, err := botRuntimeIdentityDTO(session.Bot)
	if err != nil {
		return nil, err
	}
	accessToken, userSig := session.AccessToken, session.UserSig
	return openapi.CreateBotSession200JSONResponse{
		Body: openapi.BotSession{
			AccessToken: &accessToken,
			ExpiresAt:   session.ExpiresAt.UTC(),
			Bot:         identity,
			Im: openapi.ImSession{
				SdkAppId: session.SDKAppID, UserId: session.Bot.UserID,
				UserSig: &userSig, ExpiresAt: session.UserSigExpiresAt.UTC(),
			},
		},
		Headers: openapi.CreateBotSession200ResponseHeaders{CacheControl: "no-store", Pragma: "no-cache"},
	}, nil
}

func (h *BotIMHandler) GetBotRuntimeMe(
	ctx context.Context,
	_ openapi.GetBotRuntimeMeRequestObject,
) (openapi.GetBotRuntimeMeResponseObject, error) {
	principal, ok := CurrentBotPrincipal(ctx, authnport.PrincipalBotRuntime)
	if !ok {
		return nil, apperror.New("runtime_credential_invalid", "Bot 会话无效", nil)
	}
	identity, err := h.bots.RuntimeIdentity(ctx, principal)
	if err != nil {
		return nil, err
	}
	body, err := botRuntimeIdentityDTO(identity)
	if err != nil {
		return nil, err
	}
	return openapi.GetBotRuntimeMe200JSONResponse(body), nil
}

func (h *BotIMHandler) CreateBotRuntimeGroup(
	ctx context.Context,
	request openapi.CreateBotRuntimeGroupRequestObject,
) (openapi.CreateBotRuntimeGroupResponseObject, error) {
	actor, err := h.botActor(ctx)
	if err != nil {
		return nil, err
	}
	view, err := h.createGroup(ctx, actor, request.Body)
	if err != nil {
		return nil, err
	}
	return openapi.CreateBotRuntimeGroup200JSONResponse(view), nil
}

func (h *BotIMHandler) GetBotRuntimeGroup(
	ctx context.Context,
	request openapi.GetBotRuntimeGroupRequestObject,
) (openapi.GetBotRuntimeGroupResponseObject, error) {
	actor, err := h.botActor(ctx)
	if err != nil {
		return nil, err
	}
	view, err := h.groups.Get(ctx, actor, request.GroupId.String())
	if err != nil {
		return nil, err
	}
	return openapi.GetBotRuntimeGroup200JSONResponse(imGroupDTO(view)), nil
}

func (h *BotIMHandler) UpdateBotRuntimeGroup(
	ctx context.Context,
	request openapi.UpdateBotRuntimeGroupRequestObject,
) (openapi.UpdateBotRuntimeGroupResponseObject, error) {
	actor, err := h.botActor(ctx)
	if err != nil {
		return nil, err
	}
	view, err := h.updateGroup(ctx, actor, request.GroupId, request.Body)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateBotRuntimeGroup200JSONResponse(view), nil
}

func (h *BotIMHandler) DismissBotRuntimeGroup(
	ctx context.Context,
	request openapi.DismissBotRuntimeGroupRequestObject,
) (openapi.DismissBotRuntimeGroupResponseObject, error) {
	actor, err := h.botActor(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.groups.Dismiss(ctx, actor, request.GroupId.String()); err != nil {
		return nil, err
	}
	return openapi.DismissBotRuntimeGroup204Response{}, nil
}

func (h *BotIMHandler) AddBotRuntimeGroupMember(
	ctx context.Context,
	request openapi.AddBotRuntimeGroupMemberRequestObject,
) (openapi.AddBotRuntimeGroupMemberResponseObject, error) {
	actor, err := h.botActor(ctx)
	if err != nil {
		return nil, err
	}
	view, err := h.groups.AddMember(ctx, actor, request.GroupId.String(), request.UserId)
	if err != nil {
		return nil, err
	}
	return openapi.AddBotRuntimeGroupMember200JSONResponse(imGroupDTO(view)), nil
}

func (h *BotIMHandler) RemoveBotRuntimeGroupMember(
	ctx context.Context,
	request openapi.RemoveBotRuntimeGroupMemberRequestObject,
) (openapi.RemoveBotRuntimeGroupMemberResponseObject, error) {
	actor, err := h.botActor(ctx)
	if err != nil {
		return nil, err
	}
	view, err := h.groups.RemoveMember(ctx, actor, request.GroupId.String(), request.UserId)
	if err != nil {
		return nil, err
	}
	return openapi.RemoveBotRuntimeGroupMember200JSONResponse(imGroupDTO(view)), nil
}

// ── 共享实现 ──

func (h *BotIMHandler) createGroup(
	ctx context.Context,
	actor appimgroup.Actor,
	body *openapi.CreateImGroupRequest,
) (openapi.ImGroup, error) {
	if body == nil {
		return openapi.ImGroup{}, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	input := appimgroup.CreateInput{
		GroupID: body.GroupId.String(), Name: body.Name, MemberUserIDs: body.MemberUserIds,
	}
	if body.ReplyMode != nil {
		input.ReplyMode = string(*body.ReplyMode)
	}
	view, err := h.groups.Create(ctx, actor, input)
	if err != nil {
		return openapi.ImGroup{}, err
	}
	return imGroupDTO(view), nil
}

func (h *BotIMHandler) updateGroup(
	ctx context.Context,
	actor appimgroup.Actor,
	groupID openapi.GroupId,
	body *openapi.UpdateImGroupRequest,
) (openapi.ImGroup, error) {
	if body == nil {
		return openapi.ImGroup{}, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	input := appimgroup.UpdateInput{Name: body.Name}
	if body.ReplyMode != nil {
		mode := string(*body.ReplyMode)
		input.ReplyMode = &mode
	}
	view, err := h.groups.Update(ctx, actor, groupID.String(), input)
	if err != nil {
		return openapi.ImGroup{}, err
	}
	return imGroupDTO(view), nil
}

func (h *BotIMHandler) humanActor(ctx context.Context) (appimgroup.Actor, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return appimgroup.Actor{}, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	return h.groups.HumanActor(ctx, principal.AccountID())
}

func (h *BotIMHandler) botActor(ctx context.Context) (appimgroup.Actor, error) {
	principal, ok := CurrentBotPrincipal(ctx, authnport.PrincipalBotRuntime)
	if !ok {
		return appimgroup.Actor{}, apperror.New("runtime_credential_invalid", "Bot 会话无效", nil)
	}
	bot, err := h.bots.Actor(ctx, principal)
	if err != nil {
		return appimgroup.Actor{}, err
	}
	return appimgroup.BotActor(bot), nil
}

func currentBotHuman(ctx context.Context) (appbotagent.Human, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return appbotagent.Human{}, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	return appbotagent.Human{AccountID: principal.AccountID(), Subject: principal.ExternalSubject()}, nil
}

func botAgentDTO(bot botimport.BotAgent) (openapi.BotAgent, error) {
	id, err := uuid.Parse(bot.ID)
	if err != nil {
		return openapi.BotAgent{}, apperror.New("internal_error", "Bot ID 无效", err)
	}
	result := openapi.BotAgent{
		Id:            id,
		InstanceId:    bot.InstanceID,
		BotId:         bot.BotID,
		DisplayName:   bot.DisplayName,
		UserId:        bot.IMUserID,
		State:         openapi.BotAgentState(bot.State),
		CommandPolicy: openapi.CommandPolicy(bot.CommandPolicy),
		Revision:      bot.Revision,
	}
	if bot.LastErrorCode != "" {
		code := bot.LastErrorCode
		result.LastErrorCode = &code
	}
	return result, nil
}

func botRuntimeIdentityDTO(identity appbotagent.Identity) (openapi.BotRuntimeIdentity, error) {
	id, err := uuid.Parse(identity.ID)
	if err != nil {
		return openapi.BotRuntimeIdentity{}, apperror.New("internal_error", "Bot ID 无效", err)
	}
	owners := append([]string{}, identity.OwnerUserIDs...)
	return openapi.BotRuntimeIdentity{
		Id: id, UserId: identity.UserID, DisplayName: identity.DisplayName,
		CommandPolicy: openapi.CommandPolicy(identity.CommandPolicy), OwnerUserIds: owners,
	}, nil
}

func imGroupDTO(view appimgroup.View) openapi.ImGroup {
	id, _ := uuid.Parse(view.Group.ID)
	members := make([]openapi.ImGroupMember, 0, len(view.Members))
	for _, member := range view.Members {
		members = append(members, openapi.ImGroupMember{
			UserId: member.IMUserID,
			Kind:   openapi.ImGroupMemberKind(member.Kind),
			Role:   openapi.ImGroupMemberRole(member.Role),
		})
	}
	return openapi.ImGroup{
		Id:                 id,
		TencentGroupId:     view.Group.TencentGroupID,
		Name:               view.Group.Name,
		ReplyMode:          openapi.GroupReplyMode(view.Group.ReplyMode),
		EffectiveReplyMode: openapi.GroupReplyMode(view.EffectiveReplyMode),
		ContextMessages:    view.ContextMessages,
		State:              openapi.ImGroupState(view.Group.State),
		Revision:           view.Group.Revision,
		Members:            members,
		ViewerRole:         openapi.ImGroupViewerRole(view.ViewerRole),
		DismissedBy:        dismissedBy(view.Group.DismissedBy),
		DismissReason:      optional(view.Group.DismissReason),
	}
}

func dismissedBy(value string) *openapi.ImGroupDismissedBy {
	if value == "" {
		return nil
	}
	by := openapi.ImGroupDismissedBy(value)
	return &by
}

// NewBotIMRoutes 组装 Bot IM 路由；admin 为 nil 时不注册管理后台接口。
func NewBotIMRoutes(bots botAgentService, groups imGroupService, admin ImAdminService, encoder *ErrorEncoder) (http.Handler, error) {
	if encoder == nil {
		return nil, ErrValidatorEncoderRequired
	}
	handler, err := NewBotIMHandler(bots, groups)
	if err != nil {
		return nil, err
	}
	handler.admin = admin
	strict := openapi.NewStrictHandlerWithOptions(handler, nil, StrictServerOptions(encoder))
	wrapper := &openapi.ServerInterfaceWrapper{Handler: strict, ErrorHandlerFunc: StdHTTPErrorHandler(encoder)}
	mux := http.NewServeMux()
	routes := BotIMImplementedRoutes()
	if admin != nil {
		routes = append(routes, ImAdminImplementedRoutes()...)
	}
	for _, route := range routes {
		pattern := route.Method + " " + route.Path
		switch route.Path + " " + route.Method {
		case "/v1/me/bots GET":
			mux.HandleFunc(pattern, wrapper.ListBotAgents)
		case "/v1/me/bots POST":
			mux.HandleFunc(pattern, wrapper.ProvisionBotAgent)
		case "/v1/me/bots/{botAgentId} PATCH":
			mux.HandleFunc(pattern, wrapper.UpdateBotAgent)
		case "/v1/me/bots/{botAgentId} DELETE":
			mux.HandleFunc(pattern, wrapper.DeleteBotAgent)
		case "/v1/me/bots/{botAgentId}/credential POST":
			mux.HandleFunc(pattern, wrapper.RotateBotAgentCredential)
		case "/v1/me/groups POST":
			mux.HandleFunc(pattern, wrapper.CreateImGroup)
		case "/v1/me/groups/{groupId}/invite-link POST":
			mux.HandleFunc(pattern, wrapper.CreateImGroupInviteLink)
		case "/v1/me/group-invites/accept POST":
			mux.HandleFunc(pattern, wrapper.AcceptImGroupInvite)
		case "/v1/admin/im/summary GET":
			mux.HandleFunc(pattern, wrapper.GetImAdminSummary)
		case "/v1/admin/im/identities GET":
			mux.HandleFunc(pattern, wrapper.ListImAdminIdentities)
		case "/v1/admin/im/identities/{userId}/restrict POST":
			mux.HandleFunc(pattern, wrapper.RestrictImAdminIdentity)
		case "/v1/admin/im/identities/{userId}/release POST":
			mux.HandleFunc(pattern, wrapper.ReleaseImAdminIdentity)
		case "/v1/admin/im/groups GET":
			mux.HandleFunc(pattern, wrapper.ListImAdminGroups)
		case "/v1/admin/im/groups/{groupId} GET":
			mux.HandleFunc(pattern, wrapper.GetImAdminGroup)
		case "/v1/admin/im/groups/{groupId}/dismiss POST":
			mux.HandleFunc(pattern, wrapper.DismissImAdminGroup)
		case "/v1/admin/im/accounts/{accountId}/bots/{botAgentId}/disable POST":
			mux.HandleFunc(pattern, wrapper.DisableImAdminBot)
		case "/v1/admin/im/tencent-check POST":
			mux.HandleFunc(pattern, wrapper.CheckImAdminTencent)
		case "/v1/me/groups/{groupId} GET":
			mux.HandleFunc(pattern, wrapper.GetImGroup)
		case "/v1/me/groups/{groupId} PATCH":
			mux.HandleFunc(pattern, wrapper.UpdateImGroup)
		case "/v1/me/groups/{groupId} DELETE":
			mux.HandleFunc(pattern, wrapper.DismissImGroup)
		case "/v1/me/groups/{groupId}/members/{userId} PUT":
			mux.HandleFunc(pattern, wrapper.AddImGroupMember)
		case "/v1/me/groups/{groupId}/members/{userId} DELETE":
			mux.HandleFunc(pattern, wrapper.RemoveImGroupMember)
		case "/v1/runtime/bot/session POST":
			mux.HandleFunc(pattern, wrapper.CreateBotSession)
		case "/v1/runtime/bot/me GET":
			mux.HandleFunc(pattern, wrapper.GetBotRuntimeMe)
		case "/v1/runtime/bot/groups POST":
			mux.HandleFunc(pattern, wrapper.CreateBotRuntimeGroup)
		case "/v1/runtime/bot/groups/{groupId} GET":
			mux.HandleFunc(pattern, wrapper.GetBotRuntimeGroup)
		case "/v1/runtime/bot/groups/{groupId} PATCH":
			mux.HandleFunc(pattern, wrapper.UpdateBotRuntimeGroup)
		case "/v1/runtime/bot/groups/{groupId} DELETE":
			mux.HandleFunc(pattern, wrapper.DismissBotRuntimeGroup)
		case "/v1/runtime/bot/groups/{groupId}/members/{userId} PUT":
			mux.HandleFunc(pattern, wrapper.AddBotRuntimeGroupMember)
		case "/v1/runtime/bot/groups/{groupId}/members/{userId} DELETE":
			mux.HandleFunc(pattern, wrapper.RemoveBotRuntimeGroupMember)
		default:
			return nil, errors.New("Bot IM 路由未接线：" + pattern)
		}
	}
	return mux, nil
}

// BotIMImplementedRoutes 是 Bot IM 入口真正接线的 method/path。
func BotIMImplementedRoutes() []ImplementedRoute {
	return []ImplementedRoute{
		{Method: http.MethodGet, Path: "/v1/me/bots"},
		{Method: http.MethodPost, Path: "/v1/me/bots"},
		{Method: http.MethodPatch, Path: "/v1/me/bots/{botAgentId}"},
		{Method: http.MethodDelete, Path: "/v1/me/bots/{botAgentId}"},
		{Method: http.MethodPost, Path: "/v1/me/bots/{botAgentId}/credential"},
		{Method: http.MethodPost, Path: "/v1/me/groups"},
		{Method: http.MethodGet, Path: "/v1/me/groups/{groupId}"},
		{Method: http.MethodPatch, Path: "/v1/me/groups/{groupId}"},
		{Method: http.MethodDelete, Path: "/v1/me/groups/{groupId}"},
		{Method: http.MethodPut, Path: "/v1/me/groups/{groupId}/members/{userId}"},
		{Method: http.MethodDelete, Path: "/v1/me/groups/{groupId}/members/{userId}"},
		{Method: http.MethodPost, Path: "/v1/me/groups/{groupId}/invite-link"},
		{Method: http.MethodPost, Path: "/v1/me/group-invites/accept"},
		{Method: http.MethodPost, Path: "/v1/runtime/bot/session"},
		{Method: http.MethodGet, Path: "/v1/runtime/bot/me"},
		{Method: http.MethodPost, Path: "/v1/runtime/bot/groups"},
		{Method: http.MethodGet, Path: "/v1/runtime/bot/groups/{groupId}"},
		{Method: http.MethodPatch, Path: "/v1/runtime/bot/groups/{groupId}"},
		{Method: http.MethodDelete, Path: "/v1/runtime/bot/groups/{groupId}"},
		{Method: http.MethodPut, Path: "/v1/runtime/bot/groups/{groupId}/members/{userId}"},
		{Method: http.MethodDelete, Path: "/v1/runtime/bot/groups/{groupId}/members/{userId}"},
	}
}
