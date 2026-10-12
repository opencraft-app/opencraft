// Package imadmin 是管理后台的 IM 运营能力：账号与群的查询、限制身份、解散群、停用 Bot、与腾讯核对。
//
// 列表、概览与核对都在数据库里筛选、计数和分页；写操作只定位单个 IM 身份、群或账号下的 Bot，
// 并复用用户侧相同的应用服务，保证效果与用户自己操作一致。
package imadmin

import (
	"context"
	"errors"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
)

const (
	defaultPageSize = 50
	maxPageSize     = 200
	checkBatchSize  = 100
)

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

// IdentityFilter 是账号列表的筛选与分页条件。
//
// Query 精确匹配 IM UserID、usr_、账号 ID 或 Bot ID，否则按显示名包含匹配；结果按创建时间倒序。
type IdentityFilter struct {
	Query, Kind   string
	Limit, Offset int
}

// GroupFilter 是群列表的筛选与分页条件。
//
// Query 精确匹配群 ID、腾讯 GroupId、群主账号或群主 usr_，否则按群名包含匹配；结果按创建时间倒序。
type GroupFilter struct {
	Query, State  string
	Limit, Offset int
}

// Reader 是运营查询的只读数据源；筛选、计数与分页都由数据源完成。
type Reader interface {
	Summary(context.Context) (Summary, error)
	Identities(context.Context, IdentityFilter) ([]Identity, int, error)
	// EachIdentity 按批次遍历全部 IM 身份，每批不超过 batch 个。
	EachIdentity(ctx context.Context, batch int, visit func([]Identity) error) error
	Groups(context.Context, GroupFilter) ([]Group, int, error)
	Group(context.Context, string) (Group, bool, error)
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
	summary, err := s.reader.Summary(ctx)
	if err != nil {
		return Summary{}, internal(err)
	}
	return summary, nil
}

func (s *Service) ListIdentities(ctx context.Context, query, kind string, limit, offset int) ([]Identity, int, error) {
	limit, offset = pageBounds(limit, offset)
	identities, total, err := s.reader.Identities(ctx, IdentityFilter{
		Query: strings.TrimSpace(query), Kind: kind, Limit: limit, Offset: offset,
	})
	if err != nil {
		return nil, 0, internal(err)
	}
	return identities, total, nil
}

func (s *Service) ListGroups(ctx context.Context, query, state string, limit, offset int) ([]Group, int, error) {
	limit, offset = pageBounds(limit, offset)
	groups, total, err := s.reader.Groups(ctx, GroupFilter{
		Query: strings.TrimSpace(query), State: state, Limit: limit, Offset: offset,
	})
	if err != nil {
		return nil, 0, internal(err)
	}
	return groups, total, nil
}

func (s *Service) Group(ctx context.Context, groupID string) (Group, []Member, error) {
	group, found, err := s.reader.Group(ctx, groupID)
	if err != nil {
		return Group{}, nil, internal(err)
	}
	if !found {
		return Group{}, nil, apperror.New("im_group_not_found", "平台群不存在", nil)
	}
	members, err := s.reader.GroupMembers(ctx, groupID)
	if err != nil {
		return Group{}, nil, internal(err)
	}
	return group, members, nil
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
	check := Check{Mismatches: []Mismatch{}}
	var tencentErr error
	err := s.reader.EachIdentity(ctx, checkBatchSize, func(identities []Identity) error {
		userIDs := make([]string, 0, len(identities))
		for _, identity := range identities {
			userIDs = append(userIDs, identity.UserID)
		}
		imported, err := s.identities.CheckIdentities(ctx, userIDs)
		if err != nil {
			tencentErr = err
			return err
		}
		for _, identity := range identities {
			check.Checked++
			if mismatch, ok := compare(identity, imported[identity.UserID]); ok {
				check.Mismatches = append(check.Mismatches, mismatch)
			}
			if imported[identity.UserID] {
				check.Imported++
			}
		}
		return nil
	})
	if tencentErr != nil {
		return Check{}, apperror.New("tencent_unavailable", "暂时无法向腾讯核对账号", tencentErr)
	}
	if err != nil {
		return Check{}, internal(err)
	}
	return check, nil
}

// compare 只判断平台明确知道状态的账号：就绪的应在腾讯，已删除的 Bot 不应在腾讯。
func compare(identity Identity, present bool) (Mismatch, bool) {
	expected := ""
	switch {
	case identity.State == "ready":
		expected = "present"
	case identity.Kind == botimport.IdentityKindBot && identity.State == botimport.BotStateDeleted:
		expected = "absent"
	}
	if expected == "present" && present || expected == "absent" && !present || expected == "" {
		return Mismatch{}, false
	}
	tencent := "missing"
	if present {
		tencent = "imported"
	}
	return Mismatch{UserID: identity.UserID, Kind: identity.Kind, State: identity.State, Expected: expected, Tencent: tencent}, true
}

func pageBounds(limit, offset int) (int, int) {
	if limit <= 0 || limit > maxPageSize {
		limit = defaultPageSize
	}
	if offset < 0 {
		offset = 0
	}
	return limit, offset
}

func internal(err error) error {
	return apperror.New("internal_error", "暂时无法读取 IM 运营数据", err)
}
