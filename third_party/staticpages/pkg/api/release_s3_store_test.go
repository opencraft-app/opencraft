package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/SpechtLabs/StaticPages/pkg/config"
	"github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestS3ReleaseStorePersistsRecordAndAcceptsPresignedPack(t *testing.T) {
	backend := s3mem.New()
	require.NoError(t, backend.CreateBucket("test"))
	server := httptest.NewServer(gofakes3.New(backend, gofakes3.WithHostBucket(false)).Server())
	t.Cleanup(server.Close)
	usePathStyle := true
	page := &config.Page{
		Bucket: config.BucketConfig{
			URL:           config.EnvValue(server.URL),
			Name:          config.EnvValue("test"),
			ApplicationID: config.EnvValue("access-key"),
			Secret:        config.EnvValue("secret-key"),
			Region:        config.EnvValue("us-east-1"),
			UsePathStyle:  &usePathStyle,
		},
		Git: config.GitConfig{Repository: "wisp/mono2"},
	}
	store := newS3ReleaseStore(page)
	manifest := validReleaseManifestForAPI()
	record := ReleaseRecord{
		ID: "rel_test", Repository: "wisp/mono2", SHA: "abc123", Branch: "demo", Environment: "demo",
		ManifestSHA256: repeatedHex("c"), Manifest: manifest, Status: ReleaseStatusCreated,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}

	require.NoError(t, store.SaveRecord(context.Background(), record))
	loaded, err := store.LoadRecord(context.Background(), record.ID)
	require.NoError(t, err)
	assert.Equal(t, record.ID, loaded.ID)
	assert.Equal(t, record.ManifestSHA256, loaded.ManifestSHA256)

	packBody := []byte("pack-content")
	pack := manifest.Packs[0]
	pack.CompressedSize = int64(len(packBody))
	pack.SHA256 = digestBytes(packBody)
	upload, err := store.PresignPackUpload(context.Background(), record.ID, pack)
	require.NoError(t, err)
	request, err := http.NewRequest(http.MethodPut, upload.URL, bytes.NewReader(packBody))
	require.NoError(t, err)
	for name, value := range upload.Headers {
		request.Header.Set(name, value)
	}
	request.ContentLength = int64(len(packBody))
	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	require.Less(t, response.StatusCode, 300)

	require.NoError(t, store.InspectPack(context.Background(), record.ID, pack))
	body, err := store.OpenPack(context.Background(), record.ID, pack.Name)
	require.NoError(t, err)
	defer body.Close()
	value, err := io.ReadAll(body)
	require.NoError(t, err)
	assert.Equal(t, packBody, value)
}

func TestReleaseAPIUploadsPacksAndPublishesThroughS3(t *testing.T) {
	backend := s3mem.New()
	require.NoError(t, backend.CreateBucket("test"))
	storageServer := httptest.NewServer(gofakes3.New(backend, gofakes3.WithHostBucket(false)).Server())
	t.Cleanup(storageServer.Close)
	usePathStyle := true
	publicRead := true
	page := &config.Page{
		Domain: config.DomainScope("preview.example"),
		Bucket: config.BucketConfig{
			URL:           config.EnvValue(storageServer.URL),
			Name:          config.EnvValue("test"),
			ApplicationID: config.EnvValue("access-key"),
			Secret:        config.EnvValue("secret-key"),
			Region:        config.EnvValue("us-east-1"),
			UsePathStyle:  &usePathStyle,
			PublicRead:    &publicRead,
		},
		Git: config.GitConfig{
			Provider:   "bearer",
			Repository: "wisp/mono2",
			MainBranch: "master",
			Bearer:     config.BearerAuth{Token: config.EnvValue("test-token")},
		},
		Preview: config.PreviewConfig{Enabled: true, Branch: true},
	}
	api := NewRestApi(config.StaticPagesConfig{Pages: []*config.Page{page}})
	apiServer := httptest.NewServer(api.router)
	t.Cleanup(apiServer.Close)
	packBody := buildReleasePack(t, map[string]string{"index.html": "home"})
	manifest := validReleaseManifestForAPI()
	manifest.Packs[0].CompressedSize = int64(len(packBody))
	manifest.Packs[0].SHA256 = digestBytes(packBody)
	manifest.Files[0].SHA256 = digestBytes([]byte("home"))
	manifestBody, err := json.Marshal(map[string]any{"manifest": manifest})
	require.NoError(t, err)

	createRequest, err := http.NewRequest(http.MethodPost, apiServer.URL+"/api/releases", bytes.NewReader(manifestBody))
	require.NoError(t, err)
	setReleaseAuthHeaders(createRequest)
	createResponse, err := http.DefaultClient.Do(createRequest)
	require.NoError(t, err)
	defer createResponse.Body.Close()
	require.Equal(t, http.StatusCreated, createResponse.StatusCode)
	var created struct {
		ReleaseID string              `json:"release_id"`
		Uploads   []ReleasePackUpload `json:"uploads"`
	}
	require.NoError(t, json.NewDecoder(createResponse.Body).Decode(&created))
	require.Len(t, created.Uploads, 1)

	uploadRequest, err := http.NewRequest(http.MethodPut, created.Uploads[0].URL, bytes.NewReader(packBody))
	require.NoError(t, err)
	for name, value := range created.Uploads[0].Headers {
		uploadRequest.Header.Set(name, value)
	}
	uploadRequest.ContentLength = int64(len(packBody))
	uploadResponse, err := http.DefaultClient.Do(uploadRequest)
	require.NoError(t, err)
	defer uploadResponse.Body.Close()
	_, _ = io.Copy(io.Discard, uploadResponse.Body)
	require.Less(t, uploadResponse.StatusCode, 300)

	commitRequest, err := http.NewRequest(http.MethodPost, apiServer.URL+"/api/releases/"+created.ReleaseID+"/commit", bytes.NewReader([]byte("{}")))
	require.NoError(t, err)
	setReleaseAuthHeaders(commitRequest)
	commitResponse, err := http.DefaultClient.Do(commitRequest)
	require.NoError(t, err)
	defer commitResponse.Body.Close()
	commitBody, err := io.ReadAll(commitResponse.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, commitResponse.StatusCode, string(commitBody))

	store := newS3ReleaseStore(page).(*s3ReleaseStore)
	published, err := store.client.GetObject(context.Background(), "wisp/mono2/abc123/index.html")
	require.NoError(t, err)
	defer published.Close()
	content, err := io.ReadAll(published)
	require.NoError(t, err)
	assert.Equal(t, "home", string(content))
	index, err := store.client.DownloadPageIndex(context.Background())
	require.NoError(t, err)
	require.Contains(t, index, "abc123")
	assert.Equal(t, "demo", index["abc123"].Branch)
}
