// Package imgroup 编排平台群：成员与回复规则以平台数据库为准，腾讯侧只做幂等同步。
package imgroup

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
	clockport "git.woa.com/wisp/mono2/collaboration/internal/ports/clock"

	"github.com/google/uuid"
)

// MaxMembers 是平台群（含群主）的成员上限。
const MaxMembers = 50

// MaxDismissReasonRunes 是管理员解散原因的字数上限。
const MaxDismissReasonRunes = 200

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
	inviteKey  []byte
}

// InviteTTL 是群邀请凭据的有效期。
const InviteTTL = 7 * 24 * time.Hour

// Invite 是一次性下发给群主或管理员的邀请凭据。
type Invite struct {
	GroupID   string
	Token     string
	ExpiresAt time.Time
}

// EnableInvites 配置邀请凭据的 HMAC 密钥；未配置时邀请接口不可用。
func (s *Service) EnableInvites(key []byte) error {
	if len(key) < 32 {
		return errors.New("群邀请密钥至少 32 字节")
	}
	s.inviteKey = append([]byte(nil), key...)
	return nil
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

// CreateInvite 为平台群生成邀请凭据：群 ID 与过期时间的 HMAC 签名，不落库，7 天后失效。
func (s *Service) CreateInvite(ctx context.Context, actor Actor, groupID string) (Invite, error) {
	if len(s.inviteKey) == 0 {
		return Invite{}, internal("群邀请未启用", nil)
	}
	_, members, err := s.activeGroup(ctx, groupID)
	if err != nil {
		return Invite{}, err
	}
	if err := requireManager(members, actor.IMUserID); err != nil {
		return Invite{}, err
	}
	expiresAt := s.clock.Now().UTC().Add(InviteTTL).Truncate(time.Second)
	payload := groupID + "." + strconv.FormatInt(expiresAt.Unix(), 10)
	token := base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." +
		base64.RawURLEncoding.EncodeToString(s.inviteMAC(payload))
	return Invite{GroupID: groupID, Token: token, ExpiresAt: expiresAt}, nil
}

// AcceptInvite 让持有有效凭据的人类加入平台群；已是成员时直接返回群。
func (s *Service) AcceptInvite(ctx context.Context, actor Actor, token string) (View, error) {
	invalid := apperror.New("im_group_invite_invalid", "邀请已失效，请向群主重新索取", nil)
	groupID, ok := s.verifyInvite(token)
	if !ok || actor.Kind != botimport.IdentityKindHuman {
		return View{}, invalid
	}
	group, members, err := s.activeGroup(ctx, groupID)
	if err != nil {
		return View{}, invalid
	}
	if _, ok := activeRole(members, actor.IMUserID); ok {
		return s.Get(ctx, actor, groupID)
	}
	if _, err := s.memberRoute(ctx, actor.IMUserID); err != nil {
		return View{}, err
	}
	if countActive(members) >= MaxMembers {
		return View{}, apperror.New("invalid_request", "群成员已达上限", nil)
	}
	if err := s.tencent.AddMembers(ctx, group.TencentGroupID, []string{actor.IMUserID}); err != nil {
		return View{}, apperror.New("tencent_unavailable", "暂时无法加入腾讯云 IM 群", err)
	}
	if err := s.repository.UpsertMember(ctx, botimport.GroupMember{
		GroupID: groupID, IMUserID: actor.IMUserID, Kind: botimport.IdentityKindHuman,
		Role: botimport.RoleMember, State: botimport.MemberStateActive, AddedByIMUserID: actor.IMUserID,
	}); err != nil {
		return View{}, internal("暂时无法保存群成员", err)
	}
	return s.Get(ctx, actor, groupID)
}

func (s *Service) inviteMAC(payload string) []byte {
	mac := hmac.New(sha256.New, s.inviteKey)
	mac.Write([]byte("vela-im-group-invite\n" + payload))
	return mac.Sum(nil)
}

func (s *Service) verifyInvite(token string) (string, bool) {
	if len(s.inviteKey) == 0 || len(token) > 1024 {
		return "", false
	}
	encodedPayload, encodedMAC, ok := strings.Cut(token, ".")
	if !ok {
		return "", false
	}
	payload, err := base64.RawURLEncoding.DecodeString(encodedPayload)
	if err != nil {
		return "", false
	}
	presented, err := base64.RawURLEncoding.DecodeString(encodedMAC)
	if err != nil || !hmac.Equal(presented, s.inviteMAC(string(payload))) {
		return "", false
	}
	groupID, expires, ok := strings.Cut(string(payload), ".")
	unix, err := strconv.ParseInt(expires, 10, 64)
	if !ok || err != nil || !s.clock.Now().Before(time.Unix(unix, 0)) {
		return "", false
	}
	return groupID, true
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
		// 只是显示用的系统提示；发送失败不影响建群结果。
		_ = s.tencent.SendCreatedNotice(ctx, group.TencentGroupID, group.CreatedByIMUserID)
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

// AddMember 把平台已知的 IM 身份加入群；重复添加是幂等的。群主和管理员可以拉任何人，
// 普通成员只能拉自己账号下的 Bot（多人群里每个人带自己的 Agent）。
func (s *Service) AddMember(ctx context.Context, actor Actor, groupID, userID string) (View, error) {
	group, members, err := s.activeGroup(ctx, groupID)
	if err != nil {
		return View{}, err
	}
	actorRole, ok := activeRole(members, actor.IMUserID)
	if !ok {
		return View{}, notFound(nil)
	}
	if _, ok := activeRole(members, userID); ok {
		return s.Get(ctx, actor, groupID)
	}
	route, err := s.memberRoute(ctx, userID)
	if err != nil {
		return View{}, err
	}
	if actorRole == botimport.RoleMember && !ownBot(actor, route) {
		return View{}, apperror.New("permission_denied", "普通成员只能拉入自己的 Agent", nil)
	}
	if countActive(members) >= MaxMembers {
		return View{}, apperror.New("invalid_request", "群成员已达上限", nil)
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
		route, err := s.repository.FindRoute(ctx, userID)
		if err != nil || !ownBot(actor, route) {
			return View{}, apperror.New("permission_denied", "普通成员只能移出自己的 Agent", nil)
		}
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
	return s.markDismissed(ctx, group, botimport.DismissedByOwner, "")
}

// AdminDismiss 由管理后台解散平台群；不校验群主身份，原因必填并展示给群成员，重复调用是幂等的。
func (s *Service) AdminDismiss(ctx context.Context, groupID, reason string) error {
	reason = strings.TrimSpace(reason)
	if reason == "" || utf8.RuneCountInString(reason) > MaxDismissReasonRunes {
		return apperror.New("invalid_request", "请填写 1 到 200 字的解散原因", nil)
	}
	group, _, err := s.load(ctx, groupID)
	if err != nil {
		return err
	}
	if group.State == botimport.GroupStateDismissed {
		return nil
	}
	if err := s.tencent.Destroy(ctx, group.TencentGroupID); err != nil {
		return apperror.New("tencent_unavailable", "暂时无法解散腾讯云 IM 群", err)
	}
	return s.markDismissed(ctx, group, botimport.DismissedByAdmin, reason)
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
	return s.markDismissed(ctx, group, botimport.DismissedByTencent, "")
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

func (s *Service) markDismissed(ctx context.Context, group botimport.Group, by, reason string) error {
	expected := group.Revision
	group.State = botimport.GroupStateDismissed
	group.DismissedBy = by
	group.DismissReason = reason
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

// ownBot 判断目标是不是操作者账号下的 Bot。
func ownBot(actor Actor, route botimport.Route) bool {
	return route.Kind == botimport.IdentityKindBot && actor.AccountID != "" && route.AccountID == actor.AccountID
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
