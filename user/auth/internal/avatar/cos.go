package avatar

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tencentyun/cos-go-sdk-v5"
)

type COSConfig struct {
	BucketURL    string
	SecretID     string
	SecretKey    string
	SignedURLTTL time.Duration
	MaxBytes     int64
}

type cosBucketClient struct {
	client *cos.Client
}

func NewCOSStore(config COSConfig) (*Store, error) {
	bucketURL := strings.TrimSpace(config.BucketURL)
	if bucketURL == "" {
		return nil, fmt.Errorf("cos bucket url is required")
	}
	if !strings.Contains(bucketURL, "://") {
		bucketURL = "https://" + bucketURL
	}
	parsedURL, err := url.Parse(bucketURL)
	if err != nil {
		return nil, fmt.Errorf("parse cos bucket url: %w", err)
	}

	secretID := strings.TrimSpace(config.SecretID)
	secretKey := strings.TrimSpace(config.SecretKey)
	if secretID == "" || secretKey == "" {
		return nil, fmt.Errorf("cos credentials are required")
	}

	client := cos.NewClient(&cos.BaseURL{BucketURL: parsedURL}, &http.Client{
		Transport: &cos.AuthorizationTransport{
			SecretID:  secretID,
			SecretKey: secretKey,
		},
	})

	store := NewStore(&cosBucketClient{client: client})
	if config.MaxBytes > 0 {
		store.maxBytes = config.MaxBytes
	}
	if config.SignedURLTTL > 0 {
		store.signedURLTTL = config.SignedURLTTL
	}
	return store, nil
}

func (c *cosBucketClient) PutObject(ctx context.Context, objectKey string, content []byte, contentType string) error {
	_, err := c.client.Object.Put(ctx, objectKey, bytes.NewReader(content), &cos.ObjectPutOptions{
		ObjectPutHeaderOptions: &cos.ObjectPutHeaderOptions{
			ContentType: contentType,
		},
	})
	return err
}

func (c *cosBucketClient) SignedGetURL(_ context.Context, objectKey string, ttl time.Duration) (string, error) {
	presigned, err := c.client.Object.GetPresignedURL2(context.Background(), http.MethodGet, objectKey, ttl, nil)
	if err != nil {
		return "", err
	}
	return presigned.String(), nil
}

func (c *cosBucketClient) DeleteObject(ctx context.Context, objectKey string) error {
	_, err := c.client.Object.Delete(ctx, objectKey)
	return err
}
