package website

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
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
	"sync/atomic"
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
	mu              sync.Mutex
	artifact        []byte
	metadataHash    string
	objects         map[string]int64
	putKeys         []string
	deletedObjects  []string
	rejectStorage   bool
	reportedStorage int64
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
		var batch struct {
			Objects []struct {
				Key string `xml:"Key"`
			} `xml:"Object"`
		}
		if err := xml.NewDecoder(r.Body).Decode(&batch); err != nil {
			http.Error(w, "invalid delete batch", http.StatusBadRequest)
			return
		}
		for _, object := range batch.Objects {
			s.deletedObjects = append(s.deletedObjects, object.Key)
			delete(s.objects, object.Key)
		}
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
			var usage struct {
				StorageBytes int64 `json:"storage_bytes"`
			}
			if err := json.NewDecoder(r.Body).Decode(&usage); err != nil {
				t.Error(err)
			}
			state.mu.Lock()
			state.reportedStorage = usage.StorageBytes
			state.mu.Unlock()
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
	assertSameKeys(t, state.deletedObjects, []string{
		"_artifacts/ws-1/wr-0123456789abcdef.zip",
	})
	if len(state.objects) != 0 {
		t.Fatalf("quota-rejected artifacts retained: %v", state.objects)
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
	assertSameKeys(t, state.deletedObjects, []string{
		"_artifacts/ws-1/wr-0123456789abcdef.zip",
		"sites/ws-1/releases/wr-0123456789abcdef/index.html",
	})
	if len(state.objects) != 0 {
		t.Fatalf("quota-rejected artifacts retained: %v", state.objects)
	}
}

// Exercise the existing publish/delete paths with an unavailable runtime. The
// optional CTL fact distinguishes pure static sites from retained backend history.
func TestStaticOperationsDoNotDependOnRuntime(t *testing.T) {
	for _, operation := range []string{"publish", "delete"} {
		for _, history := range []string{"false", "true", "unknown", "unknown-no-snapshot"} {
			t.Run(operation+"/history="+history, func(t *testing.T) {
				artifact := websiteZip(t, map[string]string{"index.html": "new"})
				oldKey := "sites/ws-1/releases/wr-old/index.html"
				state := &fakeCOSState{artifact: artifact, metadataHash: digestForTest(string(artifact)),
					objects: map[string]int64{oldKey: 3}}
				d, completed := newPublishTestDeployer(t, state)
				var calls atomic.Int32
				runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					http.Error(w, "unavailable", http.StatusServiceUnavailable)
				}))
				defer runtime.Close()
				d.runtimeURL, d.runtimeToken = runtime.URL, "test-deploy"
				op := Operation{Kind: "static", OperationID: "wo-1", SiteID: "ws-1",
					ReleaseID: "wr-0123456789abcdef", LeaseToken: "lease",
					ArtifactHash: state.metadataHash, ArtifactSize: int64(len(artifact))}
				if history != "unknown-no-snapshot" {
					if err := json.Unmarshal([]byte(`{"PreviousStorageBytes":20}`), &op); err != nil {
						t.Fatal(err)
					}
				}
				if history == "false" || history == "true" {
					if err := json.Unmarshal([]byte(`{"HasBackendHistory":`+history+`}`), &op); err != nil {
						t.Fatal(err)
					}
				}
				var err error
				if operation == "publish" {
					err = d.publishRelease(op, false)
				} else {
					err = d.executeDelete(op)
				}
				if (operation == "delete" && history != "false") || history == "unknown-no-snapshot" {
					if err == nil || calls.Load() != 1 {
						t.Fatalf("unconfirmed operation must fail closed: err=%v, calls=%d", err, calls.Load())
					}
				} else {
					wantCalls := int32(0)
					if history != "false" {
						wantCalls = 1
					}
					if err != nil || calls.Load() != wantCalls {
						t.Fatalf("static operation: err=%v, calls=%d, want calls=%d", err, calls.Load(), wantCalls)
					}
					if operation == "publish" && *completed == "" {
						t.Fatal("static release was not activated")
					}
				}
				state.mu.Lock()
				defer state.mu.Unlock()
				_, retained := state.objects[oldKey]
				if retained != (history != "false") {
					t.Fatalf("old release retained=%v with history=%s", retained, history)
				}
				if operation == "publish" && history != "unknown-no-snapshot" {
					wantStorage := int64(26) // old COS 3 + new COS 3 + previous reported total 20
					if history == "false" {
						wantStorage = 3
					}
					if state.reportedStorage != wantStorage {
						t.Fatalf("reported storage=%d, want %d", state.reportedStorage, wantStorage)
					}
				}
			})
		}
	}
}
