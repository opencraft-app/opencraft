package httptransport

import (
	"context"
	"net/http"
	"time"

	"git.woa.com/wisp/mono2/collaboration/internal/api/openapi"
	"git.woa.com/wisp/mono2/collaboration/internal/app/imadmin"
	"git.woa.com/wisp/mono2/collaboration/internal/apperror"

	"github.com/google/uuid"
)

// ImAdminService 是管理后台 IM 运营应用服务。
type ImAdminService interface {
	Summary(context.Context) (imadmin.Summary, error)
	ListIdentities(ctx context.Context, query, kind string, limit, offset int) ([]imadmin.Identity, int, error)
	ListGroups(ctx context.Context, query, state string, limit, offset int) ([]imadmin.Group, int, error)
	Group(context.Context, string) (imadmin.Group, []imadmin.Member, error)
	Restrict(ctx context.Context, userID string, restricted bool) (imadmin.Identity, error)
	DismissGroup(context.Context, string) error
	DisableBot(ctx context.Context, accountID, botAgentID string) error
	CheckTencent(context.Context) (imadmin.Check, error)
}

// ImAdminImplementedRoutes 是管理后台 IM 运营接口；只在配置了管理员 Token 时注册。
func ImAdminImplementedRoutes() []ImplementedRoute {
	return []ImplementedRoute{
		{Method: http.MethodGet, Path: "/v1/admin/im/summary"},
		{Method: http.MethodGet, Path: "/v1/admin/im/identities"},
		{Method: http.MethodPost, Path: "/v1/admin/im/identities/{userId}/restrict"},
		{Method: http.MethodPost, Path: "/v1/admin/im/identities/{userId}/release"},
		{Method: http.MethodGet, Path: "/v1/admin/im/groups"},
		{Method: http.MethodGet, Path: "/v1/admin/im/groups/{groupId}"},
		{Method: http.MethodPost, Path: "/v1/admin/im/groups/{groupId}/dismiss"},
		{Method: http.MethodPost, Path: "/v1/admin/im/accounts/{accountId}/bots/{botAgentId}/disable"},
		{Method: http.MethodPost, Path: "/v1/admin/im/tencent-check"},
	}
}

func (h *BotIMHandler) requireAdmin(ctx context.Context) error {
	if h.admin == nil || !IsAdmin(ctx) {
		return apperror.New("unauthenticated", "需要管理员 Token", nil)
	}
	return nil
}

func (h *BotIMHandler) GetImAdminSummary(
	ctx context.Context,
	_ openapi.GetImAdminSummaryRequestObject,
) (openapi.GetImAdminSummaryResponseObject, error) {
	if err := h.requireAdmin(ctx); err != nil {
		return nil, err
	}
	summary, err := h.admin.Summary(ctx)
	if err != nil {
		return nil, err
	}
	return openapi.GetImAdminSummary200JSONResponse{
		HumansReady: summary.HumansReady, HumansPending: summary.HumansPending,
		Bots: openapi.ImAdminBotCounts{
			Ready: summary.BotsReady, Provisioning: summary.BotsProvisioning, Error: summary.BotsError, Deleted: summary.BotsDeleted,
		},
		GroupsActive: summary.GroupsActive, GroupsDismissed: summary.GroupsDismissed,
		RestrictedIdentities: summary.Restricted, EstimatedTencentAccounts: summary.EstimatedTencentAccounts(),
	}, nil
}

func (h *BotIMHandler) ListImAdminIdentities(
	ctx context.Context,
	request openapi.ListImAdminIdentitiesRequestObject,
) (openapi.ListImAdminIdentitiesResponseObject, error) {
	if err := h.requireAdmin(ctx); err != nil {
		return nil, err
	}
	kind := ""
	if request.Params.Kind != nil {
		kind = string(*request.Params.Kind)
	}
	items, total, err := h.admin.ListIdentities(ctx, deref(request.Params.Q), kind, derefInt(request.Params.Limit, 50), derefInt(request.Params.Offset, 0))
	if err != nil {
		return nil, err
	}
	result := openapi.ImAdminIdentityList{Items: make([]openapi.ImAdminIdentity, 0, len(items)), Total: total}
	for _, item := range items {
		result.Items = append(result.Items, imAdminIdentityDTO(item))
	}
	return openapi.ListImAdminIdentities200JSONResponse(result), nil
}

func (h *BotIMHandler) RestrictImAdminIdentity(
	ctx context.Context,
	request openapi.RestrictImAdminIdentityRequestObject,
) (openapi.RestrictImAdminIdentityResponseObject, error) {
	if err := h.requireAdmin(ctx); err != nil {
		return nil, err
	}
	identity, err := h.admin.Restrict(ctx, request.UserId, true)
	if err != nil {
		return nil, err
	}
	return openapi.RestrictImAdminIdentity200JSONResponse(imAdminIdentityDTO(identity)), nil
}

func (h *BotIMHandler) ReleaseImAdminIdentity(
	ctx context.Context,
	request openapi.ReleaseImAdminIdentityRequestObject,
) (openapi.ReleaseImAdminIdentityResponseObject, error) {
	if err := h.requireAdmin(ctx); err != nil {
		return nil, err
	}
	identity, err := h.admin.Restrict(ctx, request.UserId, false)
	if err != nil {
		return nil, err
	}
	return openapi.ReleaseImAdminIdentity200JSONResponse(imAdminIdentityDTO(identity)), nil
}

func (h *BotIMHandler) ListImAdminGroups(
	ctx context.Context,
	request openapi.ListImAdminGroupsRequestObject,
) (openapi.ListImAdminGroupsResponseObject, error) {
	if err := h.requireAdmin(ctx); err != nil {
		return nil, err
	}
	state := ""
	if request.Params.State != nil {
		state = string(*request.Params.State)
	}
	items, total, err := h.admin.ListGroups(ctx, deref(request.Params.Q), state, derefInt(request.Params.Limit, 50), derefInt(request.Params.Offset, 0))
	if err != nil {
		return nil, err
	}
	result := openapi.ImAdminGroupList{Items: make([]openapi.ImAdminGroup, 0, len(items)), Total: total}
	for _, item := range items {
		dto, err := imAdminGroupDTO(item)
		if err != nil {
			return nil, err
		}
		result.Items = append(result.Items, dto)
	}
	return openapi.ListImAdminGroups200JSONResponse(result), nil
}

func (h *BotIMHandler) GetImAdminGroup(
	ctx context.Context,
	request openapi.GetImAdminGroupRequestObject,
) (openapi.GetImAdminGroupResponseObject, error) {
	if err := h.requireAdmin(ctx); err != nil {
		return nil, err
	}
	group, members, err := h.admin.Group(ctx, request.GroupId.String())
	if err != nil {
		return nil, err
	}
	dto, err := imAdminGroupDTO(group)
	if err != nil {
		return nil, err
	}
	detail := openapi.ImAdminGroupDetail{Group: dto, Members: make([]openapi.ImAdminGroupMember, 0, len(members))}
	for _, member := range members {
		detail.Members = append(detail.Members, openapi.ImAdminGroupMember{
			UserId: member.UserID, Kind: openapi.ImAdminGroupMemberKind(member.Kind), Role: openapi.ImAdminGroupMemberRole(member.Role),
			State: member.State, DisplayName: optional(member.DisplayName),
		})
	}
	return openapi.GetImAdminGroup200JSONResponse(detail), nil
}

func (h *BotIMHandler) DismissImAdminGroup(
	ctx context.Context,
	request openapi.DismissImAdminGroupRequestObject,
) (openapi.DismissImAdminGroupResponseObject, error) {
	if err := h.requireAdmin(ctx); err != nil {
		return nil, err
	}
	if err := h.admin.DismissGroup(ctx, request.GroupId.String()); err != nil {
		return nil, err
	}
	return openapi.DismissImAdminGroup204Response{}, nil
}

func (h *BotIMHandler) DisableImAdminBot(
	ctx context.Context,
	request openapi.DisableImAdminBotRequestObject,
) (openapi.DisableImAdminBotResponseObject, error) {
	if err := h.requireAdmin(ctx); err != nil {
		return nil, err
	}
	if err := h.admin.DisableBot(ctx, request.AccountId.String(), request.BotAgentId.String()); err != nil {
		return nil, err
	}
	return openapi.DisableImAdminBot204Response{}, nil
}

func (h *BotIMHandler) CheckImAdminTencent(
	ctx context.Context,
	_ openapi.CheckImAdminTencentRequestObject,
) (openapi.CheckImAdminTencentResponseObject, error) {
	if err := h.requireAdmin(ctx); err != nil {
		return nil, err
	}
	check, err := h.admin.CheckTencent(ctx)
	if err != nil {
		return nil, err
	}
	result := openapi.ImAdminTencentCheck{Checked: check.Checked, Imported: check.Imported, Mismatches: make([]openapi.ImAdminTencentMismatch, 0, len(check.Mismatches))}
	for _, mismatch := range check.Mismatches {
		result.Mismatches = append(result.Mismatches, openapi.ImAdminTencentMismatch{
			UserId: mismatch.UserID, Kind: mismatch.Kind, State: mismatch.State,
			Expected: openapi.ImAdminTencentMismatchExpected(mismatch.Expected), Tencent: openapi.ImAdminTencentMismatchTencent(mismatch.Tencent),
		})
	}
	return openapi.CheckImAdminTencent200JSONResponse(result), nil
}

func imAdminIdentityDTO(identity imadmin.Identity) openapi.ImAdminIdentity {
	return openapi.ImAdminIdentity{
		UserId: identity.UserID, Kind: openapi.ImAdminIdentityKind(identity.Kind), State: identity.State,
		DisplayName: identity.DisplayName, AccountId: optional(identity.AccountID), LightvelaUserId: optional(identity.LightVelaUserID),
		BotAgentId: optional(identity.BotAgentID), InstanceId: optional(identity.InstanceID), BotId: optional(identity.BotID),
		Restricted: identity.RestrictedAt != nil, RestrictedAt: identity.RestrictedAt, CreatedAt: optionalTime(identity.CreatedAt),
	}
}

func imAdminGroupDTO(group imadmin.Group) (openapi.ImAdminGroup, error) {
	id, err := uuid.Parse(group.ID)
	if err != nil {
		return openapi.ImAdminGroup{}, apperror.New("internal_error", "平台群 ID 无效", err)
	}
	return openapi.ImAdminGroup{
		Id: id, TencentGroupId: group.TencentGroupID, Name: group.Name, OwnerAccountId: group.OwnerAccountID,
		OwnerLightvelaUserId: optional(group.OwnerLightVelaUserID), CreatedByUserId: group.CreatedByUserID,
		ReplyMode: openapi.GroupReplyMode(group.ReplyMode), State: openapi.ImAdminGroupState(group.State),
		MemberCount: group.MemberCount, CreatedAt: optionalTime(group.CreatedAt),
	}, nil
}

func optional(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func optionalTime(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	utc := value.UTC()
	return &utc
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func derefInt(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return *value
}
