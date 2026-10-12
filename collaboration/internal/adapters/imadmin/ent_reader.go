// Package imadmin 用 Ent 实现管理后台的 IM 运营只读查询。
//
// 筛选、计数和分页都在数据库里完成。人类和 Bot 在两张表里：按类型筛选时直接分页；不筛选类型时两表各取前
// offset+limit 个排序键合并，再只读取当前页的完整行。两表都按 (created_at, im_user_id) 倒序，合并结果与
// 单表顺序一致。
package imadmin

import (
	"context"
	"errors"
	"sort"
	"time"

	"git.woa.com/wisp/mono2/collaboration/internal/app/imadmin"
	"git.woa.com/wisp/mono2/collaboration/internal/database"
	"git.woa.com/wisp/mono2/collaboration/internal/ent"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/account"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/accountloginidentity"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/botagent"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/imgroup"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/imgroupmember"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/imidentityroute"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/predicate"
	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
)

// maxSubjectMatches 限制一次 usr_ 精确匹配解析出的账号数；一个 usr_ 只对应一个账号。
const maxSubjectMatches = 10

// EntReader 读取账号、Bot、路由与平台群。
type EntReader struct {
	handle *database.Handle
}

func NewEntReader(handle *database.Handle) (*EntReader, error) {
	if handle == nil {
		return nil, errors.New("数据库句柄不能为空")
	}
	return &EntReader{handle: handle}, nil
}

var _ imadmin.Reader = (*EntReader)(nil)

func (r *EntReader) Summary(ctx context.Context) (imadmin.Summary, error) {
	client := r.handle.Client()
	var summary imadmin.Summary
	humans := client.Account.Query().Where(account.ImUserIDNEQ(""))
	total, err := humans.Clone().Count(ctx)
	if err != nil {
		return summary, err
	}
	if summary.HumansReady, err = humans.Where(account.ImStateEQ("ready")).Count(ctx); err != nil {
		return summary, err
	}
	summary.HumansPending = total - summary.HumansReady
	bots, err := countByState(ctx, client.BotAgent.Query().GroupBy(botagent.FieldState).Aggregate(ent.Count()).Scan)
	if err != nil {
		return summary, err
	}
	for state, count := range bots {
		switch state {
		case botimport.BotStateReady:
			summary.BotsReady += count
		case botimport.BotStateProvisioning:
			summary.BotsProvisioning += count
		case botimport.BotStateDeleted:
			summary.BotsDeleted += count
		default:
			summary.BotsError += count
		}
	}
	groups, err := countByState(ctx, client.IMGroup.Query().GroupBy(imgroup.FieldState).Aggregate(ent.Count()).Scan)
	if err != nil {
		return summary, err
	}
	summary.GroupsActive = groups[botimport.GroupStateActive]
	summary.GroupsDismissed = groups[botimport.GroupStateDismissed]
	summary.Restricted, err = client.IMIdentityRoute.Query().Where(imidentityroute.RestrictedAtNotNil()).Count(ctx)
	return summary, err
}

// countByState 读取按 state 分组的计数。
func countByState(ctx context.Context, scan func(context.Context, any) error) (map[string]int, error) {
	var rows []struct {
		Key   string `json:"state"`
		Count int    `json:"count"`
	}
	if err := scan(ctx, &rows); err != nil {
		return nil, err
	}
	counts := make(map[string]int, len(rows))
	for _, row := range rows {
		counts[row.Key] = row.Count
	}
	return counts, nil
}

// sortKey 是两张身份表共同的排序键。
type sortKey struct {
	userID    string
	createdAt time.Time
	human     bool
}

func newer(a, b sortKey) bool {
	if !a.createdAt.Equal(b.createdAt) {
		return a.createdAt.After(b.createdAt)
	}
	return a.userID > b.userID
}

func (r *EntReader) Identities(ctx context.Context, filter imadmin.IdentityFilter) ([]imadmin.Identity, int, error) {
	owners, err := r.subjectAccounts(ctx, filter.Query)
	if err != nil {
		return nil, 0, err
	}
	withHumans := filter.Kind == "" || filter.Kind == botimport.IdentityKindHuman
	withBots := filter.Kind == "" || filter.Kind == botimport.IdentityKindBot
	single := withHumans != withBots
	skip, take := filter.Offset, filter.Limit
	if !single {
		skip, take = 0, filter.Offset+filter.Limit
	}

	var keys []sortKey
	total := 0
	if withHumans {
		query := r.humans(filter.Query, owners)
		count, err := query.Clone().Count(ctx)
		if err != nil {
			return nil, 0, err
		}
		rows, err := query.Order(ent.Desc(account.FieldCreatedAt), ent.Desc(account.FieldImUserID)).
			Offset(skip).Limit(take).Select(account.FieldImUserID, account.FieldCreatedAt).All(ctx)
		if err != nil {
			return nil, 0, err
		}
		total += count
		for _, row := range rows {
			keys = append(keys, sortKey{userID: row.ImUserID, createdAt: row.CreatedAt, human: true})
		}
	}
	if withBots {
		query := r.bots(filter.Query, owners)
		count, err := query.Clone().Count(ctx)
		if err != nil {
			return nil, 0, err
		}
		rows, err := query.Order(ent.Desc(botagent.FieldCreatedAt), ent.Desc(botagent.FieldImUserID)).
			Offset(skip).Limit(take).Select(botagent.FieldImUserID, botagent.FieldCreatedAt).All(ctx)
		if err != nil {
			return nil, 0, err
		}
		total += count
		for _, row := range rows {
			keys = append(keys, sortKey{userID: row.ImUserID, createdAt: row.CreatedAt})
		}
	}
	if !single {
		sort.SliceStable(keys, func(i, j int) bool { return newer(keys[i], keys[j]) })
		if filter.Offset >= len(keys) {
			keys = nil
		} else {
			keys = keys[filter.Offset:min(len(keys), filter.Offset+filter.Limit)]
		}
	}

	var humanIDs, botIDs []string
	for _, key := range keys {
		if key.human {
			humanIDs = append(humanIDs, key.userID)
		} else {
			botIDs = append(botIDs, key.userID)
		}
	}
	client := r.handle.Client()
	var humans []*ent.Account
	if len(humanIDs) > 0 {
		if humans, err = client.Account.Query().Where(account.ImUserIDIn(humanIDs...)).All(ctx); err != nil {
			return nil, 0, err
		}
	}
	var bots []*ent.BotAgent
	if len(botIDs) > 0 {
		if bots, err = client.BotAgent.Query().Where(botagent.ImUserIDIn(botIDs...)).All(ctx); err != nil {
			return nil, 0, err
		}
	}
	identities, err := r.identities(ctx, humans, bots)
	if err != nil {
		return nil, 0, err
	}
	byUserID := make(map[string]imadmin.Identity, len(identities))
	for _, identity := range identities {
		byUserID[identity.UserID] = identity
	}
	page := make([]imadmin.Identity, 0, len(keys))
	for _, key := range keys {
		if identity, ok := byUserID[key.userID]; ok {
			page = append(page, identity)
		}
	}
	return page, total, nil
}

func (r *EntReader) humans(query string, owners []string) *ent.AccountQuery {
	humans := r.handle.Client().Account.Query().Where(account.ImUserIDNEQ(""))
	if query == "" {
		return humans
	}
	match := []predicate.Account{account.ImUserIDEQ(query), account.IDEQ(query), account.DisplayNameContainsFold(query)}
	if len(owners) > 0 {
		match = append(match, account.IDIn(owners...))
	}
	return humans.Where(account.Or(match...))
}

func (r *EntReader) bots(query string, owners []string) *ent.BotAgentQuery {
	bots := r.handle.Client().BotAgent.Query()
	if query == "" {
		return bots
	}
	match := []predicate.BotAgent{
		botagent.ImUserIDEQ(query), botagent.IDEQ(query), botagent.AccountIDEQ(query), botagent.DisplayNameContainsFold(query),
	}
	if len(owners) > 0 {
		match = append(match, botagent.AccountIDIn(owners...))
	}
	return bots.Where(botagent.Or(match...))
}

// subjectAccounts 把 usr_ 精确解析为账号 ID。
func (r *EntReader) subjectAccounts(ctx context.Context, query string) ([]string, error) {
	if query == "" {
		return nil, nil
	}
	logins, err := r.handle.Client().AccountLoginIdentity.Query().
		Where(accountloginidentity.NormalizedLoginEQ(query), accountloginidentity.StateEQ("active")).
		Limit(maxSubjectMatches).All(ctx)
	if err != nil {
		return nil, err
	}
	accountIDs := make([]string, 0, len(logins))
	for _, login := range logins {
		accountIDs = append(accountIDs, login.AccountID)
	}
	return accountIDs, nil
}

func (r *EntReader) EachIdentity(ctx context.Context, batch int, visit func([]imadmin.Identity) error) error {
	client := r.handle.Client()
	for after := ""; ; {
		humans, err := client.Account.Query().Where(account.ImUserIDGT(after)).
			Order(ent.Asc(account.FieldImUserID)).Limit(batch).All(ctx)
		if err != nil {
			return err
		}
		if len(humans) == 0 {
			break
		}
		if err := r.visit(ctx, humans, nil, visit); err != nil {
			return err
		}
		after = humans[len(humans)-1].ImUserID
	}
	for after := ""; ; {
		bots, err := client.BotAgent.Query().Where(botagent.ImUserIDGT(after)).
			Order(ent.Asc(botagent.FieldImUserID)).Limit(batch).All(ctx)
		if err != nil {
			return err
		}
		if len(bots) == 0 {
			return nil
		}
		if err := r.visit(ctx, nil, bots, visit); err != nil {
			return err
		}
		after = bots[len(bots)-1].ImUserID
	}
}

func (r *EntReader) visit(
	ctx context.Context, humans []*ent.Account, bots []*ent.BotAgent, visit func([]imadmin.Identity) error,
) error {
	identities, err := r.identities(ctx, humans, bots)
	if err != nil {
		return err
	}
	return visit(identities)
}

// identities 补上 usr_ 与限制状态，把账号和 Bot 行转换为运营视图。
func (r *EntReader) identities(ctx context.Context, humans []*ent.Account, bots []*ent.BotAgent) ([]imadmin.Identity, error) {
	accountIDs := make([]string, 0, len(humans)+len(bots))
	userIDs := make([]string, 0, len(humans)+len(bots))
	for _, human := range humans {
		accountIDs = append(accountIDs, human.ID)
		userIDs = append(userIDs, human.ImUserID)
	}
	for _, bot := range bots {
		accountIDs = append(accountIDs, bot.AccountID)
		userIDs = append(userIDs, bot.ImUserID)
	}
	subjects, err := r.subjects(ctx, accountIDs)
	if err != nil {
		return nil, err
	}
	restricted := map[string]*time.Time{}
	if len(userIDs) > 0 {
		routes, err := r.handle.Client().IMIdentityRoute.Query().
			Where(imidentityroute.ImUserIDIn(userIDs...), imidentityroute.RestrictedAtNotNil()).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, route := range routes {
			restricted[route.ImUserID] = route.RestrictedAt
		}
	}
	result := make([]imadmin.Identity, 0, len(humans)+len(bots))
	for _, human := range humans {
		result = append(result, imadmin.Identity{
			UserID: human.ImUserID, Kind: botimport.IdentityKindHuman, State: human.ImState,
			DisplayName: humanName(subjects[human.ID], human.DisplayName), AccountID: human.ID,
			LightVelaUserID: subjects[human.ID], RestrictedAt: restricted[human.ImUserID], CreatedAt: human.CreatedAt,
		})
	}
	for _, bot := range bots {
		result = append(result, imadmin.Identity{
			UserID: bot.ImUserID, Kind: botimport.IdentityKindBot, State: bot.State, DisplayName: bot.DisplayName,
			AccountID: bot.AccountID, LightVelaUserID: subjects[bot.AccountID], BotAgentID: bot.ID,
			InstanceID: bot.InstanceID, BotID: bot.BotID, RestrictedAt: restricted[bot.ImUserID], CreatedAt: bot.CreatedAt,
		})
	}
	return result, nil
}

// subjects 返回账号 ID 到 usr_ 的映射。
func (r *EntReader) subjects(ctx context.Context, accountIDs []string) (map[string]string, error) {
	subjects := map[string]string{}
	if len(accountIDs) == 0 {
		return subjects, nil
	}
	logins, err := r.handle.Client().AccountLoginIdentity.Query().
		Where(accountloginidentity.AccountIDIn(accountIDs...), accountloginidentity.StateEQ("active")).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, login := range logins {
		subjects[login.AccountID] = login.NormalizedLogin
	}
	return subjects, nil
}

func (r *EntReader) Groups(ctx context.Context, filter imadmin.GroupFilter) ([]imadmin.Group, int, error) {
	query := r.handle.Client().IMGroup.Query()
	if filter.State != "" {
		query = query.Where(imgroup.StateEQ(filter.State))
	}
	if filter.Query != "" {
		owners, err := r.subjectAccounts(ctx, filter.Query)
		if err != nil {
			return nil, 0, err
		}
		match := []predicate.IMGroup{
			imgroup.IDEQ(filter.Query), imgroup.TencentGroupIDEQ(filter.Query),
			imgroup.OwnerAccountIDEQ(filter.Query), imgroup.NameContainsFold(filter.Query),
		}
		if len(owners) > 0 {
			match = append(match, imgroup.OwnerAccountIDIn(owners...))
		}
		query = query.Where(imgroup.Or(match...))
	}
	total, err := query.Clone().Count(ctx)
	if err != nil {
		return nil, 0, err
	}
	rows, err := query.Order(ent.Desc(imgroup.FieldCreatedAt), ent.Desc(imgroup.FieldID)).
		Offset(filter.Offset).Limit(filter.Limit).All(ctx)
	if err != nil {
		return nil, 0, err
	}
	groups, err := r.groups(ctx, rows)
	return groups, total, err
}

func (r *EntReader) Group(ctx context.Context, groupID string) (imadmin.Group, bool, error) {
	row, err := r.handle.Client().IMGroup.Get(ctx, groupID)
	if ent.IsNotFound(err) {
		return imadmin.Group{}, false, nil
	}
	if err != nil {
		return imadmin.Group{}, false, err
	}
	groups, err := r.groups(ctx, []*ent.IMGroup{row})
	if err != nil {
		return imadmin.Group{}, false, err
	}
	return groups[0], true, nil
}

// groups 补上群主 usr_ 与在群人数。
func (r *EntReader) groups(ctx context.Context, rows []*ent.IMGroup) ([]imadmin.Group, error) {
	groupIDs := make([]string, 0, len(rows))
	owners := make([]string, 0, len(rows))
	for _, row := range rows {
		groupIDs = append(groupIDs, row.ID)
		owners = append(owners, row.OwnerAccountID)
	}
	subjects, err := r.subjects(ctx, owners)
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	if len(groupIDs) > 0 {
		var members []struct {
			GroupID string `json:"group_id"`
			Count   int    `json:"count"`
		}
		err := r.handle.Client().IMGroupMember.Query().
			Where(imgroupmember.GroupIDIn(groupIDs...), imgroupmember.StateEQ(botimport.MemberStateActive)).
			GroupBy(imgroupmember.FieldGroupID).Aggregate(ent.Count()).Scan(ctx, &members)
		if err != nil {
			return nil, err
		}
		for _, member := range members {
			counts[member.GroupID] = member.Count
		}
	}
	result := make([]imadmin.Group, 0, len(rows))
	for _, row := range rows {
		result = append(result, imadmin.Group{
			ID: row.ID, TencentGroupID: row.TencentGroupID, Name: row.Name,
			OwnerAccountID: row.OwnerAccountID, OwnerLightVelaUserID: subjects[row.OwnerAccountID],
			CreatedByUserID: row.CreatedByImUserID, ReplyMode: row.ReplyMode, State: row.State,
			MemberCount: counts[row.ID], CreatedAt: row.CreatedAt,
		})
	}
	return result, nil
}

func (r *EntReader) GroupMembers(ctx context.Context, groupID string) ([]imadmin.Member, error) {
	client := r.handle.Client()
	members, err := client.IMGroupMember.Query().Where(imgroupmember.GroupIDEQ(groupID)).All(ctx)
	if err != nil {
		return nil, err
	}
	names := map[string]string{}
	userIDs := make([]string, 0, len(members))
	for _, member := range members {
		userIDs = append(userIDs, member.ImUserID)
	}
	if len(userIDs) > 0 {
		humans, err := client.Account.Query().Where(account.ImUserIDIn(userIDs...)).All(ctx)
		if err != nil {
			return nil, err
		}
		bots, err := client.BotAgent.Query().Where(botagent.ImUserIDIn(userIDs...)).All(ctx)
		if err != nil {
			return nil, err
		}
		identities, err := r.identities(ctx, humans, bots)
		if err != nil {
			return nil, err
		}
		for _, identity := range identities {
			names[identity.UserID] = identity.DisplayName
		}
	}
	result := make([]imadmin.Member, 0, len(members))
	for _, member := range members {
		result = append(result, imadmin.Member{
			UserID: member.ImUserID, Kind: member.Kind, Role: member.Role, State: member.State, DisplayName: names[member.ImUserID],
		})
	}
	return result, nil
}

func (r *EntReader) AccountSubject(ctx context.Context, accountID string) (string, error) {
	login, err := r.handle.Client().AccountLoginIdentity.Query().
		Where(accountloginidentity.AccountIDEQ(accountID), accountloginidentity.StateEQ("active")).First(ctx)
	if ent.IsNotFound(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return login.NormalizedLogin, nil
}

// humanName 用 LightVela 用户 ID（usr_）标识人类：本地账号的显示名只是占位，运营需要能定位到具体的人。
func humanName(subject, displayName string) string {
	if subject != "" {
		return subject
	}
	return displayName
}
