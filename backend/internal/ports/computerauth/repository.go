// Package computerauth defines Computer credential currentness boundaries.
package computerauth

import (
	"context"
	"errors"
)

var (
	ErrInvalidRoute         = errors.New("Computer credential 路由无效")
	ErrCredentialNotCurrent = errors.New("Computer credential 已失效")
)

// Route is the non-secret exact lookup key encoded in a Computer credential.
type Route struct {
	ServerID   string
	ComputerID string
	Version    uint64
}

// Credential is the current credential digest found by an exact route.
type Credential struct {
	Route
	SecretDigest [32]byte
}

type Repository interface {
	FindCurrent(context.Context, Route) (Credential, error)
	ConfirmCurrent(context.Context, Route) (bool, error)
}
