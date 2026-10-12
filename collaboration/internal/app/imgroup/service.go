// Package imgroup 编排平台群：成员与回复规则以平台数据库为准，腾讯侧只做幂等同步。
package imgroup

import (
	"context"
	"errors"
	"strings"

	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
	clockport "git.woa.com/wisp/mono2/collaboration/internal/ports/clock"

	"github.com/google/uuid"
)

// MaxMembers 是平台群（含群主）的成员上限。
const MaxMembers = 50

// ContextMessages 是 mention_context 模式附带的前序消息条数。
const ContextMessages = 10

// Actor 是执行群操作的 IM 身份；Human 与 Bot 遵守同一套权限。
type Actor struct {
	IMUserID  string
	Kind      string
	AccountID string
}

// CreateInput 是创建平台群的请求。
type CreateInput struct {
	GroupID       string
	Name          string
	MemberUserIDs []string
	ReplyMode     string
}

// UpdateInput 是修改平台群的请求；nil 表示不修改。
type UpdateInput struct {
	Name      *string
	ReplyMode *string
}

// View 是返回给调用方的平台群投影。
type View struct {
	Group              botimport.Group
	Members            []botimport.GroupMember
	EffectiveReplyMode string
	ContextMessages    int
	ViewerRole         string
}

// Service 是平台群应用服务。
type Service struct {
	repository botimport.Repository
	tencent    botimport.TencentGroups
	clock      clockport.Clock
}

func NewService(
	repository botimport.Repository,
	tencent botimport.TencentGroups,
	clock clockport.Clock,
) (*Service, error) {
	if repository == nil || tencent == nil || clock == nil {
		return nil, errors.New("平台群服务配置无效")
	}
	return &Service{repository: repository, tencent: tencent, clock: clock}, nil
}

// HumanActor 把 LightVela 账号解析为群操作者，并登记其 IM 路由。
func (s *Service) HumanActor(ctx context.Context, accountID string) (Actor, error) {
	account, err := s.repository.FindAccount(ctx, accountID)
	if errors.Is(err, botimport.ErrNotFound) {
		return Actor{}, apperror.New("unauthenticated", "账号不存在", err)
	}
	if err != nil {
		return Actor{}, internal("暂时无法读取账号", err)
	}
	if account.IMState != "ready" || account.IMUserID == "" {
		return Actor{}, apperror.New("im_identity_not_ready", "IM 身份尚未就绪", nil)
	}
	route, err := s.repository.EnsureRoute(ctx, botimport.Route{
		IMUserID:  account.IMUserID,
		Kind:      botimport.IdentityKindHuman,
		AccountID: account.ID,
	})
	if err != nil {
		return Actor{}, internal("暂时无法登记 IM 路由", err)
	}
	if route.RestrictedAt != nil {
		return Actor{}, apperror.New("im_identity_restricted", "当前 IM 身份已被限制", nil)
	}
	return Actor{IMUserID: account.IMUserID, Kind: botimport.IdentityKindHuman, AccountID: account.ID}, nil
}

// AdmitHuman 在签发 Human UserSig 前登记 IM 路由，并拒绝已被限制的身份。
func (s *Service) AdmitHuman(ctx context.Context, accountID string, imUserID string) error {
	route, err := s.repository.EnsureRoute(ctx, botimport.Route{
		IMUserID:  imUserID,
		Kind:      botimport.IdentityKindHuman,
		AccountID: accountID,
	})
	if err != nil {
		return internal("暂时无法登记 IM 路由", err)
	}
	if route.RestrictedAt != nil {
		return apperror.New("im_identity_restricted", "当前 IM 身份已被限制", nil)
	}
	return nil
}

// BotActor 把当前 Bot 转换为群操作者。
func BotActor(bot botimport.BotAgent) Actor {
	return Actor{IMUserID: bot.IMUserID, Kind: botimport.IdentityKindBot, AccountID: bot.AccountID}
}

// Create 创建平台群；同一 groupId 由同一操作者重试时返回同一个群。
func (s *Service) Create(ctx context.Context, actor Actor, input CreateInput) (View, error) {
	parsed, err := uuid.Parse(input.GroupID)
	if err != nil || parsed.Version() != 7 {
		return View{}, apperror.New("invalid_request", "groupId 必须是客户端生成的 UUIDv7", err)
	}
	groupID := parsed.String()
	name := strings.TrimSpace(input.Name)
	replyMode := input.ReplyMode
	if replyMode == "" {
		replyMode = botimport.ReplyModeMention
	}
	if name == "" || len([]rune(name)) > 100 || !validReplyMode(replyMode) {
		return View{}, apperror.New("invalid_request", "群名或回复模式无效", nil)
	}
	tencentGroupID, _ := botimport.TencentGroupID(groupID)

	group, members, err := s.repository.FindGroup(ctx, groupID)
	switch {
	case err == nil:
		if group.CreatedByIMUserID != actor.IMUserID {
			return View{}, apperror.New("idempotency_conflict", "groupId 已被其他请求使用", nil)
		}
	case errors.Is(err, botimport.ErrNotFound):
		members, err = s.initialMembers(ctx, actor, input.MemberUserIDs)
		if err != nil {
			return View{}, err
		}
		now := s.clock.Now().UTC()
		group = botimport.Group{
			ID:                groupID,
			TencentGroupID:    tencentGroupID,
			OwnerAccountID:    actor.AccountID,
			CreatedByIMUserID: actor.IMUserID,
			Name:              name,
			ReplyMode:         replyMode,
			State:             botimport.GroupStateProvisioning,
			Revision:          1,
			CreatedAt:         now,
			UpdatedAt:         now,
		}
		if err := s.repository.InsertGroup(ctx, group, members); err != nil {
			if errors.Is(err, botimport.ErrConflict) {
				return s.Create(ctx, actor, input)
			}
			return View{}, internal("暂时无法保存群聊", err)
		}
	default:
		return View{}, internal("暂时无法读取群聊", err)
	}

	if group.State == botimport.GroupStateProvisioning {
		memberIDs := make([]string, 0, len(members))
		for _, member := range members {
			if member.State == botimport.MemberStateActive && member.Role != botimport.RoleOwner {
				memberIDs = append(memberIDs, member.IMUserID)
			}
		}
		if err := s.tencent.EnsureGroup(ctx, botimport.TencentGroup{
			GroupID:       group.TencentGroupID,
			Name:          group.Name,
			OwnerUserID:   group.CreatedByIMUserID,
			MemberUserIDs: memberIDs,
		}); err != nil {
			return View{}, apperror.New("tencent_unavailable", "暂时无法在腾讯云 IM 创建群聊，请用同一 groupId 重试", err)
		}
		expected := group.Revision
		group.State = botimport.GroupStateActive
		group.UpdatedAt = s.clock.Now().UTC()
		if _, err := s.repository.SaveGroup(ctx, group, expected); err != nil && !errors.Is(err, botimport.ErrConflict) {
			return View{}, internal("暂时无法保存群聊", err)
		}
	}
	return s.Get(ctx, actor, groupID)
}

// Get 返回群与规则；只有 active 成员可以读取。
func (s *Service) Get(ctx context.Context, actor Actor, groupID string) (View, error) {
	group, members, err := s.load(ctx, groupID)
	if err != nil {
		return View{}, err
	}
	role, ok := activeRole(members, actor.IMUserID)
	if !ok {
		return View{}, notFound(nil)
	}
	return view(group, members, role), nil
}

// Update 修改群名或回复模式；回复模式变化后向群内发送规则通知。
func (s *Service) Update(ctx context.Context, actor Actor, groupID string, input UpdateInput) (View, error) {
	group, members, err := s.activeGroup(ctx, groupID)
	if err != nil {
		return View{}, err
	}
	if err := requireManager(members, actor.IMUserID); err != nil {
		return View{}, err
	}
	nameChanged, modeChanged := false, false
	if input.Name != nil {
		name := strings.TrimSpace(*input.Name)
		if name == "" || len([]rune(name)) > 100 {
			return View{}, apperror.New("invalid_request", "群名无效", nil)
		}
		nameChanged = name != group.Name
		group.Name = name
	}
	if input.ReplyMode != nil {
		if !validReplyMode(*input.ReplyMode) {
			return View{}, apperror.New("invalid_request", "回复模式无效", nil)
		}
		modeChanged = *input.ReplyMode != group.ReplyMode
		group.ReplyMode = *input.ReplyMode
	}
	if !nameChanged && !modeChanged {
		return s.Get(ctx, actor, groupID)
	}
	if nameChanged {
		if err := s.tencent.Rename(ctx, group.TencentGroupID, group.Name); err != nil {
			return View{}, apperror.New("tencent_unavailable", "暂时无法修改腾讯云 IM 群名", err)
		}
	}
	expected := group.Revision
	group.UpdatedAt = s.clock.Now().UTC()
	saved, err := s.repository.SaveGroup(ctx, group, expected)
	if errors.Is(err, botimport.ErrConflict) {
		return View{}, apperror.New("revision_conflict", "群聊已被并发修改，请重试", err)
	}
	if err != nil {
		return View{}, internal("暂时无法保存群聊", err)
	}
	if modeChanged {
		// 通知只用于让 Bot 立即刷新规则；失败时 Bot 会在下次会话续期时读到新规则。
		_ = s.tencent.SendPolicyNotice(ctx, saved.TencentGroupID, botimport.PolicyNotice{
			GroupID: saved.ID, ReplyMode: saved.ReplyMode, Revision: saved.Revision,
		})
	}
	return s.Get(ctx, actor, groupID)
}

// AddMember 把平台已知的 IM 身份加入群；重复添加是幂等的。
func (s *Service) AddMember(ctx context.Context, actor Actor, groupID, userID string) (View, error) {
	group, members, err := s.activeGroup(ctx, groupID)
	if err != nil {
		return View{}, err
	}
	if err := requireManager(members, actor.IMUserID); err != nil {
		return View{}, err
	}
	if _, ok := activeRole(members, userID); ok {
		return s.Get(ctx, actor, groupID)
	}
	if countActive(members) >= MaxMembers {
		return View{}, apperror.New("invalid_request", "群成员已达上限", nil)
	}
	route, err := s.memberRoute(ctx, userID)
	if err != nil {
		return View{}, err
	}
	if err := s.tencent.AddMembers(ctx, group.TencentGroupID, []string{userID}); err != nil {
		return View{}, apperror.New("tencent_unavailable", "暂时无法把成员加入腾讯云 IM 群", err)
	}
	if err := s.repository.UpsertMember(ctx, botimport.GroupMember{
		GroupID: groupID, IMUserID: userID, Kind: route.Kind,
		Role: botimport.RoleMember, State: botimport.MemberStateActive, AddedByIMUserID: actor.IMUserID,
	}); err != nil {
		return View{}, internal("暂时无法保存群成员", err)
	}
	return s.Get(ctx, actor, groupID)
}

// RemoveMember 移出成员或退群；群主不能被移出。
func (s *Service) RemoveMember(ctx context.Context, actor Actor, groupID, userID string) (View, error) {
	group, members, err := s.activeGroup(ctx, groupID)
	if err != nil {
		return View{}, err
	}
	actorRole, ok := activeRole(members, actor.IMUserID)
	if !ok {
		return View{}, notFound(nil)
	}
	targetRole, ok := activeRole(members, userID)
	if !ok {
		return view(group, members, actorRole), nil
	}
	if targetRole == botimport.RoleOwner {
		return View{}, apperror.New("owner_immutable", "群主不能被移出；请解散群聊", nil)
	}
	if userID != actor.IMUserID && actorRole == botimport.RoleMember {
		return View{}, apperror.New("permission_denied", "只有群主和管理员可以移出成员", nil)
	}
	if err := s.tencent.RemoveMembers(ctx, group.TencentGroupID, []string{userID}); err != nil {
		return View{}, apperror.New("tencent_unavailable", "暂时无法把成员移出腾讯云 IM 群", err)
	}
	if err := s.repository.MarkMemberRemoved(ctx, groupID, userID); err != nil {
		return View{}, internal("暂时无法保存群成员", err)
	}
	if userID == actor.IMUserID {
		group, members, err = s.load(ctx, groupID)
		if err != nil {
			return View{}, err
		}
		return view(group, members, botimport.RoleMember), nil
	}
	return s.Get(ctx, actor, groupID)
}

// Dismiss 解散平台群；只有群主可以操作。
func (s *Service) Dismiss(ctx context.Context, actor Actor, groupID string) error {
	group, members, err := s.load(ctx, groupID)
	if err != nil {
		return err
	}
	role, ok := activeRole(members, actor.IMUserID)
	if !ok {
		return notFound(nil)
	}
	if role != botimport.RoleOwner {
		return apperror.New("permission_denied", "只有群主可以解散群聊", nil)
	}
	if group.State == botimport.GroupStateDismissed {
		return nil
	}
	if err := s.tencent.Destroy(ctx, group.TencentGroupID); err != nil {
		return apperror.New("tencent_unavailable", "暂时无法解散腾讯云 IM 群", err)
	}
	return s.markDismissed(ctx, group)
}

// ObserveMembersJoined 用腾讯回调对账：平台群里出现了平台未登记的成员。
func (s *Service) ObserveMembersJoined(ctx context.Context, tencentGroupID string, userIDs []string) error {
	groupID, ok := botimport.GroupIDFromTencent(tencentGroupID)
	if !ok {
		return nil
	}
	group, members, err := s.repository.FindGroup(ctx, groupID)
	if errors.Is(err, botimport.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if group.State == botimport.GroupStateDismissed {
		return nil
	}
	for _, userID := range userIDs {
		if _, ok := activeRole(members, userID); ok {
			continue
		}
		kind := botimport.IdentityKindHuman
		if route, err := s.repository.FindRoute(ctx, userID); err == nil {
			kind = route.Kind
		}
		if err := s.repository.UpsertMember(ctx, botimport.GroupMember{
			GroupID: groupID, IMUserID: userID, Kind: kind, Role: botimport.RoleMember,
			State: botimport.MemberStateActive, AddedByIMUserID: group.CreatedByIMUserID,
		}); err != nil {
			return err
		}
	}
	return nil
}

// ObserveMembersLeft 用腾讯回调对账：成员通过 SDK 退群或被移出。
func (s *Service) ObserveMembersLeft(ctx context.Context, tencentGroupID string, userIDs []string) error {
	groupID, ok := botimport.GroupIDFromTencent(tencentGroupID)
	if !ok {
		return nil
	}
	for _, userID := range userIDs {
		if err := s.repository.MarkMemberRemoved(ctx, groupID, userID); err != nil {
			return err
		}
	}
	return nil
}

// ObserveGroupDestroyed 用腾讯回调对账：群已在腾讯侧解散。
func (s *Service) ObserveGroupDestroyed(ctx context.Context, tencentGroupID string) error {
	groupID, ok := botimport.GroupIDFromTencent(tencentGroupID)
	if !ok {
		return nil
	}
	group, _, err := s.repository.FindGroup(ctx, groupID)
	if errors.Is(err, botimport.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if group.State == botimport.GroupStateDismissed {
		return nil
	}
	return s.markDismissed(ctx, group)
}

// IsRestricted 供腾讯发消息前回调判断发送者是否被封禁。
func (s *Service) IsRestricted(ctx context.Context, userID string) (bool, error) {
	route, err := s.repository.FindRoute(ctx, userID)
	if errors.Is(err, botimport.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return route.RestrictedAt != nil, nil
}

func (s *Service) markDismissed(ctx context.Context, group botimport.Group) error {
	expected := group.Revision
	group.State = botimport.GroupStateDismissed
	group.UpdatedAt = s.clock.Now().UTC()
	if _, err := s.repository.SaveGroup(ctx, group, expected); err != nil && !errors.Is(err, botimport.ErrConflict) {
		return internal("暂时无法保存群聊", err)
	}
	return nil
}

func (s *Service) initialMembers(
	ctx context.Context,
	actor Actor,
	userIDs []string,
) ([]botimport.GroupMember, error) {
	members := []botimport.GroupMember{{
		IMUserID: actor.IMUserID, Kind: actor.Kind, Role: botimport.RoleOwner,
		State: botimport.MemberStateActive, AddedByIMUserID: actor.IMUserID,
	}}
	seen := map[string]struct{}{actor.IMUserID: {}}
	for _, userID := range userIDs {
		if _, duplicate := seen[userID]; duplicate {
			continue
		}
		seen[userID] = struct{}{}
		route, err := s.memberRoute(ctx, userID)
		if err != nil {
			return nil, err
		}
		members = append(members, botimport.GroupMember{
			IMUserID: userID, Kind: route.Kind, Role: botimport.RoleMember,
			State: botimport.MemberStateActive, AddedByIMUserID: actor.IMUserID,
		})
	}
	if len(members) > MaxMembers {
		return nil, apperror.New("invalid_request", "群成员超过上限", nil)
	}
	return members, nil
}

func (s *Service) memberRoute(ctx context.Context, userID string) (botimport.Route, error) {
	route, err := s.repository.FindRoute(ctx, userID)
	if errors.Is(err, botimport.ErrNotFound) {
		return botimport.Route{}, apperror.New("im_identity_unknown", "成员 "+userID+" 尚未在平台开通 IM 身份", err)
	}
	if err != nil {
		return botimport.Route{}, internal("暂时无法读取 IM 路由", err)
	}
	if route.RestrictedAt != nil {
		return botimport.Route{}, apperror.New("im_identity_restricted", "成员 "+userID+" 已被限制", nil)
	}
	return route, nil
}

func (s *Service) load(ctx context.Context, groupID string) (botimport.Group, []botimport.GroupMember, error) {
	group, members, err := s.repository.FindGroup(ctx, groupID)
	if errors.Is(err, botimport.ErrNotFound) {
		return botimport.Group{}, nil, notFound(err)
	}
	if err != nil {
		return botimport.Group{}, nil, internal("暂时无法读取群聊", err)
	}
	return group, members, nil
}

func (s *Service) activeGroup(ctx context.Context, groupID string) (botimport.Group, []botimport.GroupMember, error) {
	group, members, err := s.load(ctx, groupID)
	if err != nil {
		return botimport.Group{}, nil, err
	}
	if group.State != botimport.GroupStateActive {
		return botimport.Group{}, nil, apperror.New("im_group_not_ready", "群聊尚未就绪或已解散", nil)
	}
	return group, members, nil
}

// view 计算生效规则：群里没有任何 active 人类时，每条消息都触发 Bot。
func view(group botimport.Group, members []botimport.GroupMember, viewerRole string) View {
	active := make([]botimport.GroupMember, 0, len(members))
	hasHuman := false
	for _, member := range members {
		if member.State != botimport.MemberStateActive {
			continue
		}
		active = append(active, member)
		if member.Kind == botimport.IdentityKindHuman {
			hasHuman = true
		}
	}
	effective := group.ReplyMode
	if !hasHuman {
		effective = botimport.ReplyModeAll
	}
	contextMessages := 0
	if effective == botimport.ReplyModeMentionContext {
		contextMessages = ContextMessages
	}
	return View{
		Group: group, Members: active, EffectiveReplyMode: effective,
		ContextMessages: contextMessages, ViewerRole: viewerRole,
	}
}

func activeRole(members []botimport.GroupMember, userID string) (string, bool) {
	for _, member := range members {
		if member.IMUserID == userID && member.State == botimport.MemberStateActive {
			return member.Role, true
		}
	}
	return "", false
}

func requireManager(members []botimport.GroupMember, userID string) error {
	role, ok := activeRole(members, userID)
	if !ok {
		return notFound(nil)
	}
	if role != botimport.RoleOwner && role != botimport.RoleAdmin {
		return apperror.New("permission_denied", "只有群主和管理员可以执行该操作", nil)
	}
	return nil
}

func countActive(members []botimport.GroupMember) int {
	count := 0
	for _, member := range members {
		if member.State == botimport.MemberStateActive {
			count++
		}
	}
	return count
}

func validReplyMode(value string) bool {
	switch value {
	case botimport.ReplyModeMention, botimport.ReplyModeMentionContext, botimport.ReplyModeAll:
		return true
	default:
		return false
	}
}

func notFound(cause error) error {
	return apperror.New("im_group_not_found", "群聊不存在或当前身份不在群内", cause)
}

func internal(message string, cause error) error {
	return apperror.New("internal_error", message, cause)
}
