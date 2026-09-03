package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/SpechtLabs/StaticPages/pkg/config"
	"github.com/SpechtLabs/StaticPages/pkg/s3_client"
	"github.com/gin-gonic/gin"
)

const maxReleaseManifestBytes = 8 * 1024 * 1024

var releaseIDPattern = regexp.MustCompile(`^rel_[a-f0-9]{32}$`)

type ReleaseStatus string

const (
	ReleaseStatusCreated    ReleaseStatus = "created"
	ReleaseStatusProcessing ReleaseStatus = "processing"
	ReleaseStatusPublished  ReleaseStatus = "published"
	ReleaseStatusFailed     ReleaseStatus = "failed"
)

type ReleaseRecord struct {
	ID             string          `json:"id"`
	Repository     string          `json:"repository"`
	SHA            string          `json:"sha"`
	Branch         string          `json:"branch"`
	Environment    string          `json:"environment"`
	ManifestSHA256 string          `json:"manifest_sha256"`
	Manifest       ReleaseManifest `json:"manifest"`
	Status         ReleaseStatus   `json:"status"`
	Error          string          `json:"error,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

type ReleasePackUpload struct {
	Name    string            `json:"name"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

type releaseStore interface {
	SaveRecord(context.Context, ReleaseRecord) error
	LoadRecord(context.Context, string) (ReleaseRecord, error)
	PresignPackUpload(context.Context, string, ReleasePack) (ReleasePackUpload, error)
	InspectPack(context.Context, string, ReleasePack) error
	OpenPack(context.Context, string, string) (io.ReadCloser, error)
	PublishFolder(context.Context, string, string) error
	PublishMetadata(context.Context, *s3_client.PageIndexData) error
	DeleteStaging(context.Context, string) error
}

type releaseStoreFactory func(*config.Page) releaseStore

type createReleaseRequest struct {
	Manifest ReleaseManifest `json:"manifest"`
}

func (r *RestApi) CreateReleaseHandler(ct *gin.Context) {
	ctx, span := r.tracer.Start(ct.Request.Context(), "restApi.CreateReleaseHandler")
	defer span.End()

	metadata, page, ok := r.authorizeReleaseRequest(ctx, ct)
	if !ok {
		return
	}
	if r.releaseStoreFactory == nil {
		ct.JSON(http.StatusServiceUnavailable, gin.H{"error": "release storage is unavailable"})
		return
	}

	ct.Request.Body = http.MaxBytesReader(ct.Writer, ct.Request.Body, maxReleaseManifestBytes)
	decoder := json.NewDecoder(ct.Request.Body)
	decoder.DisallowUnknownFields()
	var request createReleaseRequest
	if err := decoder.Decode(&request); err != nil {
		ct.JSON(http.StatusBadRequest, gin.H{"error": "invalid release manifest"})
		return
	}
	if err := ensureJSONBodyConsumed(decoder); err != nil {
		ct.JSON(http.StatusBadRequest, gin.H{"error": "invalid release manifest"})
		return
	}
	if err := validateReleaseManifest(request.Manifest); err != nil {
		ct.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	manifestBytes, err := json.Marshal(request.Manifest)
	if err != nil {
		ct.JSON(http.StatusInternalServerError, gin.H{"error": "failed to encode release manifest"})
		return
	}
	manifestDigest := sha256.Sum256(manifestBytes)
	releaseID := releaseIDFor(metadata, manifestDigest[:])
	now := time.Now().UTC()
	record := ReleaseRecord{
		ID:             releaseID,
		Repository:     metadata.Repository(),
		SHA:            metadata.SHA(),
		Branch:         metadata.Branch,
		Environment:    metadata.Environment,
		ManifestSHA256: hex.EncodeToString(manifestDigest[:]),
		Manifest:       request.Manifest,
		Status:         ReleaseStatusCreated,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	store := r.releaseStoreFactory(page)
	if existing, loadErr := store.LoadRecord(ctx, releaseID); loadErr == nil && existing.ID == releaseID {
		if !releaseBelongsTo(existing, metadata) || existing.ManifestSHA256 != record.ManifestSHA256 {
			ct.JSON(http.StatusConflict, gin.H{"error": "release identity conflict"})
			return
		}
		if existing.Status == ReleaseStatusPublished {
			ct.JSON(http.StatusOK, releaseSuccessResponse(page, metadata, existing))
			return
		}
		record.CreatedAt = existing.CreatedAt
	}
	if err := store.SaveRecord(ctx, record); err != nil {
		ct.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create release"})
		return
	}

	uploads := make([]ReleasePackUpload, 0, len(request.Manifest.Packs))
	for _, pack := range request.Manifest.Packs {
		upload, err := store.PresignPackUpload(ctx, releaseID, pack)
		if err != nil {
			ct.JSON(http.StatusInternalServerError, gin.H{"error": "failed to authorize release upload"})
			return
		}
		uploads = append(uploads, upload)
	}

	ct.JSON(http.StatusCreated, gin.H{
		"release_id": releaseID,
		"expires_at": now.Add(30 * time.Minute),
		"uploads":    uploads,
	})
}

func (r *RestApi) CommitReleaseHandler(ct *gin.Context) {
	ctx, span := r.tracer.Start(ct.Request.Context(), "restApi.CommitReleaseHandler")
	defer span.End()

	metadata, page, ok := r.authorizeReleaseRequest(ctx, ct)
	if !ok {
		return
	}
	if r.releaseStoreFactory == nil {
		ct.JSON(http.StatusServiceUnavailable, gin.H{"error": "release storage is unavailable"})
		return
	}

	releaseID := ct.Param("releaseID")
	if !releaseIDPattern.MatchString(releaseID) {
		ct.JSON(http.StatusNotFound, gin.H{"error": "release not found"})
		return
	}
	store := r.releaseStoreFactory(page)
	record, err := store.LoadRecord(ctx, releaseID)
	if err != nil || record.ID != releaseID {
		ct.JSON(http.StatusNotFound, gin.H{"error": "release not found"})
		return
	}
	if !releaseBelongsTo(record, metadata) {
		ct.JSON(http.StatusForbidden, gin.H{"error": "release not authorized"})
		return
	}
	if record.Status == ReleaseStatusPublished {
		ct.JSON(http.StatusOK, releaseSuccessResponse(page, metadata, record))
		return
	}

	for _, pack := range record.Manifest.Packs {
		if err := store.InspectPack(ctx, releaseID, pack); err != nil {
			r.failRelease(ctx, store, &record, "release pack is missing or invalid")
			ct.JSON(http.StatusUnprocessableEntity, gin.H{"error": "release pack is missing or invalid"})
			return
		}
	}

	record.Status = ReleaseStatusProcessing
	record.Error = ""
	record.UpdatedAt = time.Now().UTC()
	if err := store.SaveRecord(ctx, record); err != nil {
		ct.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update release"})
		return
	}

	uploadPath, err := os.MkdirTemp("", fmt.Sprintf("staticpages-release-%s-", sanitizeTempName(releaseID)))
	if err != nil {
		r.failRelease(ctx, store, &record, "failed to create release workspace")
		ct.JSON(http.StatusInternalServerError, gin.H{"error": "failed to process release"})
		return
	}
	defer func() { _ = os.RemoveAll(uploadPath) }()

	_, _, err = extractReleasePacks(
		ctx,
		record.Manifest,
		uploadPath,
		func(ctx context.Context, name string) (io.ReadCloser, error) {
			return store.OpenPack(ctx, releaseID, name)
		},
	)
	if err != nil {
		r.failRelease(ctx, store, &record, "release verification failed")
		ct.JSON(http.StatusUnprocessableEntity, gin.H{"error": "release verification failed"})
		return
	}

	if err := store.PublishFolder(ctx, uploadPath, filepath.ToSlash(filepath.Join(record.Repository, record.SHA))); err != nil {
		r.failRelease(ctx, store, &record, "failed to publish release files")
		ct.JSON(http.StatusInternalServerError, gin.H{"error": "failed to publish release"})
		return
	}
	publishedMetadata := s3_client.NewPageCommitMetadata(
		record.Repository,
		record.SHA,
		record.Branch,
		record.Environment,
		time.Now().UTC(),
	)
	if err := store.PublishMetadata(ctx, publishedMetadata); err != nil {
		r.failRelease(ctx, store, &record, "failed to publish release metadata")
		ct.JSON(http.StatusInternalServerError, gin.H{"error": "failed to publish release"})
		return
	}

	record.Status = ReleaseStatusPublished
	record.Error = ""
	record.UpdatedAt = time.Now().UTC()
	if err := store.SaveRecord(ctx, record); err != nil {
		ct.JSON(http.StatusInternalServerError, gin.H{"error": "release published but status update failed"})
		return
	}
	_ = store.DeleteStaging(ctx, releaseID)

	ct.JSON(http.StatusOK, releaseSuccessResponse(page, publishedMetadata, record))
}

func releaseBelongsTo(record ReleaseRecord, metadata *s3_client.PageIndexData) bool {
	return record.Repository == metadata.Repository() &&
		record.SHA == metadata.SHA() &&
		record.Branch == metadata.Branch &&
		record.Environment == metadata.Environment
}

func releaseSuccessResponse(page *config.Page, metadata *s3_client.PageIndexData, record ReleaseRecord) gin.H {
	return gin.H{
		"status":      record.Status,
		"release_id":  record.ID,
		"file_count":  record.Manifest.FileCount,
		"url":         fmt.Sprintf("https://%s", page.Domain.String()),
		"preview_url": getPreviewUrls(page, metadata),
	}
}

func (r *RestApi) failRelease(ctx context.Context, store releaseStore, record *ReleaseRecord, message string) {
	record.Status = ReleaseStatusFailed
	record.Error = message
	record.UpdatedAt = time.Now().UTC()
	_ = store.SaveRecord(ctx, *record)
}

func (r *RestApi) authorizeReleaseRequest(ctx context.Context, ct *gin.Context) (*s3_client.PageIndexData, *config.Page, bool) {
	metadata, err := r.extractAndVerifyAuth(ctx, ct)
	if err != nil {
		ct.JSON(http.StatusForbidden, gin.H{"error": "invalid authorization header"})
		return nil, nil, false
	}
	page, err := r.extractPagesConfig(ctx, metadata.Repository())
	if err != nil {
		ct.JSON(http.StatusForbidden, gin.H{"error": "repository not authorized"})
		return nil, nil, false
	}
	return metadata, page, true
}

func ensureJSONBodyConsumed(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("unexpected trailing JSON value")
		}
		return err
	}
	return nil
}

func releaseIDFor(metadata *s3_client.PageIndexData, manifestDigest []byte) string {
	digest := sha256.New()
	for _, value := range []string{
		metadata.Repository(),
		metadata.SHA(),
		metadata.Branch,
		metadata.Environment,
	} {
		_, _ = digest.Write([]byte(value))
		_, _ = digest.Write([]byte{0})
	}
	_, _ = digest.Write(manifestDigest)
	return "rel_" + hex.EncodeToString(digest.Sum(nil))[:32]
}
