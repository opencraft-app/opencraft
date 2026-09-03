package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/SpechtLabs/StaticPages/pkg/config"
	"github.com/SpechtLabs/StaticPages/pkg/s3_client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeReleaseStore struct {
	records           map[string]ReleaseRecord
	packs             map[string][]byte
	publishedTarget   string
	publishedMetadata *s3_client.PageIndexData
	stagingDeleted    bool
	presignCount      int
	loadCount         int
}

func (s *fakeReleaseStore) SaveRecord(_ context.Context, record ReleaseRecord) error {
	if s.records == nil {
		s.records = make(map[string]ReleaseRecord)
	}
	s.records[record.ID] = record
	return nil
}

func (s *fakeReleaseStore) LoadRecord(_ context.Context, releaseID string) (ReleaseRecord, error) {
	s.loadCount++
	return s.records[releaseID], nil
}

func (s *fakeReleaseStore) PresignPackUpload(_ context.Context, releaseID string, pack ReleasePack) (ReleasePackUpload, error) {
	s.presignCount++
	return ReleasePackUpload{
		Name:    pack.Name,
		URL:     "https://cos.example/" + releaseID + "/" + pack.Name,
		Headers: map[string]string{"X-Pack-SHA256": pack.SHA256},
	}, nil
}

func (s *fakeReleaseStore) InspectPack(_ context.Context, _ string, pack ReleasePack) error {
	return nil
}

func (s *fakeReleaseStore) OpenPack(_ context.Context, _ string, name string) (io.ReadCloser, error) {
	body, ok := s.packs[name]
	if !ok {
		return nil, assert.AnError
	}
	return io.NopCloser(bytes.NewReader(body)), nil
}

func (s *fakeReleaseStore) PublishFolder(_ context.Context, source string, target string) error {
	if _, err := os.Stat(filepath.Join(source, "index.html")); err != nil {
		return err
	}
	s.publishedTarget = target
	return nil
}

func (s *fakeReleaseStore) PublishMetadata(_ context.Context, metadata *s3_client.PageIndexData) error {
	s.publishedMetadata = metadata
	return nil
}

func (s *fakeReleaseStore) DeleteStaging(_ context.Context, _ string) error {
	s.stagingDeleted = true
	return nil
}

func TestCreateReleaseReturnsExactPresignedPackUploads(t *testing.T) {
	ginAPI, store := newReleaseTestAPI()
	manifest := validReleaseManifestForAPI()
	body, err := json.Marshal(map[string]any{"manifest": manifest})
	require.NoError(t, err)
	request := httptest.NewRequest(http.MethodPost, "/api/releases", bytes.NewReader(body))
	setReleaseAuthHeaders(request)
	response := httptest.NewRecorder()

	ginAPI.router.ServeHTTP(response, request)

	require.Equal(t, http.StatusCreated, response.Code, response.Body.String())
	var payload struct {
		ReleaseID string              `json:"release_id"`
		Uploads   []ReleasePackUpload `json:"uploads"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	require.NotEmpty(t, payload.ReleaseID)
	require.Len(t, payload.Uploads, 1)
	assert.Equal(t, manifest.Packs[0].Name, payload.Uploads[0].Name)
	assert.Contains(t, payload.Uploads[0].URL, payload.ReleaseID)
	assert.Equal(t, manifest.Packs[0].SHA256, payload.Uploads[0].Headers["X-Pack-SHA256"])
	assert.Equal(t, ReleaseStatusCreated, store.records[payload.ReleaseID].Status)
}

func TestCreateReleaseDoesNotResetAlreadyPublishedRelease(t *testing.T) {
	ginAPI, store := newReleaseTestAPI()
	manifest := validReleaseManifestForAPI()
	releaseID := createReleaseForTest(t, ginAPI, manifest)
	record := store.records[releaseID]
	record.Status = ReleaseStatusPublished
	store.records[releaseID] = record
	initialPresignCount := store.presignCount
	body, err := json.Marshal(map[string]any{"manifest": manifest})
	require.NoError(t, err)
	request := httptest.NewRequest(http.MethodPost, "/api/releases", bytes.NewReader(body))
	setReleaseAuthHeaders(request)
	response := httptest.NewRecorder()

	ginAPI.router.ServeHTTP(response, request)

	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Equal(t, ReleaseStatusPublished, store.records[releaseID].Status)
	assert.Equal(t, initialPresignCount, store.presignCount)
}

func TestCommitReleasePublishesOnlyAfterVerifiedExtraction(t *testing.T) {
	ginAPI, store := newReleaseTestAPI()
	packBody := buildReleasePack(t, map[string]string{"index.html": "home"})
	manifest := validReleaseManifestForAPI()
	manifest.Packs[0].CompressedSize = int64(len(packBody))
	manifest.Packs[0].SHA256 = digestBytes(packBody)
	manifest.Files[0].SHA256 = digestBytes([]byte("home"))
	store.packs = map[string][]byte{manifest.Packs[0].Name: packBody}

	releaseID := createReleaseForTest(t, ginAPI, manifest)
	request := httptest.NewRequest(http.MethodPost, "/api/releases/"+releaseID+"/commit", bytes.NewReader([]byte("{}")))
	setReleaseAuthHeaders(request)
	response := httptest.NewRecorder()

	ginAPI.router.ServeHTTP(response, request)

	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Equal(t, "wisp/mono2/abc123", store.publishedTarget)
	require.NotNil(t, store.publishedMetadata)
	assert.Equal(t, "abc123", store.publishedMetadata.SHA())
	assert.Equal(t, ReleaseStatusPublished, store.records[releaseID].Status)
	assert.True(t, store.stagingDeleted)
}

func TestCommitReleaseDoesNotPublishCorruptedPack(t *testing.T) {
	ginAPI, store := newReleaseTestAPI()
	packBody := buildReleasePack(t, map[string]string{"index.html": "home"})
	manifest := validReleaseManifestForAPI()
	manifest.Packs[0].CompressedSize = int64(len(packBody))
	manifest.Packs[0].SHA256 = repeatedHex("f")
	manifest.Files[0].SHA256 = digestBytes([]byte("home"))
	store.packs = map[string][]byte{manifest.Packs[0].Name: packBody}
	releaseID := createReleaseForTest(t, ginAPI, manifest)
	request := httptest.NewRequest(http.MethodPost, "/api/releases/"+releaseID+"/commit", bytes.NewReader([]byte("{}")))
	setReleaseAuthHeaders(request)
	response := httptest.NewRecorder()

	ginAPI.router.ServeHTTP(response, request)

	assert.Equal(t, http.StatusUnprocessableEntity, response.Code)
	assert.Empty(t, store.publishedTarget)
	assert.Nil(t, store.publishedMetadata)
	assert.Equal(t, ReleaseStatusFailed, store.records[releaseID].Status)
}

func TestCommitReleaseRejectsInvalidReleaseIDBeforeStorageLookup(t *testing.T) {
	ginAPI, store := newReleaseTestAPI()
	request := httptest.NewRequest(http.MethodPost, "/api/releases/not-a-release/commit", bytes.NewReader([]byte("{}")))
	setReleaseAuthHeaders(request)
	response := httptest.NewRecorder()

	ginAPI.router.ServeHTTP(response, request)

	assert.Equal(t, http.StatusNotFound, response.Code)
	assert.Zero(t, store.loadCount)
}

func newReleaseTestAPI() (*RestApi, *fakeReleaseStore) {
	page := &config.Page{
		Domain: config.DomainScope("preview.example"),
		Git: config.GitConfig{
			Provider:   "bearer",
			Repository: "wisp/mono2",
			MainBranch: "master",
			Bearer:     config.BearerAuth{Token: config.EnvValue("test-token")},
		},
		Preview: config.PreviewConfig{Branch: true, CommitSha: true, Environments: true},
	}
	store := &fakeReleaseStore{}
	api := NewRestApi(config.StaticPagesConfig{Pages: []*config.Page{page}})
	api.releaseStoreFactory = func(_ *config.Page) releaseStore { return store }
	return api, store
}

func setReleaseAuthHeaders(request *http.Request) {
	request.Header.Set("Authorization", "Bearer test-token")
	request.Header.Set(staticPagesRepositoryHeader, "wisp/mono2")
	request.Header.Set(staticPagesBranchHeader, "demo")
	request.Header.Set(staticPagesSHAHeader, "abc123")
	request.Header.Set(staticPagesEnvironmentHeader, "demo")
	request.Header.Set("Content-Type", "application/json")
}

func validReleaseManifestForAPI() ReleaseManifest {
	packName := "pack-0001-0123456789abcdef.tar.gz"
	return ReleaseManifest{
		FormatVersion:          1,
		FileCount:              1,
		TotalUncompressedBytes: 4,
		Packs: []ReleasePack{{
			Name:           packName,
			CompressedSize: 128,
			SHA256:         repeatedHex("a"),
			FileCount:      1,
		}},
		Files: []ReleaseFile{{
			Path: "index.html", Size: 4, SHA256: repeatedHex("b"), ContentType: "text/html", Pack: packName,
		}},
	}
}

func createReleaseForTest(t *testing.T, ginAPI *RestApi, manifest ReleaseManifest) string {
	t.Helper()
	body, err := json.Marshal(map[string]any{"manifest": manifest})
	require.NoError(t, err)
	request := httptest.NewRequest(http.MethodPost, "/api/releases", bytes.NewReader(body))
	setReleaseAuthHeaders(request)
	response := httptest.NewRecorder()
	ginAPI.router.ServeHTTP(response, request)
	require.Equal(t, http.StatusCreated, response.Code, response.Body.String())
	var payload struct {
		ReleaseID string `json:"release_id"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	return payload.ReleaseID
}
