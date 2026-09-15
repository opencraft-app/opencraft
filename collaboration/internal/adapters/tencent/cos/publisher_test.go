package cos

import (
	"bytes"
	"context"
	"crypto/sha256"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	cosSDK "github.com/tencentyun/cos-go-sdk-v5"
)

func TestPublisherForbidsOverwriteAndVerifiesRemoteBytes(t *testing.T) {
	payload := []byte("immutable-computer-release")
	digest := sha256.Sum256(payload)
	var stored []byte
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.Method {
		case http.MethodPut:
			if request.Header.Get("x-cos-forbid-overwrite") != "true" {
				t.Error("PUT missing x-cos-forbid-overwrite")
			}
			stored, _ = io.ReadAll(request.Body)
			response.WriteHeader(http.StatusOK)
		case http.MethodGet:
			_, _ = response.Write(stored)
		default:
			response.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()
	endpoint, _ := url.Parse(server.URL)
	publisher := &Publisher{client: cosSDK.NewClient(
		&cosSDK.BaseURL{BucketURL: endpoint}, server.Client(),
	)}
	filename := filepath.Join(t.TempDir(), "artifact")
	if err := os.WriteFile(filename, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := publisher.PublishFile(
		context.Background(), "computer/releases/0.1.0/artifact",
		filename, "application/octet-stream", digest, int64(len(payload)),
	); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, payload) {
		t.Fatalf("stored = %q", stored)
	}
}

func TestPublisherTreatsExistingIdenticalObjectAsIdempotent(t *testing.T) {
	payload := []byte("already-published")
	digest := sha256.Sum256(payload)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodPut {
			response.WriteHeader(http.StatusConflict)
			_, _ = response.Write([]byte(`<Error><Code>FileAlreadyExists</Code></Error>`))
			return
		}
		_, _ = response.Write(payload)
	}))
	defer server.Close()
	endpoint, _ := url.Parse(server.URL)
	publisher := &Publisher{client: cosSDK.NewClient(
		&cosSDK.BaseURL{BucketURL: endpoint}, server.Client(),
	)}
	filename := filepath.Join(t.TempDir(), "artifact")
	if err := os.WriteFile(filename, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := publisher.PublishFile(
		context.Background(), "computer/releases/0.1.0/artifact",
		filename, "application/octet-stream", digest, int64(len(payload)),
	); err != nil {
		t.Fatal(err)
	}
}

func TestPublisherRejectsLocalOrRemoteHashMismatch(t *testing.T) {
	payload := []byte("payload")
	digest := sha256.Sum256(payload)
	filename := filepath.Join(t.TempDir(), "artifact")
	if err := os.WriteFile(filename, []byte("different"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := (&Publisher{}).PublishFile(
		context.Background(), "computer/releases/0.1.0/artifact",
		filename, "application/octet-stream", digest, int64(len(payload)),
	); err == nil {
		t.Fatal("PublishFile() accepted mismatched local bytes")
	}
}
