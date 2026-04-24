package route

import (
	"context"
	"errors"
	"time"
)

// Rule maps a sandbox to a backend address.
type Rule struct {
	SandboxID  string    `json:"sandbox_id"`
	InstanceID string    `json:"instance_id"`
	Address    string    `json:"address"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// ErrRouteNotFound indicates no route exists for the sandbox.
var ErrRouteNotFound = errors.New("route not found")

// Store abstracts route rule persistence.
type Store interface {
	Get(ctx context.Context, sandboxID string) (Rule, error)
	Set(ctx context.Context, rule Rule) error
	Delete(ctx context.Context, sandboxID string) error
}
