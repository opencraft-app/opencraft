// Package runtimedirectory reads the current Agent's authorized Server directory from Ent.
package runtimedirectory

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/account"
	agententity "chatserver/internal/ent/agent"
	channelentity "chatserver/internal/ent/channel"
	"chatserver/internal/ent/channelmember"
	"chatserver/internal/ent/member"
	"chatserver/internal/ent/server"
	directoryport "chatserver/internal/ports/runtimedirectory"
)

const (
	directoryChannelLimit = 1000
	directoryMemberLimit  = 10000
)

type EntRepository struct{ handle *database.Handle }

func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Runtime 目录 Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

func (repository *EntRepository) Get(
	ctx context.Context,
	serverID string,
	agentID string,
) (directoryport.Snapshot, error) {
	client := repository.handle.Client()
	serverEntity, err := client.Server.Query().
		Where(server.IDEQ(serverID)).
		Only(ctx)
	if ent.IsNotFound(err) {
		return directoryport.Snapshot{}, directoryport.ErrNotFound
	}
	if err != nil {
		return directoryport.Snapshot{}, err
	}
	selfMember, err := client.Member.Query().Where(
		member.IDEQ(agentID),
		member.ServerIDEQ(serverID),
		member.KindEQ("agent"),
		member.StatusEQ("active"),
		member.ImStateEQ("ready"),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return directoryport.Snapshot{}, directoryport.ErrNotFound
	}
	if err != nil {
		return directoryport.Snapshot{}, err
	}
	selfAgent, err := client.Agent.Query().Where(
		agententity.IDEQ(agentID),
		agententity.ServerIDEQ(serverID),
		agententity.ImStateEQ("ready"),
		agententity.DeletedAtIsNil(),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return directoryport.Snapshot{}, directoryport.ErrNotFound
	}
	if err != nil {
		return directoryport.Snapshot{}, err
	}

	channels, err := repository.listChannels(ctx, serverID, agentID)
	if err != nil {
		return directoryport.Snapshot{}, err
	}
	members, err := repository.listMembers(ctx, serverID)
	if err != nil {
		return directoryport.Snapshot{}, err
	}
	snapshot := directoryport.Snapshot{
		Server: directoryport.Server{
			ID: serverEntity.ID, Slug: serverEntity.Slug, Name: serverEntity.Name,
		},
		Self: directoryport.Self{
			AgentID: agentID, MemberID: selfMember.ID,
			Handle: selfMember.Handle, DisplayName: selfMember.DisplayName,
			IMUserID: selfAgent.ImUserID,
		},
		Channels: channels,
		Members:  members,
	}
	snapshot.Revision = directoryRevision(serverEntity.Revision, snapshot)
	return snapshot, nil
}

func (repository *EntRepository) GetChannelMembers(
	ctx context.Context,
	serverID string,
	agentID string,
	channelID string,
) (directoryport.ChannelMembersSnapshot, error) {
	client := repository.handle.Client()
	if err := repository.requireCurrentAgent(ctx, serverID, agentID); err != nil {
		return directoryport.ChannelMembersSnapshot{}, err
	}
	channel, err := client.Channel.Query().Where(
		channelentity.IDEQ(channelID),
		channelentity.ServerIDEQ(serverID),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return directoryport.ChannelMembersSnapshot{}, directoryport.ErrNotFound
	}
	if err != nil {
		return directoryport.ChannelMembersSnapshot{}, err
	}

	var memberIDs []string
	root := channel.SystemKey != nil && *channel.SystemKey == "all"
	if !root {
		memberships, err := client.ChannelMember.Query().Where(
			channelmember.ServerIDEQ(serverID),
			channelmember.ChannelIDEQ(channelID),
			channelmember.StateEQ("active"),
			channelmember.ImStateEQ("ready"),
		).All(ctx)
		if err != nil {
			return directoryport.ChannelMembersSnapshot{}, err
		}
		allowed := false
		for _, value := range memberships {
			memberIDs = append(memberIDs, value.MemberID)
			if value.MemberID == agentID {
				allowed = true
			}
		}
		if !allowed {
			return directoryport.ChannelMembersSnapshot{}, directoryport.ErrNotFound
		}
	}
	members, err := repository.listMembersByIDs(ctx, serverID, memberIDs)
	if err != nil {
		return directoryport.ChannelMembersSnapshot{}, err
	}
	result := directoryport.ChannelMembersSnapshot{
		Channel: directoryport.Channel{
			ID: channel.ID, Name: channel.Name, Visibility: channel.Visibility,
			Joined: true, IMGroupID: channel.ImGroupID,
			IMTopicID: channel.ImTopicID, IMState: channel.ImState,
			Revision: channel.Revision,
		},
		Members: members,
	}
	result.Revision = channelMembersRevision(serverID, result)
	return result, nil
}

func (repository *EntRepository) requireCurrentAgent(
	ctx context.Context,
	serverID string,
	agentID string,
) error {
	client := repository.handle.Client()
	exists, err := client.Member.Query().Where(
		member.IDEQ(agentID),
		member.ServerIDEQ(serverID),
		member.KindEQ("agent"),
		member.StatusEQ("active"),
		member.ImStateEQ("ready"),
	).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return directoryport.ErrNotFound
	}
	exists, err = client.Agent.Query().Where(
		agententity.IDEQ(agentID),
		agententity.ServerIDEQ(serverID),
		agententity.ImStateEQ("ready"),
		agententity.DeletedAtIsNil(),
	).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return directoryport.ErrNotFound
	}
	return nil
}

func (repository *EntRepository) listChannels(
	ctx context.Context,
	serverID string,
	agentID string,
) ([]directoryport.Channel, error) {
	client := repository.handle.Client()
	memberships, err := client.ChannelMember.Query().Where(
		channelmember.ServerIDEQ(serverID),
		channelmember.MemberIDEQ(agentID),
		channelmember.StateEQ("active"),
		channelmember.ImStateEQ("ready"),
	).All(ctx)
	if err != nil {
		return nil, err
	}
	joined := make(map[string]struct{}, len(memberships))
	privateIDs := make([]string, 0, len(memberships))
	for _, value := range memberships {
		joined[value.ChannelID] = struct{}{}
		privateIDs = append(privateIDs, value.ChannelID)
	}
	query := client.Channel.Query().Where(channelentity.ServerIDEQ(serverID))
	if len(privateIDs) == 0 {
		query = query.Where(channelentity.SystemKeyEQ("all"))
	} else {
		query = query.Where(channelentity.Or(
			channelentity.SystemKeyEQ("all"),
			channelentity.IDIn(privateIDs...),
		))
	}
	entities, err := query.Order(ent.Asc(channelentity.FieldID)).
		Limit(directoryChannelLimit + 1).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(entities) > directoryChannelLimit {
		return nil, directoryport.ErrTooLarge
	}
	result := make([]directoryport.Channel, 0, len(entities))
	for _, value := range entities {
		_, explicitlyJoined := joined[value.ID]
		result = append(result, directoryport.Channel{
			ID: value.ID, Name: value.Name, Visibility: value.Visibility,
			Joined:    value.SystemKey != nil && *value.SystemKey == "all" || explicitlyJoined,
			IMGroupID: value.ImGroupID, IMTopicID: value.ImTopicID,
			IMState: value.ImState, Revision: value.Revision,
		})
	}
	return result, nil
}

func (repository *EntRepository) listMembers(
	ctx context.Context,
	serverID string,
) ([]directoryport.Member, error) {
	return repository.listMembersByIDs(ctx, serverID, nil)
}

func (repository *EntRepository) listMembersByIDs(
	ctx context.Context,
	serverID string,
	memberIDs []string,
) ([]directoryport.Member, error) {
	client := repository.handle.Client()
	query := client.Member.Query().Where(
		member.ServerIDEQ(serverID),
		member.StatusEQ("active"),
		member.ImStateEQ("ready"),
	)
	if memberIDs != nil {
		if len(memberIDs) == 0 {
			return []directoryport.Member{}, nil
		}
		query = query.Where(member.IDIn(memberIDs...))
	}
	entities, err := query.Order(ent.Asc(member.FieldID)).
		Limit(directoryMemberLimit + 1).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(entities) > directoryMemberLimit {
		return nil, directoryport.ErrTooLarge
	}
	accountIDs := make([]string, 0)
	agentIDs := make([]string, 0)
	for _, value := range entities {
		if value.Kind == "human" && value.AccountID != nil {
			accountIDs = append(accountIDs, *value.AccountID)
		}
		if value.Kind == "agent" {
			agentIDs = append(agentIDs, value.ID)
		}
	}
	accountRoutes := make(map[string]string, len(accountIDs))
	if len(accountIDs) > 0 {
		values, err := client.Account.Query().Where(
			account.IDIn(accountIDs...),
			account.ImStateEQ("ready"),
		).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, value := range values {
			accountRoutes[value.ID] = value.ImUserID
		}
	}
	agentRoutes := make(map[string]string, len(agentIDs))
	if len(agentIDs) > 0 {
		values, err := client.Agent.Query().Where(
			agententity.ServerIDEQ(serverID),
			agententity.IDIn(agentIDs...),
			agententity.ImStateEQ("ready"),
			agententity.DeletedAtIsNil(),
		).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, value := range values {
			agentRoutes[value.ID] = value.ImUserID
		}
	}
	result := make([]directoryport.Member, 0, len(entities))
	for _, value := range entities {
		entry := directoryport.Member{
			MemberID: value.ID, Kind: value.Kind,
			Handle: value.Handle, DisplayName: value.DisplayName,
		}
		switch value.Kind {
		case "human":
			if value.AccountID == nil {
				continue
			}
			entry.IMUserID = accountRoutes[*value.AccountID]
			if entry.IMUserID == "" {
				continue
			}
			humanID := *value.AccountID
			entry.HumanID = &humanID
		case "agent":
			entry.IMUserID = agentRoutes[value.ID]
			if entry.IMUserID == "" {
				continue
			}
			agentID := value.ID
			entry.AgentID = &agentID
		default:
			continue
		}
		result = append(result, entry)
	}
	return result, nil
}

func channelMembersRevision(
	serverID string,
	value directoryport.ChannelMembersSnapshot,
) string {
	return directoryRevision(0, directoryport.Snapshot{
		Server:   directoryport.Server{ID: serverID},
		Channels: []directoryport.Channel{value.Channel},
		Members:  value.Members,
	})
}

func directoryRevision(serverRevision int64, value directoryport.Snapshot) string {
	digest := sha256.New()
	_, _ = fmt.Fprintf(digest, "server\x00%s\x00%d\x00", value.Server.ID, serverRevision)
	channels := append([]directoryport.Channel(nil), value.Channels...)
	sort.Slice(channels, func(i, j int) bool { return channels[i].ID < channels[j].ID })
	for _, channel := range channels {
		_, _ = fmt.Fprintf(
			digest, "channel\x00%s\x00%d\x00%t\x00%s\x00",
			channel.ID, channel.Revision, channel.Joined, channel.IMState,
		)
	}
	members := append([]directoryport.Member(nil), value.Members...)
	sort.Slice(members, func(i, j int) bool { return members[i].MemberID < members[j].MemberID })
	for _, member := range members {
		_, _ = fmt.Fprintf(
			digest, "member\x00%s\x00%s\x00%s\x00",
			member.MemberID, member.Kind, member.IMUserID,
		)
	}
	return "sha256:" + hex.EncodeToString(digest.Sum(nil))
}

var _ directoryport.Repository = (*EntRepository)(nil)
