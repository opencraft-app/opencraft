package platform

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"velachat/agent/internal/common"
)

const (
	maxRuntimeDirectoryResponseBytes = 8 << 20
	maxRuntimeDirectoryChannels      = 1000
	maxRuntimeDirectoryMembers       = 10000
	maxRuntimeDirectoryDirects       = 10000
)

var ErrInvalidRuntimeDirectory = errors.New("平台返回的 Runtime 目录无效")

type DirectoryServer struct {
	ID   string
	Slug string
	Name string
}

type DirectorySelf struct {
	AgentID     string
	MemberID    string
	Handle      string
	DisplayName string
	IMUserID    string
}

type DirectoryChannel struct {
	ID         string
	Name       string
	Visibility string
	Joined     bool
	IMGroupID  string
	IMTopicID  string
	IMState    string
	Revision   int64
}

type DirectoryMember struct {
	MemberID    string
	Kind        string
	HumanID     string
	AgentID     string
	Handle      string
	DisplayName string
	IMUserID    string
}

type DirectoryDirectConversation struct {
	ID           string
	PeerMemberID string
	IMGroupID    string
	IMState      string
	Revision     int64
}

type RuntimeDirectory struct {
	Server              DirectoryServer
	Self                DirectorySelf
	Channels            []DirectoryChannel
	Members             []DirectoryMember
	DirectConversations []DirectoryDirectConversation
	Revision            string
	ExpiresAt           time.Time
}

type RuntimeChannelMembers struct {
	Channel   DirectoryChannel
	Members   []DirectoryMember
	Revision  string
	ExpiresAt time.Time
}

type runtimeDirectoryChannelPayload struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Visibility string  `json:"visibility"`
	Joined     bool    `json:"joined"`
	IMGroupID  string  `json:"imGroupId"`
	IMTopicID  *string `json:"imTopicId"`
	IMState    string  `json:"imState"`
	Revision   int64   `json:"revision"`
}

type runtimeDirectoryMemberPayload struct {
	MemberID    string  `json:"memberId"`
	Kind        string  `json:"kind"`
	HumanID     *string `json:"humanId"`
	AgentID     *string `json:"agentId"`
	Handle      string  `json:"handle"`
	DisplayName string  `json:"displayName"`
	IMUserID    string  `json:"imUserId"`
}

type runtimeDirectoryDirectConversationPayload struct {
	ID           string `json:"id"`
	PeerMemberID string `json:"peerMemberId"`
	IMGroupID    string `json:"imGroupId"`
	IMState      string `json:"imState"`
	Revision     int64  `json:"revision"`
}

type runtimeDirectoryPayload struct {
	Server struct {
		ID   string `json:"id"`
		Slug string `json:"slug"`
		Name string `json:"name"`
	} `json:"server"`
	Self struct {
		AgentID     string `json:"agentId"`
		MemberID    string `json:"memberId"`
		Handle      string `json:"handle"`
		DisplayName string `json:"displayName"`
		IMUserID    string `json:"imUserId"`
	} `json:"self"`
	Channels            []runtimeDirectoryChannelPayload             `json:"channels"`
	Members             []runtimeDirectoryMemberPayload              `json:"members"`
	DirectConversations *[]runtimeDirectoryDirectConversationPayload `json:"directConversations"`
	Revision            string                                       `json:"revision"`
	ExpiresAt           time.Time                                    `json:"expiresAt"`
}

type runtimeChannelMembersPayload struct {
	Channel   runtimeDirectoryChannelPayload  `json:"channel"`
	Members   []runtimeDirectoryMemberPayload `json:"members"`
	Revision  string                          `json:"revision"`
	ExpiresAt time.Time                       `json:"expiresAt"`
}

func (c *Client) GetRuntimeDirectory(
	ctx context.Context,
	token AccessToken,
	serverID string,
	agentID string,
) (RuntimeDirectory, error) {
	if !validUUIDv7(serverID) || !validUUIDv7(agentID) {
		return RuntimeDirectory{}, ErrInvalidConfig
	}
	request, err := c.runtimeTaskRequest(
		ctx,
		token,
		http.MethodGet,
		"/runtime/directory-v2",
		nil,
	)
	if err != nil {
		return RuntimeDirectory{}, err
	}
	response, err := c.doRuntimeRequest(
		request,
		http.StatusOK,
		http.StatusNotFound,
	)
	if err != nil {
		return RuntimeDirectory{}, err
	}
	legacy := response.StatusCode == http.StatusNotFound
	if legacy {
		response.Body.Close()
		request, err = c.runtimeTaskRequest(
			ctx,
			token,
			http.MethodGet,
			"/runtime/directory",
			nil,
		)
		if err != nil {
			return RuntimeDirectory{}, err
		}
		response, err = c.doRuntimeTaskRequest(request)
		if err != nil {
			return RuntimeDirectory{}, err
		}
	}
	defer response.Body.Close()
	data, err := readBounded(response.Body, maxRuntimeDirectoryResponseBytes)
	if err != nil {
		return RuntimeDirectory{}, ErrInvalidRuntimeDirectory
	}
	var payload runtimeDirectoryPayload
	if err := common.Unmarshal(data, &payload); err != nil {
		return RuntimeDirectory{}, ErrInvalidRuntimeDirectory
	}
	return c.validateRuntimeDirectory(payload, serverID, agentID, !legacy)
}

func (c *Client) GetRuntimeChannelMembers(
	ctx context.Context,
	token AccessToken,
	serverID string,
	agentID string,
	channelID string,
) (RuntimeChannelMembers, error) {
	if !validUUIDv7(serverID) || !validUUIDv7(agentID) || !validUUIDv7(channelID) {
		return RuntimeChannelMembers{}, ErrInvalidConfig
	}
	request, err := c.runtimeTaskRequest(
		ctx,
		token,
		http.MethodGet,
		"/runtime/channels/"+url.PathEscape(channelID)+"/members",
		nil,
	)
	if err != nil {
		return RuntimeChannelMembers{}, err
	}
	response, err := c.doRuntimeTaskRequest(request)
	if err != nil {
		return RuntimeChannelMembers{}, err
	}
	defer response.Body.Close()
	data, err := readBounded(response.Body, maxRuntimeDirectoryResponseBytes)
	if err != nil {
		return RuntimeChannelMembers{}, ErrInvalidRuntimeDirectory
	}
	var payload runtimeChannelMembersPayload
	if err := common.Unmarshal(data, &payload); err != nil ||
		strings.TrimSpace(payload.Revision) == "" || len(payload.Revision) > 512 ||
		len(payload.Members) > maxRuntimeDirectoryMembers ||
		!validExpiry(payload.ExpiresAt, c.now().UTC(), c.maxSessionTTL) {
		return RuntimeChannelMembers{}, ErrInvalidRuntimeDirectory
	}
	channel, err := validateDirectoryChannel(payload.Channel)
	if err != nil || channel.ID != channelID || !channel.Joined {
		return RuntimeChannelMembers{}, ErrInvalidRuntimeDirectory
	}
	members, selfFound, err := validateDirectoryMembers(
		payload.Members, agentID, "",
	)
	if err != nil || !selfFound {
		return RuntimeChannelMembers{}, ErrInvalidRuntimeDirectory
	}
	return RuntimeChannelMembers{
		Channel: channel, Members: members,
		Revision: payload.Revision, ExpiresAt: payload.ExpiresAt.UTC(),
	}, nil
}

func (c *Client) validateRuntimeDirectory(
	payload runtimeDirectoryPayload,
	serverID string,
	agentID string,
	requireDirectConversations bool,
) (RuntimeDirectory, error) {
	if requireDirectConversations && payload.DirectConversations == nil {
		return RuntimeDirectory{}, ErrInvalidRuntimeDirectory
	}
	directConversations := []runtimeDirectoryDirectConversationPayload(nil)
	if payload.DirectConversations != nil {
		directConversations = *payload.DirectConversations
	}
	if payload.Server.ID != serverID || payload.Self.AgentID != agentID ||
		payload.Self.MemberID != agentID ||
		strings.TrimSpace(payload.Server.Slug) == "" ||
		strings.TrimSpace(payload.Server.Name) == "" ||
		strings.TrimSpace(payload.Self.Handle) == "" ||
		strings.TrimSpace(payload.Self.DisplayName) == "" ||
		strings.TrimSpace(payload.Self.IMUserID) == "" ||
		strings.TrimSpace(payload.Revision) == "" || len(payload.Revision) > 512 ||
		len(payload.Channels) > maxRuntimeDirectoryChannels ||
		len(payload.Members) > maxRuntimeDirectoryMembers ||
		len(directConversations) > maxRuntimeDirectoryDirects ||
		!validExpiry(payload.ExpiresAt, c.now().UTC(), c.maxSessionTTL) {
		return RuntimeDirectory{}, ErrInvalidRuntimeDirectory
	}
	result := RuntimeDirectory{
		Server: DirectoryServer{
			ID: payload.Server.ID, Slug: payload.Server.Slug, Name: payload.Server.Name,
		},
		Self: DirectorySelf{
			AgentID: payload.Self.AgentID, MemberID: payload.Self.MemberID,
			Handle: payload.Self.Handle, DisplayName: payload.Self.DisplayName,
			IMUserID: payload.Self.IMUserID,
		},
		Channels: make([]DirectoryChannel, 0, len(payload.Channels)),
		Members:  make([]DirectoryMember, 0, len(payload.Members)),
		DirectConversations: make(
			[]DirectoryDirectConversation,
			0,
			len(directConversations),
		),
		Revision: payload.Revision, ExpiresAt: payload.ExpiresAt.UTC(),
	}
	channelNames := make(map[string]struct{}, len(payload.Channels))
	for _, value := range payload.Channels {
		channel, err := validateDirectoryChannel(value)
		if err != nil {
			return RuntimeDirectory{}, ErrInvalidRuntimeDirectory
		}
		nameKey := strings.ToLower(channel.Name)
		if _, duplicate := channelNames[nameKey]; duplicate {
			return RuntimeDirectory{}, ErrInvalidRuntimeDirectory
		}
		channelNames[nameKey] = struct{}{}
		result.Channels = append(result.Channels, channel)
	}
	members, selfFound, err := validateDirectoryMembers(
		payload.Members, agentID, payload.Self.IMUserID,
	)
	if err != nil {
		return RuntimeDirectory{}, ErrInvalidRuntimeDirectory
	}
	result.Members = members
	if !selfFound {
		return RuntimeDirectory{}, ErrInvalidRuntimeDirectory
	}
	membersByID := make(map[string]struct{}, len(result.Members))
	for _, member := range result.Members {
		membersByID[member.MemberID] = struct{}{}
	}
	directIDs := make(map[string]struct{}, len(directConversations))
	directPeers := make(map[string]struct{}, len(directConversations))
	for _, value := range directConversations {
		direct, err := validateDirectoryDirectConversation(value)
		if err != nil || direct.PeerMemberID == agentID {
			return RuntimeDirectory{}, ErrInvalidRuntimeDirectory
		}
		if _, exists := membersByID[direct.PeerMemberID]; !exists {
			return RuntimeDirectory{}, ErrInvalidRuntimeDirectory
		}
		if _, duplicate := directIDs[direct.ID]; duplicate {
			return RuntimeDirectory{}, ErrInvalidRuntimeDirectory
		}
		if _, duplicate := directPeers[direct.PeerMemberID]; duplicate {
			return RuntimeDirectory{}, ErrInvalidRuntimeDirectory
		}
		directIDs[direct.ID] = struct{}{}
		directPeers[direct.PeerMemberID] = struct{}{}
		result.DirectConversations = append(result.DirectConversations, direct)
	}
	return result, nil
}

func validateDirectoryDirectConversation(
	value runtimeDirectoryDirectConversationPayload,
) (DirectoryDirectConversation, error) {
	groupID := strings.TrimSpace(value.IMGroupID)
	if !validUUIDv7(value.ID) || !validUUIDv7(value.PeerMemberID) ||
		groupID == "" || value.Revision < 0 ||
		!validDirectConversationIMState(value.IMState) {
		return DirectoryDirectConversation{}, ErrInvalidRuntimeDirectory
	}
	return DirectoryDirectConversation{
		ID: value.ID, PeerMemberID: value.PeerMemberID,
		IMGroupID: groupID, IMState: value.IMState,
		Revision: value.Revision,
	}, nil
}

func validateDirectoryChannel(
	value runtimeDirectoryChannelPayload,
) (DirectoryChannel, error) {
	name := strings.TrimSpace(value.Name)
	if !validUUIDv7(value.ID) || name == "" ||
		(value.Visibility != "public" && value.Visibility != "private") ||
		strings.TrimSpace(value.IMGroupID) == "" || value.Revision < 0 ||
		!validDirectoryIMState(value.IMState) {
		return DirectoryChannel{}, ErrInvalidRuntimeDirectory
	}
	topicID := ""
	if value.IMTopicID != nil {
		topicID = strings.TrimSpace(*value.IMTopicID)
		if topicID == "" {
			return DirectoryChannel{}, ErrInvalidRuntimeDirectory
		}
	}
	return DirectoryChannel{
		ID: value.ID, Name: name, Visibility: value.Visibility,
		Joined: value.Joined, IMGroupID: strings.TrimSpace(value.IMGroupID),
		IMTopicID: topicID, IMState: value.IMState, Revision: value.Revision,
	}, nil
}

func validateDirectoryMembers(
	values []runtimeDirectoryMemberPayload,
	agentID string,
	selfIMUserID string,
) ([]DirectoryMember, bool, error) {
	handles := make(map[string]struct{}, len(values))
	result := make([]DirectoryMember, 0, len(values))
	selfFound := false
	for _, value := range values {
		handle := strings.TrimSpace(value.Handle)
		handleKey := strings.ToLower(handle)
		if !validUUIDv7(value.MemberID) || handleKey == "" ||
			strings.TrimSpace(value.DisplayName) == "" ||
			strings.TrimSpace(value.IMUserID) == "" {
			return nil, false, ErrInvalidRuntimeDirectory
		}
		if _, duplicate := handles[handleKey]; duplicate {
			return nil, false, ErrInvalidRuntimeDirectory
		}
		handles[handleKey] = struct{}{}
		member := DirectoryMember{
			MemberID: value.MemberID, Kind: value.Kind, Handle: handle,
			DisplayName: strings.TrimSpace(value.DisplayName),
			IMUserID:    strings.TrimSpace(value.IMUserID),
		}
		switch value.Kind {
		case "human":
			if value.HumanID == nil || !validUUIDv7(*value.HumanID) || value.AgentID != nil {
				return nil, false, ErrInvalidRuntimeDirectory
			}
			member.HumanID = *value.HumanID
		case "agent":
			if value.AgentID == nil || *value.AgentID != value.MemberID || value.HumanID != nil {
				return nil, false, ErrInvalidRuntimeDirectory
			}
			member.AgentID = *value.AgentID
		default:
			return nil, false, ErrInvalidRuntimeDirectory
		}
		if member.MemberID == agentID && member.Kind == "agent" &&
			(selfIMUserID == "" || member.IMUserID == selfIMUserID) {
			selfFound = true
		}
		result = append(result, member)
	}
	return result, selfFound, nil
}

func validDirectoryIMState(value string) bool {
	switch value {
	case "provisioning", "ready", "error", "deleting":
		return true
	default:
		return false
	}
}

func validDirectConversationIMState(value string) bool {
	switch value {
	case "provisioning", "ready", "error", "deleted":
		return true
	default:
		return false
	}
}
