package website

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tencentyun/cos-go-sdk-v5"
)

func websiteZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(w, body); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type fakeCOSState struct {
	mu             sync.Mutex
	artifact       []byte
	metadataHash   string
	objects        map[string]int64
	putKeys        []string
	deletedObjects []string
	rejectStorage  bool
}

func (s *fakeCOSState) handler(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, "/")
	s.mu.Lock()
	defer s.mu.Unlock()

	if r.Method == http.MethodGet && key == "_artifacts/ws-1/wr-0123456789abcdef.zip" {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(s.artifact)))
		w.Header().Set("x-cos-meta-artifact-sha256", s.metadataHash)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(s.artifact)
		return
	}
	if r.Method == http.MethodGet && key == "" {
		prefix := r.URL.Query().Get("prefix")
		keys := make([]string, 0)
		for objectKey := range s.objects {
			if strings.HasPrefix(objectKey, prefix) {
				keys = append(keys, objectKey)
			}
		}
		sort.Strings(keys)
		w.Header().Set("Content-Type", "application/xml")
		_, _ = io.WriteString(w, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>`)
		for _, objectKey := range keys {
			_, _ = fmt.Fprintf(w, `<Contents><Key>%s</Key><LastModified>2026-08-09T00:00:00.000Z</LastModified><Size>%d</Size></Contents>`, objectKey, s.objects[objectKey])
		}
		_, _ = io.WriteString(w, `</ListBucketResult>`)
		return
	}
	if r.Method == http.MethodPut {
		body, _ := io.ReadAll(r.Body)
		s.putKeys = append(s.putKeys, key)
		s.objects[key] = int64(len(body))
		if r.Header.Get("x-cos-copy-source") != "" {
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, `<CopyObjectResult><ETag>"etag"</ETag><LastModified>2026-08-09T00:00:00.000Z</LastModified></CopyObjectResult>`)
			return
		}
		w.Header().Set("x-cos-hash-crc64ecma", strconv.FormatUint(
			crc64.Checksum(body, crc64.MakeTable(crc64.ECMA)), 10))
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method == http.MethodDelete {
		s.deletedObjects = append(s.deletedObjects, key)
		delete(s.objects, key)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method == http.MethodPost && r.URL.Query().Has("delete") {
		w.Header().Set("Content-Type", "application/xml")
		_, _ = io.WriteString(w, `<DeleteResult></DeleteResult>`)
		return
	}
	w.WriteHeader(http.StatusNotFound)
}

func newPublishTestDeployer(t *testing.T, state *fakeCOSState) (*Deployer, *string) {
	t.Helper()
	cosServer := httptest.NewServer(http.HandlerFunc(state.handler))
	t.Cleanup(cosServer.Close)
	bucketURL, err := url.Parse(cosServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	cosHTTP := cosServer.Client()
	cosHTTP.Timeout = time.Second

	completedPath := ""
	ctlServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/complete"):
			var body struct {
				CloudPath string `json:"cloud_path"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			completedPath = body.CloudPath
		case strings.HasSuffix(r.URL.Path, "/fail"):
		case strings.HasSuffix(r.URL.Path, "/storage"):
			if state.rejectStorage {
				w.WriteHeader(http.StatusForbidden)
				_, _ = io.WriteString(w, `{"code":"WEBSITE_QUOTA_EXCEEDED"}`)
				return
			}
		default:
			t.Errorf("unexpected CTL path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"code":"OK","data":{}}`)
	}))
	t.Cleanup(ctlServer.Close)

	return &Deployer{
		ctlBaseURL:           ctlServer.URL,
		httpClient:           ctlServer.Client(),
		maxArtifactBytes:     1024 * 1024,
		maxFiles:             10,
		maxUncompressedBytes: 1024 * 1024,
		siteRootDomain:       "sites.example.test",
		siteURLScheme:        "https",
		siteCos: &cosClient{
			bucket: "test-bucket",
			region: "ap-test",
			client: cos.NewClient(&cos.BaseURL{BucketURL: bucketURL}, cosHTTP),
		},
	}, &completedPath
}

func TestPublishReleaseActivatesImmutablePrefixWithoutWritingCurrent(t *testing.T) {
	artifact := websiteZip(t, map[string]string{"index.html": "hello", "assets/app.js": "app"})
	hash := digestForTest(string(artifact))
	state := &fakeCOSState{
		artifact:     artifact,
		metadataHash: hash,
		objects: map[string]int64{
			"_artifacts/ws-1/wr-0123456789abcdef.zip": int64(len(artifact)),
			"sites/ws-1/current/index.html":           3,
		},
	}
	d, completedPath := newPublishTestDeployer(t, state)
	op := Operation{OperationID: "wo-1", SiteID: "ws-1", ReleaseID: "wr-0123456789abcdef",
		OperationType: "deploy", LeaseToken: "lease", ArtifactSize: int64(len(artifact)), ArtifactHash: hash}

	if err := d.publishRelease(op, false); err != nil {
		t.Fatalf("publishRelease: %v", err)
	}
	wantPrefix := "sites/ws-1/releases/wr-0123456789abcdef/"
	if *completedPath != wantPrefix {
		t.Fatalf("completed cloud_path = %q, want %q", *completedPath, wantPrefix)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	for _, key := range state.putKeys {
		if strings.Contains(key, "/current/") {
			t.Fatalf("publish wrote mutable current key %q", key)
		}
		if !strings.HasPrefix(key, wantPrefix) {
			t.Fatalf("publish wrote outside immutable prefix: %q", key)
		}
	}
	artifactKey := "_artifacts/ws-1/wr-0123456789abcdef.zip"
	if len(state.deletedObjects) != 1 || state.deletedObjects[0] != artifactKey {
		t.Fatalf("successful publish must remove temporary artifact, deleted objects = %v", state.deletedObjects)
	}
}

func TestPublishReleaseDeletesArtifactWhenHashIsInvalid(t *testing.T) {
	artifact := websiteZip(t, map[string]string{"index.html": "hello"})
	actualHash := digestForTest(string(artifact))
	state := &fakeCOSState{
		artifact:     artifact,
		metadataHash: actualHash,
		objects: map[string]int64{
			"_artifacts/ws-1/wr-0123456789abcdef.zip": int64(len(artifact)),
		},
	}
	d, _ := newPublishTestDeployer(t, state)
	op := Operation{OperationID: "wo-1", SiteID: "ws-1", ReleaseID: "wr-0123456789abcdef",
		OperationType: "deploy", LeaseToken: "lease", ArtifactSize: int64(len(artifact)), ArtifactHash: strings.Repeat("0", 64)}

	err := d.publishRelease(op, false)
	if !errors.Is(err, ErrOperationFailedAndReported) {
		t.Fatalf("publishRelease error = %v", err)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.deletedObjects) != 1 || state.deletedObjects[0] != "_artifacts/ws-1/wr-0123456789abcdef.zip" {
		t.Fatalf("deleted objects = %v", state.deletedObjects)
	}
}

func TestPublishReleaseDoesNotActivateWhenActualStorageIsRejected(t *testing.T) {
	artifact := websiteZip(t, map[string]string{"index.html": "hello"})
	hash := digestForTest(string(artifact))
	state := &fakeCOSState{
		artifact:      artifact,
		metadataHash:  hash,
		rejectStorage: true,
		objects: map[string]int64{
			"_artifacts/ws-1/wr-0123456789abcdef.zip": int64(len(artifact)),
		},
	}
	d, completedPath := newPublishTestDeployer(t, state)
	op := Operation{OperationID: "wo-1", SiteID: "ws-1", ReleaseID: "wr-0123456789abcdef",
		OperationType: "deploy", LeaseToken: "lease", ArtifactSize: int64(len(artifact)), ArtifactHash: hash}

	err := d.publishRelease(op, false)
	if !errors.Is(err, ErrOperationFailedAndReported) {
		t.Fatalf("publishRelease error = %v", err)
	}
	if *completedPath != "" {
		t.Fatalf("quota-rejected release activated %q", *completedPath)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.deletedObjects) != 1 || state.deletedObjects[0] != "_artifacts/ws-1/wr-0123456789abcdef.zip" {
		t.Fatalf("deleted objects = %v", state.deletedObjects)
	}
}
