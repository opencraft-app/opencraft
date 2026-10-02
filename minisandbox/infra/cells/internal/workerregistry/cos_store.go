package workerregistry

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	cos "github.com/tencentyun/cos-go-sdk-v5"
)

const maxStoredVersionBytes = 4 << 20

type COSObjectStore struct {
	client *cos.Client
}

type COSConfig struct {
	BucketURL    string
	SecretID     string
	SecretKey    string
	SessionToken string
	Timeout      time.Duration
}

func NewCOSObjectStore(config COSConfig) (*COSObjectStore, error) {
	bucketURL, err := url.Parse(config.BucketURL)
	if err != nil || bucketURL.Scheme == "" || bucketURL.Host == "" {
		return nil, fmt.Errorf("COS bucket URL is invalid")
	}
	if config.Timeout <= 0 {
		config.Timeout = 15 * time.Second
	}
	transport := &cos.AuthorizationTransport{
		SecretID:     config.SecretID,
		SecretKey:    config.SecretKey,
		SessionToken: config.SessionToken,
		Transport:    http.DefaultTransport,
	}
	client := cos.NewClient(&cos.BaseURL{BucketURL: bucketURL}, &http.Client{
		Transport: transport,
		Timeout:   config.Timeout,
	})
	client.Conf.RetryOpt.Count = 2
	client.Conf.RetryOpt.Interval = 100 * time.Millisecond
	return &COSObjectStore{client: client}, nil
}

func (s *COSObjectStore) Check(ctx context.Context) error {
	response, err := s.client.Bucket.Head(ctx)
	if response != nil && response.Body != nil {
		response.Body.Close()
	}
	if err != nil {
		return fmt.Errorf("head COS bucket: %w", err)
	}
	return nil
}

func (s *COSObjectStore) PutImmutable(ctx context.Context, key string, content []byte) (bool, error) {
	if len(content) > maxStoredVersionBytes {
		return false, fmt.Errorf("Worker version object exceeds %d bytes", maxStoredVersionBytes)
	}
	headers := make(http.Header)
	headers.Set("x-cos-forbid-overwrite", "true")
	response, err := s.client.Object.Put(ctx, key, bytes.NewReader(content), &cos.ObjectPutOptions{
		ObjectPutHeaderOptions: &cos.ObjectPutHeaderOptions{
			ContentType:   "application/json",
			ContentLength: int64(len(content)),
			XOptionHeader: &headers,
		},
	})
	if response != nil && response.Body != nil {
		response.Body.Close()
	}
	if err == nil {
		return true, nil
	}
	var responseError *cos.ErrorResponse
	if !errors.As(err, &responseError) || responseError.Response == nil ||
		(responseError.Response.StatusCode != http.StatusConflict || responseError.Code != "FileAlreadyExists") {
		return false, err
	}
	// COS may briefly delay cross-request visibility even though the conditional
	// PUT has already established that the key exists. Retry only not-found;
	// other errors retain their precise failure semantics.
	for attempt := 0; attempt < 5; attempt++ {
		persisted, getErr := s.Get(ctx, key)
		if getErr == nil {
			if !bytes.Equal(persisted, content) {
				return false, ErrImmutableConflict
			}
			return false, nil
		}
		if !errors.Is(getErr, ErrNotFound) || attempt == 4 {
			return false, fmt.Errorf("verify existing immutable COS object: %w", getErr)
		}
		delay := time.Duration(1<<attempt) * 50 * time.Millisecond
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return false, ctx.Err()
		case <-timer.C:
		}
	}
	panic("unreachable")
}

func (s *COSObjectStore) Get(ctx context.Context, key string) ([]byte, error) {
	response, err := s.client.Object.Get(ctx, key, nil)
	if err != nil {
		if cos.IsNotFoundError(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	defer response.Body.Close()
	content, err := io.ReadAll(io.LimitReader(response.Body, maxStoredVersionBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read COS object: %w", err)
	}
	if len(content) > maxStoredVersionBytes {
		return nil, fmt.Errorf("COS Worker version object exceeds %d bytes", maxStoredVersionBytes)
	}
	return content, nil
}
