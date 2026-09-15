// Package runtimedirectory defines the authorized collaboration directory read boundary.
package runtimedirectory

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound = errors.New("Runtime 目录不存在")
	ErrTooLarge = errors.New("Runtime 目录超过平台上限")
)

type Server struct {
	ID   string
	Slug string
	Name string
}

type Self struct {
	AgentID     string
	MemberID    string
	Handle      string
	DisplayName string
	IMUserID    string
}

type Channel struct {
	ID         string
	Name       string
	Visibility string
	Joined     bool
	IMGroupID  string
	IMTopicID  *string
	IMState    string
	Revision   int64
}

type Member struct {
	MemberID    string
	Kind        string
	HumanID     *string
	AgentID     *string
	Handle      string
	DisplayName string
	IMUserID    string
}

type Directory struct {
	Server    Server
	Self      Self
	Channels  []Channel
	Members   []Member
	Revision  string
	ExpiresAt time.Time
}

type ChannelMembers struct {
	Channel   Channel
	Members   []Member
	Revision  string
	ExpiresAt time.Time
}

type Snapshot struct {
	Server   Server
	Self     Self
	Channels []Channel
	Members  []Member
	Revision string
}

type ChannelMembersSnapshot struct {
	Channel  Channel
	Members  []Member
	Revision string
}

type Repository interface {
	Get(context.Context, string, string) (Snapshot, error)
	GetChannelMembers(
		context.Context,
		string,
		string,
		string,
	) (ChannelMembersSnapshot, error)
}
