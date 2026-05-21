package store

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound      = errors.New("not found")
	ErrQuotaExceeded = errors.New("quota exceeded")
)

type Entry struct {
	Namespace string    `json:"namespace"`
	Key       string    `json:"key"`
	Value     string    `json:"value,omitempty"`
	Size      int       `json:"size"`
	UpdatedAt time.Time `json:"updated_at"`
}

type ListPage struct {
	Entries    []Entry
	NextCursor string
}

type KVStore interface {
	Put(ctx context.Context, ownerID string, namespace string, key string, value []byte) (Entry, bool, error)
	Get(ctx context.Context, ownerID string, namespace string, key string) (Entry, error)
	Delete(ctx context.Context, ownerID string, namespace string, key string) (bool, error)
	List(ctx context.Context, ownerID string, namespace string, cursor string, limit int) (ListPage, error)
	Ping(ctx context.Context) error
}
