package avatar

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"strings"
	"time"

	_ "image/gif"
	_ "image/png"

	_ "golang.org/x/image/webp"
)

const (
	defaultMaxBytes      int64 = 200 * 1024
	defaultFetchMaxBytes int64 = 2 << 20
	defaultSignedURLTTL        = 5 * time.Minute
)

type BucketClient interface {
	PutObject(ctx context.Context, objectKey string, content []byte, contentType string) error
	SignedGetURL(ctx context.Context, objectKey string, ttl time.Duration) (string, error)
	DeleteObject(ctx context.Context, objectKey string) error
}

type Store struct {
	client        BucketClient
	maxBytes      int64
	signedURLTTL  time.Duration
	fetchClient   *http.Client
	fetchMaxBytes int64
}

func NewStore(client BucketClient) *Store {
	return &Store{
		client:        client,
		maxBytes:      defaultMaxBytes,
		signedURLTTL:  defaultSignedURLTTL,
		fetchClient:   http.DefaultClient,
		fetchMaxBytes: defaultFetchMaxBytes,
	}
}

func (s *Store) StoreAvatar(ctx context.Context, userID string, content []byte) (string, error) {
	if s == nil || s.client == nil {
		return "", fmt.Errorf("avatar store client is not configured")
	}
	normalized, err := s.normalizeAvatar(content)
	if err != nil {
		return "", err
	}

	objectKey := avatarObjectKey(userID)
	if err := s.client.PutObject(ctx, objectKey, normalized, "image/jpeg"); err != nil {
		return "", err
	}
	return objectKey, nil
}

func (s *Store) SyncRemoteAvatar(ctx context.Context, userID string, remoteURL string) (string, error) {
	if s == nil || s.client == nil {
		return "", fmt.Errorf("avatar store client is not configured")
	}
	if strings.TrimSpace(remoteURL) == "" {
		return "", fmt.Errorf("remote avatar url is required")
	}

	client := s.fetchClient
	if client == nil {
		client = http.DefaultClient
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, remoteURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("fetch remote avatar: unexpected status %d", resp.StatusCode)
	}

	limit := s.fetchMaxBytes
	if limit <= 0 {
		limit = defaultFetchMaxBytes
	}
	content, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return "", err
	}
	if int64(len(content)) > limit {
		return "", fmt.Errorf("remote avatar exceeds fetch limit")
	}

	return s.StoreAvatar(ctx, userID, content)
}

func (s *Store) SignedAvatarURL(ctx context.Context, objectKey string) (string, error) {
	if s == nil || s.client == nil {
		return "", fmt.Errorf("avatar store client is not configured")
	}
	if strings.TrimSpace(objectKey) == "" {
		return "", fmt.Errorf("object key is required")
	}
	ttl := s.signedURLTTL
	if ttl <= 0 {
		ttl = defaultSignedURLTTL
	}
	return s.client.SignedGetURL(ctx, objectKey, ttl)
}

func (s *Store) DeleteAvatar(ctx context.Context, objectKey string) error {
	if s == nil || s.client == nil {
		return fmt.Errorf("avatar store client is not configured")
	}
	trimmedObjectKey := strings.TrimSpace(objectKey)
	if trimmedObjectKey == "" {
		return nil
	}
	return s.client.DeleteObject(ctx, trimmedObjectKey)
}

func (s *Store) normalizeAvatar(content []byte) ([]byte, error) {
	limit := s.maxBytes
	if limit <= 0 {
		limit = defaultMaxBytes
	}

	img, _, err := image.Decode(bytes.NewReader(content))
	if err != nil {
		return nil, fmt.Errorf("decode avatar: %w", err)
	}

	var output bytes.Buffer
	quality := 85
	for {
		output.Reset()
		if err := jpeg.Encode(&output, img, &jpeg.Options{Quality: quality}); err != nil {
			return nil, fmt.Errorf("encode avatar: %w", err)
		}
		if int64(output.Len()) <= limit || quality <= 35 {
			break
		}
		quality -= 10
	}

	if int64(output.Len()) > limit {
		return nil, fmt.Errorf("avatar exceeds %d bytes after normalization", limit)
	}

	return append([]byte(nil), output.Bytes()...), nil
}

func avatarObjectKey(userID string) string {
	return fmt.Sprintf("avatars/%s/current.jpg", strings.TrimSpace(userID))
}
