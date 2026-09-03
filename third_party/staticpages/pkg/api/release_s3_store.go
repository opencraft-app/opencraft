package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	"github.com/SpechtLabs/StaticPages/pkg/config"
	"github.com/SpechtLabs/StaticPages/pkg/s3_client"
)

type s3ReleaseStore struct {
	page   *config.Page
	client *s3_client.S3PageClient
}

func newS3ReleaseStore(page *config.Page) releaseStore {
	return &s3ReleaseStore{page: page, client: s3_client.NewS3PageClient(page)}
}

func (s *s3ReleaseStore) SaveRecord(ctx context.Context, record ReleaseRecord) error {
	body, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return s.client.PutPrivateObject(
		ctx,
		s.releaseRecordKey(record.ID),
		bytes.NewReader(body),
		int64(len(body)),
		"application/json",
		nil,
	)
}

func (s *s3ReleaseStore) LoadRecord(ctx context.Context, releaseID string) (ReleaseRecord, error) {
	body, err := s.client.GetObject(ctx, s.releaseRecordKey(releaseID))
	if err != nil {
		return ReleaseRecord{}, err
	}
	defer body.Close()
	var record ReleaseRecord
	if err := json.NewDecoder(io.LimitReader(body, maxReleaseManifestBytes+1024*1024)).Decode(&record); err != nil {
		return ReleaseRecord{}, err
	}
	return record, nil
}

func (s *s3ReleaseStore) PresignPackUpload(ctx context.Context, releaseID string, pack ReleasePack) (ReleasePackUpload, error) {
	upload, err := s.client.PresignPrivatePutObject(
		ctx,
		s.packKey(releaseID, pack.Name),
		pack.CompressedSize,
		"application/gzip",
		map[string]string{"sha256": pack.SHA256},
		30*time.Minute,
	)
	if err != nil {
		return ReleasePackUpload{}, err
	}
	return ReleasePackUpload{Name: pack.Name, URL: upload.URL, Headers: upload.Headers}, nil
}

func (s *s3ReleaseStore) InspectPack(ctx context.Context, releaseID string, pack ReleasePack) error {
	info, err := s.client.HeadObject(ctx, s.packKey(releaseID, pack.Name))
	if err != nil {
		return err
	}
	if info.Size != pack.CompressedSize {
		return fmt.Errorf("pack size mismatch: %q", pack.Name)
	}
	checksum := info.Metadata["sha256"]
	if checksum == "" {
		checksum = info.Metadata["Sha256"]
	}
	if !strings.EqualFold(checksum, pack.SHA256) {
		return fmt.Errorf("pack checksum metadata mismatch: %q", pack.Name)
	}
	return nil
}

func (s *s3ReleaseStore) OpenPack(ctx context.Context, releaseID string, name string) (io.ReadCloser, error) {
	return s.client.GetObject(ctx, s.packKey(releaseID, name))
}

func (s *s3ReleaseStore) PublishFolder(ctx context.Context, source string, target string) error {
	if err := s.client.UploadFolder(ctx, source, target); err != nil {
		return err
	}
	return nil
}

func (s *s3ReleaseStore) PublishMetadata(ctx context.Context, metadata *s3_client.PageIndexData) error {
	index, err := s.client.DownloadPageIndex(ctx)
	if err != nil {
		return err
	}
	index[metadata.SHA()] = metadata
	if err := s.client.UploadPageIndex(ctx, index); err != nil {
		return err
	}
	s3_client.InvalidatePageMetadata(s.page)
	return nil
}

func (s *s3ReleaseStore) DeleteStaging(ctx context.Context, releaseID string) error {
	return s.client.DeleteObjectPrefix(ctx, s.stagingPrefix(releaseID))
}

func (s *s3ReleaseStore) releaseRecordKey(releaseID string) string {
	return path.Join("_staticpages", "releases", s.page.Git.Repository, releaseID+".json")
}

func (s *s3ReleaseStore) stagingPrefix(releaseID string) string {
	return path.Join("_staticpages", "uploads", s.page.Git.Repository, releaseID)
}

func (s *s3ReleaseStore) packKey(releaseID string, name string) string {
	return path.Join(s.stagingPrefix(releaseID), "packs", name)
}
