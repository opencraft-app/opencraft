// Package imadmin 用 Ent 实现管理后台的 IM 运营只读查询。
package imadmin

import (
	"context"
	"errors"
	"time"

	"git.woa.com/wisp/mono2/collaboration/internal/app/imadmin"
	"git.woa.com/wisp/mono2/collaboration/internal/database"
	"git.woa.com/wisp/mono2/collaboration/internal/ent"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/account"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/accountloginidentity"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/botagent"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/imgroupmember"
	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
)

// EntReader 扫描账号、Bot、路由与平台群；只用于低频运营查询。
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

func (r *EntReader) subjects(ctx context.Context, limit int) (map[string]string, error) {
	logins, err := r.handle.Client().AccountLoginIdentity.Query().
		Where(accountloginidentity.StateEQ("active")).Limit(limit).All(ctx)
	if err != nil {
		return nil, err
	}
	subjects := make(map[string]string, len(logins))
	for _, login := range logins {
		subjects[login.AccountID] = login.NormalizedLogin
	}
	return subjects, nil
}

func (r *EntReader) Identities(ctx context.Context, limit int) ([]imadmin.Identity, error) {
	client := r.handle.Client()
	subjects, err := r.subjects(ctx, limit)
	if err != nil {
		return nil, err
	}
	routes, err := client.IMIdentityRoute.Query().Limit(limit).All(ctx)
	if err != nil {
		return nil, err
	}
	restricted := make(map[string]*ent.IMIdentityRoute, len(routes))
	for _, route := range routes {
		restricted[route.ImUserID] = route
	}
	restrictedAt := func(userID string) *time.Time {
		if route := restricted[userID]; route != nil {
			return route.RestrictedAt
		}
		return nil
	}
	humans, err := client.Account.Query().Where(account.ImUserIDNEQ("")).Limit(limit).All(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]imadmin.Identity, 0, len(humans))
	for _, human := range humans {
		result = append(result, imadmin.Identity{
			UserID: human.ImUserID, Kind: botimport.IdentityKindHuman, State: human.ImState, DisplayName: humanName(subjects[human.ID], human.DisplayName),
			AccountID: human.ID, LightVelaUserID: subjects[human.ID], RestrictedAt: restrictedAt(human.ImUserID), CreatedAt: human.CreatedAt,
		})
	}
	bots, err := client.BotAgent.Query().Limit(limit).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, bot := range bots {
		result = append(result, imadmin.Identity{
			UserID: bot.ImUserID, Kind: botimport.IdentityKindBot, State: bot.State, DisplayName: bot.DisplayName,
			AccountID: bot.AccountID, LightVelaUserID: subjects[bot.AccountID], BotAgentID: bot.ID,
			InstanceID: bot.InstanceID, BotID: bot.BotID, RestrictedAt: restrictedAt(bot.ImUserID), CreatedAt: bot.CreatedAt,
		})
	}
	return result, nil
}

func (r *EntReader) Groups(ctx context.Context, limit int) ([]imadmin.Group, error) {
	client := r.handle.Client()
	subjects, err := r.subjects(ctx, limit)
	if err != nil {
		return nil, err
	}
	groups, err := client.IMGroup.Query().Limit(limit).All(ctx)
	if err != nil {
		return nil, err
	}
	members, err := client.IMGroupMember.Query().
		Where(imgroupmember.StateEQ(botimport.MemberStateActive)).Limit(limit * 10).All(ctx)
	if err != nil {
		return nil, err
	}
	counts := make(map[string]int, len(groups))
	for _, member := range members {
		counts[member.GroupID]++
	}
	result := make([]imadmin.Group, 0, len(groups))
	for _, group := range groups {
		result = append(result, imadmin.Group{
			ID: group.ID, TencentGroupID: group.TencentGroupID, Name: group.Name,
			OwnerAccountID: group.OwnerAccountID, OwnerLightVelaUserID: subjects[group.OwnerAccountID],
			CreatedByUserID: group.CreatedByImUserID, ReplyMode: group.ReplyMode, State: group.State,
			MemberCount: counts[group.ID], CreatedAt: group.CreatedAt,
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
		accountIDs := make([]string, 0, len(humans))
		for _, human := range humans {
			accountIDs = append(accountIDs, human.ID)
		}
		subjects := map[string]string{}
		if len(accountIDs) > 0 {
			logins, err := client.AccountLoginIdentity.Query().
				Where(accountloginidentity.AccountIDIn(accountIDs...), accountloginidentity.StateEQ("active")).All(ctx)
			if err != nil {
				return nil, err
			}
			for _, login := range logins {
				subjects[login.AccountID] = login.NormalizedLogin
			}
		}
		for _, human := range humans {
			names[human.ImUserID] = humanName(subjects[human.ID], human.DisplayName)
		}
		bots, err := client.BotAgent.Query().Where(botagent.ImUserIDIn(userIDs...)).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, bot := range bots {
			names[bot.ImUserID] = bot.DisplayName
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
