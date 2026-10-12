// Package imadmin 是管理后台的 IM 运营能力：账号与群的查询、限制身份、解散群、停用 Bot、与腾讯核对。
//
// 列表是低频运营查询，在受限的行数内分页扫描；写操作只定位单个 IM 身份、群或账号下的 Bot，
// 并复用用户侧相同的应用服务，保证效果与用户自己操作一致。
package imadmin

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
)

// MaxScanRows 是单次列表扫描的行数上限；超过时只返回前面的部分并在 Total 中体现扫描到的数量。
const MaxScanRows = 20000

// Identity 是平台创建的一个腾讯 IM 账号。
type Identity struct {
	UserID          string
	Kind            string
	State           string
	DisplayName     string
	AccountID       string
	LightVelaUserID string
	BotAgentID      string
	InstanceID      string
	BotID           string
	RestrictedAt    *time.Time
	CreatedAt       time.Time
}

// Group 是平台群的运营视图。
type Group struct {
	ID                   string
	TencentGroupID       string
	Name                 string
	OwnerAccountID       string
	OwnerLightVelaUserID string
	CreatedByUserID      string
	ReplyMode            string
	State                string
	MemberCount          int
	CreatedAt            time.Time
}

// Member 是群成员的运营视图。
type Member struct {
	UserID      string
	Kind        string
	Role        string
	State       string
	DisplayName string
}

// Summary 是 IM 运营概览。
type Summary struct {
	HumansReady, HumansPending                          int
	BotsReady, BotsProvisioning, BotsError, BotsDeleted int
	GroupsActive, GroupsDismissed                       int
	Restricted                                          int
}

// EstimatedTencentAccounts 是平台认为仍占用腾讯账号的数量。
func (s Summary) EstimatedTencentAccounts() int {
	return s.HumansReady + s.HumansPending + s.BotsReady + s.BotsProvisioning + s.BotsError
}

// Mismatch 是平台记录与腾讯不一致的账号。
type Mismatch struct {
	UserID, Kind, State, Expected, Tencent string
}

// Check 是与腾讯核对的结果。
type Check struct {
	Checked, Imported int
	Mismatches        []Mismatch
}

// Reader 是运营查询的只读数据源。
type Reader interface {
	Identities(context.Context, int) ([]Identity, error)
	Groups(context.Context, int) ([]Group, error)
	GroupMembers(context.Context, string) ([]Member, error)
	AccountSubject(context.Context, string) (string, error)
}

// Bots 是停用 Bot 时复用的用户侧能力。
type Bots interface {
	AdminDelete(ctx context.Context, accountID, subject, botAgentID string) error
}

// Groups 是解散群时复用的群服务能力。
type Groups interface {
	AdminDismiss(ctx context.Context, groupID string) error
}

// Identities 是腾讯账号的下线与核对能力。
type Identities interface {
	KickIdentity(context.Context, string) error
	CheckIdentities(context.Context, []string) (map[string]bool, error)
}

// Service 是管理后台的 IM 运营应用服务。
type Service struct {
	reader     Reader
	routes     botimport.Repository
	bots       Bots
	groups     Groups
	identities Identities
	now        func() time.Time
}

func NewService(reader Reader, routes botimport.Repository, bots Bots, groups Groups, identities Identities) (*Service, error) {
	if reader == nil || routes == nil || bots == nil || groups == nil || identities == nil {
		return nil, errors.New("IM 运营服务配置无效")
	}
	return &Service{reader: reader, routes: routes, bots: bots, groups: groups, identities: identities, now: time.Now}, nil
}

func (s *Service) Summary(ctx context.Context) (Summary, error) {
	identities, err := s.reader.Identities(ctx, MaxScanRows)
	if err != nil {
		return Summary{}, internal(err)
	}
	groups, err := s.reader.Groups(ctx, MaxScanRows)
	if err != nil {
		return Summary{}, internal(err)
	}
	var summary Summary
	for _, identity := range identities {
		if identity.RestrictedAt != nil {
			summary.Restricted++
		}
		switch {
		case identity.Kind == botimport.IdentityKindHuman && identity.State == "ready":
			summary.HumansReady++
		case identity.Kind == botimport.IdentityKindHuman:
			summary.HumansPending++
		case identity.State == botimport.BotStateReady:
			summary.BotsReady++
		case identity.State == botimport.BotStateProvisioning:
			summary.BotsProvisioning++
		case identity.State == botimport.BotStateDeleted:
			summary.BotsDeleted++
		default:
			summary.BotsError++
		}
	}
	for _, group := range groups {
		switch group.State {
		case botimport.GroupStateActive:
			summary.GroupsActive++
		case botimport.GroupStateDismissed:
			summary.GroupsDismissed++
		}
	}
	return summary, nil
}

// ListIdentities 精确匹配 IM UserID、usr_ 或账号 ID，否则按显示名包含匹配。
func (s *Service) ListIdentities(ctx context.Context, query, kind string, limit, offset int) ([]Identity, int, error) {
	identities, err := s.reader.Identities(ctx, MaxScanRows)
	if err != nil {
		return nil, 0, internal(err)
	}
	query = strings.TrimSpace(query)
	matched := make([]Identity, 0, len(identities))
	for _, identity := range identities {
		if kind != "" && identity.Kind != kind {
			continue
		}
		if query != "" && identity.UserID != query && identity.LightVelaUserID != query && identity.AccountID != query &&
			identity.BotAgentID != query && !strings.Contains(strings.ToLower(identity.DisplayName), strings.ToLower(query)) {
			continue
		}
		matched = append(matched, identity)
	}
	sort.SliceStable(matched, func(i, j int) bool { return matched[i].CreatedAt.After(matched[j].CreatedAt) })
	return page(matched, limit, offset), len(matched), nil
}

// ListGroups 精确匹配群 ID、腾讯 GroupId 或群主 usr_，否则按群名包含匹配。
func (s *Service) ListGroups(ctx context.Context, query, state string, limit, offset int) ([]Group, int, error) {
	groups, err := s.reader.Groups(ctx, MaxScanRows)
	if err != nil {
		return nil, 0, internal(err)
	}
	query = strings.TrimSpace(query)
	matched := make([]Group, 0, len(groups))
	for _, group := range groups {
		if state != "" && group.State != state {
			continue
		}
		if query != "" && group.ID != query && group.TencentGroupID != query && group.OwnerLightVelaUserID != query &&
			group.OwnerAccountID != query && !strings.Contains(strings.ToLower(group.Name), strings.ToLower(query)) {
			continue
		}
		matched = append(matched, group)
	}
	sort.SliceStable(matched, func(i, j int) bool { return matched[i].CreatedAt.After(matched[j].CreatedAt) })
	return page(matched, limit, offset), len(matched), nil
}

func (s *Service) Group(ctx context.Context, groupID string) (Group, []Member, error) {
	groups, err := s.reader.Groups(ctx, MaxScanRows)
	if err != nil {
		return Group{}, nil, internal(err)
	}
	for _, group := range groups {
		if group.ID != groupID {
			continue
		}
		members, err := s.reader.GroupMembers(ctx, groupID)
		if err != nil {
			return Group{}, nil, internal(err)
		}
		return group, members, nil
	}
	return Group{}, nil, apperror.New("im_group_not_found", "平台群不存在", nil)
}

// Restrict 限制或解除一个 IM 身份；限制时立即使其腾讯登录态失效。
func (s *Service) Restrict(ctx context.Context, userID string, restricted bool) (Identity, error) {
	var at *time.Time
	if restricted {
		now := s.now().UTC()
		at = &now
	}
	if _, err := s.routes.SetRouteRestricted(ctx, userID, at); err != nil {
		if errors.Is(err, botimport.ErrNotFound) {
			return Identity{}, apperror.New("im_identity_unknown", "平台没有这个 IM 身份", err)
		}
		return Identity{}, internal(err)
	}
	if restricted {
		if err := s.identities.KickIdentity(ctx, userID); err != nil {
			return Identity{}, apperror.New("tencent_unavailable", "已限制，但腾讯登录态下线失败，请重试", err)
		}
	}
	identities, _, err := s.ListIdentities(ctx, userID, "", 1, 0)
	if err != nil {
		return Identity{}, err
	}
	if len(identities) == 0 {
		return Identity{}, apperror.New("im_identity_unknown", "平台没有这个 IM 身份", nil)
	}
	return identities[0], nil
}

func (s *Service) DismissGroup(ctx context.Context, groupID string) error {
	return s.groups.AdminDismiss(ctx, groupID)
}

// DisableBot 与用户删除 Bot 相同：下线、删除腾讯账号、吊销凭据。
func (s *Service) DisableBot(ctx context.Context, accountID, botAgentID string) error {
	subject, err := s.reader.AccountSubject(ctx, accountID)
	if err != nil {
		return internal(err)
	}
	return s.bots.AdminDelete(ctx, accountID, subject, botAgentID)
}

// CheckTencent 逐批核对平台记录的账号是否存在于腾讯。
func (s *Service) CheckTencent(ctx context.Context) (Check, error) {
	identities, err := s.reader.Identities(ctx, MaxScanRows)
	if err != nil {
		return Check{}, internal(err)
	}
	userIDs := make([]string, 0, len(identities))
	for _, identity := range identities {
		userIDs = append(userIDs, identity.UserID)
	}
	imported, err := s.identities.CheckIdentities(ctx, userIDs)
	if err != nil {
		return Check{}, apperror.New("tencent_unavailable", "暂时无法向腾讯核对账号", err)
	}
	check := Check{Checked: len(identities), Mismatches: []Mismatch{}}
	for _, identity := range identities {
		present := imported[identity.UserID]
		if present {
			check.Imported++
		}
		expected := ""
		switch {
		case identity.State == "ready":
			expected = "present"
		case identity.Kind == botimport.IdentityKindBot && identity.State == botimport.BotStateDeleted:
			expected = "absent"
		}
		if expected == "present" && !present || expected == "absent" && present {
			tencent := "missing"
			if present {
				tencent = "imported"
			}
			check.Mismatches = append(check.Mismatches, Mismatch{
				UserID: identity.UserID, Kind: identity.Kind, State: identity.State, Expected: expected, Tencent: tencent,
			})
		}
	}
	return check, nil
}

func page[T any](items []T, limit, offset int) []T {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 || offset >= len(items) {
		return []T{}
	}
	end := offset + limit
	if end > len(items) {
		end = len(items)
	}
	return items[offset:end]
}

func internal(err error) error {
	return apperror.New("internal_error", "暂时无法读取 IM 运营数据", err)
}
