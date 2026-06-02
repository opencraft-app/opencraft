package avatar

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestStoreAvatarNormalizesAndStoresJPEG(t *testing.T) {
	t.Parallel()

	client := &stubBucketClient{signedURL: "https://example.com/signed"}
	store := &Store{
		client:        client,
		maxBytes:      200 * 1024,
		signedURLTTL:  5 * time.Minute,
		fetchClient:   http.DefaultClient,
		fetchMaxBytes: 2 << 20,
	}

	objectKey, err := store.StoreAvatar(context.Background(), "usr_123", testAvatarPNG(t))
	if err != nil {
		t.Fatalf("store avatar failed: %v", err)
	}
	if objectKey != "avatars/321_rsu/current.jpg" {
		t.Fatalf("expected object key to use reversed user prefix, got %q", objectKey)
	}
	if client.lastContentType != "image/jpeg" {
		t.Fatalf("expected normalized jpeg content type, got %q", client.lastContentType)
	}
	if len(client.lastContent) == 0 {
		t.Fatal("expected object bytes to be uploaded")
	}
	if len(client.lastContent) > 200*1024 {
		t.Fatalf("expected normalized avatar to fit limit, got %d bytes", len(client.lastContent))
	}
}

func TestStoreAvatarReturnsTooLargeWhenNormalizedImageExceedsLimit(t *testing.T) {
	t.Parallel()

	store := &Store{
		client:        &stubBucketClient{},
		maxBytes:      1,
		signedURLTTL:  5 * time.Minute,
		fetchClient:   http.DefaultClient,
		fetchMaxBytes: 2 << 20,
	}

	_, err := store.StoreAvatar(context.Background(), "usr_large", testAvatarPNG(t))
	if !errors.Is(err, ErrAvatarTooLarge) {
		t.Fatalf("expected ErrAvatarTooLarge, got %v", err)
	}
}

func TestSyncRemoteAvatarFetchesRemoteImageAndStores(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(testAvatarPNG(t))
	}))
	defer server.Close()

	client := &stubBucketClient{}
	store := &Store{
		client:        client,
		maxBytes:      200 * 1024,
		signedURLTTL:  5 * time.Minute,
		fetchClient:   server.Client(),
		fetchMaxBytes: 2 << 20,
	}

	objectKey, err := store.SyncRemoteAvatar(context.Background(), "usr_qq", server.URL)
	if err != nil {
		t.Fatalf("sync remote avatar failed: %v", err)
	}
	if objectKey != "avatars/qq_rsu/current.jpg" {
		t.Fatalf("unexpected object key: %q", objectKey)
	}
	if client.lastObjectKey != objectKey {
		t.Fatalf("expected sync to upload object key %q, got %q", objectKey, client.lastObjectKey)
	}
}

func TestAvatarObjectKeyReversesUserIDPrefix(t *testing.T) {
	t.Parallel()

	objectKey := avatarObjectKey("  usr_12345  ")

	if objectKey != "avatars/54321_rsu/current.jpg" {
		t.Fatalf("expected reversed user id object key, got %q", objectKey)
	}
}

func TestSignedAvatarURLDelegatesToBucketClient(t *testing.T) {
	t.Parallel()

	client := &stubBucketClient{signedURL: "https://example.com/avatar.jpg?sign=demo"}
	store := &Store{
		client:       client,
		maxBytes:     200 * 1024,
		signedURLTTL: 5 * time.Minute,
	}

	url, err := store.SignedAvatarURL(context.Background(), "avatars/usr_123/current.jpg")
	if err != nil {
		t.Fatalf("signed avatar url failed: %v", err)
	}
	if url != client.signedURL {
		t.Fatalf("expected signed url %q, got %q", client.signedURL, url)
	}
	if client.lastSignedKey != "avatars/usr_123/current.jpg" {
		t.Fatalf("expected signed key to be forwarded, got %q", client.lastSignedKey)
	}
}

type stubBucketClient struct {
	lastObjectKey   string
	lastContentType string
	lastContent     []byte
	lastSignedKey   string
	signedURL       string
}

func (s *stubBucketClient) PutObject(_ context.Context, objectKey string, content []byte, contentType string) error {
	s.lastObjectKey = objectKey
	s.lastContentType = contentType
	s.lastContent = append([]byte(nil), content...)
	return nil
}

func (s *stubBucketClient) SignedGetURL(_ context.Context, objectKey string, _ time.Duration) (string, error) {
	s.lastSignedKey = objectKey
	if strings.TrimSpace(s.signedURL) == "" {
		s.signedURL = "https://example.com/" + objectKey
	}
	return s.signedURL, nil
}

func (s *stubBucketClient) DeleteObject(_ context.Context, objectKey string) error {
	s.lastObjectKey = objectKey
	return nil
}

func testAvatarPNG(t *testing.T) []byte {
	t.Helper()

	var buf bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			img.Set(x, y, color.RGBA{R: 0x66, G: 0x99, B: 0xcc, A: 0xff})
		}
	}
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}
