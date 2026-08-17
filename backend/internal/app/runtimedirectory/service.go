// Package runtimedirectory returns the current Agent's authorized collaboration directory.
package runtimedirectory

import (
	"context"
	"errors"
	"strings"
	"time"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	directoryport "chatserver/internal/ports/runtimedirectory"

	"github.com/google/uuid"
)

const (
	maximumDirectoryChannels = 1000
	maximumDirectoryMembers  = 10000
	maximumDirectoryDirects  = 10000
)

type Service struct {
	repository directoryport.Repository
	clock      clockport.Clock
	ttl        time.Duration
}

func NewService(
	repository directoryport.Repository,
	clock clockport.Clock,
	ttl time.Duration,
) (*Service, error) {
	if repository == nil || clock == nil || ttl <= 0 || ttl > 10*time.Minute {
		return nil, errors.New("Runtime 目录服务配置无效")
	}
	return &Service{repository: repository, clock: clock, ttl: ttl}, nil
}

func (service *Service) Get(
	ctx context.Context,
	serverID string,
	agentID string,
) (directoryport.Directory, error) {
	if !isUUIDv7(serverID) || !isUUIDv7(agentID) {
		return directoryport.Directory{},
			apperror.New("invalid_request", "Runtime 目录身份无效", nil)
	}
	snapshot, err := service.repository.Get(ctx, serverID, agentID)
	if err != nil {
		switch {
		case errors.Is(err, directoryport.ErrNotFound):
			return directoryport.Directory{}, apperror.New(
				"runtime_directory_not_found",
				"当前 Agent 的协作目录不存在",
				err,
			)
		case errors.Is(err, directoryport.ErrTooLarge):
			return directoryport.Directory{}, apperror.New(
				"runtime_directory_too_large",
				"当前 Server 的协作目录超过限制",
				err,
			)
		default:
			return directoryport.Directory{}, apperror.New(
				"internal_error",
				"暂时无法读取 Runtime 协作目录",
				err,
			)
		}
	}
	if !validSnapshot(snapshot, serverID, agentID) {
		return directoryport.Directory{}, apperror.New(
			"internal_error",
			"Runtime 协作目录数据无效",
			errors.New("invalid Runtime directory snapshot"),
		)
	}
	return directoryport.Directory{
		Server:   snapshot.Server,
		Self:     snapshot.Self,
		Channels: append([]directoryport.Channel(nil), snapshot.Channels...),
		Members:  append([]directoryport.Member(nil), snapshot.Members...),
		DirectConversations: append(
			[]directoryport.DirectConversation(nil),
			snapshot.DirectConversations...,
		),
		Revision:  snapshot.Revision,
		ExpiresAt: service.clock.Now().UTC().Add(service.ttl),
	}, nil
}

func (service *Service) GetChannelMembers(
	ctx context.Context,
	serverID string,
	agentID string,
	channelID string,
) (directoryport.ChannelMembers, error) {
	if !isUUIDv7(serverID) || !isUUIDv7(agentID) || !isUUIDv7(channelID) {
		return directoryport.ChannelMembers{},
			apperror.New("invalid_request", "Runtime Channel 身份无效", nil)
	}
	snapshot, err := service.repository.GetChannelMembers(
		ctx, serverID, agentID, channelID,
	)
	if err != nil {
		switch {
		case errors.Is(err, directoryport.ErrNotFound):
			return directoryport.ChannelMembers{}, apperror.New(
				"runtime_channel_not_found",
				"当前 Agent 无权查看该 Channel",
				err,
			)
		case errors.Is(err, directoryport.ErrTooLarge):
			return directoryport.ChannelMembers{}, apperror.New(
				"runtime_directory_too_large",
				"当前 Channel 的成员目录超过限制",
				err,
			)
		default:
			return directoryport.ChannelMembers{}, apperror.New(
				"internal_error",
				"暂时无法读取 Runtime Channel 成员",
				err,
			)
		}
	}
	if !validChannelMembersSnapshot(snapshot, channelID, agentID) {
		return directoryport.ChannelMembers{}, apperror.New(
			"internal_error",
			"Runtime Channel 成员数据无效",
			errors.New("invalid Runtime channel members snapshot"),
		)
	}
	return directoryport.ChannelMembers{
		Channel:   snapshot.Channel,
		Members:   append([]directoryport.Member(nil), snapshot.Members...),
		Revision:  snapshot.Revision,
		ExpiresAt: service.clock.Now().UTC().Add(service.ttl),
	}, nil
}

func validSnapshot(
	value directoryport.Snapshot,
	serverID string,
	agentID string,
) bool {
	if value.Server.ID != serverID || value.Self.AgentID != agentID ||
		value.Self.MemberID != agentID ||
		strings.TrimSpace(value.Server.Slug) == "" ||
		strings.TrimSpace(value.Server.Name) == "" ||
		strings.TrimSpace(value.Self.Handle) == "" ||
		strings.TrimSpace(value.Self.DisplayName) == "" ||
		strings.TrimSpace(value.Self.IMUserID) == "" ||
		strings.TrimSpace(value.Revision) == "" ||
		len(value.Channels) > maximumDirectoryChannels ||
		len(value.Members) > maximumDirectoryMembers ||
		len(value.DirectConversations) > maximumDirectoryDirects {
		return false
	}
	for _, channel := range value.Channels {
		if !isUUIDv7(channel.ID) || strings.TrimSpace(channel.Name) == "" ||
			(channel.Visibility != "public" && channel.Visibility != "private") ||
			strings.TrimSpace(channel.IMGroupID) == "" || channel.Revision < 0 {
			return false
		}
	}
	selfFound := false
	memberIDs := make(map[string]struct{}, len(value.Members))
	for _, member := range value.Members {
		if !validDirectoryMember(member) {
			return false
		}
		if member.MemberID == agentID && member.Kind == "agent" &&
			member.IMUserID == value.Self.IMUserID {
			selfFound = true
		}
		memberIDs[member.MemberID] = struct{}{}
	}
	directIDs := make(map[string]struct{}, len(value.DirectConversations))
	directPeers := make(map[string]struct{}, len(value.DirectConversations))
	for _, direct := range value.DirectConversations {
		if !isUUIDv7(direct.ID) || !isUUIDv7(direct.PeerMemberID) ||
			direct.PeerMemberID == agentID ||
			strings.TrimSpace(direct.IMGroupID) == "" ||
			!validDirectConversationIMState(direct.IMState) ||
			direct.Revision < 0 {
			return false
		}
		if _, exists := memberIDs[direct.PeerMemberID]; !exists {
			return false
		}
		if _, duplicate := directIDs[direct.ID]; duplicate {
			return false
		}
		if _, duplicate := directPeers[direct.PeerMemberID]; duplicate {
			return false
		}
		directIDs[direct.ID] = struct{}{}
		directPeers[direct.PeerMemberID] = struct{}{}
	}
	return selfFound
}

func validDirectConversationIMState(value string) bool {
	switch value {
	case "provisioning", "ready", "error", "deleted":
		return true
	default:
		return false
	}
}

func validChannelMembersSnapshot(
	value directoryport.ChannelMembersSnapshot,
	channelID string,
	agentID string,
) bool {
	if value.Channel.ID != channelID || strings.TrimSpace(value.Channel.Name) == "" ||
		(value.Channel.Visibility != "public" && value.Channel.Visibility != "private") ||
		!value.Channel.Joined || strings.TrimSpace(value.Channel.IMGroupID) == "" ||
		strings.TrimSpace(value.Revision) == "" ||
		len(value.Members) > maximumDirectoryMembers {
		return false
	}
	selfFound := false
	for _, member := range value.Members {
		if !validDirectoryMember(member) {
			return false
		}
		if member.MemberID == agentID && member.Kind == "agent" {
			selfFound = true
		}
	}
	return selfFound
}

func validDirectoryMember(value directoryport.Member) bool {
	if !isUUIDv7(value.MemberID) ||
		(value.Kind != "human" && value.Kind != "agent") ||
		strings.TrimSpace(value.Handle) == "" ||
		strings.TrimSpace(value.DisplayName) == "" ||
		strings.TrimSpace(value.IMUserID) == "" {
		return false
	}
	switch value.Kind {
	case "human":
		return value.HumanID != nil && isUUIDv7(*value.HumanID) && value.AgentID == nil
	case "agent":
		return value.AgentID != nil && *value.AgentID == value.MemberID && value.HumanID == nil
	default:
		return false
	}
}

func isUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.Version() == 7
}
