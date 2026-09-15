// Package computerv2 defines the stable boundary for LightVela instance Computers.
package computerv2

import (
	"context"
	"errors"
	"time"
)

var (
	ErrServerNotFound          = errors.New("Server 不存在")
	ErrAdminRequired           = errors.New("需要 Server 管理权限")
	ErrInstanceAlreadyAttached = errors.New("LightVela 实例已归属 Server")
	ErrIdempotencyConflict     = errors.New("幂等请求冲突")
)

type Instance struct {
	ID     string
	Name   string
	Status string
}

type Computer struct {
	ID             string
	ServerID       string
	Kind           string
	InstanceID     string
	Name           string
	LifecycleState string
	ObservedState  string
	LastObservedAt *time.Time
	LastErrorCode  string
	Revision       int64
	CreatedAt      time.Time
}

type Draft struct {
	ID             string
	Kind           string
	InstanceID     string
	Name           string
	LifecycleState string
}

type AttachCommand struct {
	AccountID      string
	ServerID       string
	IdempotencyKey string
	RequestHash    [32]byte
	CreatedAt      time.Time
	Computer       Draft
}

type ListOptions struct {
	Limit   int
	AfterID string
}

type Page struct {
	Items      []Computer
	NextCursor string
}

type Repository interface {
	Attach(context.Context, AttachCommand) (Computer, error)
	List(context.Context, string, string, ListOptions) (Page, error)
}

type InstanceDirectory interface {
	ListOwned(context.Context, string) ([]Instance, error)
}
