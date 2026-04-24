package httpapi

import "context"

type AvatarStore interface {
	StoreAvatar(ctx context.Context, userID string, content []byte) (string, error)
	SyncRemoteAvatar(ctx context.Context, userID string, remoteURL string) (string, error)
	SignedAvatarURL(ctx context.Context, objectKey string) (string, error)
	DeleteAvatar(ctx context.Context, objectKey string) error
}
